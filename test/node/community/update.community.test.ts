import lockfile from "@pkc/proper-lock-file";
import path from "path";
import {
    createSubWithNoChallenge,
    itSkipIfRpc,
    mockPKC,
    publishRandomPost,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
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

    it(`Can receive updates from local sub`, async () => {
        const sub = await createSubWithNoChallenge({}, pkc);
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        const recreatedSub = await pkc.createCommunity({ address: sub.address });
        expect(recreatedSub.state).to.equal("stopped");
        expect(recreatedSub.started).to.be.a("boolean"); // make sure it's creating a local sub, not remote

        const oldUpdatedAt = JSON.parse(JSON.stringify(recreatedSub.updatedAt)) as number;
        await recreatedSub.update();
        await publishRandomPost({ communityAddress: recreatedSub.address, pkc: pkc });
        await resolveWhenConditionIsTrue({ toUpdate: recreatedSub, predicate: async () => recreatedSub.updatedAt !== oldUpdatedAt });
        expect(recreatedSub.updatedAt).to.be.greaterThan(oldUpdatedAt);
        await recreatedSub.stop();
        await sub.delete();
    });

    it(`A local community is not emitting updates unneccessarily (after first update)`, async () => {
        const sub = await createSubWithNoChallenge({}, pkc);
        expect(sub.started).to.be.a("boolean"); // make sure it's creating a local sub, not remote
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });

        const recreatedSub = await pkc.createCommunity({ address: sub.address });
        const oldUpdatedAt = JSON.parse(JSON.stringify(recreatedSub.updatedAt)) as number;
        expect(oldUpdatedAt).to.be.a("number");
        expect(oldUpdatedAt).to.equal(sub.updatedAt);

        await recreatedSub.update();
        let updatesEmitted = 0;

        const failPromise = new Promise<void>((resolve, reject) =>
            recreatedSub.on("update", () => {
                updatesEmitted++;
                if (recreatedSub.updatedAt === oldUpdatedAt && updatesEmitted > 1)
                    reject(new Error("It should not emit an update if there's no new info"));
            })
        );

        try {
            await Promise.race([failPromise, new Promise<void>((resolve) => setTimeout(resolve, pkc.publishInterval * 3))]);
        } catch (e) {
            throw e;
        } finally {
            await sub.delete();
            await recreatedSub.stop();
        }
    });

    it(`A local community is not emitted updates unnecessarily (before first update)`, async () => {
        const sub = await createSubWithNoChallenge({}, pkc);
        expect(sub.started).to.be.a("boolean"); // make sure it's creating a local sub, not remote

        let emittedUpdates = 0;
        sub.on("update", () => emittedUpdates++);

        await sub.update();

        await new Promise<void>((resolve) => setTimeout(resolve, pkc.publishInterval * 3));

        expect(emittedUpdates).to.equal(0);

        await sub.delete();
    });

    itSkipIfRpc(`Local community should update properly even when another process holds the start lock`, async () => {
        const sub = await createSubWithNoChallenge({}, pkc);
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        await sub.stop();

        const subDbPath = path.join(pkc.dataPath!, "communities", sub.address);
        const lockfilePath = `${subDbPath}.start.lock`;

        const releaseLock = await lockfile.lock(subDbPath, {
            lockfilePath,
            retries: 0,
            onCompromised: () => {}
        });

        const secondPKC = await mockPKC({ dataPath: pkc.dataPath! });

        try {
            const recreatedSub = await secondPKC.createCommunity({ address: sub.address });
            expect(recreatedSub.updatedAt).to.be.a("number");
        } catch (e) {
            throw e;
        } finally {
            await releaseLock();
            await secondPKC.destroy();
        }
    });
});
