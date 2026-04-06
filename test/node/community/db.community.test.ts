import { beforeAll, afterAll } from "vitest";
import signers from "../../fixtures/signers.js";

import path from "path";
import fs from "fs";
import tempy from "tempy";
import {
    mockPKC,
    generateMockPost,
    publishWithExpectedResult,
    describeSkipIfRpc,
    waitUntilPKCCommunitysIncludeSubAddress,
    publishRandomPost,
    createSubWithNoChallenge,
    resolveWhenConditionIsTrue,
    waitTillPostInCommunityInstancePages
} from "../../../dist/node/test/test-util.js";
import * as cborg from "cborg";

import plebbitVersion from "../../../dist/node/version.js";

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
        dataPath: tempy.directory(),
        kuboRpcClientsOptions: ["http://localhost:15004/api/v0"],
        pubsubKuboRpcClientsOptions: ["http://localhost:15005/api/v0"]
    };
};

const getDatabasesToMigrate = (): DatabaseToMigrate[] => {
    const dbRootPath = path.join(process.cwd(), "test", "fixtures", "subplebbits_dbs");
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
    const plebbit: PKCType = await mockPKC();
    const sub = await createSubWithNoChallenge({}, plebbit);
    await sub.start();
    await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => Boolean(sub.updatedAt) });

    const post: Comment = await publishRandomPost({ communityAddress: sub.address, plebbit: plebbit });
    await waitTillPostInCommunityInstancePages(post as Comment & { cid: string }, sub);

    await sub.stop();
    await plebbit.destroy();

    return sub;
};

const copyDbToDataPath = async (databaseObj: { path: string; address: string }, plebbit: PKCType): Promise<void> => {
    const newPath = path.join(plebbit.dataPath!, "subplebbits", databaseObj.address);
    await fs.promises.cp(databaseObj.path, newPath);
};

describeSkipIfRpc.sequential(`DB importing`, async () => {
    let plebbit: PKCType;

    beforeAll(async () => {
        plebbit = await mockPKC(getTemporaryPKCOptions());
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`Community will show up in plebbit.subplebbits if its db was copied to datapath/subplebbits`, async () => {
        expect(plebbit.subplebbits).to.not.include(signers[0].address);

        const regularPKC: PKCType = await mockPKC();
        const databaseToMigrate = {
            address: signers[0].address,
            path: path.join(regularPKC.dataPath!, "subplebbits", signers[0].address)
        };
        await copyDbToDataPath(databaseToMigrate, plebbit);
        await waitUntilPKCCommunitysIncludeSubAddress(plebbit, databaseToMigrate.address);
        expect(plebbit.subplebbits).to.include(databaseToMigrate.address);
        await regularPKC.destroy();
    });

    it(`Can import a subplebbit by copying its sql file to datapath/subplebbits`, async () => {
        const regularPKC: PKCType = await mockPKC();
        const randomSub = await generateRandomSub();
        const tempPKC: PKCType = await mockPKC(getTemporaryPKCOptions());
        const srcDbPath = path.join(regularPKC.dataPath!, "subplebbits", randomSub.address);
        await fs.promises.cp(srcDbPath, path.join(tempPKC.dataPath!, "subplebbits", randomSub.address));
        await waitUntilPKCCommunitysIncludeSubAddress(tempPKC, randomSub.address);
        // Should be included in tempPKC.subplebbits now
        const subplebbit = (await tempPKC.createCommunity({ address: randomSub.address })) as LocalCommunity | RpcLocalCommunity;
        await subplebbit.edit({
            settings: { ...subplebbit.settings, challenges: [{ name: "question", options: { question: "1+1=?", answer: "2" } }] }
        }); // We want this sub to have a full challenge exchange to test all db tables
        expect(subplebbit.updatedAt).to.be.a("number"); // Should be fetched from db

        await subplebbit.start();
        await new Promise<void>((resolve) => subplebbit.once("update", () => resolve()));
        const localSub = subplebbit as LocalCommunity;
        const currentDbVersion = await localSub._dbHandler.getDbVersion();
        expect(currentDbVersion).to.equal(plebbitVersion.DB_VERSION);

        const mockPost: Comment = await generateMockPost({ communityAddress: subplebbit.address, plebbit: tempPKC });
        mockPost.once("challenge", async () => {
            await mockPost.publishChallengeAnswers(["2"]); // hardcode answer here
        });

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

        await subplebbit.delete();
        await tempPKC.destroy();
        await regularPKC.destroy();
    });

    // skip until kubo fixes the bug
    it.skip(`A subplebbit IPNS' sequence number is up to date even after migrating to new ipfs repo`, async () => {
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
        const srcDbPath = path.join(regularPKC.dataPath!, "subplebbits", randomSub.address);
        await fs.promises.cp(srcDbPath, path.join(tempPKC.dataPath!, "subplebbits", randomSub.address));
        await waitUntilPKCCommunitysIncludeSubAddress(tempPKC, randomSub.address);
        // Should be included in tempPKC.subplebbits now
        const subplebbit = (await tempPKC.createCommunity({ address: randomSub.address })) as LocalCommunity | RpcLocalCommunity;
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => subplebbit.updatedAt! > randomSub.updatedAt! });

        const localCommunity = subplebbit as LocalCommunity;
        const ipnsRecordOfSubInDifferentKubo = await localCommunity._dbHandler.keyvGet("LAST_IPNS_RECORD");

        expect(ipnsRecordOfSubInDifferentKubo).to.exist;

        const ipnsRecordOfSubInDifferentKuboDecoded = cborg.decode(
            new Uint8Array(Object.values(ipnsRecordOfSubInDifferentKubo as object)),
            {
                allowBigInt: true
            }
        );
        expect(ipnsRecordOfSubInDifferentKuboDecoded.sequence).to.equal(3);

        await subplebbit.stop();

        await regularPKC.destroy();
        await tempPKC.destroy();

        // const mockPost = await generateMockPost({ communityAddress: subplebbit.address, plebbit: tempPKC });
        // mockPost.once("challenge", async (challengeMsg) => {
        //     await mockPost.publishChallengeAnswers(["2"]); // hardcode answer here
        // });

        // await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

        // await subplebbit.delete();
        // await tempPKC.destroy();
        // await regularPKC.destroy();
    });
});

