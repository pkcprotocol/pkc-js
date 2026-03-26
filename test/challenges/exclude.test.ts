import { beforeAll } from "vitest";
import {
    shouldExcludeChallengeCommentCids,
    shouldExcludePublication,
    shouldExcludeChallengeSuccess
} from "../../dist/node/runtime/node/subplebbit/challenges/exclude/index.js";
import { addToRateLimiter } from "../../dist/node/runtime/node/subplebbit/challenges/exclude/rate-limiter.js";
import type { DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor } from "../../dist/node/pubsub-messages/types.js";
import type { LocalSubplebbit } from "../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import * as remeda from "remeda";
import { Plebbit, authors } from "./fixtures/fixtures.ts";
import validCommentEditFixture from "../fixtures/signatures/commentEdit/valid_comment_edit.json" with { type: "json" };
import validCommentFixture from "..//fixtures/signatures/comment/commentUpdate/valid_comment_ipfs.json" with { type: "json" };
import validVoteFixture from "../fixtures/valid_vote.json" with { type: "json" };

// Type helpers for function signatures
type SubplebbitChallengeArg = Parameters<typeof shouldExcludePublication>[0];
type ChallengeRequestArg = Parameters<typeof shouldExcludePublication>[1];
type SubplebbitArg = Parameters<typeof shouldExcludePublication>[2];

type AddToRateLimiterChallenges = Parameters<typeof addToRateLimiter>[0];
type AddToRateLimiterRequest = Parameters<typeof addToRateLimiter>[1];
type AddToRateLimiterSuccess = Parameters<typeof addToRateLimiter>[2];

type ShouldExcludeChallengeSuccessChallenge = Parameters<typeof shouldExcludeChallengeSuccess>[0];
type ShouldExcludeChallengeSuccessChallengeResults = Parameters<typeof shouldExcludeChallengeSuccess>[2];

type ShouldExcludeChallengeCommentCidsChallenge = Parameters<typeof shouldExcludeChallengeCommentCids>[0];
type ShouldExcludeChallengeCommentCidsRequest = Parameters<typeof shouldExcludeChallengeCommentCids>[1];
type ShouldExcludeChallengeCommentCidsPlebbit = Parameters<typeof shouldExcludeChallengeCommentCids>[2];

// Wrapper functions to reduce type assertion boilerplate
const testShouldExcludePublication = (
    subplebbitChallenge: Record<string, unknown>,
    request: Record<string, unknown>,
    subplebbit?: Record<string, unknown>
): boolean => {
    return shouldExcludePublication(
        subplebbitChallenge as unknown as SubplebbitChallengeArg,
        request as unknown as ChallengeRequestArg,
        (subplebbit ?? undefined) as unknown as SubplebbitArg
    );
};

const testAddToRateLimiter = (
    subplebbitChallenges: Record<string, unknown>[],
    request: Record<string, unknown>,
    challengeSuccess: boolean
): void => {
    addToRateLimiter(
        subplebbitChallenges as unknown as AddToRateLimiterChallenges,
        request as unknown as AddToRateLimiterRequest,
        challengeSuccess as AddToRateLimiterSuccess
    );
};

const testShouldExcludeChallengeSuccess = (
    subplebbitChallenge: Record<string, unknown>,
    subplebbitChallengeIndex: number,
    challengeResults: Record<string, unknown>[]
): boolean => {
    return shouldExcludeChallengeSuccess(
        subplebbitChallenge as unknown as ShouldExcludeChallengeSuccessChallenge,
        subplebbitChallengeIndex,
        challengeResults as unknown as ShouldExcludeChallengeSuccessChallengeResults
    );
};

const testShouldExcludeChallengeCommentCids = (
    subplebbitChallenge: Record<string, unknown>,
    challengeRequestMessage: { comment: { author: { address: string } }; challengeCommentCids: string[] | undefined },
    plebbit: unknown
): Promise<boolean> => {
    return shouldExcludeChallengeCommentCids(
        subplebbitChallenge as unknown as ShouldExcludeChallengeCommentCidsChallenge,
        challengeRequestMessage as unknown as ShouldExcludeChallengeCommentCidsRequest,
        plebbit as unknown as ShouldExcludeChallengeCommentCidsPlebbit
    );
};

// sometimes use random addresses because the rate limiter
// is based on author addresses and doesn't reset between tests
const getRandomAddress = (): string => String(Math.random());

