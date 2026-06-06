import { beforeAll, describe, expect, it } from "vitest";
import { getChallengeVerification, pkcJsChallenges } from "../../dist/node/runtime/node/community/challenges/index.js";
import type { GetChallengeAnswers } from "../../dist/node/runtime/node/community/challenges/index.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "../../dist/node/pubsub-messages/types.js";
import type { LocalCommunity } from "../../dist/node/runtime/node/community/local-community.js";
import { PKC } from "./fixtures/fixtures.ts";

// Helper that builds a synthetic challenge factory returning a fixed challenge-result shape so we
// can exercise the aggregation and override-guard paths from the user's seat (the challenge author)
// without needing the full LocalCommunity stack.
const makeExtrasChallenge = (resultLiteral: Record<string, unknown>) => () => ({
    type: "extras-test",
    getChallenge: async () => resultLiteral
});

describe("ChallengeResult extras: aggregation across successful challenges", () => {
    const author = { address: "QmTestAddr" };
    const challengeRequestMessage = {
        comment: { author },
        challengeAnswers: []
    } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

    let mockPkc: ReturnType<typeof PKC>;
    beforeAll(() => {
        mockPkc = PKC();
    });

    it("merges `comment` extras across challenges (last-wins by index)", async () => {
        (mockPkc.settings ??= {}).challenges = {
            "extras-a": makeExtrasChallenge({ success: true, comment: { a: 1, b: 1 } }),
            "extras-b": makeExtrasChallenge({ success: true, comment: { b: 2, c: 3 } })
        };
        const community = {
            settings: { challenges: [{ name: "extras-a" }, { name: "extras-b" }] },
            _pkc: mockPkc
        } as unknown as LocalCommunity;

        const verification = (await getChallengeVerification({
            challengeRequestMessage,
            community,
            getChallengeAnswers: (async () => []) as GetChallengeAnswers
        })) as { challengeSuccess: boolean; aggregatedComment?: Record<string, unknown> };

        expect(verification.challengeSuccess).to.equal(true);
        expect(verification.aggregatedComment).to.deep.equal({ a: 1, b: 2, c: 3 });
    });

    it("merges `commentUpdate` extras across challenges (last-wins by index)", async () => {
        (mockPkc.settings ??= {}).challenges = {
            "cu-a": makeExtrasChallenge({ success: true, commentUpdate: { reason: "first", flairs: [{ text: "alpha" }] } }),
            "cu-b": makeExtrasChallenge({ success: true, commentUpdate: { reason: "second" } })
        };
        const community = {
            settings: { challenges: [{ name: "cu-a" }, { name: "cu-b" }] },
            _pkc: mockPkc
        } as unknown as LocalCommunity;

        const verification = (await getChallengeVerification({
            challengeRequestMessage,
            community,
            getChallengeAnswers: (async () => []) as GetChallengeAnswers
        })) as { challengeSuccess: boolean; aggregatedCommentUpdate?: Record<string, unknown> };

        expect(verification.challengeSuccess).to.equal(true);
        expect(verification.aggregatedCommentUpdate).to.deep.equal({ reason: "second", flairs: [{ text: "alpha" }] });
    });

    it("propagates `aggregatedReason` on failure", async () => {
        (mockPkc.settings ??= {}).challenges = {
            "f-1": makeExtrasChallenge({ success: false, error: "denied", reason: "kyc missing" })
        };
        const community = {
            settings: { challenges: [{ name: "f-1" }] },
            _pkc: mockPkc
        } as unknown as LocalCommunity;

        const verification = (await getChallengeVerification({
            challengeRequestMessage,
            community,
            getChallengeAnswers: (async () => []) as GetChallengeAnswers
        })) as { challengeSuccess: boolean; aggregatedReason?: string; challengeErrors?: Record<string, string> };

        expect(verification.challengeSuccess).to.equal(false);
        expect(verification.challengeErrors).to.deep.equal({ 0: "denied" });
        expect(verification.aggregatedReason).to.equal("kyc missing");
    });

    it("pending-approval challenge can attach a `commentUpdate.reason` explaining why", async () => {
        // Mirrors the driving use case: a challenge marked pendingApproval: true succeeds, comment
        // gets queued for mod approval, and the challenge attaches a rationale (e.g. low-confidence
        // spam score) that the mod can see on the pending commentUpdate.
        (mockPkc.settings ??= {}).challenges = {
            "low-confidence": makeExtrasChallenge({
                success: true,
                commentUpdate: { reason: "comment got sent to pending approval cause low spam-score confidence" }
            })
        };
        const community = {
            settings: { challenges: [{ name: "low-confidence", pendingApproval: true }] },
            _pkc: mockPkc
        } as unknown as LocalCommunity;

        const verification = (await getChallengeVerification({
            challengeRequestMessage,
            community,
            getChallengeAnswers: (async () => []) as GetChallengeAnswers
        })) as {
            challengeSuccess: boolean;
            pendingApproval?: boolean;
            aggregatedCommentUpdate?: Record<string, unknown>;
        };

        expect(verification.challengeSuccess).to.equal(true);
        expect(verification.pendingApproval).to.equal(true);
        expect(verification.aggregatedCommentUpdate).to.deep.equal({
            reason: "comment got sent to pending approval cause low spam-score confidence"
        });
    });
});

