// Leak suite (#496): pkc.destroy() must still release the helia node when one stop() rejects.
import { it, expect } from "vitest";
import {
    mockPKCWithHeliaConfig,
    publishStaticCommunityWithPostInPages,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { listUpdatingComments } from "../../../dist/node/pkc/tracked-instance-registry-util.js";

// it.fails: this is a known leak with no fix yet (#516). The body asserts the clean behaviour, so the test
// starts failing once the leak is fixed: remove the .fails then.

it.fails("libp2p-js: destroy() with a comment whose stop() rejects still stops the helia node", async () => {
    const fixture = await publishStaticCommunityWithPostInPages();
    const pkc = await mockPKCWithHeliaConfig({ forceMockPubsub: false });
    const client = Object.values(pkc.clients.libp2pJsClients)[0];
    const helia = client._helia;
    try {
        const comment = await pkc.createComment({ cid: fixture.commentCid });
        await comment.update();
        await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });
        const updating = listUpdatingComments(pkc);
        expect(updating.length).toBeGreaterThan(0);
        const originalStop = updating[0].stop.bind(updating[0]);
        updating[0].stop = async () => {
            await originalStop(); // the real cleanup runs; only the outcome is a rejection
            throw new Error("stop failed");
        };

        const firstDestroy = await pkc.destroy().then(
            () => "resolved",
            () => "rejected"
        );
        const secondDestroy = await pkc.destroy().then(
            () => "resolved",
            () => "rejected"
        );
        expect({ heliaStatusAfterDestroy: helia.libp2p.status, usesLeft: client.countOfUsesOfInstance }).toEqual({
            heliaStatusAfterDestroy: "stopped",
            usesLeft: 0
        });
    } finally {
        if (helia.libp2p.status !== "stopped") await client.heliaWithKuboRpcClientFunctions.stop();
        await fixture.ipnsObj.pkc.destroy();
    }
});