describe("shouldExcludePublication", () => {
    it("empty", () => {
        const publication = { author: { address: "Qm..." } };
        let subplebbitChallenge: { exclude: undefined | unknown[] } = { exclude: [] };
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication })).to.equal(false);
        subplebbitChallenge = { exclude: undefined };
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication })).to.equal(false);
    });

    it("postScore and replyScore", () => {
        const subplebbitChallenge = {
            exclude: [{ postScore: 100 }, { replyScore: 100 }]
        };
        const authorScoreUndefined = {
            author: { subplebbit: {} }
        };
        const authorSubplebbitUndefined = {
            author: {}
        };
        const authorPostScoreLow = {
            author: {
                subplebbit: {
                    postScore: 99
                }
            }
        };
        const authorPostScoreHigh = {
            author: {
                subplebbit: {
                    postScore: 100
                }
            }
        };
        const authorReplyScoreLow = {
            author: {
                subplebbit: {
                    replyScore: 99
                }
            }
        };
        const authorReplyScoreHigh = {
            author: {
                subplebbit: {
                    replyScore: 100
                }
            }
        };
        const authorReplyAndPostScoreHigh = {
            author: {
                subplebbit: {
                    postScore: 100,
                    replyScore: 100
                }
            }
        };
        const authorReplyAndPostScoreLow = {
            author: {
                subplebbit: {
                    postScore: 99,
                    replyScore: 99
                }
            }
        };
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: authorScoreUndefined })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: authorSubplebbitUndefined })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: authorPostScoreLow })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: authorPostScoreHigh })).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: authorReplyScoreLow })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: authorReplyScoreHigh }, authorReplyScoreHigh)).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: authorReplyAndPostScoreHigh })).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: authorReplyAndPostScoreLow })).to.equal(false);
    });

    it("firstCommentTimestamp", () => {
        const subplebbitChallenge = {
            exclude: [
                { firstCommentTimestamp: 60 * 60 * 24 * 100 } // 100 days
            ]
        };
        const oldAuthor = {
            author: {
                subplebbit: {
                    firstCommentTimestamp: Math.round(Date.now() / 1000) - 60 * 60 * 24 * 101 // 101 days
                }
            }
        };
        const newAuthor = {
            author: {
                subplebbit: {
                    firstCommentTimestamp: Math.round(Date.now() / 1000) - 60 * 60 * 24 * 99 // 99 days
                }
            }
        };
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: oldAuthor })).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: newAuthor })).to.equal(false);
    });

    it("firstCommentTimestamp and postScore", () => {
        const subplebbitChallenge = {
            exclude: [
                {
                    postScore: 100,
                    firstCommentTimestamp: 60 * 60 * 24 * 100 // 100 days
                }
            ]
        };
        const oldAuthor = {
            author: {
                subplebbit: {
                    postScore: 100,
                    firstCommentTimestamp: Math.round(Date.now() / 1000) - 60 * 60 * 24 * 101 // 101 days
                }
            }
        };
        const newAuthor = {
            author: {
                subplebbit: {
                    postScore: 99,
                    firstCommentTimestamp: Math.round(Date.now() / 1000) - 60 * 60 * 24 * 101 // 101 days
                }
            }
        };
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: oldAuthor })).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: newAuthor })).to.equal(false);
    });

    it("firstCommentTimestamp or (postScore and replyScore)", () => {
        const subplebbitChallenge = {
            exclude: [
                { postScore: 100, replyScore: 100 },
                { firstCommentTimestamp: 60 * 60 * 24 * 100 } // 100 days
            ]
        };
        const oldAuthor = {
            author: {
                subplebbit: {
                    firstCommentTimestamp: Math.round(Date.now() / 1000) - 60 * 60 * 24 * 101 // 101 days
                }
            }
        };
        const newAuthor = {
            author: {
                subplebbit: {
                    postScore: 101,
                    firstCommentTimestamp: Math.round(Date.now() / 1000) - 60 * 60 * 24 * 99 // 99 days
                }
            }
        };
        const popularAuthor = {
            author: {
                subplebbit: {
                    postScore: 100,
                    replyScore: 100
                }
            }
        };
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: oldAuthor })).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: newAuthor })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: popularAuthor })).to.equal(true);
    });

    const author = { address: "Qm..." };
    const post = {
        content: "content",
        author
    };
    const reply = {
        content: "content",
        parentCid: "Qm...",
        author
    };
    const vote = {
        commentCid: "Qm...",
        vote: 0,
        author
    };
    const commentEdit = {
        commentCid: "Qm...",
        content: "edited content",
        author
    };
    const commentModeration = {
        commentCid: "Qm...",
        commentModeration: { locked: true },
        author
    };
    const subplebbitEdit = {
        communityAddress: "Qm...",
        subplebbitEdit: { title: "New Title" },
        author
    };

    it("publicationType.post", () => {
        const subplebbitChallenge = {
            exclude: [{ publicationType: { post: true } }]
        };
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: post })).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: reply })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { vote })).to.equal(false);
    });

    it("publicationType.reply", () => {
        const subplebbitChallenge = {
            exclude: [{ publicationType: { reply: true } }]
        };
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: post })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: reply })).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { vote })).to.equal(false);
    });

    it("publicationType.vote", () => {
        const subplebbitChallenge = {
            exclude: [{ publicationType: { vote: true } }]
        };
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: post })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: reply })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { vote })).to.equal(true);
    });

    it("publicationType.vote and publicationType.reply", () => {
        const subplebbitChallenge = {
            exclude: [{ publicationType: { vote: true, reply: true } }]
        };
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: post })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: reply })).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { vote })).to.equal(true);
    });

    it("publicationType.subplebbitEdit and publicationType.commentEdit", () => {
        const subplebbitChallenge = {
            exclude: [{ publicationType: { subplebbitEdit: true, commentEdit: true } }]
        };
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: post })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: reply })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { vote })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { commentEdit })).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { commentModeration })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { subplebbitEdit })).to.equal(true);
    });

    it("publicationType.commentEdit", () => {
        const subplebbitChallenge = {
            exclude: [{ publicationType: { commentEdit: true } }]
        };
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: post })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: reply })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { vote })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { commentEdit })).to.equal(true);
    });

    it("publicationType.commentModeration", () => {
        const subplebbitChallenge = {
            exclude: [{ publicationType: { commentModeration: true } }]
        };
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: post })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: reply })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { vote })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { commentModeration })).to.equal(true);
    });

    it("publicationType.subplebbitEdit", () => {
        const subplebbitChallenge = {
            exclude: [{ publicationType: { subplebbitEdit: true } }]
        };
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: post })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: reply })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { vote })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { commentEdit })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { commentModeration })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { subplebbitEdit })).to.equal(true);
    });

    // Exclude based on roles
    it("Moderator edits are excluded from challenges", async () => {
        const subplebbitChallenge = {
            exclude: [{ role: ["moderator", "admin", "owner"], publicationType: { commentModeration: true } }]
        };
        // high-karma.bso is a mod
        const modAuthor = { address: "high-karma.bso", displayName: "Mod User" };

        const commentEditOfMod = remeda.clone(validCommentEditFixture);
        commentEditOfMod.author = modAuthor;

        const postOfMod = remeda.clone(validCommentFixture);
        postOfMod.author = modAuthor;

        const replyOfMod = {
            ...postOfMod,
            parentCid: "Qm..."
        };
        const voteOfMod = remeda.clone(validVoteFixture);
        voteOfMod.author = modAuthor;

        // Mock subplebbit with roles - high-karma.bso is a moderator
        const subplebbit = {
            roles: {
                "high-karma.bso": { role: "moderator" }
            }
        };

        expect(testShouldExcludePublication(subplebbitChallenge, { commentModeration: commentEditOfMod }, subplebbit)).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: postOfMod }, subplebbit)).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: replyOfMod }, subplebbit)).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { vote: voteOfMod }, subplebbit)).to.equal(false);
    });

    it("should only exclude authors with specified roles, not all authors (bug reproduction)", () => {
        const subplebbitChallenge = {
            exclude: [{ role: ["moderator", "admin", "owner"] }]
        };

        // Author without any roles
        const regularAuthor = { address: "regular-user.bso" };
        const postByRegularUser = {
            content: "test post",
            author: regularAuthor
        };

        // Author with moderator role
        const modAuthor = { address: "high-karma.bso" };
        const postByMod = {
            content: "test post",
            author: modAuthor
        };

        // Mock subplebbit with roles
        const subplebbit = {
            roles: {
                "high-karma.bso": { role: "moderator" }
            }
        };

        // BUG: When subplebbit parameter is missing, both should return false but might not
        const resultRegularUserWithoutSubplebbit = testShouldExcludePublication(subplebbitChallenge, { comment: postByRegularUser });
        const resultModWithoutSubplebbit = testShouldExcludePublication(subplebbitChallenge, { comment: postByMod });

        // Expected behavior: regular user should NOT be excluded
        expect(resultRegularUserWithoutSubplebbit).to.equal(false);
        // Expected behavior: mod should also NOT be excluded without role info
        expect(resultModWithoutSubplebbit).to.equal(false);

        // CORRECT: When subplebbit parameter is provided with roles
        const resultRegularUserWithSubplebbit = testShouldExcludePublication(
            subplebbitChallenge,
            { comment: postByRegularUser },
            subplebbit
        );
        const resultModWithSubplebbit = testShouldExcludePublication(subplebbitChallenge, { comment: postByMod }, subplebbit);

        // Expected behavior: regular user should NOT be excluded
        expect(resultRegularUserWithSubplebbit).to.equal(false);
        // Expected behavior: mod should be excluded
        expect(resultModWithSubplebbit).to.equal(true);
    });

    it("postCount", () => {
        const subplebbitChallenge = {
            exclude: [{ postCount: 10 }]
        };
        const publication = { author: { address: "Qm..." }, signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" } };
        const mockSubplebbitExact = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 10, replyCount: 0 }) }
        };
        const mockSubplebbitAbove = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 11, replyCount: 0 }) }
        };
        const mockSubplebbitBelow = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 9, replyCount: 0 }) }
        };
        const mockSubplebbitZero = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 0, replyCount: 0 }) }
        };
        // exact threshold -> excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockSubplebbitExact)).to.equal(true);
        // above threshold -> excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockSubplebbitAbove)).to.equal(true);
        // below threshold -> not excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockSubplebbitBelow)).to.equal(false);
        // zero posts -> not excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockSubplebbitZero)).to.equal(false);
    });

    it("replyCount", () => {
        const subplebbitChallenge = {
            exclude: [{ replyCount: 5 }]
        };
        const publication = { author: { address: "Qm..." }, signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" } };
        const mockSubplebbitExact = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 0, replyCount: 5 }) }
        };
        const mockSubplebbitAbove = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 0, replyCount: 20 }) }
        };
        const mockSubplebbitBelow = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 0, replyCount: 4 }) }
        };
        // exact threshold -> excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockSubplebbitExact)).to.equal(true);
        // above threshold -> excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockSubplebbitAbove)).to.equal(true);
        // below threshold -> not excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockSubplebbitBelow)).to.equal(false);
    });

    it("postCount OR replyCount (separate exclude rules)", () => {
        const subplebbitChallenge = {
            exclude: [{ postCount: 10 }, { replyCount: 10 }]
        };
        const publication = { author: { address: "Qm..." }, signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" } };
        const mockHighPostOnly = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 10, replyCount: 0 }) }
        };
        const mockHighReplyOnly = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 0, replyCount: 50 }) }
        };
        const mockBothHigh = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 10, replyCount: 50 }) }
        };
        const mockBothLow = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 9, replyCount: 9 }) }
        };
        // postCount meets first exclude rule -> excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockHighPostOnly)).to.equal(true);
        // replyCount meets second exclude rule -> excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockHighReplyOnly)).to.equal(true);
        // both meet -> excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockBothHigh)).to.equal(true);
        // neither meets -> not excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockBothLow)).to.equal(false);
    });

    it("postCount AND replyCount (same exclude rule)", () => {
        const subplebbitChallenge = {
            exclude: [{ postCount: 5, replyCount: 10 }]
        };
        const publication = { author: { address: "Qm..." }, signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" } };
        const mockBothMeet = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 5, replyCount: 10 }) }
        };
        const mockOnlyPostMeets = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 5, replyCount: 9 }) }
        };
        const mockOnlyReplyMeets = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 4, replyCount: 10 }) }
        };
        const mockNeitherMeets = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 4, replyCount: 9 }) }
        };
        // both meet -> excluded (AND)
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockBothMeet)).to.equal(true);
        // only postCount meets -> not excluded (AND requires both)
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockOnlyPostMeets)).to.equal(false);
        // only replyCount meets -> not excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockOnlyReplyMeets)).to.equal(false);
        // neither meets -> not excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockNeitherMeets)).to.equal(false);
    });

    it("postCount without _dbHandler", () => {
        const subplebbitChallenge = {
            exclude: [{ postCount: 5 }]
        };
        const publication = { author: { address: "Qm..." }, signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" } };
        // no subplebbit arg -> counts are undefined -> should not exclude
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication })).to.equal(false);
        // empty subplebbit (no _dbHandler) -> should not exclude
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, {})).to.equal(false);
    });

    it("postCount with threshold of 0 (exclude everyone)", () => {
        const subplebbitChallenge = {
            exclude: [{ postCount: 0 }]
        };
        const publication = { author: { address: "Qm..." }, signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" } };
        const mockSubplebbitZero = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 0, replyCount: 0 }) }
        };
        const mockSubplebbitSome = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 3, replyCount: 0 }) }
        };
        // 0 >= 0 -> excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockSubplebbitZero)).to.equal(true);
        // 3 >= 0 -> excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockSubplebbitSome)).to.equal(true);
    });

    it("postCount AND postScore in same exclude rule (AND logic)", () => {
        const subplebbitChallenge = {
            exclude: [{ postCount: 5, postScore: 100 }]
        };
        const publication = {
            author: { address: "Qm...", subplebbit: { postScore: 100 } },
            signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" }
        };
        const publicationLowScore = {
            author: { address: "Qm...", subplebbit: { postScore: 99 } },
            signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" }
        };
        const mockSubplebbitHighCount = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 5, replyCount: 0 }) }
        };
        const mockSubplebbitLowCount = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 4, replyCount: 0 }) }
        };
        // both postCount (5 >= 5) AND postScore (100 >= 100) meet threshold -> excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockSubplebbitHighCount)).to.equal(true);
        // postCount too low -> not excluded despite postScore being high
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockSubplebbitLowCount)).to.equal(false);
        // postScore too low -> not excluded despite postCount being high
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationLowScore }, mockSubplebbitHighCount)).to.equal(
            false
        );
    });

    it("postCount AND firstCommentTimestamp in same exclude rule", () => {
        const subplebbitChallenge = {
            exclude: [{ postCount: 3, firstCommentTimestamp: 60 * 60 * 24 * 100 }] // 100 days
        };
        const oldAuthor = {
            author: {
                address: "Qm...",
                subplebbit: { firstCommentTimestamp: Math.round(Date.now() / 1000) - 60 * 60 * 24 * 101 } // 101 days
            },
            signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" }
        };
        const newAuthor = {
            author: {
                address: "Qm...",
                subplebbit: { firstCommentTimestamp: Math.round(Date.now() / 1000) - 60 * 60 * 24 * 99 } // 99 days
            },
            signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" }
        };
        const mockHighCount = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 3, replyCount: 0 }) }
        };
        const mockLowCount = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 2, replyCount: 0 }) }
        };
        // old author AND high count -> excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: oldAuthor }, mockHighCount)).to.equal(true);
        // old author AND low count -> not excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: oldAuthor }, mockLowCount)).to.equal(false);
        // new author AND high count -> not excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: newAuthor }, mockHighCount)).to.equal(false);
    });

    it("postCount AND publicationType in same exclude rule", () => {
        const subplebbitChallenge = {
            exclude: [{ postCount: 5, publicationType: { post: true } }]
        };
        const postPub = {
            content: "content",
            author: { address: "Qm..." },
            signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" }
        };
        const replyPub = {
            content: "content",
            parentCid: "Qm...",
            author: { address: "Qm..." },
            signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" }
        };
        const mockHighCount = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 5, replyCount: 0 }) }
        };
        // post with high count -> excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: postPub }, mockHighCount)).to.equal(true);
        // reply with high count -> not excluded (publicationType doesn't match)
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: replyPub }, mockHighCount)).to.equal(false);
    });

    it("replyCount AND rateLimit in same exclude rule", () => {
        const subplebbitChallenge = {
            exclude: [{ replyCount: 3, rateLimit: 1 }]
        };
        const subplebbitChallenges = [subplebbitChallenge];
        const address = getRandomAddress();
        const publication = {
            author: { address },
            parentCid: "Qm...",
            signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" }
        };
        const mockHighCount = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 0, replyCount: 3 }) }
        };
        const mockLowCount = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 0, replyCount: 2 }) }
        };
        // high count and not rate limited -> excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockHighCount)).to.equal(true);
        // low count -> not excluded even before rate limit
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockLowCount)).to.equal(false);
        // after rate limiting
        testAddToRateLimiter(subplebbitChallenges, { comment: publication }, true);
        // high count but rate limited -> not excluded
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publication }, mockHighCount)).to.equal(false);
    });

    it("firstCommentTimestamp OR postCount (separate exclude rules)", () => {
        const subplebbitChallenge = {
            exclude: [
                { firstCommentTimestamp: 60 * 60 * 24 * 100 }, // 100 days
                { postCount: 5 }
            ]
        };
        const oldAuthorNoSignature = {
            author: {
                address: "Qm...",
                subplebbit: { firstCommentTimestamp: Math.round(Date.now() / 1000) - 60 * 60 * 24 * 101 } // 101 days
            }
        };
        const newAuthorWithSignature = {
            author: {
                address: "Qm...",
                subplebbit: { firstCommentTimestamp: Math.round(Date.now() / 1000) - 60 * 60 * 24 * 10 } // 10 days
            },
            signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" }
        };
        const mockHighCount = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 5, replyCount: 0 }) }
        };
        const mockLowCount = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 4, replyCount: 0 }) }
        };
        // old author -> excluded by firstCommentTimestamp rule (no DB needed)
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: oldAuthorNoSignature })).to.equal(true);
        // new author but high count -> excluded by postCount rule
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: newAuthorWithSignature }, mockHighCount)).to.equal(true);
        // new author and low count -> not excluded by either rule
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: newAuthorWithSignature }, mockLowCount)).to.equal(false);
    });

    it("rateLimit", () => {
        const subplebbitChallenge = {
            exclude: [
                { rateLimit: 1 } // 1 publication per hour
            ]
        };
        const subplebbitChallenges = [subplebbitChallenge];
        const publicationAuthor1 = { author: { address: getRandomAddress() } };
        const publicationAuthor2 = { author: { address: getRandomAddress() } };
        const challengeSuccess = true;
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationAuthor1 })).to.equal(true);
        testAddToRateLimiter(subplebbitChallenges, { comment: publicationAuthor1 }, challengeSuccess);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationAuthor1 })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationAuthor2 })).to.equal(true);
    });

    it("rateLimit and postScore", () => {
        const subplebbitChallenge = {
            exclude: [{ postScore: 100, rateLimit: 1 }]
        };
        const address = getRandomAddress();
        const authorScoreUndefined = {
            author: { address, subplebbit: {} }
        };
        const authorSubplebbitUndefined = {
            author: { address }
        };
        const authorPostScoreLow = {
            author: {
                address,
                subplebbit: {
                    postScore: 99
                }
            }
        };
        const authorPostScoreHigh = {
            author: {
                address,
                subplebbit: {
                    postScore: 100
                }
            }
        };
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: authorScoreUndefined })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: authorSubplebbitUndefined })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: authorPostScoreLow })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: authorPostScoreHigh })).to.equal(true);

        // after rate limited
        const subplebbitChallenges = [subplebbitChallenge];
        const challengeSuccess = true;
        testAddToRateLimiter(subplebbitChallenges, { comment: authorPostScoreHigh }, challengeSuccess);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: authorScoreUndefined })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: authorSubplebbitUndefined })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: authorPostScoreLow })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: authorPostScoreHigh })).to.equal(false);
    });

    it("rateLimit challengeSuccess false", () => {
        const subplebbitChallenge = {
            exclude: [
                { rateLimit: 1 } // 1 publication per hour
            ]
        };
        const subplebbitChallenges = [subplebbitChallenge];
        const publicationAuthor1 = { author: { address: getRandomAddress() } };
        const publicationAuthor2 = { author: { address: getRandomAddress() } };
        const challengeSuccess = false;
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationAuthor1 })).to.equal(true);
        testAddToRateLimiter(subplebbitChallenges, { comment: publicationAuthor1 }, challengeSuccess);
        // without rateLimitChallengeSuccess, rateLimit only applies to challengeSuccess true publications
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationAuthor1 })).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationAuthor2 })).to.equal(true);
    });

    it("rateLimit post, reply, vote", () => {
        const subplebbitChallenge = {
            exclude: [
                { publicationType: { post: true }, rateLimit: 1 }, // 1 per hour
                { publicationType: { reply: true }, rateLimit: 1 }, // 1 per hour
                { publicationType: { vote: true }, rateLimit: 1 } // 1 per hour
            ]
        };
        const subplebbitChallenges = [subplebbitChallenge];
        const author = { address: getRandomAddress() };
        const publicationPost = { author };
        const publicationReply = { author, parentCid: "Qm..." };
        const publicationVote = { author, commentCid: "Qm...", vote: 0 };
        let challengeSuccess = true;
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationPost })).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationReply })).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { vote: publicationVote })).to.equal(true);
        testAddToRateLimiter(subplebbitChallenges, { comment: publicationPost }, challengeSuccess);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationPost })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationReply })).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { vote: publicationVote })).to.equal(true);
        testAddToRateLimiter(subplebbitChallenges, { comment: publicationReply }, challengeSuccess);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationPost })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationReply })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { vote: publicationVote })).to.equal(true);

        // publish with challengeSuccess false, should do nothing
        challengeSuccess = false;
        testAddToRateLimiter(subplebbitChallenges, { vote: publicationVote }, challengeSuccess);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationPost })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationReply })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { vote: publicationVote })).to.equal(true);

        // publish with challengeSuccess true, should rate limit
        challengeSuccess = true;
        testAddToRateLimiter(subplebbitChallenges, { vote: publicationVote }, challengeSuccess);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationPost })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationReply })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { vote: publicationVote })).to.equal(false);
    });

    it("rateLimit rateLimitChallengeSuccess true", () => {
        const subplebbitChallenge = {
            exclude: [
                { rateLimit: 1, rateLimitChallengeSuccess: true } // 1 publication per hour
            ]
        };
        const subplebbitChallenges = [subplebbitChallenge];
        const publicationAuthor1 = { author: { address: getRandomAddress() } };
        const publicationAuthor2 = { author: { address: getRandomAddress() } };
        const challengeSuccess = true;
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationAuthor1 })).to.equal(true);
        testAddToRateLimiter(subplebbitChallenges, { comment: publicationAuthor1 }, challengeSuccess);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationAuthor1 })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationAuthor2 })).to.equal(true);
    });

    it("rateLimit rateLimitChallengeSuccess true challengeSuccess false", () => {
        const subplebbitChallenge = {
            exclude: [
                { rateLimit: 1, rateLimitChallengeSuccess: true } // 1 publication per hour
            ]
        };
        const subplebbitChallenges = [subplebbitChallenge];
        const publicationAuthor1 = { author: { address: getRandomAddress() } };
        const publicationAuthor2 = { author: { address: getRandomAddress() } };
        const challengeSuccess = false;
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationAuthor1 })).to.equal(true);
        testAddToRateLimiter(subplebbitChallenges, { comment: publicationAuthor1 }, challengeSuccess);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationAuthor1 })).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationAuthor2 })).to.equal(true);
    });

    it("rateLimit rateLimitChallengeSuccess false challengeSuccess true", () => {
        const subplebbitChallenge = {
            exclude: [
                { rateLimit: 1, rateLimitChallengeSuccess: false } // 1 publication per hour
            ]
        };
        const subplebbitChallenges = [subplebbitChallenge];
        const publicationAuthor1 = { author: { address: getRandomAddress() } };
        const publicationAuthor2 = { author: { address: getRandomAddress() } };
        const challengeSuccess = true;
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationAuthor1 })).to.equal(true);
        testAddToRateLimiter(subplebbitChallenges, { comment: publicationAuthor1 }, challengeSuccess);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationAuthor1 })).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationAuthor2 })).to.equal(true);
    });

    it("rateLimit rateLimitChallengeSuccess false challengeSuccess false", () => {
        const subplebbitChallenge = {
            exclude: [
                { rateLimit: 1, rateLimitChallengeSuccess: false } // 1 publication per hour
            ]
        };
        const subplebbitChallenges = [subplebbitChallenge];
        const publicationAuthor1 = { author: { address: getRandomAddress() } };
        const publicationAuthor2 = { author: { address: getRandomAddress() } };
        const challengeSuccess = false;
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationAuthor1 })).to.equal(true);
        testAddToRateLimiter(subplebbitChallenges, { comment: publicationAuthor1 }, challengeSuccess);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationAuthor1 })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationAuthor2 })).to.equal(true);
    });

    it("rateLimit post, reply rateLimitChallengeSuccess false", () => {
        const subplebbitChallenge = {
            exclude: [
                { publicationType: { post: true }, rateLimit: 1, rateLimitChallengeSuccess: false }, // 1 per hour
                { publicationType: { reply: true }, rateLimit: 1 } // 1 per hour
            ]
        };
        const subplebbitChallenges = [subplebbitChallenge];
        const author = { address: getRandomAddress() };
        const publicationPost = { author };
        const publicationReply = { author, parentCid: "Qm..." };
        const publicationVote = { author, commentCid: "Qm...", vote: 0 };
        let challengeSuccess = true;

        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationPost })).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationReply })).to.equal(true);
        // vote can never pass because it's not included in any of the excludes
        expect(testShouldExcludePublication(subplebbitChallenge, { vote: publicationVote })).to.equal(false);

        // no effect because post true and rateLimitChallengeSuccess false
        testAddToRateLimiter(subplebbitChallenges, { comment: publicationPost }, challengeSuccess);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationPost })).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationReply })).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { vote: publicationVote })).to.equal(false);

        // now has effect because success false
        challengeSuccess = false;
        testAddToRateLimiter(subplebbitChallenges, { comment: publicationPost }, challengeSuccess);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationPost })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationReply })).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { vote: publicationVote })).to.equal(false);

        // no effect because reply true, challengeSuccess false and rateLimitChallengeSuccess undefined
        testAddToRateLimiter(subplebbitChallenges, { comment: publicationReply }, challengeSuccess);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationPost })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationReply })).to.equal(true);
        expect(testShouldExcludePublication(subplebbitChallenge, { vote: publicationVote })).to.equal(false);

        // now has effect because success true
        challengeSuccess = true;
        testAddToRateLimiter(subplebbitChallenges, { comment: publicationReply }, challengeSuccess);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationPost })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { comment: publicationReply })).to.equal(false);
        expect(testShouldExcludePublication(subplebbitChallenge, { vote: publicationVote })).to.equal(false);
    });
});

