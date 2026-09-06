// Regression for issue #228: two overlapping challenge requests for one signed publication.
//
// A publisher can send the same signed comment under two different challengeRequestIds while a
// slow automatic challenge (e.g. AI moderation slower than the client's 10s provider-switch
// threshold) is still running for the first one. Both requests pass the pre-challenge duplicate
// check because neither has been stored yet. The first to finish stores the comment; the second
// then hits the duplicate check at the storage boundary, and the community turned that into a
// `challengeSuccess: false` / ERR_DUPLICATE_COMMENT verification for a comment that is already
// accepted. Expected: exactly one row, and both exchanges resolve successfully with that row's cid.
//
// The second request must also not run the challenge again: the challenge is the expensive part
// (an AI moderation call in the reported incidents), and one signed publication needs one verdict.
//
// The race is reproduced deterministically with an in-process challenge that parks the first
// request until the community has received the second one, so the second request arrives while
// the first is still in flight and before any row exists.

import {
    mockPKC,
    generateMockPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    selfResolvingMockNameForAddress
} from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { messages } from "../../../../dist/node/errors.js";
import { it, beforeAll, afterAll, beforeEach, expect, vi } from "vitest";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { CommunityFeatures } from "../../../../dist/node/community/types.js";
import type { ChallengeFileInput, ChallengeResultInput, CommunityChallengeSetting } from "../../../../dist/node/community/types.js";
import type {
    DecryptedChallengeMessageType,
    DecryptedChallengeVerificationMessageType
} from "../../../../dist/node/pubsub-messages/types.js";

type ChallengeGate = {
    calls: number;
    waitForRelease: Promise<void>;
    release: () => void;
    // Verdicts handed out per getChallenge call, in order; a call past the end succeeds.
    verdicts: ChallengeResultInput[];
};

const makeGate = (): ChallengeGate => {
    let release!: () => void;
    const waitForRelease = new Promise<void>((resolve) => (release = resolve));
    return { calls: 0, waitForRelease, release, verdicts: [] };
};

const clonePublication = <T>(value: T): T => JSON.parse(JSON.stringify(value));

