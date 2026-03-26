import { beforeAll, afterAll } from "vitest";
import signers from "../../fixtures/signers.js";

import path from "path";
import fs from "fs";
import tempy from "tempy";
import {
    mockPlebbit,
    generateMockPost,
    publishWithExpectedResult,
    describeSkipIfRpc,
    waitUntilPlebbitSubplebbitsIncludeSubAddress,
    publishRandomPost,
    createSubWithNoChallenge,
    resolveWhenConditionIsTrue,
    waitTillPostInSubplebbitInstancePages
} from "../../../dist/node/test/test-util.js";
import * as cborg from "cborg";

import plebbitVersion from "../../../dist/node/version.js";

import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";

import type { InputPlebbitOptions } from "../../../dist/node/types.js";

interface DatabaseToMigrate {
    version: number;
    path: string;
    address: string;
}

const getTemporaryPlebbitOptions = (): InputPlebbitOptions => {
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

const generateRandomSub = async (): Promise<LocalSubplebbit | RpcLocalSubplebbit> => {
    const plebbit: PlebbitType = await mockPlebbit();
    const sub = await createSubWithNoChallenge({}, plebbit);
    await sub.start();
    await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => Boolean(sub.updatedAt) });

    const post: Comment = await publishRandomPost({ communityAddress: sub.address, plebbit: plebbit });
    await waitTillPostInSubplebbitInstancePages(post as Comment & { cid: string }, sub);

    await sub.stop();
    await plebbit.destroy();

    return sub;
};

const copyDbToDataPath = async (databaseObj: { path: string; address: string }, plebbit: PlebbitType): Promise<void> => {
    const newPath = path.join(plebbit.dataPath!, "subplebbits", databaseObj.address);
    await fs.promises.cp(databaseObj.path, newPath);
};

