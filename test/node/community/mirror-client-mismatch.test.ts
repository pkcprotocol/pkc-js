import { it, expect } from "vitest";
import { mockPlebbit, describeSkipIfRpc } from "../../../dist/node/test/test-util.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/community/local-community.js";

describeSkipIfRpc(`mirror() should not crash when client URLs mismatch between subplebbit instances`, () => {
    it(`updating sub with different pubsubKuboRpcClientsOptions should not emit TypeError`, async () => {
        // Plebbit A: started sub uses the default mockPlebbit pubsub URLs
        // (http://localhost:15002, http://localhost:42234, http://localhost:42254)
        const plebbitA = await mockPlebbit();

        const startedSub = (await plebbitA.createSubplebbit()) as LocalSubplebbit;
        await startedSub.start();

        try {
            // Plebbit B: uses a different pubsub URL that doesn't exist on plebbitA
            const plebbitB = await mockPlebbit({
                pubsubKuboRpcClientsOptions: ["http://localhost:15001/api/v0"]
            });

            const updatingSub = (await plebbitB.createSubplebbit({ address: startedSub.address })) as LocalSubplebbit;

            // Track any errors emitted during mirroring
            const errors: Error[] = [];
            updatingSub.on("error", (err) => {
                errors.push(err);
            });

            await updatingSub.update();

            // Wait a bit for the mirror to complete and any error events to fire
            await new Promise((resolve) => setTimeout(resolve, 2000));

            // Should not have emitted a TypeError about reading 'state' of undefined
            const typeErrors = errors.filter(
                (e) => e instanceof TypeError || (e.message && e.message.includes("Cannot read properties of undefined"))
            );
            expect(typeErrors, `mirror() emitted TypeError: ${typeErrors.map((e) => e.message).join(", ")}`).to.have.lengthOf(0);

            await updatingSub.stop();
            await plebbitB.destroy();
        } finally {
            await startedSub.stop();
            await plebbitA.destroy();
        }
    });
});
