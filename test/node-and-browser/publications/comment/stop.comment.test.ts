import signers from "../../../fixtures/signers.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import {
    publishRandomPost,
    resolveWhenConditionIsTrue,
    getAvailablePlebbitConfigsToTestAgainst
} from "../../../../dist/node/test/test-util.js";

import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";

const subplebbitAddress = signers[0].address;

getAvailablePlebbitConfigsToTestAgainst().map((config) =>
    describe(`comment.stop() timing - ${config.name}`, async () => {
        let plebbit: Plebbit;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`comment.stop() after update() should complete within 10s`, async () => {
            const post = await publishRandomPost({ subplebbitAddress: subplebbitAddress, plebbit: plebbit });

            const recreatedPost = await plebbit.createComment({ cid: post.cid });
            await recreatedPost.update();
            await resolveWhenConditionIsTrue({
                toUpdate: recreatedPost,
                predicate: async () => typeof recreatedPost.updatedAt === "number"
            });
            const startMs = Date.now();
            await recreatedPost.stop();
            const elapsed = Date.now() - startMs;
            expect(elapsed).to.be.lessThan(10000);
        });
    })
);