describeSkipIfRpc.sequential(`DB importing`, async () => {
    let plebbit: PlebbitType;

    beforeAll(async () => {
        plebbit = await mockPlebbit(getTemporaryPlebbitOptions());
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`Subplebbit will show up in plebbit.subplebbits if its db was copied to datapath/subplebbits`, async () => {
        expect(plebbit.subplebbits).to.not.include(signers[0].address);

        const regularPlebbit: PlebbitType = await mockPlebbit();
        const databaseToMigrate = {
            address: signers[0].address,
            path: path.join(regularPlebbit.dataPath!, "subplebbits", signers[0].address)
        };
        await copyDbToDataPath(databaseToMigrate, plebbit);
        await waitUntilPlebbitSubplebbitsIncludeSubAddress(plebbit, databaseToMigrate.address);
        expect(plebbit.subplebbits).to.include(databaseToMigrate.address);
        await regularPlebbit.destroy();
    });

    it(`Can import a subplebbit by copying its sql file to datapath/subplebbits`, async () => {
        const regularPlebbit: PlebbitType = await mockPlebbit();
        const randomSub = await generateRandomSub();
        const tempPlebbit: PlebbitType = await mockPlebbit(getTemporaryPlebbitOptions());
        const srcDbPath = path.join(regularPlebbit.dataPath!, "subplebbits", randomSub.address);
        await fs.promises.cp(srcDbPath, path.join(tempPlebbit.dataPath!, "subplebbits", randomSub.address));
        await waitUntilPlebbitSubplebbitsIncludeSubAddress(tempPlebbit, randomSub.address);
        // Should be included in tempPlebbit.subplebbits now
        const subplebbit = (await tempPlebbit.createSubplebbit({ address: randomSub.address })) as LocalSubplebbit | RpcLocalSubplebbit;
        await subplebbit.edit({
            settings: { ...subplebbit.settings, challenges: [{ name: "question", options: { question: "1+1=?", answer: "2" } }] }
        }); // We want this sub to have a full challenge exchange to test all db tables
        expect(subplebbit.updatedAt).to.be.a("number"); // Should be fetched from db

        await subplebbit.start();
        await new Promise<void>((resolve) => subplebbit.once("update", () => resolve()));
        const localSub = subplebbit as LocalSubplebbit;
        const currentDbVersion = await localSub._dbHandler.getDbVersion();
        expect(currentDbVersion).to.equal(plebbitVersion.DB_VERSION);

        const mockPost: Comment = await generateMockPost({ communityAddress: subplebbit.address, plebbit: tempPlebbit });
        mockPost.once("challenge", async () => {
            await mockPost.publishChallengeAnswers(["2"]); // hardcode answer here
        });

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

        await subplebbit.delete();
        await tempPlebbit.destroy();
        await regularPlebbit.destroy();
    });

    // skip until kubo fixes the bug
    it.skip(`A subplebbit IPNS' sequence number is up to date even after migrating to new ipfs repo`, async () => {
        const regularPlebbit: PlebbitType = await mockPlebbit();
        const randomSub = await generateRandomSub();
        await randomSub.start();
        await resolveWhenConditionIsTrue({ toUpdate: randomSub, predicate: async () => Boolean(randomSub.updatedAt) });

        const localRandomSub = randomSub as LocalSubplebbit;
        const ipnsRecord = await localRandomSub._dbHandler.keyvGet("LAST_IPNS_RECORD");

        expect(ipnsRecord).to.exist;

        const ipnsRecordDecoded = cborg.decode(new Uint8Array(Object.values(ipnsRecord as object)), { allowBigInt: true });
        expect(ipnsRecordDecoded.sequence).to.equal(1);

        await randomSub.stop();
        const tempPlebbit: PlebbitType = await mockPlebbit(getTemporaryPlebbitOptions()); // different kubo, should use sequence in keyv
        const srcDbPath = path.join(regularPlebbit.dataPath!, "subplebbits", randomSub.address);
        await fs.promises.cp(srcDbPath, path.join(tempPlebbit.dataPath!, "subplebbits", randomSub.address));
        await waitUntilPlebbitSubplebbitsIncludeSubAddress(tempPlebbit, randomSub.address);
        // Should be included in tempPlebbit.subplebbits now
        const subplebbit = (await tempPlebbit.createSubplebbit({ address: randomSub.address })) as LocalSubplebbit | RpcLocalSubplebbit;
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => subplebbit.updatedAt! > randomSub.updatedAt! });

        const localSubplebbit = subplebbit as LocalSubplebbit;
        const ipnsRecordOfSubInDifferentKubo = await localSubplebbit._dbHandler.keyvGet("LAST_IPNS_RECORD");

        expect(ipnsRecordOfSubInDifferentKubo).to.exist;

        const ipnsRecordOfSubInDifferentKuboDecoded = cborg.decode(
            new Uint8Array(Object.values(ipnsRecordOfSubInDifferentKubo as object)),
            {
                allowBigInt: true
            }
        );
        expect(ipnsRecordOfSubInDifferentKuboDecoded.sequence).to.equal(3);

        await subplebbit.stop();

        await regularPlebbit.destroy();
        await tempPlebbit.destroy();

        // const mockPost = await generateMockPost({ communityAddress: subplebbit.address, plebbit: tempPlebbit });
        // mockPost.once("challenge", async (challengeMsg) => {
        //     await mockPost.publishChallengeAnswers(["2"]); // hardcode answer here
        // });

        // await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

        // await subplebbit.delete();
        // await tempPlebbit.destroy();
        // await regularPlebbit.destroy();
    });
});

describeSkipIfRpc.sequential("DB Migration", () => {
    const databasesToMigrate = getDatabasesToMigrate();

    databasesToMigrate.map((databaseInfo) =>
        it(`Can migrate from DB version ${databaseInfo.version} to ${plebbitVersion.DB_VERSION} - address (${databaseInfo.address})`, async () => {
            // Once we start the sub, it's gonna attempt to migrate to the latest DB version

            const plebbit: PlebbitType = await mockPlebbit(getTemporaryPlebbitOptions());

            console.log(
                `We're using datapath (${plebbit.dataPath}) For testing migration from db version (${databaseInfo.version}) to ${plebbitVersion.DB_VERSION}`
            );
            await copyDbToDataPath(databaseInfo, plebbit);

            await waitUntilPlebbitSubplebbitsIncludeSubAddress(plebbit, databaseInfo.address);

            const subplebbit = (await plebbit.createSubplebbit({ address: databaseInfo.address })) as LocalSubplebbit | RpcLocalSubplebbit;
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
