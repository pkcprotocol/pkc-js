import { beforeAll } from "vitest";
import {
    shouldExcludeChallengeCommentCids,
    shouldExcludePublication,
    shouldExcludeChallengeSuccess
} from "../../dist/node/runtime/node/community/challenges/exclude/index.js";
import { addToRateLimiter } from "../../dist/node/runtime/node/community/challenges/exclude/rate-limiter.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "../../dist/node/pubsub-messages/types.js";
import type { LocalCommunity } from "../../dist/node/runtime/node/community/local-community.js";
import { clone } from "remeda";
import { PKC, authors, authorSigners, mockClientsManager } from "./fixtures/fixtures.ts";
import signers from "../fixtures/signers.js";
import validCommentEditFixture from "../fixtures/signatures/commentEdit/valid_comment_edit.json" with { type: "json" };
import validCommentFixture from "..//fixtures/signatures/comment/commentUpdate/valid_comment_ipfs.json" with { type: "json" };
import validVoteFixture from "../fixtures/valid_vote.json" with { type: "json" };

// Type helpers for function signatures
type CommunityChallengeArg = Parameters<typeof shouldExcludePublication>[0];
type ChallengeRequestArg = Parameters<typeof shouldExcludePublication>[1];
type CommunityArg = Parameters<typeof shouldExcludePublication>[2];

type AddToRateLimiterChallenges = Parameters<typeof addToRateLimiter>[0];
type AddToRateLimiterRequest = Parameters<typeof addToRateLimiter>[1];
type AddToRateLimiterSuccess = Parameters<typeof addToRateLimiter>[2];

type ShouldExcludeChallengeSuccessChallenge = Parameters<typeof shouldExcludeChallengeSuccess>[0];
type ShouldExcludeChallengeSuccessChallengeResults = Parameters<typeof shouldExcludeChallengeSuccess>[2];

type ShouldExcludeChallengeCommentCidsChallenge = Parameters<typeof shouldExcludeChallengeCommentCids>[0];
type ShouldExcludeChallengeCommentCidsRequest = Parameters<typeof shouldExcludeChallengeCommentCids>[1];
type ShouldExcludeChallengeCommentCidsPKC = Parameters<typeof shouldExcludeChallengeCommentCids>[2];

// Wrapper functions to reduce type assertion boilerplate
const testShouldExcludePublication = (
    communityChallenge: Record<string, unknown>,
    request: Record<string, unknown>,
    community?: Record<string, unknown>
): Promise<boolean> => {
    return shouldExcludePublication(
        communityChallenge as unknown as CommunityChallengeArg,
        request as unknown as ChallengeRequestArg,
        (community ?? undefined) as unknown as CommunityArg
    );
};

const testAddToRateLimiter = (
    communityChallenges: Record<string, unknown>[],
    request: Record<string, unknown>,
    challengeSuccess: boolean
): void => {
    addToRateLimiter(
        communityChallenges as unknown as AddToRateLimiterChallenges,
        request as unknown as AddToRateLimiterRequest,
        challengeSuccess as AddToRateLimiterSuccess
    );
};

const testShouldExcludeChallengeSuccess = (
    communityChallenge: Record<string, unknown>,
    communityChallengeIndex: number,
    challengeResults: Record<string, unknown>[]
): boolean => {
    return shouldExcludeChallengeSuccess(
        communityChallenge as unknown as ShouldExcludeChallengeSuccessChallenge,
        communityChallengeIndex,
        challengeResults as unknown as ShouldExcludeChallengeSuccessChallengeResults
    );
};

const testShouldExcludeChallengeCommentCids = (
    communityChallenge: Record<string, unknown>,
    challengeRequestMessage: {
        comment: { author: { address: string }; signature: { publicKey: string } };
        challengeCommentCids: string[] | undefined;
    },
    pkc: unknown
): Promise<boolean> => {
    return shouldExcludeChallengeCommentCids(
        communityChallenge as unknown as ShouldExcludeChallengeCommentCidsChallenge,
        challengeRequestMessage as unknown as ShouldExcludeChallengeCommentCidsRequest,
        pkc as unknown as ShouldExcludeChallengeCommentCidsPKC
    );
};

// sometimes use random addresses because the rate limiter
// is based on author addresses and doesn't reset between tests
const getRandomAddress = (): string => String(Math.random());

