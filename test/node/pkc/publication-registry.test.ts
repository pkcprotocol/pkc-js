import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mockPKC, generateMockPost, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import { itSkipIfRpc } from "../../helpers/conditional-tests.js";

// Node-only: starts a LocalCommunity, which is not available in the browser bundle.
//
// publish() registers the publication in pkc._publishingPublications before its first await so
// that pkc.destroy() can stop it (issue #270). These tests pin the two edges of that registry:
// a publication that never gets off the ground must not stay registered for the lifetime of the
// PKC, and stop() must drain the background community refresh even when cleanup fails.
describe("publication registry (pkc._publishingPublications) lifecycle", () => {
    let pkc: PKCType;
    let community: LocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = (await pkc.createCommunity()) as LocalCommunity;
        // A question challenge parks the publication in waiting-challenge-answers until we answer,
        // which is never. That is what keeps a publication in flight for the stop() test below.
        await community.edit({ settings: { challenges: [{ name: "question", options: { question: "1+1=?", answer: "2" } }] } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    });

    afterAll(async () => {
        if (!pkc.destroyed) await pkc.destroy();
    });

    it("a publication whose pre-flight fails does not stay registered", async () => {
        const post = await generateMockPost({ communityAddress: community.address, pkc });
        post.on("error", () => {});

        // _initCommunity() runs before any challenge exchange exists, so its rejection never
        // reaches _postSucessOrFailurePublishing() -- the funnel that unregisters.
        const fetchError = new Error("mocked community fetch failure");
        vi.spyOn(post, "_fetchCommunityForPublishing").mockRejectedValue(fetchError);

        await expect(post.publish()).rejects.toThrow(fetchError);

        expect(post.publishingState).to.equal("failed");
        // Unregistration is deferred until any in-flight stale-cache refresh settles, so poll
        // rather than assert synchronously.
        await vi.waitFor(() => expect(pkc._publishingPublications.has(post)).toBe(false), { timeout: 30000, interval: 100 });
    });

    // Under RPC the cleanup funnel takes the _rpcPublishSubscriptionId branch, which try/catches
    // its own unsubscribe, so there is no way to make cleanup reject and the premise does not hold.
    itSkipIfRpc("stop() drains the background community refresh even when cleanup rejects", async () => {
        const post = await generateMockPost({ communityAddress: community.address, pkc });
        post.on("error", () => {});

        const receivedChallenge = new Promise<void>((resolve) => post.once("challenge", () => resolve()));
        // Deliberately not awaited: publish() does not resolve until the exchange completes, and we
        // never answer the challenge.
        post.publish().catch(() => {});
        await receivedChallenge;

        const unsubscribeError = new Error("mocked pubsub unsubscribe failure");
        const unsubscribeSpy = vi.spyOn(post._clientsManager, "pubsubUnsubscribe").mockRejectedValue(unsubscribeError);

        // The real refresh fired at the start of publish has already settled by now, so stand in a
        // controlled one to observe whether stop() waits for it.
        let drained = false;
        post._backgroundCommunityRefresh = new Promise<void>((resolve) =>
            setTimeout(() => {
                drained = true;
                resolve();
            }, 500)
        );

        try {
            await expect(post.stop()).rejects.toThrow(unsubscribeError);

            expect(drained).to.be.true;
            expect(post.publishingState).to.equal("stopped");
        } finally {
            unsubscribeSpy.mockRestore();
        }
    });
});