// The community's "challengerequest" event fires before the challenge runs, so event-driven waits
// cannot observe the challenge being entered. Poll instead; without an explicit deadline the
// vitest timeout bounds a hang.
const waitFor = async (predicate: () => boolean, deadline?: { timeoutMs: number; message: string }): Promise<void> => {
    const startedAt = Date.now();
    while (!predicate()) {
        if (deadline && Date.now() - startedAt > deadline.timeoutMs) throw new Error(deadline.message);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
};

// Rows stored for one signed publication. Under per-reply pseudonymity the stored row is re-signed
// and keeps the author's signature in originalCommentSignatureEncoded.
const countCommentRows = (community: LocalCommunity, signature: string): number => {
    const dbHandler = community._dbHandler as unknown as {
        _db: { prepare(sql: string): { get(...params: string[]): { n: number } } };
    };
    return dbHandler._db
        .prepare(
            "SELECT COUNT(*) AS n FROM comments WHERE json_extract(signature, '$.signature') = ? OR originalCommentSignatureEncoded = ?"
        )
        .get(signature, signature).n;
};

type ChallengeRequestLike = { comment?: { signature: { signature: string } } };

// Skipped under RPC: registers an in-process challenge factory via pkc.settings.challenges and
// reads the community's private state (RPC clients cannot install challenge code on the remote
// community).
const describeInFlightDuplicates = (label: string, features: CommunityFeatures | undefined) =>
    describeSkipIfRpc(`in-flight duplicate challenge requests (#228) - ${label}`, () => {
        let pkc: PKCType;
        let community: LocalCommunity;
        let gate: ChallengeGate;

        // Automatic challenge (no challenge message) that parks every request until the test releases it.
        const blockingChallenge = (_: { challengeSettings: CommunityChallengeSetting }): ChallengeFileInput => {
            const getChallenge = async (): Promise<ChallengeResultInput> => {
                const verdict = gate.verdicts[gate.calls] ?? { success: true };
                gate.calls += 1;
                await gate.waitForRelease;
                return verdict;
            };
            return { getChallenge, type: "text/plain", description: "Blocks until the test releases it, then answers with its verdict" };
        };

        beforeAll(async () => {
            pkc = await mockPKC();
            pkc.settings.challenges = { "blocking-auto": blockingChallenge };
            community = (await pkc.createCommunity()) as LocalCommunity;
            community.setMaxListeners(100);
            await community.edit({ settings: { challenges: [{ name: "blocking-auto" }] }, ...(features ? { features } : {}) });
            await community.start();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        });

        beforeEach(() => {
            gate = makeGate();
        });

        afterAll(async () => {
            gate?.release();
            await community.delete();
            await pkc.destroy();
        });

        it("stores the comment once, runs the challenge once, and answers both overlapping requests with the same cid", async () => {
            const original = await generateMockPost({ communityAddress: community.address, pkc });
            const signature = original.signature!.signature;

            // Count the requests the community has received for this signed publication.
            let requestsReceivedByCommunity = 0;
            const countRequests = (request: ChallengeRequestLike) => {
                if (request.comment?.signature.signature === signature) requestsReceivedByCommunity += 1;
            };
            community.on("challengerequest", countRequests);

            // Publish the original; its challenge request lands in the blocking challenge.
            const originalPublish = publishWithExpectedResult({ publication: original, expectedChallengeSuccess: true });
            originalPublish.catch(() => {}); // awaited below; this only keeps an early rejection from being unhandled
            await waitFor(() => gate.calls >= 1);
            expect(requestsReceivedByCommunity).to.equal(1);

            // Re-send the exact same signed publication under a new challengeRequestId, like the
            // client's provider-switch retry does.
            const signedPublication = clonePublication(original.raw.pubsubMessageToPublish!);
            const retry = await pkc.createComment(signedPublication);
            expect(retry.signature!.signature).to.equal(signature);

            const retryPublish = publishWithExpectedResult({ publication: retry, expectedChallengeSuccess: true });
            retryPublish.catch(() => {});

            // The retry has reached the community while the original is still parked in its
            // challenge and no row exists yet. Only now let the original finish.
            await waitFor(() => requestsReceivedByCommunity >= 2);
            expect(countCommentRows(community, signature)).to.equal(0);
            gate.release();

            try {
                await Promise.all([originalPublish, retryPublish]);
            } finally {
                community.removeListener("challengerequest", countRequests);
                await retry.stop();
                await original.stop();
            }

            expect(original.cid).to.be.a("string");
            expect(retry.cid).to.equal(original.cid);
            expect(countCommentRows(community, signature)).to.equal(1);
            // One signed publication, one challenge run: the retry rode on the original's verdict.
            expect(gate.calls).to.equal(1);

            // The overlapping request was not a replay of a stored row, so it must not consume the
            // publisher's single post-storage idempotent retry.
            expect(community._duplicatePublicationAttempts.get(signature)).to.be.undefined;

            // A later replay (e.g. after a lost verification) still gets its one idempotent success...
            const replay = await pkc.createComment(clonePublication(signedPublication));
            try {
                await publishWithExpectedResult({ publication: replay, expectedChallengeSuccess: true });
                expect(replay.cid).to.equal(original.cid);
            } finally {
                await replay.stop();
            }
            expect(countCommentRows(community, signature)).to.equal(1);

            // ...and the replay after that is rejected as spam.
            const spam = await pkc.createComment(clonePublication(signedPublication));
            try {
                await publishWithExpectedResult({
                    publication: spam,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_DUPLICATE_COMMENT
                });
            } finally {
                await spam.stop();
            }
            expect(countCommentRows(community, signature)).to.equal(1);
            // Post-storage replays are answered from the database, never by re-running the challenge.
            expect(gate.calls).to.equal(1);
        });

        it("does not spend the replay budget on an overlapping request whose validation ran after the original stored", async () => {
            // CodeRabbit finding on PR #341: the overlapping request's first duplicate check ran
            // before it looked at the in-flight exchange. If the original stored during that
            // check, the overlap was classified as a replay of a stored row and consumed the
            // author's single post-storage idempotent retry. Its validation is parked here at the
            // author-name resolve (the only await inside validation that the test can hold) until
            // the original's row exists, so the check is guaranteed to observe the stored row.
            const signer = await pkc.createSigner();
            const original = await generateMockPost({
                communityAddress: community.address,
                pkc,
                postProps: { signer, author: { name: selfResolvingMockNameForAddress(signer.address) } }
            });
            const signature = original.signature!.signature;

            let requestsReceivedByCommunity = 0;
            const countRequests = (request: ChallengeRequestLike) => {
                if (request.comment?.signature.signature === signature) requestsReceivedByCommunity += 1;
            };
            community.on("challengerequest", countRequests);

            const clientsManager = community._clientsManager;
            const realResolve = clientsManager.resolveAuthorNameIfNeeded.bind(clientsManager);
            let resolveCalls = 0;
            const resolveSpy = vi.spyOn(clientsManager, "resolveAuthorNameIfNeeded").mockImplementation(async (args) => {
                resolveCalls += 1;
                // The first resolve is the original's validation. Every later one for this author
                // is an overlapping request's validation: hold it until the original's row exists.
                if (resolveCalls > 1) await waitFor(() => community._dbHandler.hasCommentWithSignatureEncoded(signature));
                return realResolve(args);
            });

            const originalPublish = publishWithExpectedResult({ publication: original, expectedChallengeSuccess: true });
            originalPublish.catch(() => {});
            await waitFor(() => gate.calls >= 1);

            const signedPublication = clonePublication(original.raw.pubsubMessageToPublish!);
            const retry = await pkc.createComment(signedPublication);
            const retryPublish = publishWithExpectedResult({ publication: retry, expectedChallengeSuccess: true });
            retryPublish.catch(() => {});

            // The retry has arrived (its request is decrypted and its event emitted) while the
            // original is still parked in its challenge. Let the original finish; the retry's
            // duplicate check now runs after the row exists.
            await waitFor(() => requestsReceivedByCommunity >= 2);
            gate.release();

            try {
                await Promise.all([originalPublish, retryPublish]);
            } finally {
                resolveSpy.mockRestore();
                community.removeListener("challengerequest", countRequests);
                await retry.stop();
                await original.stop();
            }

            expect(retry.cid).to.equal(original.cid);
            expect(gate.calls).to.equal(1);
            expect(community._duplicatePublicationAttempts.get(signature)).to.be.undefined;

            // The author's one post-storage replay must still be answered idempotently.
            const replay = await pkc.createComment(clonePublication(signedPublication));
            try {
                await publishWithExpectedResult({ publication: replay, expectedChallengeSuccess: true });
                expect(replay.cid).to.equal(original.cid);
            } finally {
                await replay.stop();
            }
        });

        it("answers the overlapping request with pendingApproval when the original was stored pending approval", async () => {
            // The idempotent verification is built from the stored row, and it dropped the row's
            // pendingApproval flag, so the overlapping request's client learned a cid with no pending
            // marker and treated a comment awaiting moderation as live.
            await community.edit({ settings: { challenges: [{ name: "blocking-auto", pendingApproval: true }] } });
            const original = await generateMockPost({ communityAddress: community.address, pkc });
            const signature = original.signature!.signature;
            let requestsReceivedByCommunity = 0;
            const countRequests = (request: ChallengeRequestLike) => {
                if (request.comment?.signature.signature === signature) requestsReceivedByCommunity += 1;
            };
            community.on("challengerequest", countRequests);
            const verifications: DecryptedChallengeVerificationMessageType[] = [];
            const recordVerification = (verification: DecryptedChallengeVerificationMessageType) => {
                verifications.push(verification);
            };
            community.on("challengeverification", recordVerification);

            const originalPublish = publishWithExpectedResult({ publication: original, expectedChallengeSuccess: true });
            originalPublish.catch(() => {});
            await waitFor(() => gate.calls >= 1);
            const retry = await pkc.createComment(clonePublication(original.raw.pubsubMessageToPublish!));
            const retryPublish = publishWithExpectedResult({ publication: retry, expectedChallengeSuccess: true });
            retryPublish.catch(() => {});
            await waitFor(() => requestsReceivedByCommunity >= 2);
            gate.release();

            try {
                await Promise.all([originalPublish, retryPublish]);
            } finally {
                community.removeListener("challengerequest", countRequests);
                community.removeListener("challengeverification", recordVerification);
                await retry.stop();
                await original.stop();
                await community.edit({ settings: { challenges: [{ name: "blocking-auto" }] } });
            }

            expect(original.pendingApproval).to.be.true;
            expect(retry.cid).to.equal(original.cid);
            expect(retry.pendingApproval, "the overlapping request must learn the comment is pending approval").to.be.true;
            expect(verifications.length).to.equal(2);
            for (const verification of verifications) expect(verification.commentUpdate?.pendingApproval).to.be.true;
            expect(countCommentRows(community, signature)).to.equal(1);
        });

        it("runs its own exchange when the exchange it waited on failed", async () => {
            // The waiter re-validates once the first exchange settles. Nothing was stored, so it is
            // not a duplicate and gets a fresh verdict of its own instead of inheriting the failure.
            gate.verdicts.push({ success: false, error: "first request rejected" });
            const original = await generateMockPost({ communityAddress: community.address, pkc });
            const signature = original.signature!.signature;
            let requestsReceivedByCommunity = 0;
            const countRequests = (request: ChallengeRequestLike) => {
                if (request.comment?.signature.signature === signature) requestsReceivedByCommunity += 1;
            };
            community.on("challengerequest", countRequests);

            const originalPublish = publishWithExpectedResult({ publication: original, expectedChallengeSuccess: false });
            originalPublish.catch(() => {});
            await waitFor(() => gate.calls >= 1);
            const retry = await pkc.createComment(clonePublication(original.raw.pubsubMessageToPublish!));
            const retryPublish = publishWithExpectedResult({ publication: retry, expectedChallengeSuccess: true });
            retryPublish.catch(() => {});
            await waitFor(() => requestsReceivedByCommunity >= 2);
            expect(gate.calls, "the retry must wait rather than run the challenge concurrently").to.equal(1);
            gate.release();

            try {
                await Promise.all([originalPublish, retryPublish]);
            } finally {
                community.removeListener("challengerequest", countRequests);
                await retry.stop();
                await original.stop();
            }

            expect(original.cid).to.be.undefined;
            expect(retry.cid).to.be.a("string");
            expect(gate.calls, "the retry ran the challenge once the failed exchange settled").to.equal(2);
            expect(countCommentRows(community, signature)).to.equal(1);
            expect(community._duplicatePublicationAttempts.get(signature)).to.be.undefined;
        });
    });

describeInFlightDuplicates("no pseudonymity", undefined);
describeInFlightDuplicates("per-reply pseudonymity", { pseudonymityMode: "per-reply" });

// The wait on an in-flight exchange must be bounded. Nothing rejects a pending challenge answer
// when the author walks away from an interactive challenge, so without a bound that handler holds
// the signature for the life of the community run and every later request for it waits forever.
// The bound is the same ttl the sibling challenge caches use (CHALLENGE_EXCHANGE_TTL_MS), lowered
// here through the instance field so the test does not wait ten minutes.
//
// Skipped under RPC: same reasons as above.
describeSkipIfRpc("challenge exchange ttl bounds an overlapping request's wait (#228)", () => {
    const TTL_MS = 3000;
    let pkc: PKCType;
    let community: LocalCommunity;
    let challengeCalls = 0;

    const interactiveChallenge = (_: { challengeSettings: CommunityChallengeSetting }): ChallengeFileInput => ({
        type: "text/plain",
        description: "Accepts any answer",
        getChallenge: async () => {
            challengeCalls += 1;
            return { challenge: "say anything", type: "text/plain", verify: async () => ({ success: true }) };
        }
    });

    beforeAll(async () => {
        pkc = await mockPKC();
        pkc.settings.challenges = { interactive: interactiveChallenge };
        community = (await pkc.createCommunity()) as LocalCommunity;
        community.setMaxListeners(100);
        community._challengeExchangeTtlMs = TTL_MS;
        await community.edit({ settings: { challenges: [{ name: "interactive" }] } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("fails an unanswered exchange after the ttl and lets the request that waited on it run its own", async () => {
        const original = await generateMockPost({ communityAddress: community.address, pkc });
        const signature = original.signature!.signature;
        let requestsReceivedByCommunity = 0;
        const countRequests = (request: ChallengeRequestLike) => {
            if (request.comment?.signature.signature === signature) requestsReceivedByCommunity += 1;
        };
        community.on("challengerequest", countRequests);

        const originalChallenges: DecryptedChallengeMessageType[] = [];
        const originalVerifications: DecryptedChallengeVerificationMessageType[] = [];
        original.on("challenge", (challenge) => originalChallenges.push(challenge));
        original.on("challengeverification", (verification) => originalVerifications.push(verification));

        const retry = await pkc.createComment(clonePublication(original.raw.pubsubMessageToPublish!));
        const retryChallenges: DecryptedChallengeMessageType[] = [];
        retry.on("challenge", (challenge) => retryChallenges.push(challenge));

        try {
            // The original is challenged and its author never answers.
            await original.publish();
            await waitFor(() => originalChallenges.length >= 1);
            expect(challengeCalls).to.equal(1);

            // The retry arrives and waits on the parked exchange.
            await retry.publish();
            await waitFor(() => requestsReceivedByCommunity >= 2);
            expect(community._inFlightPublicationExchanges.has(signature)).to.be.true;
            expect(retryChallenges.length).to.equal(0);

            // After the ttl the community gives up on the unanswered exchange...
            await waitFor(() => originalVerifications.length >= 1, {
                timeoutMs: TTL_MS * 4,
                message: `the unanswered exchange was not failed within ${TTL_MS * 4}ms of waiting`
            });
            expect(originalVerifications[0].challengeSuccess).to.be.false;
            expect(originalVerifications[0].reason).to.equal(messages.ERR_COMMUNITY_TIMED_OUT_WAITING_FOR_CHALLENGE_ANSWER);

            // ...and the retry gets an exchange of its own, which its author can complete.
            await waitFor(() => retryChallenges.length >= 1, {
                timeoutMs: TTL_MS * 4,
                message: "the waiting request was never challenged after the parked exchange was failed"
            });
            expect(challengeCalls).to.equal(2);
            await retry.publishChallengeAnswers({ challengeAnswers: ["anything"] });
            await waitFor(() => typeof retry.cid === "string", {
                timeoutMs: TTL_MS * 4,
                message: "the retry's own exchange did not succeed"
            });
            expect(retry.publishingState).to.equal("succeeded");
            expect(countCommentRows(community, signature)).to.equal(1);
            expect(community._inFlightPublicationExchanges.size).to.equal(0);
        } finally {
            community.removeListener("challengerequest", countRequests);
            await retry.stop();
            await original.stop();
        }
    });
});