describeSkipIfRpc.sequential("DB Migration", () => {
    const databasesToMigrate = getDatabasesToMigrate();

    databasesToMigrate.map((databaseInfo) =>
        it(`Can migrate from DB version ${databaseInfo.version} to ${plebbitVersion.DB_VERSION} - address (${databaseInfo.address})`, async () => {
            // Once we start the sub, it's gonna attempt to migrate to the latest DB version

            const plebbit: PKCType = await mockPKC(getTemporaryPKCOptions());

            console.log(
                `We're using datapath (${plebbit.dataPath}) For testing migration from db version (${databaseInfo.version}) to ${plebbitVersion.DB_VERSION}`
            );
            await copyDbToDataPath(databaseInfo, plebbit);

            await waitUntilPKCCommunitysIncludeSubAddress(plebbit, databaseInfo.address);

            const subplebbit = (await plebbit.createCommunity({ address: databaseInfo.address })) as LocalCommunity | RpcLocalCommunity;
            expect(subplebbit.started).to.be.a("boolean"); // make sure it's creating a local sub instance
            expect(subplebbit.updatedAt).to.be.a("number"); // it should load the internal state from db
            expect(subplebbit.createdAt).to.be.a("number"); // it should load the internal state from db

            await subplebbit.start();

            await new Promise<void>((resolve) => subplebbit.once("update", () => resolve())); // Ensure IPNS is published
            await subplebbit.edit({ settings: { ...subplebbit.settings, challenges: [] } });
            const mockPost: Comment = await publishRandomPost({ communityAddress: subplebbit.address, plebbit: plebbit });

            await mockPost.update();
            await resolveWhenConditionIsTrue({ toUpdate: mockPost, predicate: async () => Boolean(mockPost.updatedAt) });
            expect(mockPost.updatedAt).to.be.a("number");
            expect(mockPost.author.subplebbit).to.be.a("object");
            await mockPost.stop();

            await subplebbit.delete();
            await plebbit.destroy();
        })
    );
});
