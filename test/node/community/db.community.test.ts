import { beforeAll, afterAll } from "vitest";
import signers from "../../fixtures/signers.js";

import path from "path";
import fs from "fs";
import { temporaryDirectory } from "tempy";
import {
    mockPKC,
    generateMockPost,
    publishWithExpectedResult,
    waitUntilPKCCommunitiesIncludeCommunityAddress,
    publishRandomPost,
    createSubWithNoChallenge,
    resolveWhenConditionIsTrue,
    waitTillPostInCommunityInstancePages,
    expectCommunityListed,
    expectCommunityNotListed
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { marshalIPNSRecord } from "ipns";
import { getIpnsRecordInLocalKuboNode } from "../../../dist/node/util.js";

import pkcVersion from "../../../dist/node/version.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";

import type { InputPKCOptions } from "../../../dist/node/types.js";

interface DatabaseToMigrate {
    version: number;
    path: string;
    address: string;
}

const getTemporaryPKCOptions = (): InputPKCOptions => {
    return {
        dataPath: temporaryDirectory(),
        kuboRpcClientsOptions: ["http://localhost:15004/api/v0"],
        pubsubKuboRpcClientsOptions: ["http://localhost:15005/api/v0"]
    };
};

const getDatabasesToMigrate = (): DatabaseToMigrate[] => {
    const dbRootPath = path.join(process.cwd(), "test", "fixtures", "communities_dbs");
    if (!fs.existsSync(dbRootPath)) return [];
    const versions = fs.readdirSync(dbRootPath); // version_6, version_7, version_8 etc
    const databasesToMigrate: DatabaseToMigrate[] = [];

    for (const version of versions) {
        const databases = fs.readdirSync(path.join(dbRootPath, version)); // Would give a list of databases

        for (const database of databases) {
            const fullDbPath = path.join(dbRootPath, version, database);
            const versionNumberParsed = parseInt(version.replace(/[^\d.]/g, ""));
            databasesToMigrate.push({ path: fullDbPath, version: versionNumberParsed, address: database });
        }
    }
    return databasesToMigrate;
};

const generateRandomSub = async (): Promise<LocalCommunity | RpcLocalCommunity> => {
    const pkc: PKCType = await mockPKC();
    const community = await createSubWithNoChallenge({}, pkc);
    await community.start();
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => Boolean(community.updatedAt) });

    const post: Comment = await publishRandomPost({ communityAddress: community.address, pkc: pkc });
    await waitTillPostInCommunityInstancePages(post as Comment & { cid: string }, community);

    await community.stop();
    await pkc.destroy();

    return community;
};

const copyDbToDataPath = async (databaseObj: { path: string; address: string }, pkc: PKCType): Promise<void> => {
    const newPath = path.join(pkc.dataPath!, "communities", databaseObj.address);
    await fs.promises.cp(databaseObj.path, newPath);
};