describe("ChallengeResult extras: override-guard", () => {
    const author = { address: "QmTestAddr2" };
    const challengeRequestMessage = {
        comment: { author },
        challengeAnswers: []
    } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

    let mockPkc: ReturnType<typeof PKC>;
    beforeAll(() => {
        mockPkc = PKC();
    });

    it("surfaces failure when a challenge tries to override a comment-signed field", async () => {
        // `content` is part of CommentSignedPropertyNames. getChallengeVerification wraps its inner
        // loops in try/catch and turns a thrown PKCError into `{ challengeSuccess: false, reason }`
        // so misconfigured challenges fail loudly with a descriptive message.
        (mockPkc.settings ??= {}).challenges = {
            "bad-comment": makeExtrasChallenge({ success: true, comment: { content: "spoofed by challenge" } })
        };
        const community = {
            settings: { challenges: [{ name: "bad-comment" }] },
            _pkc: mockPkc
        } as unknown as LocalCommunity;

        let caught: Error | undefined;
        try {
            await getChallengeVerification({
                challengeRequestMessage,
                community,
                getChallengeAnswers: (async () => []) as GetChallengeAnswers
            });
        } catch (e) {
            caught = e as Error;
        }
        // The thrown PKCError bubbles out of the inner classification loop. local-community/challenges.ts
        // catches it at the outer caller (`runChallengeExchangeIfNeeded`); here we exercise the inner
        // function directly, so we see the throw.
        expect(caught).to.not.equal(undefined);
        expect((caught as { code?: string })?.code).to.equal("ERR_CHALLENGE_RESULT_OVERRIDES_COMMENT_SIGNED_FIELD");
    });

    it("surfaces failure when a challenge sets a reserved commentUpdate field", async () => {
        (mockPkc.settings ??= {}).challenges = {
            "bad-cu": makeExtrasChallenge({ success: true, commentUpdate: { upvoteCount: 999 } })
        };
        const community = {
            settings: { challenges: [{ name: "bad-cu" }] },
            _pkc: mockPkc
        } as unknown as LocalCommunity;

        let caught: Error | undefined;
        try {
            await getChallengeVerification({
                challengeRequestMessage,
                community,
                getChallengeAnswers: (async () => []) as GetChallengeAnswers
            });
        } catch (e) {
            caught = e as Error;
        }
        expect(caught).to.not.equal(undefined);
        expect((caught as { code?: string })?.code).to.equal("ERR_CHALLENGE_RESULT_OVERRIDES_RESERVED_COMMENT_UPDATE_FIELD");
    });

    it("allows an arbitrary new key on `comment` (e.g. countryCode)", async () => {
        (mockPkc.settings ??= {}).challenges = {
            country: makeExtrasChallenge({ success: true, comment: { countryCode: "FR" } })
        };
        const community = {
            settings: { challenges: [{ name: "country" }] },
            _pkc: mockPkc
        } as unknown as LocalCommunity;

        const verification = (await getChallengeVerification({
            challengeRequestMessage,
            community,
            getChallengeAnswers: (async () => []) as GetChallengeAnswers
        })) as { challengeSuccess: boolean; aggregatedComment?: Record<string, unknown> };

        expect(verification.challengeSuccess).to.equal(true);
        expect(verification.aggregatedComment).to.deep.equal({ countryCode: "FR" });
    });

    it("allows an arbitrary new key under `commentUpdate.author.community` (e.g. countryCode)", async () => {
        (mockPkc.settings ??= {}).challenges = {
            "author-country": makeExtrasChallenge({
                success: true,
                commentUpdate: { author: { community: { countryCode: "FR" } } }
            })
        };
        const community = {
            settings: { challenges: [{ name: "author-country" }] },
            _pkc: mockPkc
        } as unknown as LocalCommunity;

        const verification = (await getChallengeVerification({
            challengeRequestMessage,
            community,
            getChallengeAnswers: (async () => []) as GetChallengeAnswers
        })) as { challengeSuccess: boolean; aggregatedCommentUpdate?: Record<string, unknown> };

        expect(verification.challengeSuccess).to.equal(true);
        expect(verification.aggregatedCommentUpdate).to.deep.equal({ author: { community: { countryCode: "FR" } } });
    });

    it("rejects a non-`community` key under `commentUpdate.author` (e.g. author.address)", async () => {
        (mockPkc.settings ??= {}).challenges = {
            "bad-author": makeExtrasChallenge({
                success: true,
                commentUpdate: { author: { address: "spoofed" } }
            })
        };
        const community = {
            settings: { challenges: [{ name: "bad-author" }] },
            _pkc: mockPkc
        } as unknown as LocalCommunity;

        let caught: Error | undefined;
        try {
            await getChallengeVerification({
                challengeRequestMessage,
                community,
                getChallengeAnswers: (async () => []) as GetChallengeAnswers
            });
        } catch (e) {
            caught = e as Error;
        }
        expect(caught).to.not.equal(undefined);
        expect((caught as { code?: string })?.code).to.equal("ERR_CHALLENGE_RESULT_OVERRIDES_NON_COMMUNITY_AUTHOR_KEY");
    });

    it("allows challenge-seeded `commentUpdate.author.community.flairs` (mod-overridable lowest priority)", async () => {
        // flairs is intentionally allowed: challenges seed with lowest priority; mods override via
        // commentModeration.author.flairs. The override semantics are exercised in the DB test file
        // (challengeCommentUpdate.db.community.test.ts); here we just assert the validator passes.
        (mockPkc.settings ??= {}).challenges = {
            "country-flair": makeExtrasChallenge({
                success: true,
                commentUpdate: { author: { community: { flairs: [{ text: "🇫🇷 FR" }] } } }
            })
        };
        const community = {
            settings: { challenges: [{ name: "country-flair" }] },
            _pkc: mockPkc
        } as unknown as LocalCommunity;

        const verification = (await getChallengeVerification({
            challengeRequestMessage,
            community,
            getChallengeAnswers: (async () => []) as GetChallengeAnswers
        })) as { challengeSuccess: boolean; aggregatedCommentUpdate?: Record<string, unknown> };

        expect(verification.challengeSuccess).to.equal(true);
        expect(verification.aggregatedCommentUpdate).to.deep.equal({
            author: { community: { flairs: [{ text: "🇫🇷 FR" }] } }
        });
    });

    it("rejects a mod-settable-but-reserved key under `commentUpdate.author.community` (e.g. banExpiresAt)", async () => {
        // banExpiresAt remains reserved: mods own bans via commentModeration.author.banExpiresAt.
        // Unlike flairs (which is a soft "badge"), allowing challenges to ban authors would let any
        // challenge effectively gate-keep without mod consent.
        (mockPkc.settings ??= {}).challenges = {
            "bad-ban": makeExtrasChallenge({
                success: true,
                commentUpdate: { author: { community: { banExpiresAt: 9999999999 } } }
            })
        };
        const community = {
            settings: { challenges: [{ name: "bad-ban" }] },
            _pkc: mockPkc
        } as unknown as LocalCommunity;

        let caught: Error | undefined;
        try {
            await getChallengeVerification({
                challengeRequestMessage,
                community,
                getChallengeAnswers: (async () => []) as GetChallengeAnswers
            });
        } catch (e) {
            caught = e as Error;
        }
        expect(caught).to.not.equal(undefined);
        expect((caught as { code?: string })?.code).to.equal("ERR_CHALLENGE_RESULT_OVERRIDES_RESERVED_COMMUNITY_AUTHOR_FIELD");
    });

    it("rejects a community-computed key under `commentUpdate.author.community` (e.g. postScore)", async () => {
        (mockPkc.settings ??= {}).challenges = {
            "bad-score": makeExtrasChallenge({
                success: true,
                commentUpdate: { author: { community: { postScore: 999 } } }
            })
        };
        const community = {
            settings: { challenges: [{ name: "bad-score" }] },
            _pkc: mockPkc
        } as unknown as LocalCommunity;

        let caught: Error | undefined;
        try {
            await getChallengeVerification({
                challengeRequestMessage,
                community,
                getChallengeAnswers: (async () => []) as GetChallengeAnswers
            });
        } catch (e) {
            caught = e as Error;
        }
        expect(caught).to.not.equal(undefined);
        expect((caught as { code?: string })?.code).to.equal("ERR_CHALLENGE_RESULT_OVERRIDES_RESERVED_COMMUNITY_AUTHOR_FIELD");
    });
});
