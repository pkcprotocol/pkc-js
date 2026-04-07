import { describe, it } from "vitest";
import { mockPKC, createSubWithNoChallenge } from "../../../dist/node/test/test-util.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

describe(`community.stop() timing`, async () => {
    it(`LocalCommunity.stop() after update() should complete within 10s`, async () => {
        const pkc: PKCType = await mockPKC();
        const sub = await createSubWithNoChallenge({}, pkc);
        await sub.update();
        const startMs = Date.now();
        await sub.stop();
        const elapsed = Date.now() - startMs;
        expect(elapsed).to.be.lessThan(10000);
        await sub.delete();
        await pkc.destroy();
    });
});
