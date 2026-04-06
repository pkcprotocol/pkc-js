import { describe, it } from "vitest";
import { mockPlebbit, createSubWithNoChallenge } from "../../../dist/node/test/test-util.js";

import type { Plebbit as PlebbitType } from "../../../dist/node/pkc/pkc.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/community/local-community.js";

describe(`subplebbit.stop() timing`, async () => {
    it(`LocalSubplebbit.stop() after update() should complete within 10s`, async () => {
        const plebbit: PlebbitType = await mockPlebbit();
        const sub = await createSubWithNoChallenge({}, plebbit);
        await sub.update();
        const startMs = Date.now();
        await sub.stop();
        const elapsed = Date.now() - startMs;
        expect(elapsed).to.be.lessThan(10000);
        await sub.delete();
        await plebbit.destroy();
    });
});