describe("shouldExcludeChallengeSuccess", () => {
    it("exclude 0, 1", () => {
        const subplebbitChallenge = {
            exclude: [{ challenges: [0, 1] }]
        };
        const challengeResultsSucceed2 = [{ success: true }, { success: true }, { success: false }];
        const challengeResultsSucceed3 = [{ success: true }, { success: true }, { success: true }];
        const challengeResultsFail1 = [{ success: true }, { success: false }];
        const challengeResultsFail2 = [{ success: false }, { success: false }];
        const challengeResultsEmpty: Record<string, unknown>[] = [];
        const challengeResultsMixed = [{ success: true }, { success: false }, { success: true }, { success: false }];
        expect(testShouldExcludeChallengeSuccess(subplebbitChallenge, 0, challengeResultsSucceed2)).to.equal(true);
        expect(testShouldExcludeChallengeSuccess(subplebbitChallenge, 0, challengeResultsSucceed3)).to.equal(true);
        expect(testShouldExcludeChallengeSuccess(subplebbitChallenge, 0, challengeResultsFail1)).to.equal(false);
        expect(testShouldExcludeChallengeSuccess(subplebbitChallenge, 0, challengeResultsFail2)).to.equal(false);
        expect(testShouldExcludeChallengeSuccess(subplebbitChallenge, 0, challengeResultsEmpty)).to.equal(false);
        expect(testShouldExcludeChallengeSuccess(subplebbitChallenge, 0, challengeResultsMixed)).to.equal(false);
    });

    it("exclude (0, 1) or 2", () => {
        const subplebbitChallenge = {
            exclude: [{ challenges: [0, 1] }, { challenges: [2] }]
        };
        const challengeResultsSucceed12 = [{ success: true }, { success: true }, { success: false }];
        const challengeResultsSucceed123 = [{ success: true }, { success: true }, { success: true }];
        const challengeResultsSucceed3 = [{ success: false }, { success: false }, { success: true }];
        const challengeResultsSucceed4 = [{ success: false }, { success: false }, { success: false }, { success: true }];
        const challengeResultsEmpty: Record<string, unknown>[] = [];
        expect(testShouldExcludeChallengeSuccess(subplebbitChallenge, 0, challengeResultsSucceed12)).to.equal(true);
        expect(testShouldExcludeChallengeSuccess(subplebbitChallenge, 0, challengeResultsSucceed123)).to.equal(true);
        expect(testShouldExcludeChallengeSuccess(subplebbitChallenge, 0, challengeResultsSucceed3)).to.equal(true);
        expect(testShouldExcludeChallengeSuccess(subplebbitChallenge, 0, challengeResultsSucceed4)).to.equal(false);
        expect(testShouldExcludeChallengeSuccess(subplebbitChallenge, 0, challengeResultsEmpty)).to.equal(false);
    });

    it("should handle undefined challenge results", () => {
        const subplebbitChallenge = {
            exclude: [{ challenges: [0, 1] }]
        };
        // This reproduces the error: challengeResults[1] is undefined
        const challengeResultsWithUndefined = [{ success: true }];

        // This should not throw an error and should return false
        expect(() => testShouldExcludeChallengeSuccess(subplebbitChallenge, 0, challengeResultsWithUndefined)).to.not.throw();
        expect(testShouldExcludeChallengeSuccess(subplebbitChallenge, 0, challengeResultsWithUndefined)).to.equal(false);
    });

    it("should handle out of bounds challenge indices", () => {
        const subplebbitChallenge = {
            exclude: [{ challenges: [5, 10] }] // indices that don't exist in the array
        };
        const challengeResults = [{ success: true }, { success: false }];

        // This should not throw an error and should return false
        expect(() => testShouldExcludeChallengeSuccess(subplebbitChallenge, 0, challengeResults)).to.not.throw();
        expect(testShouldExcludeChallengeSuccess(subplebbitChallenge, 0, challengeResults)).to.equal(false);
    });

    it("should handle mixed undefined and valid challenge results", () => {
        const subplebbitChallenge = {
            exclude: [{ challenges: [0, 2] }] // index 2 doesn't exist
        };
        const challengeResults = [{ success: true }, { success: false }]; // only 2 elements, index 2 is undefined

        // This should not throw an error and should return false
        expect(() => testShouldExcludeChallengeSuccess(subplebbitChallenge, 0, challengeResults)).to.not.throw();
        expect(testShouldExcludeChallengeSuccess(subplebbitChallenge, 0, challengeResults)).to.equal(false);
    });

    it("pending challenges excludes failed non pending challenge", () => {
        const subplebbitChallenge = {
            exclude: [{ challenges: [1] }]
        };
        const challengeResults = [{ success: false }, { challenge: "What is the password?" }];

        expect(testShouldExcludeChallengeSuccess(subplebbitChallenge, 0, challengeResults)).to.equal(true);
        expect(testShouldExcludeChallengeSuccess(subplebbitChallenge, 1, challengeResults)).to.equal(false);
    });

    it("pending challenges does not exclude another pending challenge", () => {
        const subplebbitChallenge = {
            exclude: [{ challenges: [1] }]
        };
        const challengeResults = [{ challenge: "What is the password?" }, { challenge: "What is the other password?" }];

        expect(testShouldExcludeChallengeSuccess(subplebbitChallenge, 0, challengeResults)).to.equal(false);
        expect(testShouldExcludeChallengeSuccess(subplebbitChallenge, 1, challengeResults)).to.equal(false);
    });
});

