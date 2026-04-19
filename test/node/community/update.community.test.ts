import lockfile from "@pkcprotocol/proper-lock-file";
import path from "path";
import { createSubWithNoChallenge, mockPKC, publishRandomPost, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { itSkipIfRpc } from "../../helpers/conditional-tests.js";
import { describe, beforeAll, afterAll, it } from "vitest";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";

describe.concurrent(`community.update - Local subs`, async () => {
    let pkc: PKCType;
    beforeAll(async () => {
        pkc = await mockPKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`Can receive updates from local community`, async () => {
        const community = await createSubWithNoChallenge({}, pkc);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        const recreatedCommunity = await pkc.createCommunity({ address: community.address });
        expect(recreatedCommunity.state).to.equal("stopped");
        expect(recreatedCommunity.started).to.be.a("boolean"); // make sure it's creating a local community, not remote

        const oldUpdatedAt = JSON.parse(JSON.stringify(recreatedCommunity.updatedAt)) as number;
        await recreatedCommunity.update();
        await publishRandomPost({ communityAddress: recreatedCommunity.address, pkc: pkc });
        await resolveWhenConditionIsTrue({
            toUpdate: recreatedCommunity,
            predicate: async () => recreatedCommunity.updatedAt !== oldUpdatedAt
        });
        expect(recreatedCommunity.updatedAt).to.be.greaterThan(oldUpdatedAt);
        await recreatedCommunity.stop();
        await community.delete();
    });

    it(`A local community is not emitting updates unneccessarily (after first update)`, async () => {
        const community = await createSubWithNoChallenge({}, pkc);
        expect(community.started).to.be.a("boolean"); // make sure it's creating a local community, not remote
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        const recreatedCommunity = await pkc.createCommunity({ address: community.address });
        const oldUpdatedAt = JSON.parse(JSON.stringify(recreatedCommunity.updatedAt)) as number;
        expect(oldUpdatedAt).to.be.a("number");
        expect(oldUpdatedAt).to.equal(community.updatedAt);

        await recreatedCommunity.update();
        let updatesEmitted = 0;

        const failPromise = new Promise<void>((resolve, reject) =>
            recreatedCommunity.on("update", () => {
                updatesEmitted++;
                if (recreatedCommunity.updatedAt === oldUpdatedAt && updatesEmitted > 1)
                    reject(new Error("It should not emit an update if there's no new info"));
            })
        );

        try {
            await Promise.race([failPromise, new Promise<void>((resolve) => setTimeout(resolve, pkc.publishInterval * 3))]);
        } catch (e) {
            throw e;
        } finally {
            await community.delete();
            await recreatedCommunity.stop();
        }
    });

    it(`A local community is not emitted updates unnecessarily (before first update)`, async () => {
        const community = await createSubWithNoChallenge({}, pkc);
        expect(community.started).to.be.a("boolean"); // make sure it's creating a local community, not remote

        let emittedUpdates = 0;
        community.on("update", () => emittedUpdates++);

        await community.update();

        await new Promise<void>((resolve) => setTimeout(resolve, pkc.publishInterval * 3));

        expect(emittedUpdates).to.equal(0);

        await community.delete();
    });

    itSkipIfRpc(`Local community should update properly even when another process holds the start lock`, async () => {
        const community = await createSubWithNoChallenge({}, pkc);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        await community.stop();

        const communityDbPath = path.join(pkc.dataPath!, "communities", community.address);
        const lockfilePath = `${communityDbPath}.start.lock`;

        const releaseLock = await lockfile.lock(communityDbPath, {
            lockfilePath,
            retries: 0,
            onCompromised: () => {}
        });

        const secondPKC = await mockPKC({ dataPath: pkc.dataPath! });

        try {
            const recreatedCommunity = await secondPKC.createCommunity({ address: community.address });
            expect(recreatedCommunity.updatedAt).to.be.a("number");
        } catch (e) {
            throw e;
        } finally {
            await releaseLock();
            await secondPKC.destroy();
        }
    });
});
