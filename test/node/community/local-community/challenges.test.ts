// Unit tests for src/runtime/node/community/local-community/challenges.ts.
// The challenge orchestrator (handleChallengeRequest, handleChallengeAnswer,
// handleChallengeExchange, publishChallenges, publishChallengeVerification, etc.)
// owns decrypt / sign / pubsub / DB / role checks and is exercised end-to-end by
// the integration suite under test/challenges/ and test/node/community/.
// Unit tests here cover the cheap stand-alone helpers:
//   - cleanUpChallengeAnswerPromise (pure cache mutation)
//   - buildRuntimeChallengeRequestPublication / buildRuntimeChallengeRequest (pure transformations)
// and a smoke check that the orchestrator exports exist. The exchange state that handleChallengeAnswer keeps for
// an answer that fails verification is covered at the bottom, with a mock community and really signed messages.

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
import { cleanUpBeforePublishing, signChallengeAnswer } from "../../../../dist/node/signer/signatures.js";
import { encryptEd25519AesGcm } from "../../../../dist/node/signer/encryption.js";
import { getBufferedPKCAddressFromPublicKey } from "../../../../dist/node/signer/util.js";
import signers from "../../../fixtures/signers.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type {
    ChallengeAnswerMessageType,
    DecryptedChallengeRequestMessageType,
    PublicationFromDecryptedChallengeRequest
} from "../../../../dist/node/pubsub-messages/types.js";
import type { SignerType } from "../../../../dist/node/signer/types.js";

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
            signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" }
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
            comment: {
                author: { displayName: "alice" },
                signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" }
            },
            signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" }
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
            vote: {
                author: { displayName: "voter" },
                signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" }
            },
            signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" }
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

// The exchange state handleChallengeAnswer reads and writes, on a community that runs as
// signers[0]. A challengeRequestId is the address of the key that signed the request, so only the holder of
// that key can sign a valid answer or request for it. Everything else a topic peer sends with that id fails
// verification, and must not change the exchange it names.
const communitySigner = signers[0];
const publisherPubsubSigner = signers[1]; // the per-request key a publisher signs its request and answer with
const otherPeerSigner = signers[2];

type AnswerResolveReject = { resolve: (answers: string[]) => void; reject: (error: Error) => void };

const createExchangeCommunity = () => {
    const community = {
        signer: communitySigner,
        settings: {},
        _pkc: { userAgent: "test-user-agent" },
        _clientsManager: { updateKuboRpcPubsubStateIfProviderExists: vi.fn(), pubsubPublish: vi.fn(async () => undefined) },
        _ongoingChallengeExchanges: new LRUCache<string, boolean>({ max: 1000 }), // same bound as initBeforeStarting
        _challengeAnswerPromises: new LRUCache<string, Promise<string[]>>({ max: 1000 }),
        _challengeAnswerResolveReject: new LRUCache<string, AnswerResolveReject>({ max: 1000 }),
        _challengeExchangesFromLocalPublishers: {} as Record<string, boolean>,
        emit: vi.fn()
    };
    return { community, localCommunity: community as unknown as LocalCommunity };
};

// What runChallengeExchangeIfNeeded leaves behind once it published the challenge and awaits the answer
const parkExchangeAwaitingAnswer = (community: ReturnType<typeof createExchangeCommunity>["community"], challengeRequestId: string) => {
    const resolveReject = { resolve: vi.fn(), reject: vi.fn() };
    community._ongoingChallengeExchanges.set(challengeRequestId, true);
    community._challengeAnswerResolveReject.set(challengeRequestId, resolveReject);
    community._challengeAnswerPromises.set(challengeRequestId, new Promise<string[]>(() => {}));
    return resolveReject;
};

const createChallengeAnswer = async ({
    challengeRequestId,
    signer,
    challengeAnswers
}: {
    challengeRequestId: Uint8Array;
    signer: SignerType;
    challengeAnswers: string[];
}): Promise<ChallengeAnswerMessageType> => {
    const toSign: Omit<ChallengeAnswerMessageType, "signature"> = cleanUpBeforePublishing({
        type: "CHALLENGEANSWER",
        challengeRequestId,
        encrypted: await encryptEd25519AesGcm(JSON.stringify({ challengeAnswers }), signer.privateKey, communitySigner.publicKey),
        userAgent: "test-user-agent",
        protocolVersion: "1.0.0",
        timestamp: Math.round(Date.now() / 1000)
    });
    return { ...toSign, signature: await signChallengeAnswer({ challengeAnswer: toSign, signer }) };
};

describe("challenges: handleChallengeAnswer with an answer that fails verification", () => {
    const forgeries = [
        {
            name: "signed by a key the request id is not derived from",
            expectedCode: "ERR_CHALLENGE_REQUEST_ID_NOT_DERIVED_FROM_SIGNATURE",
            forge: (challengeRequestId: Uint8Array) =>
                createChallengeAnswer({ challengeRequestId, signer: otherPeerSigner, challengeAnswers: ["1"] })
        },
        {
            name: "carrying the publisher's key with a signature that does not verify",
            expectedCode: "ERR_SIGNATURE_IS_INVALID",
            forge: async (challengeRequestId: Uint8Array): Promise<ChallengeAnswerMessageType> => {
                const signed = await createChallengeAnswer({ challengeRequestId, signer: publisherPubsubSigner, challengeAnswers: ["1"] });
                return { ...signed, signature: { ...signed.signature, signature: new Uint8Array(signed.signature.signature.length) } };
            }
        }
    ];

    for (const { name, expectedCode, forge } of forgeries) {
        it(`an answer ${name} leaves the exchange intact, and the publisher's own answer still resolves it`, async () => {
            const { community, localCommunity } = createExchangeCommunity();
            const challengeRequestId = getBufferedPKCAddressFromPublicKey(publisherPubsubSigner.publicKey);
            const idString = challengeRequestId.toString();
            const answerPromise = parkExchangeAwaitingAnswer(community, idString);

            // The id is public: it is in the publisher's CHALLENGEREQUEST and the community's CHALLENGE on the topic
            await expect(handleChallengeAnswer(localCommunity, await forge(challengeRequestId))).rejects.toMatchObject({
                code: expectedCode
            });
            expect(community._ongoingChallengeExchanges.has(idString)).to.equal(true);
            expect(community._challengeAnswerResolveReject.has(idString)).to.equal(true);
            expect(community._challengeAnswerPromises.has(idString)).to.equal(true);

            const realAnswer = await createChallengeAnswer({ challengeRequestId, signer: publisherPubsubSigner, challengeAnswers: ["2"] });
            await handleChallengeAnswer(localCommunity, realAnswer);

            expect(answerPromise.resolve).toHaveBeenCalledWith(["2"]);
            // No ERR_CHALLENGE_ANSWER_WITH_NO_CHALLENGE_REQUEST verification for the real answer
            expect(community.emit.mock.calls.map(([eventName]) => eventName)).to.deep.equal(["challengeanswer"]);
        });
    }
});
