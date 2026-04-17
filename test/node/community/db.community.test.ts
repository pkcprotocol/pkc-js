import { beforeAll, afterAll } from "vitest";
import signers from "../../fixtures/signers.js";

import path from "path";
import fs from "fs";
import { temporaryDirectory } from "tempy";
import {
    mockPKC,
    generateMockPost,
    publishWithExpectedResult,
    describeSkipIfRpc,
    waitUntilPKCCommunitiesIncludeSubAddress,
    publishRandomPost,
    createSubWithNoChallenge,
    resolveWhenConditionIsTrue,
    waitTillPostInCommunityInstancePages
} from "../../../dist/node/test/test-util.js";
import * as cborg from "cborg";

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
        expect(pkc.communities).to.not.include(signers[0].address);

        const regularPKC: PKCType = await mockPKC();
        const databaseToMigrate = {
            address: signers[0].address,
            path: path.join(regularPKC.dataPath!, "communities", signers[0].address)
        };
        await copyDbToDataPath(databaseToMigrate, pkc);
        await waitUntilPKCCommunitiesIncludeSubAddress(pkc, databaseToMigrate.address);
        expect(pkc.communities).to.include(databaseToMigrate.address);
        await regularPKC.destroy();
    });

    it(`Can import a community by copying its sql file to datapath/communities`, async () => {
        const regularPKC: PKCType = await mockPKC();
        const randomSub = await generateRandomSub();
        const tempPKC: PKCType = await mockPKC(getTemporaryPKCOptions());
        const srcDbPath = path.join(regularPKC.dataPath!, "communities", randomSub.address);
        await fs.promises.cp(srcDbPath, path.join(tempPKC.dataPath!, "communities", randomSub.address));
        await waitUntilPKCCommunitiesIncludeSubAddress(tempPKC, randomSub.address);
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
            await mockPost.publishChallengeAnswers(["2"]); // hardcode answer here
        });

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

        await community.delete();
        await tempPKC.destroy();
        await regularPKC.destroy();
    });

    // skip until kubo fixes the bug
    it.skip(`A community IPNS' sequence number is up to date even after migrating to new ipfs repo`, async () => {
        const regularPKC: PKCType = await mockPKC();
        const randomSub = await generateRandomSub();
        await randomSub.start();
        await resolveWhenConditionIsTrue({ toUpdate: randomSub, predicate: async () => Boolean(randomSub.updatedAt) });

        const localRandomSub = randomSub as LocalCommunity;
        const ipnsRecord = await localRandomSub._dbHandler.keyvGet("LAST_IPNS_RECORD");

        expect(ipnsRecord).to.exist;

        const ipnsRecordDecoded = cborg.decode(new Uint8Array(Object.values(ipnsRecord as object)), { allowBigInt: true });
        expect(ipnsRecordDecoded.sequence).to.equal(1);

        await randomSub.stop();
        const tempPKC: PKCType = await mockPKC(getTemporaryPKCOptions()); // different kubo, should use sequence in keyv
        const srcDbPath = path.join(regularPKC.dataPath!, "communities", randomSub.address);
        await fs.promises.cp(srcDbPath, path.join(tempPKC.dataPath!, "communities", randomSub.address));
        await waitUntilPKCCommunitiesIncludeSubAddress(tempPKC, randomSub.address);
        // Should be included in tempPKC.communities now
        const community = (await tempPKC.createCommunity({ address: randomSub.address })) as LocalCommunity | RpcLocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.updatedAt! > randomSub.updatedAt! });

        const localCommunity = community as LocalCommunity;
        const ipnsRecordOfSubInDifferentKubo = await localCommunity._dbHandler.keyvGet("LAST_IPNS_RECORD");

        expect(ipnsRecordOfSubInDifferentKubo).to.exist;

        const ipnsRecordOfSubInDifferentKuboDecoded = cborg.decode(
            new Uint8Array(Object.values(ipnsRecordOfSubInDifferentKubo as object)),
            {
                allowBigInt: true
            }
        );
        expect(ipnsRecordOfSubInDifferentKuboDecoded.sequence).to.equal(3);

        await community.stop();

        await regularPKC.destroy();
        await tempPKC.destroy();

        // const mockPost = await generateMockPost({ communityAddress: community.address, pkc: tempPKC });
        // mockPost.once("challenge", async (challengeMsg) => {
        //     await mockPost.publishChallengeAnswers(["2"]); // hardcode answer here
        // });

        // await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

        // await community.delete();
        // await tempPKC.destroy();
        // await regularPKC.destroy();
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

            await waitUntilPKCCommunitiesIncludeSubAddress(pkc, databaseInfo.address);

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