describe("shouldExcludePublication", () => {
    it("empty", async () => {
        const publication = { author: { address: "Qm..." } };
        let communityChallenge: { exclude: undefined | unknown[] } = { exclude: [] };
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication })).to.equal(false);
        communityChallenge = { exclude: undefined };
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication })).to.equal(false);
    });

    it("postScore and replyScore", async () => {
        const communityChallenge = {
            exclude: [{ postScore: 100 }, { replyScore: 100 }]
        };
        const authorScoreUndefined = {
            author: { community: {} }
        };
        const authorCommunityUndefined = {
            author: {}
        };
        const authorPostScoreLow = {
            author: {
                community: {
                    postScore: 99
                }
            }
        };
        const authorPostScoreHigh = {
            author: {
                community: {
                    postScore: 100
                }
            }
        };
        const authorReplyScoreLow = {
            author: {
                community: {
                    replyScore: 99
                }
            }
        };
        const authorReplyScoreHigh = {
            author: {
                community: {
                    replyScore: 100
                }
            }
        };
        const authorReplyAndPostScoreHigh = {
            author: {
                community: {
                    postScore: 100,
                    replyScore: 100
                }
            }
        };
        const authorReplyAndPostScoreLow = {
            author: {
                community: {
                    postScore: 99,
                    replyScore: 99
                }
            }
        };
        expect(await testShouldExcludePublication(communityChallenge, { comment: authorScoreUndefined })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: authorCommunityUndefined })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: authorPostScoreLow })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: authorPostScoreHigh })).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { comment: authorReplyScoreLow })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: authorReplyScoreHigh }, authorReplyScoreHigh)).to.equal(
            true
        );
        expect(await testShouldExcludePublication(communityChallenge, { comment: authorReplyAndPostScoreHigh })).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { comment: authorReplyAndPostScoreLow })).to.equal(false);
    });

    it("firstCommentTimestamp", async () => {
        const communityChallenge = {
            exclude: [
                { firstCommentTimestamp: 60 * 60 * 24 * 100 } // 100 days
            ]
        };
        const oldAuthor = {
            author: {
                community: {
                    firstCommentTimestamp: Math.round(Date.now() / 1000) - 60 * 60 * 24 * 101 // 101 days
                }
            }
        };
        const newAuthor = {
            author: {
                community: {
                    firstCommentTimestamp: Math.round(Date.now() / 1000) - 60 * 60 * 24 * 99 // 99 days
                }
            }
        };
        expect(await testShouldExcludePublication(communityChallenge, { comment: oldAuthor })).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { comment: newAuthor })).to.equal(false);
    });

    it("firstCommentTimestamp and postScore", async () => {
        const communityChallenge = {
            exclude: [
                {
                    postScore: 100,
                    firstCommentTimestamp: 60 * 60 * 24 * 100 // 100 days
                }
            ]
        };
        const oldAuthor = {
            author: {
                community: {
                    postScore: 100,
                    firstCommentTimestamp: Math.round(Date.now() / 1000) - 60 * 60 * 24 * 101 // 101 days
                }
            }
        };
        const newAuthor = {
            author: {
                community: {
                    postScore: 99,
                    firstCommentTimestamp: Math.round(Date.now() / 1000) - 60 * 60 * 24 * 101 // 101 days
                }
            }
        };
        expect(await testShouldExcludePublication(communityChallenge, { comment: oldAuthor })).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { comment: newAuthor })).to.equal(false);
    });

    it("firstCommentTimestamp or (postScore and replyScore)", async () => {
        const communityChallenge = {
            exclude: [
                { postScore: 100, replyScore: 100 },
                { firstCommentTimestamp: 60 * 60 * 24 * 100 } // 100 days
            ]
        };
        const oldAuthor = {
            author: {
                community: {
                    firstCommentTimestamp: Math.round(Date.now() / 1000) - 60 * 60 * 24 * 101 // 101 days
                }
            }
        };
        const newAuthor = {
            author: {
                community: {
                    postScore: 101,
                    firstCommentTimestamp: Math.round(Date.now() / 1000) - 60 * 60 * 24 * 99 // 99 days
                }
            }
        };
        const popularAuthor = {
            author: {
                community: {
                    postScore: 100,
                    replyScore: 100
                }
            }
        };
        expect(await testShouldExcludePublication(communityChallenge, { comment: oldAuthor })).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { comment: newAuthor })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: popularAuthor })).to.equal(true);
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
    const communityEdit = {
        communityAddress: "Qm...",
        communityEdit: { title: "New Title" },
        author
    };

    it("publicationType.post", async () => {
        const communityChallenge = {
            exclude: [{ publicationType: { post: true } }]
        };
        expect(await testShouldExcludePublication(communityChallenge, { comment: post })).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { comment: reply })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { vote })).to.equal(false);
    });

    it("publicationType.reply", async () => {
        const communityChallenge = {
            exclude: [{ publicationType: { reply: true } }]
        };
        expect(await testShouldExcludePublication(communityChallenge, { comment: post })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: reply })).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { vote })).to.equal(false);
    });

    it("publicationType.vote", async () => {
        const communityChallenge = {
            exclude: [{ publicationType: { vote: true } }]
        };
        expect(await testShouldExcludePublication(communityChallenge, { comment: post })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: reply })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { vote })).to.equal(true);
    });

    it("publicationType.vote and publicationType.reply", async () => {
        const communityChallenge = {
            exclude: [{ publicationType: { vote: true, reply: true } }]
        };
        expect(await testShouldExcludePublication(communityChallenge, { comment: post })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: reply })).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { vote })).to.equal(true);
    });

    it("publicationType.communityEdit and publicationType.commentEdit", async () => {
        const communityChallenge = {
            exclude: [{ publicationType: { communityEdit: true, commentEdit: true } }]
        };
        expect(await testShouldExcludePublication(communityChallenge, { comment: post })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: reply })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { vote })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { commentEdit })).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { commentModeration })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { communityEdit })).to.equal(true);
    });

    it("publicationType.commentEdit", async () => {
        const communityChallenge = {
            exclude: [{ publicationType: { commentEdit: true } }]
        };
        expect(await testShouldExcludePublication(communityChallenge, { comment: post })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: reply })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { vote })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { commentEdit })).to.equal(true);
    });

    it("publicationType.commentModeration", async () => {
        const communityChallenge = {
            exclude: [{ publicationType: { commentModeration: true } }]
        };
        expect(await testShouldExcludePublication(communityChallenge, { comment: post })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: reply })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { vote })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { commentModeration })).to.equal(true);
    });

    it("publicationType.communityEdit", async () => {
        const communityChallenge = {
            exclude: [{ publicationType: { communityEdit: true } }]
        };
        expect(await testShouldExcludePublication(communityChallenge, { comment: post })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: reply })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { vote })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { commentEdit })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { commentModeration })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { communityEdit })).to.equal(true);
    });

    // Exclude based on roles
    it("Moderator edits are excluded from challenges", async () => {
        const communityChallenge = {
            exclude: [{ roles: ["moderator", "admin", "owner"], publicationType: { commentModeration: true } }]
        };
        // the mod is identified by its signer address (issue #267): role keys are matched through the signature
        const modSigner = signers[0];
        const modAuthor = { address: modSigner.address, displayName: "Mod User" };

        const commentEditOfMod = clone(validCommentEditFixture);
        commentEditOfMod.author = modAuthor;
        commentEditOfMod.signature = { ...commentEditOfMod.signature, publicKey: modSigner.publicKey };

        const postOfMod = clone(validCommentFixture);
        postOfMod.author = modAuthor;
        postOfMod.signature = { ...postOfMod.signature, publicKey: modSigner.publicKey };

        const replyOfMod = {
            ...postOfMod,
            parentCid: "Qm..."
        };
        const voteOfMod = clone(validVoteFixture);
        voteOfMod.author = modAuthor;
        voteOfMod.signature = { ...voteOfMod.signature, publicKey: modSigner.publicKey };

        // Mock community with roles - the mod signer is a moderator
        const community = {
            roles: {
                [modSigner.address]: { role: "moderator" }
            }
        };

        expect(await testShouldExcludePublication(communityChallenge, { commentModeration: commentEditOfMod }, community)).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { comment: postOfMod }, community)).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: replyOfMod }, community)).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { vote: voteOfMod }, community)).to.equal(false);
    });

    it("should only exclude authors with specified roles, not all authors (bug reproduction)", async () => {
        const communityChallenge = {
            exclude: [{ roles: ["moderator", "admin", "owner"] }]
        };

        // Author without any roles
        const regularAuthor = { address: signers[1].address };
        const postByRegularUser = {
            content: "test post",
            author: regularAuthor,
            signature: { publicKey: signers[1].publicKey }
        };

        // Author with moderator role
        const modAuthor = { address: signers[0].address };
        const postByMod = {
            content: "test post",
            author: modAuthor,
            signature: { publicKey: signers[0].publicKey }
        };

        // Mock community with roles
        const community = {
            roles: {
                [signers[0].address]: { role: "moderator" }
            }
        };

        // BUG: When community parameter is missing, both should return false but might not
        const resultRegularUserWithoutCommunity = await testShouldExcludePublication(communityChallenge, { comment: postByRegularUser });
        const resultModWithoutCommunity = await testShouldExcludePublication(communityChallenge, { comment: postByMod });

        // Expected behavior: regular user should NOT be excluded
        expect(resultRegularUserWithoutCommunity).to.equal(false);
        // Expected behavior: mod should also NOT be excluded without role info
        expect(resultModWithoutCommunity).to.equal(false);

        // CORRECT: When community parameter is provided with roles
        const resultRegularUserWithCommunity = await testShouldExcludePublication(
            communityChallenge,
            { comment: postByRegularUser },
            community
        );
        const resultModWithCommunity = await testShouldExcludePublication(communityChallenge, { comment: postByMod }, community);

        // Expected behavior: regular user should NOT be excluded
        expect(resultRegularUserWithCommunity).to.equal(false);
        // Expected behavior: mod should be excluded
        expect(resultModWithCommunity).to.equal(true);
    });

    // Issue #267: identity excludes are bound to the signature, not to the publisher-controlled author.address
    it("publicKeys matches the signer regardless of the claimed author.address", async () => {
        const communityChallenge = { exclude: [{ publicKeys: [signers[0].address] }] };
        const signedByZero = { author: { address: "whatever.bso" }, signature: { publicKey: signers[0].publicKey } };
        const signedByOne = { author: { address: signers[0].address }, signature: { publicKey: signers[1].publicKey } };
        expect(await testShouldExcludePublication(communityChallenge, { comment: signedByZero })).to.equal(true);
        // claiming the excluded address without signing with its key does not match
        expect(await testShouldExcludePublication(communityChallenge, { comment: signedByOne })).to.equal(false);
    });

    it("names matches only when the wire name is the domain and it resolves to the signer", async () => {
        const communityChallenge = { exclude: [{ names: ["high-karma.bso"] }] };
        const community = { _clientsManager: mockClientsManager, _pkc: PKC() };
        const owner = { author: { address: "high-karma.bso" }, signature: { publicKey: authorSigners["high-karma.bso"].publicKey } };
        const impostor = { author: { address: "high-karma.bso" }, signature: { publicKey: signers[8].publicKey } };
        const ownerWithoutName = {
            author: { address: signers[0].address },
            signature: { publicKey: authorSigners["high-karma.bso"].publicKey }
        };
        const unresolvable = { author: { address: "unknown.bso" }, signature: { publicKey: signers[8].publicKey } };
        expect(await testShouldExcludePublication(communityChallenge, { comment: owner }, community)).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { comment: impostor }, community)).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: ownerWithoutName }, community)).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: unresolvable }, community)).to.equal(false);
    });

    it("names does not match when the resolver throws", async () => {
        const communityChallenge = { exclude: [{ names: ["high-karma.bso"] }] };
        const community = {
            _clientsManager: {
                resolveAuthorNameIfNeeded: async () => {
                    throw new Error("resolver down");
                }
            },
            _pkc: PKC()
        };
        const owner = { author: { address: "high-karma.bso" }, signature: { publicKey: authorSigners["high-karma.bso"].publicKey } };
        expect(await testShouldExcludePublication(communityChallenge, { comment: owner }, community)).to.equal(false);
    });

    it("role with a domain role key is bound to the signer", async () => {
        const communityChallenge = { exclude: [{ roles: ["moderator"] }] };
        const community = { roles: { "high-karma.bso": { role: "moderator" } }, _clientsManager: mockClientsManager, _pkc: PKC() };
        const owner = { author: { address: "high-karma.bso" }, signature: { publicKey: authorSigners["high-karma.bso"].publicKey } };
        const impostor = { author: { address: "high-karma.bso" }, signature: { publicKey: signers[8].publicKey } };
        expect(await testShouldExcludePublication(communityChallenge, { comment: owner }, community)).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { comment: impostor }, community)).to.equal(false);
    });

    it("postCount", async () => {
        const communityChallenge = {
            exclude: [{ postCount: 10 }]
        };
        const publication = { author: { address: "Qm..." }, signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" } };
        const mockCommunityExact = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 10, replyCount: 0 }) }
        };
        const mockCommunityAbove = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 11, replyCount: 0 }) }
        };
        const mockCommunityBelow = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 9, replyCount: 0 }) }
        };
        const mockCommunityZero = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 0, replyCount: 0 }) }
        };
        // exact threshold -> excluded
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockCommunityExact)).to.equal(true);
        // above threshold -> excluded
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockCommunityAbove)).to.equal(true);
        // below threshold -> not excluded
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockCommunityBelow)).to.equal(false);
        // zero posts -> not excluded
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockCommunityZero)).to.equal(false);
    });

    it("replyCount", async () => {
        const communityChallenge = {
            exclude: [{ replyCount: 5 }]
        };
        const publication = { author: { address: "Qm..." }, signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" } };
        const mockCommunityExact = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 0, replyCount: 5 }) }
        };
        const mockCommunityAbove = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 0, replyCount: 20 }) }
        };
        const mockCommunityBelow = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 0, replyCount: 4 }) }
        };
        // exact threshold -> excluded
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockCommunityExact)).to.equal(true);
        // above threshold -> excluded
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockCommunityAbove)).to.equal(true);
        // below threshold -> not excluded
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockCommunityBelow)).to.equal(false);
    });

    it("postCount OR replyCount (separate exclude rules)", async () => {
        const communityChallenge = {
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
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockHighPostOnly)).to.equal(true);
        // replyCount meets second exclude rule -> excluded
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockHighReplyOnly)).to.equal(true);
        // both meet -> excluded
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockBothHigh)).to.equal(true);
        // neither meets -> not excluded
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockBothLow)).to.equal(false);
    });

    it("postCount AND replyCount (same exclude rule)", async () => {
        const communityChallenge = {
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
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockBothMeet)).to.equal(true);
        // only postCount meets -> not excluded (AND requires both)
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockOnlyPostMeets)).to.equal(false);
        // only replyCount meets -> not excluded
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockOnlyReplyMeets)).to.equal(false);
        // neither meets -> not excluded
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockNeitherMeets)).to.equal(false);
    });

    it("postCount without _dbHandler", async () => {
        const communityChallenge = {
            exclude: [{ postCount: 5 }]
        };
        const publication = { author: { address: "Qm..." }, signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" } };
        // no community arg -> counts are undefined -> should not exclude
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication })).to.equal(false);
        // empty community (no _dbHandler) -> should not exclude
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, {})).to.equal(false);
    });

    it("postCount with threshold of 0 (exclude everyone)", async () => {
        const communityChallenge = {
            exclude: [{ postCount: 0 }]
        };
        const publication = { author: { address: "Qm..." }, signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" } };
        const mockCommunityZero = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 0, replyCount: 0 }) }
        };
        const mockCommunitySome = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 3, replyCount: 0 }) }
        };
        // 0 >= 0 -> excluded
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockCommunityZero)).to.equal(true);
        // 3 >= 0 -> excluded
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockCommunitySome)).to.equal(true);
    });

    it("postCount AND postScore in same exclude rule (AND logic)", async () => {
        const communityChallenge = {
            exclude: [{ postCount: 5, postScore: 100 }]
        };
        const publication = {
            author: { address: "Qm...", community: { postScore: 100 } },
            signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" }
        };
        const publicationLowScore = {
            author: { address: "Qm...", community: { postScore: 99 } },
            signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" }
        };
        const mockCommunityHighCount = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 5, replyCount: 0 }) }
        };
        const mockCommunityLowCount = {
            _dbHandler: { queryAuthorPublicationCounts: () => ({ postCount: 4, replyCount: 0 }) }
        };
        // both postCount (5 >= 5) AND postScore (100 >= 100) meet threshold -> excluded
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockCommunityHighCount)).to.equal(true);
        // postCount too low -> not excluded despite postScore being high
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockCommunityLowCount)).to.equal(false);
        // postScore too low -> not excluded despite postCount being high
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationLowScore }, mockCommunityHighCount)).to.equal(
            false
        );
    });

    it("postCount AND firstCommentTimestamp in same exclude rule", async () => {
        const communityChallenge = {
            exclude: [{ postCount: 3, firstCommentTimestamp: 60 * 60 * 24 * 100 }] // 100 days
        };
        const oldAuthor = {
            author: {
                address: "Qm...",
                community: { firstCommentTimestamp: Math.round(Date.now() / 1000) - 60 * 60 * 24 * 101 } // 101 days
            },
            signature: { publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0" }
        };
        const newAuthor = {
            author: {
                address: "Qm...",
                community: { firstCommentTimestamp: Math.round(Date.now() / 1000) - 60 * 60 * 24 * 99 } // 99 days
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
        expect(await testShouldExcludePublication(communityChallenge, { comment: oldAuthor }, mockHighCount)).to.equal(true);
        // old author AND low count -> not excluded
        expect(await testShouldExcludePublication(communityChallenge, { comment: oldAuthor }, mockLowCount)).to.equal(false);
        // new author AND high count -> not excluded
        expect(await testShouldExcludePublication(communityChallenge, { comment: newAuthor }, mockHighCount)).to.equal(false);
    });

    it("postCount AND publicationType in same exclude rule", async () => {
        const communityChallenge = {
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
        expect(await testShouldExcludePublication(communityChallenge, { comment: postPub }, mockHighCount)).to.equal(true);
        // reply with high count -> not excluded (publicationType doesn't match)
        expect(await testShouldExcludePublication(communityChallenge, { comment: replyPub }, mockHighCount)).to.equal(false);
    });

    it("replyCount AND rateLimit in same exclude rule", async () => {
        const communityChallenge = {
            exclude: [{ replyCount: 3, rateLimit: 1 }]
        };
        const communityChallenges = [communityChallenge];
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
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockHighCount)).to.equal(true);
        // low count -> not excluded even before rate limit
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockLowCount)).to.equal(false);
        // after rate limiting
        testAddToRateLimiter(communityChallenges, { comment: publication }, true);
        // high count but rate limited -> not excluded
        expect(await testShouldExcludePublication(communityChallenge, { comment: publication }, mockHighCount)).to.equal(false);
    });

    it("firstCommentTimestamp OR postCount (separate exclude rules)", async () => {
        const communityChallenge = {
            exclude: [
                { firstCommentTimestamp: 60 * 60 * 24 * 100 }, // 100 days
                { postCount: 5 }
            ]
        };
        const oldAuthorNoSignature = {
            author: {
                address: "Qm...",
                community: { firstCommentTimestamp: Math.round(Date.now() / 1000) - 60 * 60 * 24 * 101 } // 101 days
            }
        };
        const newAuthorWithSignature = {
            author: {
                address: "Qm...",
                community: { firstCommentTimestamp: Math.round(Date.now() / 1000) - 60 * 60 * 24 * 10 } // 10 days
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
        expect(await testShouldExcludePublication(communityChallenge, { comment: oldAuthorNoSignature })).to.equal(true);
        // new author but high count -> excluded by postCount rule
        expect(await testShouldExcludePublication(communityChallenge, { comment: newAuthorWithSignature }, mockHighCount)).to.equal(true);
        // new author and low count -> not excluded by either rule
        expect(await testShouldExcludePublication(communityChallenge, { comment: newAuthorWithSignature }, mockLowCount)).to.equal(false);
    });

    it("rateLimit", async () => {
        const communityChallenge = {
            exclude: [
                { rateLimit: 1 } // 1 publication per hour
            ]
        };
        const communityChallenges = [communityChallenge];
        const publicationAuthor1 = { author: { address: getRandomAddress() } };
        const publicationAuthor2 = { author: { address: getRandomAddress() } };
        const challengeSuccess = true;
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationAuthor1 })).to.equal(true);
        testAddToRateLimiter(communityChallenges, { comment: publicationAuthor1 }, challengeSuccess);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationAuthor1 })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationAuthor2 })).to.equal(true);
    });

    it("rateLimit and postScore", async () => {
        const communityChallenge = {
            exclude: [{ postScore: 100, rateLimit: 1 }]
        };
        const address = getRandomAddress();
        const authorScoreUndefined = {
            author: { address, community: {} }
        };
        const authorCommunityUndefined = {
            author: { address }
        };
        const authorPostScoreLow = {
            author: {
                address,
                community: {
                    postScore: 99
                }
            }
        };
        const authorPostScoreHigh = {
            author: {
                address,
                community: {
                    postScore: 100
                }
            }
        };
        expect(await testShouldExcludePublication(communityChallenge, { comment: authorScoreUndefined })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: authorCommunityUndefined })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: authorPostScoreLow })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: authorPostScoreHigh })).to.equal(true);

        // after rate limited
        const communityChallenges = [communityChallenge];
        const challengeSuccess = true;
        testAddToRateLimiter(communityChallenges, { comment: authorPostScoreHigh }, challengeSuccess);
        expect(await testShouldExcludePublication(communityChallenge, { comment: authorScoreUndefined })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: authorCommunityUndefined })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: authorPostScoreLow })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: authorPostScoreHigh })).to.equal(false);
    });

    it("rateLimit challengeSuccess false", async () => {
        const communityChallenge = {
            exclude: [
                { rateLimit: 1 } // 1 publication per hour
            ]
        };
        const communityChallenges = [communityChallenge];
        const publicationAuthor1 = { author: { address: getRandomAddress() } };
        const publicationAuthor2 = { author: { address: getRandomAddress() } };
        const challengeSuccess = false;
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationAuthor1 })).to.equal(true);
        testAddToRateLimiter(communityChallenges, { comment: publicationAuthor1 }, challengeSuccess);
        // without rateLimitChallengeSuccess, rateLimit only applies to challengeSuccess true publications
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationAuthor1 })).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationAuthor2 })).to.equal(true);
    });

    it("rateLimit post, reply, vote", async () => {
        const communityChallenge = {
            exclude: [
                { publicationType: { post: true }, rateLimit: 1 }, // 1 per hour
                { publicationType: { reply: true }, rateLimit: 1 }, // 1 per hour
                { publicationType: { vote: true }, rateLimit: 1 } // 1 per hour
            ]
        };
        const communityChallenges = [communityChallenge];
        const author = { address: getRandomAddress() };
        const publicationPost = { author };
        const publicationReply = { author, parentCid: "Qm..." };
        const publicationVote = { author, commentCid: "Qm...", vote: 0 };
        let challengeSuccess = true;
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationPost })).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationReply })).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { vote: publicationVote })).to.equal(true);
        testAddToRateLimiter(communityChallenges, { comment: publicationPost }, challengeSuccess);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationPost })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationReply })).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { vote: publicationVote })).to.equal(true);
        testAddToRateLimiter(communityChallenges, { comment: publicationReply }, challengeSuccess);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationPost })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationReply })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { vote: publicationVote })).to.equal(true);

        // publish with challengeSuccess false, should do nothing
        challengeSuccess = false;
        testAddToRateLimiter(communityChallenges, { vote: publicationVote }, challengeSuccess);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationPost })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationReply })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { vote: publicationVote })).to.equal(true);

        // publish with challengeSuccess true, should rate limit
        challengeSuccess = true;
        testAddToRateLimiter(communityChallenges, { vote: publicationVote }, challengeSuccess);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationPost })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationReply })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { vote: publicationVote })).to.equal(false);
    });

    it("rateLimit rateLimitChallengeSuccess true", async () => {
        const communityChallenge = {
            exclude: [
                { rateLimit: 1, rateLimitChallengeSuccess: true } // 1 publication per hour
            ]
        };
        const communityChallenges = [communityChallenge];
        const publicationAuthor1 = { author: { address: getRandomAddress() } };
        const publicationAuthor2 = { author: { address: getRandomAddress() } };
        const challengeSuccess = true;
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationAuthor1 })).to.equal(true);
        testAddToRateLimiter(communityChallenges, { comment: publicationAuthor1 }, challengeSuccess);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationAuthor1 })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationAuthor2 })).to.equal(true);
    });

    it("rateLimit rateLimitChallengeSuccess true challengeSuccess false", async () => {
        const communityChallenge = {
            exclude: [
                { rateLimit: 1, rateLimitChallengeSuccess: true } // 1 publication per hour
            ]
        };
        const communityChallenges = [communityChallenge];
        const publicationAuthor1 = { author: { address: getRandomAddress() } };
        const publicationAuthor2 = { author: { address: getRandomAddress() } };
        const challengeSuccess = false;
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationAuthor1 })).to.equal(true);
        testAddToRateLimiter(communityChallenges, { comment: publicationAuthor1 }, challengeSuccess);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationAuthor1 })).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationAuthor2 })).to.equal(true);
    });

    it("rateLimit rateLimitChallengeSuccess false challengeSuccess true", async () => {
        const communityChallenge = {
            exclude: [
                { rateLimit: 1, rateLimitChallengeSuccess: false } // 1 publication per hour
            ]
        };
        const communityChallenges = [communityChallenge];
        const publicationAuthor1 = { author: { address: getRandomAddress() } };
        const publicationAuthor2 = { author: { address: getRandomAddress() } };
        const challengeSuccess = true;
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationAuthor1 })).to.equal(true);
        testAddToRateLimiter(communityChallenges, { comment: publicationAuthor1 }, challengeSuccess);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationAuthor1 })).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationAuthor2 })).to.equal(true);
    });

    it("rateLimit rateLimitChallengeSuccess false challengeSuccess false", async () => {
        const communityChallenge = {
            exclude: [
                { rateLimit: 1, rateLimitChallengeSuccess: false } // 1 publication per hour
            ]
        };
        const communityChallenges = [communityChallenge];
        const publicationAuthor1 = { author: { address: getRandomAddress() } };
        const publicationAuthor2 = { author: { address: getRandomAddress() } };
        const challengeSuccess = false;
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationAuthor1 })).to.equal(true);
        testAddToRateLimiter(communityChallenges, { comment: publicationAuthor1 }, challengeSuccess);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationAuthor1 })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationAuthor2 })).to.equal(true);
    });

    it("rateLimit post, reply rateLimitChallengeSuccess false", async () => {
        const communityChallenge = {
            exclude: [
                { publicationType: { post: true }, rateLimit: 1, rateLimitChallengeSuccess: false }, // 1 per hour
                { publicationType: { reply: true }, rateLimit: 1 } // 1 per hour
            ]
        };
        const communityChallenges = [communityChallenge];
        const author = { address: getRandomAddress() };
        const publicationPost = { author };
        const publicationReply = { author, parentCid: "Qm..." };
        const publicationVote = { author, commentCid: "Qm...", vote: 0 };
        let challengeSuccess = true;

        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationPost })).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationReply })).to.equal(true);
        // vote can never pass because it's not included in any of the excludes
        expect(await testShouldExcludePublication(communityChallenge, { vote: publicationVote })).to.equal(false);

        // no effect because post true and rateLimitChallengeSuccess false
        testAddToRateLimiter(communityChallenges, { comment: publicationPost }, challengeSuccess);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationPost })).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationReply })).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { vote: publicationVote })).to.equal(false);

        // now has effect because success false
        challengeSuccess = false;
        testAddToRateLimiter(communityChallenges, { comment: publicationPost }, challengeSuccess);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationPost })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationReply })).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { vote: publicationVote })).to.equal(false);

        // no effect because reply true, challengeSuccess false and rateLimitChallengeSuccess undefined
        testAddToRateLimiter(communityChallenges, { comment: publicationReply }, challengeSuccess);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationPost })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationReply })).to.equal(true);
        expect(await testShouldExcludePublication(communityChallenge, { vote: publicationVote })).to.equal(false);

        // now has effect because success true
        challengeSuccess = true;
        testAddToRateLimiter(communityChallenges, { comment: publicationReply }, challengeSuccess);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationPost })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { comment: publicationReply })).to.equal(false);
        expect(await testShouldExcludePublication(communityChallenge, { vote: publicationVote })).to.equal(false);
    });
});

