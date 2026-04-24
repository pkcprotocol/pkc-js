import { afterAll, beforeAll, beforeEach, expect, it, describe } from "vitest";
import { getAvailablePKCConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";
import { itSkipIfRpc } from "../../helpers/conditional-tests.js";
import signers from "../../fixtures/signers.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";

const communityAddress = signers[0].address;

// Format-valid but never-published CID — getPage against it will hang until page-ipfs timeout,
// giving tests a deterministic window in which to fire abort and observe cancellation.
async function makeUnreachableCid(): Promise<string> {
    const unique = `abort-test-${Math.random()}-${Date.now()}`;
    return await calculateIpfsHash(unique);
}

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`getPage abortSignal - ${config.name}`, () => {
        let pkc: PKC;
        let mockCommunity: RemoteCommunity;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            if (!pkc.destroyed) await pkc.destroy();
        });

        beforeEach(async () => {
            mockCommunity = await pkc.createCommunity({ address: communityAddress });
        });

        it("rejects synchronously when called with an already-aborted signal (no network call)", async () => {
            const unreachableCid = await makeUnreachableCid();
            mockCommunity.posts.pageCids = { ...mockCommunity.posts.pageCids, hot: unreachableCid };

            const abortController = new AbortController();
            abortController.abort();

            const before = Date.now();
            await expect(mockCommunity.posts.getPage({ cid: unreachableCid, abortSignal: abortController.signal })).rejects.toSatisfy(
                (err: Error) => err.name === "AbortError"
            );
            const elapsed = Date.now() - before;
            // Synchronous short-circuit should reject well before any network timeout kicks in.
            expect(elapsed).to.be.lessThan(1000);
        });

        // v1 does not plumb abortSignal into the rpc-websockets call(), so a mid-flight user abort
        // would not actually cancel the underlying RPC request — skip under RPC.
        itSkipIfRpc("rejects in-flight getPage when the user signal aborts", async () => {
            const unreachableCid = await makeUnreachableCid();
            mockCommunity.posts.pageCids = { ...mockCommunity.posts.pageCids, hot: unreachableCid };

            const abortController = new AbortController();
            const pagePromise = mockCommunity.posts.getPage({ cid: unreachableCid, abortSignal: abortController.signal });

            setTimeout(() => abortController.abort(), 150);

            await expect(pagePromise).rejects.toSatisfy((err: Error) => err.name === "AbortError");
        });

        // v1 does not plumb the pkc destroy signal into in-flight RPC getPage, so destroy() waits for
        // the WebSocket to close before the call settles — can exceed the 10s budget used here. Skip under RPC.
        itSkipIfRpc("pkc.destroy() rejects in-flight getPage and resolves quickly", async () => {
            // Use a dedicated PKC instance so destroy doesn't tear down the shared one used by other tests.
            const isolatedPkc = await config.pkcInstancePromise();
            const community = await isolatedPkc.createCommunity({ address: communityAddress });
            const unreachableCid = await makeUnreachableCid();
            community.posts.pageCids = { ...community.posts.pageCids, hot: unreachableCid };

            const pagePromise = community.posts.getPage({ cid: unreachableCid });
            const rejectionPromise = pagePromise.catch((err) => err);

            // Give the fetch a moment to kick off before destroying.
            await new Promise((resolve) => setTimeout(resolve, 100));

            const destroyStart = Date.now();
            await isolatedPkc.destroy();
            const destroyElapsed = Date.now() - destroyStart;

            // destroy() must resolve quickly — the gateway/P2P timeout is 30s; destroy should finish in seconds.
            expect(destroyElapsed).to.be.lessThan(10_000);

            const rejection = await rejectionPromise;
            expect(rejection).to.be.instanceOf(Error);
            // The destroy abort reason is a PKCError with code ERR_PKC_IS_DESTROYED; it may be wrapped
            // by the gateway/P2P error envelope, so check both the top-level code and the serialized form.
            expect(rejection.code === "ERR_PKC_IS_DESTROYED" || JSON.stringify(rejection).includes("ERR_PKC_IS_DESTROYED")).to.equal(true);
        });
    });
});