describe("shouldExcludeChallengeCommentCids", () => {
    const getChallengeRequestMessage = (
        commentCids: string[] | undefined
    ): { comment: { author: { address: string } }; challengeCommentCids: string[] | undefined } => {
        // define author based on high or low karma
        const author = { address: "Qm..." };
        const [_subplebbitAddress, karma, _age] = (commentCids?.[0] || "").replace("Qm...", "").split(",");
        if (karma === "high") {
            author.address = authors[0].address;
        } else if (karma === "low") {
            author.address = authors[1].address;
        }
        return {
            comment: { author },
            challengeCommentCids: commentCids
        };
    };

    let plebbit: ReturnType<typeof Plebbit>;
    beforeAll(async () => {
        plebbit = await Plebbit();
    });

    it("firstCommentTimestamp", async () => {
        const subplebbitChallenge = {
            exclude: [
                {
                    subplebbit: {
                        addresses: ["friendly-sub.bso"],
                        firstCommentTimestamp: 60 * 60 * 24 * 100, // 100 days
                        maxCommentCids: 2
                    }
                }
            ]
        };

        const commentCidsOld = getChallengeRequestMessage(["Qm...friendly-sub.bso,high,old", "Qm...friendly-sub.bso,high,old"]);
        const commentCidsNew = getChallengeRequestMessage(["Qm...friendly-sub.bso,high,new", "Qm...friendly-sub.bso,high,new"]);
        const commentCidsNoAuthorSubplebbit = getChallengeRequestMessage(["Qm...friendly-sub.bso", "Qm...friendly-sub.bso"]);
        const commentCidsEmpty = getChallengeRequestMessage([]);
        const commentCidsUndefined = getChallengeRequestMessage(undefined);
        const commentCidsWrongSubplebbitAddress = getChallengeRequestMessage(["Qm...wrong.bso,high,old", "Qm...wrong.bso,high,old"]);
        const commentCidsMoreThanMax = getChallengeRequestMessage([
            "Qm...friendly-sub.bso,high,new",
            "Qm...friendly-sub.bso,high,new",
            "Qm...friendly-sub.bso,high,old"
        ]);

        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsOld, plebbit)).to.equal(true);
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsNew, plebbit)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsNoAuthorSubplebbit, plebbit)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsEmpty, plebbit)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsUndefined, plebbit)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsWrongSubplebbitAddress, plebbit)).to.equal(
            false
        );
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsMoreThanMax, plebbit)).to.equal(false);
    });

    it("firstCommentTimestamp and postScore", async () => {
        const subplebbitChallenge = {
            exclude: [
                {
                    subplebbit: {
                        addresses: ["friendly-sub.bso"],
                        postScore: 100,
                        firstCommentTimestamp: 60 * 60 * 24 * 100, // 100 days
                        maxCommentCids: 2
                    }
                }
            ]
        };
        const commentCidsHighKarma = getChallengeRequestMessage(["Qm...friendly-sub.bso,high", "Qm...friendly-sub.bso,high"]);
        const commentCidsHighKarmaOld = getChallengeRequestMessage(["Qm...friendly-sub.bso,high,old", "Qm...friendly-sub.bso,high"]);
        const commentCidsHighKarmaNew = getChallengeRequestMessage(["Qm...friendly-sub.bso,high,new", "Qm...friendly-sub.bso,high"]);
        const commentCidsLowKarmaOld = getChallengeRequestMessage(["Qm...friendly-sub.bso,low,old", "Qm...friendly-sub.bso,low,old"]);
        const commentCidsNoAuthorSubplebbit = getChallengeRequestMessage(["Qm...friendly-sub.bso", "Qm...friendly-sub.bso"]);
        const commentCidsEmpty = getChallengeRequestMessage([]);
        const commentCidsWrongSubplebbitAddress = getChallengeRequestMessage(["Qm...wrong.bso,high", "Qm...wrong.bso,high"]);
        const commentCidsMoreThanMax = getChallengeRequestMessage([
            "Qm...friendly-sub.bso,low",
            "Qm...friendly-sub.bso,low",
            "Qm...friendly-sub.bso,high"
        ]);

        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsHighKarma, plebbit)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsHighKarmaOld, plebbit)).to.equal(true);
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsHighKarmaNew, plebbit)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsLowKarmaOld, plebbit)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsNoAuthorSubplebbit, plebbit)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsEmpty, plebbit)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsWrongSubplebbitAddress, plebbit)).to.equal(
            false
        );
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsMoreThanMax, plebbit)).to.equal(false);
    });

    it("firstCommentTimestamp or (postScore and replyScore)", async () => {
        const subplebbitChallenge = {
            exclude: [
                {
                    subplebbit: {
                        addresses: ["friendly-sub.bso"],
                        firstCommentTimestamp: 60 * 60 * 24 * 100, // 100 days
                        maxCommentCids: 2
                    }
                },
                {
                    subplebbit: {
                        addresses: ["friendly-sub.bso"],
                        replyScore: 100,
                        postScore: 100,
                        maxCommentCids: 2
                    }
                }
            ]
        };
        const commentCidsHighKarma = getChallengeRequestMessage(["Qm...friendly-sub.bso,high", "Qm...friendly-sub.bso,high"]);
        const commentCidsHighKarmaOld = getChallengeRequestMessage(["Qm...friendly-sub.bso,high,old", "Qm...friendly-sub.bso,high"]);
        const commentCidsHighKarmaNew = getChallengeRequestMessage(["Qm...friendly-sub.bso,high,new", "Qm...friendly-sub.bso,high"]);
        const commentCidsLowKarmaOld = getChallengeRequestMessage(["Qm...friendly-sub.bso,low,old", "Qm...friendly-sub.bso,low,old"]);
        const commentCidsLowKarmaNew = getChallengeRequestMessage(["Qm...friendly-sub.bso,low,new", "Qm...friendly-sub.bso,low,new"]);
        const commentCidsNoAuthorSubplebbit = getChallengeRequestMessage(["Qm...friendly-sub.bso", "Qm...friendly-sub.bso"]);
        const commentCidsEmpty = getChallengeRequestMessage([]);
        const commentCidsWrongSubplebbitAddress = getChallengeRequestMessage(["Qm...wrong.bso,high", "Qm...wrong.bso,high"]);
        const commentCidsMoreThanMax = getChallengeRequestMessage([
            "Qm...friendly-sub.bso,low",
            "Qm...friendly-sub.bso,low",
            "Qm...friendly-sub.bso,high"
        ]);

        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsHighKarma, plebbit)).to.equal(true);
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsHighKarmaOld, plebbit)).to.equal(true);
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsHighKarmaNew, plebbit)).to.equal(true);
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsLowKarmaOld, plebbit)).to.equal(true);
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsLowKarmaNew, plebbit)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsNoAuthorSubplebbit, plebbit)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsEmpty, plebbit)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsWrongSubplebbitAddress, plebbit)).to.equal(
            false
        );
        expect(await testShouldExcludeChallengeCommentCids(subplebbitChallenge, commentCidsMoreThanMax, plebbit)).to.equal(false);
    });
});