describe("shouldExcludeChallengeSuccess", () => {
    it("exclude 0, 1", () => {
        const communityChallenge = {
            exclude: [{ challenges: [0, 1] }]
        };
        const challengeResultsSucceed2 = [{ success: true }, { success: true }, { success: false }];
        const challengeResultsSucceed3 = [{ success: true }, { success: true }, { success: true }];
        const challengeResultsFail1 = [{ success: true }, { success: false }];
        const challengeResultsFail2 = [{ success: false }, { success: false }];
        const challengeResultsEmpty: Record<string, unknown>[] = [];
        const challengeResultsMixed = [{ success: true }, { success: false }, { success: true }, { success: false }];
        expect(testShouldExcludeChallengeSuccess(communityChallenge, 0, challengeResultsSucceed2)).to.equal(true);
        expect(testShouldExcludeChallengeSuccess(communityChallenge, 0, challengeResultsSucceed3)).to.equal(true);
        expect(testShouldExcludeChallengeSuccess(communityChallenge, 0, challengeResultsFail1)).to.equal(false);
        expect(testShouldExcludeChallengeSuccess(communityChallenge, 0, challengeResultsFail2)).to.equal(false);
        expect(testShouldExcludeChallengeSuccess(communityChallenge, 0, challengeResultsEmpty)).to.equal(false);
        expect(testShouldExcludeChallengeSuccess(communityChallenge, 0, challengeResultsMixed)).to.equal(false);
    });

    it("exclude (0, 1) or 2", () => {
        const communityChallenge = {
            exclude: [{ challenges: [0, 1] }, { challenges: [2] }]
        };
        const challengeResultsSucceed12 = [{ success: true }, { success: true }, { success: false }];
        const challengeResultsSucceed123 = [{ success: true }, { success: true }, { success: true }];
        const challengeResultsSucceed3 = [{ success: false }, { success: false }, { success: true }];
        const challengeResultsSucceed4 = [{ success: false }, { success: false }, { success: false }, { success: true }];
        const challengeResultsEmpty: Record<string, unknown>[] = [];
        expect(testShouldExcludeChallengeSuccess(communityChallenge, 0, challengeResultsSucceed12)).to.equal(true);
        expect(testShouldExcludeChallengeSuccess(communityChallenge, 0, challengeResultsSucceed123)).to.equal(true);
        expect(testShouldExcludeChallengeSuccess(communityChallenge, 0, challengeResultsSucceed3)).to.equal(true);
        expect(testShouldExcludeChallengeSuccess(communityChallenge, 0, challengeResultsSucceed4)).to.equal(false);
        expect(testShouldExcludeChallengeSuccess(communityChallenge, 0, challengeResultsEmpty)).to.equal(false);
    });

    it("should handle undefined challenge results", () => {
        const communityChallenge = {
            exclude: [{ challenges: [0, 1] }]
        };
        // This reproduces the error: challengeResults[1] is undefined
        const challengeResultsWithUndefined = [{ success: true }];

        // This should not throw an error and should return false
        expect(() => testShouldExcludeChallengeSuccess(communityChallenge, 0, challengeResultsWithUndefined)).to.not.throw();
        expect(testShouldExcludeChallengeSuccess(communityChallenge, 0, challengeResultsWithUndefined)).to.equal(false);
    });

    it("should handle out of bounds challenge indices", () => {
        const communityChallenge = {
            exclude: [{ challenges: [5, 10] }] // indices that don't exist in the array
        };
        const challengeResults = [{ success: true }, { success: false }];

        // This should not throw an error and should return false
        expect(() => testShouldExcludeChallengeSuccess(communityChallenge, 0, challengeResults)).to.not.throw();
        expect(testShouldExcludeChallengeSuccess(communityChallenge, 0, challengeResults)).to.equal(false);
    });

    it("should handle mixed undefined and valid challenge results", () => {
        const communityChallenge = {
            exclude: [{ challenges: [0, 2] }] // index 2 doesn't exist
        };
        const challengeResults = [{ success: true }, { success: false }]; // only 2 elements, index 2 is undefined

        // This should not throw an error and should return false
        expect(() => testShouldExcludeChallengeSuccess(communityChallenge, 0, challengeResults)).to.not.throw();
        expect(testShouldExcludeChallengeSuccess(communityChallenge, 0, challengeResults)).to.equal(false);
    });

    it("pending challenges excludes failed non pending challenge", () => {
        const communityChallenge = {
            exclude: [{ challenges: [1] }]
        };
        const challengeResults = [{ success: false }, { challenge: "What is the password?" }];

        expect(testShouldExcludeChallengeSuccess(communityChallenge, 0, challengeResults)).to.equal(true);
        expect(testShouldExcludeChallengeSuccess(communityChallenge, 1, challengeResults)).to.equal(false);
    });

    it("pending challenges does not exclude another pending challenge", () => {
        const communityChallenge = {
            exclude: [{ challenges: [1] }]
        };
        const challengeResults = [{ challenge: "What is the password?" }, { challenge: "What is the other password?" }];

        expect(testShouldExcludeChallengeSuccess(communityChallenge, 0, challengeResults)).to.equal(false);
        expect(testShouldExcludeChallengeSuccess(communityChallenge, 1, challengeResults)).to.equal(false);
    });
});

