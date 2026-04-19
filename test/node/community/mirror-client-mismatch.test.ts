import { it, expect } from "vitest";
import { mockPKC } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

describeSkipIfRpc(`mirror() should not crash when client URLs mismatch between community instances`, () => {
    it(`updating community with different pubsubKuboRpcClientsOptions should not emit TypeError`, async () => {
        // PKC A: started community uses the default mockPKC pubsub URLs
        // (http://localhost:15002, http://localhost:42234, http://localhost:42254)
        const pkcA = await mockPKC();

        const startedCommunity = (await pkcA.createCommunity()) as LocalCommunity;
        await startedCommunity.start();

        try {
            // PKC B: uses a different pubsub URL that doesn't exist on pkcA
            const pkcB = await mockPKC({
                pubsubKuboRpcClientsOptions: ["http://localhost:15001/api/v0"]
            });

            const updatingCommunity = (await pkcB.createCommunity({ address: startedCommunity.address })) as LocalCommunity;

            // Track any errors emitted during mirroring
            const errors: Error[] = [];
            updatingCommunity.on("error", (err) => {
                errors.push(err);
            });

            await updatingCommunity.update();

            // Wait a bit for the mirror to complete and any error events to fire
            await new Promise((resolve) => setTimeout(resolve, 2000));

            // Should not have emitted a TypeError about reading 'state' of undefined
            const typeErrors = errors.filter(
                (e) => e instanceof TypeError || (e.message && e.message.includes("Cannot read properties of undefined"))
            );
            expect(typeErrors, `mirror() emitted TypeError: ${typeErrors.map((e) => e.message).join(", ")}`).to.have.lengthOf(0);

            await updatingCommunity.stop();
            await pkcB.destroy();
        } finally {
            await startedCommunity.stop();
            await pkcA.destroy();
        }
    });
});