describeSkipIfRpc.sequential(`DB importing`, async () => {
    let pkc: PKCType;

    beforeAll(async () => {
        pkc = await mockPKC(getTemporaryPKCOptions());
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`Community will show up in pkc.communities if its db was copied to datapath/communities`, async () => {
        expectCommunityNotListed({ pkc, publicKey: signers[0].address, address: signers[0].address });

        const regularPKC: PKCType = await mockPKC();
        const databaseToMigrate = {
            address: signers[0].address,
            path: path.join(regularPKC.dataPath!, "communities", signers[0].address)
        };
        await copyDbToDataPath(databaseToMigrate, pkc);
        await waitUntilPKCCommunitiesIncludeCommunityAddress(pkc, databaseToMigrate.address);
        expectCommunityListed({ pkc: pkc, publicKey: signers[0].address, address: databaseToMigrate.address, name: undefined });
        await regularPKC.destroy();
    });

    it(`Can import a community by copying its sql file to datapath/communities`, async () => {
        const regularPKC: PKCType = await mockPKC();
        const randomSub = await generateRandomSub();
        const tempPKC: PKCType = await mockPKC(getTemporaryPKCOptions());
        const srcDbPath = path.join(regularPKC.dataPath!, "communities", randomSub.address);
        await fs.promises.cp(srcDbPath, path.join(tempPKC.dataPath!, "communities", randomSub.address));
        await waitUntilPKCCommunitiesIncludeCommunityAddress(tempPKC, randomSub.address);
        // Should be included in tempPKC.communities now
        const community = (await tempPKC.createCommunity({ address: randomSub.address })) as LocalCommunity | RpcLocalCommunity;
        await community.edit({
            settings: { ...community.settings, challenges: [{ name: "question", options: { question: "1+1=?", answer: "2" } }] }
        }); // We want this community to have a full challenge exchange to test all db tables
        expect(community.updatedAt).to.be.a("number"); // Should be fetched from db

        await community.start();
        await new Promise<void>((resolve) => community.once("update", () => resolve()));
        const localCommunity = community as LocalCommunity;
        const currentDbVersion = await localCommunity._dbHandler.getDbVersion();
        expect(currentDbVersion).to.equal(pkcVersion.DB_VERSION);

        const mockPost: Comment = await generateMockPost({ communityAddress: community.address, pkc: tempPKC });
        mockPost.once("challenge", async () => {
            await mockPost.publishChallengeAnswers({ challengeAnswers: { "0": "2" } }); // hardcode answer here
        });

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

        await community.delete();
        await tempPKC.destroy();
        await regularPKC.destroy();
    });

    // Issue #553: a community is moved by copying its DB, which carries the last published IPNS record and its
    // sequence. The kubo node behind getTemporaryPKCOptions() has no peers and has never published this key, so
    // left to itself it starts the sequence at 0 and every reader that holds the old node's record ignores the
    // new one as older. Only the sequence stored in the DB can continue it here.
    it(`A community's IPNS sequence continues after its DB is moved to a PKC on another kubo node`, async () => {
        const oldPKC: PKCType = await mockPKC();
        const oldKubo = Object.values(oldPKC.clients.kuboRpcClients)[0];
        const original = (await createSubWithNoChallenge({}, oldPKC)) as LocalCommunity;
        await original.start();
        await resolveWhenConditionIsTrue({ toUpdate: original, predicate: async () => Boolean(original.updatedAt) });
        // A few more records, so that continuing the sequence cannot be mistaken for starting over
        for (let i = 0; i < 3; i++) {
            const cidBefore = original.updateCid;
            original._communityUpdateTrigger = true;
            await resolveWhenConditionIsTrue({ toUpdate: original, predicate: async () => original.updateCid !== cidBefore });
        }
        const ipnsName = original.signer.address;
        const oldRecord = await getIpnsRecordInLocalKuboNode(oldKubo, ipnsName);
        expect(oldRecord.sequence >= 3n, `old node should be at sequence 3 or above, is at ${oldRecord.sequence}`).to.be.true;
        const oldUpdatedAt = original.updatedAt!;
        await original.stop();

        const newPKC: PKCType = await mockPKC(getTemporaryPKCOptions());
        const newKubo = Object.values(newPKC.clients.kuboRpcClients)[0];
        await fs.promises.cp(
            path.join(oldPKC.dataPath!, "communities", original.address),
            path.join(newPKC.dataPath!, "communities", original.address)
        );
        await waitUntilPKCCommunitiesIncludeCommunityAddress(newPKC, original.address);
        const migrated = (await newPKC.createCommunity({ address: original.address })) as LocalCommunity;
        await migrated.start();
        await resolveWhenConditionIsTrue({ toUpdate: migrated, predicate: async () => (migrated.updatedAt ?? 0) > oldUpdatedAt });

        const newRecord = await getIpnsRecordInLocalKuboNode(newKubo, ipnsName);
        expect(newRecord.value).to.equal("/ipfs/" + migrated.updateCid);
        expect(
            newRecord.sequence > oldRecord.sequence,
            `new node published sequence ${newRecord.sequence}, old node was at ${oldRecord.sequence}`
        ).to.be.true;

        // The reader side: a node that holds the old record is handed the new node's record and has to prefer it
        for await (const _event of oldKubo._client.routing.put(`/ipns/${ipnsName}`, marshalIPNSRecord(newRecord), { allowOffline: true }));
        const recordOnOldNode = await getIpnsRecordInLocalKuboNode(oldKubo, ipnsName);
        expect(recordOnOldNode.value, "the node that held the old record kept it over the new one").to.equal(newRecord.value);

        await migrated.stop();
        await newPKC.destroy();
        await oldPKC.destroy();
    });
});

describeSkipIfRpc.sequential("DB Migration", () => {
    const databasesToMigrate = getDatabasesToMigrate();

    databasesToMigrate.map((databaseInfo) =>
        it(`Can migrate from DB version ${databaseInfo.version} to ${pkcVersion.DB_VERSION} - address (${databaseInfo.address})`, async () => {
            // Once we start the community, it's gonna attempt to migrate to the latest DB version

            const pkc: PKCType = await mockPKC(getTemporaryPKCOptions());

            console.log(
                `We're using datapath (${pkc.dataPath}) For testing migration from db version (${databaseInfo.version}) to ${pkcVersion.DB_VERSION}`
            );
            await copyDbToDataPath(databaseInfo, pkc);

            await waitUntilPKCCommunitiesIncludeCommunityAddress(pkc, databaseInfo.address);

            const community = (await pkc.createCommunity({ address: databaseInfo.address })) as LocalCommunity | RpcLocalCommunity;
            expect(community.started).to.be.a("boolean"); // make sure it's creating a local sub instance
            expect(community.updatedAt).to.be.a("number"); // it should load the internal state from db
            expect(community.createdAt).to.be.a("number"); // it should load the internal state from db

            await community.start();

            await new Promise<void>((resolve) => community.once("update", () => resolve())); // Ensure IPNS is published
            await community.edit({ settings: { ...community.settings, challenges: [] } });
            const mockPost: Comment = await publishRandomPost({ communityAddress: community.address, pkc: pkc });

            await mockPost.update();
            await resolveWhenConditionIsTrue({ toUpdate: mockPost, predicate: async () => Boolean(mockPost.updatedAt) });
            expect(mockPost.updatedAt).to.be.a("number");
            expect(mockPost.author.community).to.be.a("object");
            await mockPost.stop();

            await community.delete();
            await pkc.destroy();
        })
    );
});