describe("shouldExcludeChallengeCommentCids", () => {
    const getChallengeRequestMessage = (
        commentCids: string[] | undefined
    ): { comment: { author: { address: string }; signature: { publicKey: string } }; challengeCommentCids: string[] | undefined } => {
        // define author based on high or low karma; the friendly-community comments must be signed by the same key
        const author = { address: "Qm..." };
        let signer = signers[8];
        const [_communityAddress, karma, _age] = (commentCids?.[0] || "").replace("Qm...", "").split(",");
        if (karma === "high") {
            author.address = authors[0].address;
            signer = authorSigners[authors[0].address];
        } else if (karma === "low") {
            author.address = authors[1].address;
            signer = authorSigners[authors[1].address];
        }
        return {
            comment: { author, signature: { publicKey: signer.publicKey } },
            challengeCommentCids: commentCids
        };
    };

    let pkc: ReturnType<typeof PKC>;
    beforeAll(async () => {
        pkc = await PKC();
    });

    it("firstCommentTimestamp", async () => {
        const communityChallenge = {
            exclude: [
                {
                    community: {
                        addresses: ["friendly-sub.bso"],
                        firstCommentTimestamp: 60 * 60 * 24 * 100, // 100 days
                        maxCommentCids: 2
                    }
                }
            ]
        };

        const commentCidsOld = getChallengeRequestMessage(["Qm...friendly-sub.bso,high,old", "Qm...friendly-sub.bso,high,old"]);
        const commentCidsNew = getChallengeRequestMessage(["Qm...friendly-sub.bso,high,new", "Qm...friendly-sub.bso,high,new"]);
        const commentCidsNoAuthorCommunity = getChallengeRequestMessage(["Qm...friendly-sub.bso", "Qm...friendly-sub.bso"]);
        const commentCidsEmpty = getChallengeRequestMessage([]);
        const commentCidsUndefined = getChallengeRequestMessage(undefined);
        const commentCidsWrongCommunityAddress = getChallengeRequestMessage(["Qm...wrong.bso,high,old", "Qm...wrong.bso,high,old"]);
        const commentCidsMoreThanMax = getChallengeRequestMessage([
            "Qm...friendly-sub.bso,high,new",
            "Qm...friendly-sub.bso,high,new",
            "Qm...friendly-sub.bso,high,old"
        ]);

        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsOld, pkc)).to.equal(true);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsNew, pkc)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsNoAuthorCommunity, pkc)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsEmpty, pkc)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsUndefined, pkc)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsWrongCommunityAddress, pkc)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsMoreThanMax, pkc)).to.equal(false);
    });

    it("firstCommentTimestamp and postScore", async () => {
        const communityChallenge = {
            exclude: [
                {
                    community: {
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
        const commentCidsNoAuthorCommunity = getChallengeRequestMessage(["Qm...friendly-sub.bso", "Qm...friendly-sub.bso"]);
        const commentCidsEmpty = getChallengeRequestMessage([]);
        const commentCidsWrongCommunityAddress = getChallengeRequestMessage(["Qm...wrong.bso,high", "Qm...wrong.bso,high"]);
        const commentCidsMoreThanMax = getChallengeRequestMessage([
            "Qm...friendly-sub.bso,low",
            "Qm...friendly-sub.bso,low",
            "Qm...friendly-sub.bso,high"
        ]);

        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsHighKarma, pkc)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsHighKarmaOld, pkc)).to.equal(true);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsHighKarmaNew, pkc)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsLowKarmaOld, pkc)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsNoAuthorCommunity, pkc)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsEmpty, pkc)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsWrongCommunityAddress, pkc)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsMoreThanMax, pkc)).to.equal(false);
    });

    it("firstCommentTimestamp or (postScore and replyScore)", async () => {
        const communityChallenge = {
            exclude: [
                {
                    community: {
                        addresses: ["friendly-sub.bso"],
                        firstCommentTimestamp: 60 * 60 * 24 * 100, // 100 days
                        maxCommentCids: 2
                    }
                },
                {
                    community: {
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
        const commentCidsNoAuthorCommunity = getChallengeRequestMessage(["Qm...friendly-sub.bso", "Qm...friendly-sub.bso"]);
        const commentCidsEmpty = getChallengeRequestMessage([]);
        const commentCidsWrongCommunityAddress = getChallengeRequestMessage(["Qm...wrong.bso,high", "Qm...wrong.bso,high"]);
        const commentCidsMoreThanMax = getChallengeRequestMessage([
            "Qm...friendly-sub.bso,low",
            "Qm...friendly-sub.bso,low",
            "Qm...friendly-sub.bso,high"
        ]);

        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsHighKarma, pkc)).to.equal(true);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsHighKarmaOld, pkc)).to.equal(true);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsHighKarmaNew, pkc)).to.equal(true);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsLowKarmaOld, pkc)).to.equal(true);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsLowKarmaNew, pkc)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsNoAuthorCommunity, pkc)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsEmpty, pkc)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsWrongCommunityAddress, pkc)).to.equal(false);
        expect(await testShouldExcludeChallengeCommentCids(communityChallenge, commentCidsMoreThanMax, pkc)).to.equal(false);
    });
});
