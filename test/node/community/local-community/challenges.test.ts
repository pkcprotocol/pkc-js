// Unit tests for src/runtime/node/community/local-community/challenges.ts.
// The challenge orchestrator (handleChallengeRequest, handleChallengeAnswer,
// handleChallengeExchange, publishChallenges, publishChallengeVerification, etc.)
// owns decrypt / sign / pubsub / DB / role checks and is exercised end-to-end by
// the integration suite under test/challenges/ and test/node/community/.
// Unit tests here cover the cheap stand-alone helpers:
//   - cleanUpChallengeAnswerPromise (pure cache mutation)
//   - buildRuntimeChallengeRequestPublication / buildRuntimeChallengeRequest (pure transformations)
// and a smoke check that the orchestrator exports exist.

import { describe, it, expect, vi } from "vitest";
import { LRUCache } from "lru-cache";
import {
    buildRuntimeChallengeRequest,
    buildRuntimeChallengeRequestPublication,
    cleanUpChallengeAnswerPromise,
    decryptOrRespondWithFailure,
    handleChallengeAnswer,
    handleChallengeExchange,
    handleChallengeRequest,
    parseChallengeAnswerOrRespondWithFailure,
    parseChallengeRequestPublicationOrRespondWithFailure,
    publishChallengeVerification,
    publishChallenges,
    publishFailedChallengeVerification,
    publishIdempotentDuplicateVerification,
    storePublicationAndEncryptForChallengeVerification
} from "../../../../dist/node/runtime/node/community/local-community/challenges.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type {
    DecryptedChallengeRequestMessageType,
    PublicationFromDecryptedChallengeRequest
} from "../../../../dist/node/pubsub-messages/types.js";

describe("challenges: export shape", () => {
    it("exports all challenge helpers", () => {
        expect(typeof buildRuntimeChallengeRequest).to.equal("function");
        expect(typeof buildRuntimeChallengeRequestPublication).to.equal("function");
        expect(typeof cleanUpChallengeAnswerPromise).to.equal("function");
        expect(typeof decryptOrRespondWithFailure).to.equal("function");
        expect(typeof handleChallengeAnswer).to.equal("function");
        expect(typeof handleChallengeExchange).to.equal("function");
        expect(typeof handleChallengeRequest).to.equal("function");
        expect(typeof parseChallengeAnswerOrRespondWithFailure).to.equal("function");
        expect(typeof parseChallengeRequestPublicationOrRespondWithFailure).to.equal("function");
        expect(typeof publishChallengeVerification).to.equal("function");
        expect(typeof publishChallenges).to.equal("function");
        expect(typeof publishFailedChallengeVerification).to.equal("function");
        expect(typeof publishIdempotentDuplicateVerification).to.equal("function");
        expect(typeof storePublicationAndEncryptForChallengeVerification).to.equal("function");
    });
});

describe("challenges: cleanUpChallengeAnswerPromise", () => {
    it("removes the entry from all three challenge-answer caches", () => {
        const id = "challenge-id-123";
        const promiseCache = new LRUCache<string, Promise<unknown>>({ max: 10 });
        const resolveRejectCache = new LRUCache<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>({ max: 10 });
        promiseCache.set(id, Promise.resolve());
        resolveRejectCache.set(id, { resolve: vi.fn(), reject: vi.fn() });
        const exchangesFromLocalPublishers: Record<string, boolean> = { [id]: true };

        const community = {
            _challengeAnswerPromises: promiseCache,
            _challengeAnswerResolveReject: resolveRejectCache,
            _challengeExchangesFromLocalPublishers: exchangesFromLocalPublishers
        } as unknown as LocalCommunity;

        cleanUpChallengeAnswerPromise(community, id);

        expect(promiseCache.has(id)).to.equal(false);
        expect(resolveRejectCache.has(id)).to.equal(false);
        expect(id in exchangesFromLocalPublishers).to.equal(false);
    });

    it("is a no-op when the id is not in any cache", () => {
        const promiseCache = new LRUCache<string, Promise<unknown>>({ max: 10 });
        const resolveRejectCache = new LRUCache<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>({ max: 10 });
        const exchangesFromLocalPublishers: Record<string, boolean> = {};

        const community = {
            _challengeAnswerPromises: promiseCache,
            _challengeAnswerResolveReject: resolveRejectCache,
            _challengeExchangesFromLocalPublishers: exchangesFromLocalPublishers
        } as unknown as LocalCommunity;

        // Should not throw.
        cleanUpChallengeAnswerPromise(community, "never-set");
        expect(promiseCache.size).to.equal(0);
    });
});

describe("challenges: buildRuntimeChallengeRequestPublication", () => {
    it("attaches an author.community block to the publication via buildRuntimeAuthor", () => {
        const publication = {
            author: { displayName: "alice" },
            signature: { publicKey: "pubKey" }
        } as unknown as PublicationFromDecryptedChallengeRequest;
        const authorCommunity = { postScore: 10, replyScore: 5, firstCommentTimestamp: 1, lastCommentCid: "QmL" };

        const result = buildRuntimeChallengeRequestPublication({ publication, authorCommunity });

        // The output carries the original publication fields plus a derived author with community attached.
        expect(result.signature).to.deep.equal(publication.signature);
        expect(result.author).to.not.equal(undefined);
        expect(result.author?.community).to.deep.equal(authorCommunity);
    });
});

describe("challenges: buildRuntimeChallengeRequest", () => {
    it("clones the request and attaches author.community to whatever publication is present", () => {
        const request = {
            challengeRequestId: new Uint8Array([1, 2, 3]),
            comment: { author: { displayName: "alice" }, signature: { publicKey: "p1" } },
            signature: { publicKey: "p1" }
        } as unknown as DecryptedChallengeRequestMessageType;
        const authorCommunity = { postScore: 1, replyScore: 1, firstCommentTimestamp: 1, lastCommentCid: "QmFoo" };

        const runtime = buildRuntimeChallengeRequest({ request, authorCommunity });

        expect(runtime.comment?.author?.community).to.deep.equal(authorCommunity);
        // Did not mutate the original request.
        expect(request.comment?.author).to.not.have.property("community");
    });

    it("does not attach community to publications that aren't on the request", () => {
        const request = {
            challengeRequestId: new Uint8Array([1, 2, 3]),
            vote: { author: { displayName: "voter" }, signature: { publicKey: "p2" } },
            signature: { publicKey: "p2" }
        } as unknown as DecryptedChallengeRequestMessageType;
        const authorCommunity = { postScore: 1, replyScore: 1, firstCommentTimestamp: 1, lastCommentCid: "QmFoo" };

        const runtime = buildRuntimeChallengeRequest({ request, authorCommunity });

        expect(runtime.vote).to.not.equal(undefined);
        expect(runtime.comment).to.equal(undefined);
        expect(runtime.commentEdit).to.equal(undefined);
        expect(runtime.commentModeration).to.equal(undefined);
        expect(runtime.communityEdit).to.equal(undefined);
    });
});
