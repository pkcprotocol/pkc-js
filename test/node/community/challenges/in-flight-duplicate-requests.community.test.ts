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

import { mockPKC, generateMockPost, publishWithExpectedResult, resolveWhenConditionIsTrue } from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { messages } from "../../../../dist/node/errors.js";
import { it, beforeAll, afterAll, beforeEach, expect } from "vitest";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { CommunityFeatures } from "../../../../dist/node/community/types.js";
import type { ChallengeFileInput, ChallengeResultInput, CommunityChallengeSetting } from "../../../../dist/node/community/types.js";

type ChallengeGate = { calls: number; waitForRelease: Promise<void>; release: () => void };

const makeGate = (): ChallengeGate => {
    let release!: () => void;
    const waitForRelease = new Promise<void>((resolve) => (release = resolve));
    return { calls: 0, waitForRelease, release };
};

const clonePublication = <T>(value: T): T => JSON.parse(JSON.stringify(value));

// The community's "challengerequest" event fires before the challenge runs, so event-driven waits
// cannot observe the challenge being entered. Poll instead; the vitest timeout bounds a hang.
const waitFor = async (predicate: () => boolean): Promise<void> => {
    while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 20));
};

const countCommentRows = (community: LocalCommunity): number => {
    const dbHandler = community._dbHandler as unknown as { _db: { prepare(sql: string): { get(): { n: number } } } };
    return dbHandler._db.prepare("SELECT COUNT(*) AS n FROM comments").get().n;
};

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
                gate.calls += 1;
                await gate.waitForRelease;
                return { success: true };
            };
            return { getChallenge, type: "text/plain", description: "Blocks until the test releases it, then succeeds" };
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
            const countRequests = (request: { comment?: { signature: { signature: string } } }) => {
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
            expect(countCommentRows(community)).to.equal(0);
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
            expect(countCommentRows(community)).to.equal(1);
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
            expect(countCommentRows(community)).to.equal(1);

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
            expect(countCommentRows(community)).to.equal(1);
            // Post-storage replays are answered from the database, never by re-running the challenge.
            expect(gate.calls).to.equal(1);
        });
    });

describeInFlightDuplicates("no pseudonymity", undefined);
describeInFlightDuplicates("per-reply pseudonymity", { pseudonymityMode: "per-reply" });
