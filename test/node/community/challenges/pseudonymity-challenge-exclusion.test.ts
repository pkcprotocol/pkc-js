import { describe, it, beforeAll, afterAll, expect } from "vitest";
import {
    createSubWithNoChallenge,
    describeSkipIfRpc,
    mockPlebbit,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import type { Plebbit } from "../../../../dist/node/pkc/pkc.js";
import type { LocalSubplebbit } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalSubplebbit } from "../../../../dist/node/community/rpc-local-community.js";
import type { SignerWithPublicKeyAddress } from "../../../../dist/node/signer/index.js";
import type { CommentUpdatesRow, CommentsTableRow } from "../../../../dist/node/publications/comment/types.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { SubplebbitChallengeSetting, SubplebbitFeatures } from "../../../../dist/node/community/types.js";
import type {
    DecryptedChallengeMessageType,
    ChallengeVerificationMessageType,
    DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor
} from "../../../../dist/node/pubsub-messages/types.js";

type StoredCommentUpdate = Pick<
    CommentUpdatesRow,
    "cid" | "updatedAt" | "replyCount" | "protocolVersion" | "signature" | "edit" | "author"
>;

interface ChallengeExclusionTestContext {
    plebbit: Plebbit;
    subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    cleanup: () => Promise<void>;
}

async function createSubplebbitWithChallengeExclusion(opts: {
    pseudonymityMode: NonNullable<SubplebbitFeatures["pseudonymityMode"]>;
    challengeExclude: SubplebbitChallengeSetting["exclude"];
}): Promise<ChallengeExclusionTestContext> {
    const plebbit = await mockPlebbit();
    const subplebbit = await createSubWithNoChallenge({}, plebbit);

    await subplebbit.edit({
        features: { pseudonymityMode: opts.pseudonymityMode },
        settings: {
            challenges: [
                {
                    name: "question",
                    options: { question: "What is 1+1?", answer: "2" },
                    exclude: opts.challengeExclude
                }
            ]
        }
    });

    await subplebbit.start();
    await resolveWhenConditionIsTrue({
        toUpdate: subplebbit,
        predicate: async () => typeof subplebbit.updatedAt === "number"
    });

    return {
        plebbit,
        subplebbit,
        cleanup: async () => {
            await subplebbit.delete();
            await plebbit.destroy();
        }
    };
}

async function waitForStoredCommentUpdate(subplebbit: LocalSubplebbit, cid: string): Promise<StoredCommentUpdate> {
    const timeoutMs = 60000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const stored = subplebbit._dbHandler.queryStoredCommentUpdate({ cid }) as StoredCommentUpdate | undefined;
        if (stored) return stored;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for stored comment update for ${cid}`);
}

async function waitForStoredCommentUpdateWithAssertions(subplebbit: LocalSubplebbit, comment: Comment): Promise<StoredCommentUpdate> {
    const storedUpdate = await waitForStoredCommentUpdate(subplebbit, comment.cid);
    expect(storedUpdate.cid).to.equal(comment.cid);
    expect(storedUpdate.updatedAt).to.be.a("number");
    return storedUpdate;
}

async function publishPostWithChallengeAnswer(
    communityAddress: string,
    plebbit: Plebbit,
    signer: SignerWithPublicKeyAddress,
    challengeAnswer: string
): Promise<Comment> {
    const post = await plebbit.createComment({
        communityAddress: communityAddress,
        signer,
        title: "Test post for challenge exclusion",
        content: "Content " + Math.random()
    });

    post.once("challenge", async (challengeMessage: DecryptedChallengeMessageType) => {
        await post.publishChallengeAnswers([challengeAnswer]);
    });

    await post.publish();

    await new Promise<void>((resolve, reject) => {
        post.once("challengeverification", (msg: ChallengeVerificationMessageType) => {
            if (msg.challengeSuccess) resolve();
            else reject(new Error(`Challenge failed: ${JSON.stringify(msg.challengeErrors)}`));
        });
    });

    return post;
}

async function publishPostAndTrackChallenge(
    communityAddress: string,
    plebbit: Plebbit,
    signer: SignerWithPublicKeyAddress,
    opts?: {
        title?: string;
        content?: string;
        challengeAnswer?: string;
    }
): Promise<{ post: Comment; challengeReceived: boolean }> {
    const post = await plebbit.createComment({
        communityAddress: communityAddress,
        signer,
        title: opts?.title ?? "Test post for role exclusion",
        content: opts?.content ?? "Content " + Math.random()
    });

    let challengeReceived = false;
    post.once("challenge", async () => {
        challengeReceived = true;
        await post.publishChallengeAnswers([opts?.challengeAnswer ?? "2"]);
    });

    await post.publish();

    await new Promise<void>((resolve, reject) => {
        post.once("challengeverification", (msg: ChallengeVerificationMessageType) => {
            if (msg.challengeSuccess) resolve();
            else reject(new Error(`Challenge failed: ${JSON.stringify(msg.challengeErrors || msg.reason)}`));
        });
    });

    return { post, challengeReceived };
}

async function publishReplyWithChallengeAnswer(
    parentComment: Pick<Comment, "cid" | "postCid" | "communityAddress">,
    plebbit: Plebbit,
    signer: SignerWithPublicKeyAddress,
    challengeAnswer: string
): Promise<Comment> {
    // For replies, postCid is the top-level post CID
    // If parentComment is a post (depth=0), its cid is the postCid
    // If parentComment is a reply, use its postCid
    const postCid = parentComment.postCid || parentComment.cid;

    const reply = await plebbit.createComment({
        communityAddress: parentComment.communityAddress,
        parentCid: parentComment.cid,
        postCid,
        signer,
        content: "Reply content " + Math.random()
    });

    reply.once("challenge", async (challengeMessage: DecryptedChallengeMessageType) => {
        await reply.publishChallengeAnswers([challengeAnswer]);
    });

    await reply.publish();

    await new Promise<void>((resolve, reject) => {
        reply.once("challengeverification", (msg: ChallengeVerificationMessageType) => {
            if (msg.challengeSuccess) resolve();
            else reject(new Error(`Challenge failed: ${JSON.stringify(msg.challengeErrors)}`));
        });
    });

    return reply;
}

async function publishVoteWithChallengeAnswer(
    plebbit: Plebbit,
    opts: {
        communityAddress: string;
        commentCid: string;
        vote: 1 | -1 | 0;
        signer: SignerWithPublicKeyAddress;
    },
    challengeAnswer: string
): Promise<void> {
    const vote = await plebbit.createVote({
        communityAddress: opts.communityAddress,
        commentCid: opts.commentCid,
        vote: opts.vote,
        signer: opts.signer
    });

    vote.once("challenge", async (challengeMessage: DecryptedChallengeMessageType) => {
        await vote.publishChallengeAnswers([challengeAnswer]);
    });

    await vote.publish();

    await new Promise<void>((resolve, reject) => {
        vote.once("challengeverification", (msg: ChallengeVerificationMessageType) => {
            if (msg.challengeSuccess) resolve();
            else reject(new Error(`Vote challenge failed: ${JSON.stringify(msg.challengeErrors)}`));
        });
    });
}

describeSkipIfRpc("Challenge exclusion with pseudonymity mode", () => {
    describe("per-post pseudonymity mode", () => {
        it("moderators are excluded from role-based challenges in per-post mode", async () => {
            const context = await createSubplebbitWithChallengeExclusion({
                pseudonymityMode: "per-post",
                challengeExclude: [{ role: ["moderator"] }]
            });

            try {
                const moderator = await context.plebbit.createSigner();

                await context.subplebbit.edit({
                    roles: {
                        ...(context.subplebbit.roles || {}),
                        [moderator.address]: { role: "moderator" }
                    }
                });
                await resolveWhenConditionIsTrue({
                    toUpdate: context.subplebbit,
                    predicate: async () => context.subplebbit.roles?.[moderator.address]?.role === "moderator"
                });

                const challengeRequestPromise = new Promise<DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor>((resolve) => {
                    context.subplebbit.once("challengerequest", resolve);
                });
                const moderatorPublication = await publishPostAndTrackChallenge(context.subplebbit.address, context.plebbit, moderator, {
                    title: "Moderator post",
                    content: "Moderator should be excluded from challenge"
                });
                const challengeRequest = await challengeRequestPromise;

                expect(challengeRequest.comment?.author.address).to.equal(moderator.address);
                expect(moderatorPublication.challengeReceived, "Moderator should be excluded from the challenge").to.be.false;

                await moderatorPublication.post.stop();
            } finally {
                await context.cleanup();
            }
        });

        it("new author with no karma must solve challenge (not excluded by postScore)", async () => {
            const context = await createSubplebbitWithChallengeExclusion({
                pseudonymityMode: "per-post",
                challengeExclude: [{ postScore: 5 }]
            });

            try {
                const author = await context.plebbit.createSigner();

                // Publish a post - since author has no karma, they should receive a challenge
                let challengeReceived = false;
                const post = await context.plebbit.createComment({
                    communityAddress: context.subplebbit.address,
                    signer: author,
                    title: "Test post",
                    content: "Content"
                });

                post.once("challenge", async (challengeMessage: DecryptedChallengeMessageType) => {
                    challengeReceived = true;
                    await post.publishChallengeAnswers(["2"]);
                });

                await post.publish();

                await new Promise<void>((resolve, reject) => {
                    post.once("challengeverification", (msg: ChallengeVerificationMessageType) => {
                        if (msg.challengeSuccess) resolve();
                        else reject(new Error(`Challenge failed: ${JSON.stringify(msg.challengeErrors)}`));
                    });
                });

                expect(challengeReceived, "New author should receive a challenge").to.be.true;
                await post.stop();
            } finally {
                await context.cleanup();
            }
        });

        it("author with enough postScore karma is excluded from challenge in per-post mode", async () => {
            const context = await createSubplebbitWithChallengeExclusion({
                pseudonymityMode: "per-post",
                challengeExclude: [{ postScore: 1 }]
            });

            try {
                const author = await context.plebbit.createSigner();
                const voter = await context.plebbit.createSigner();

                // First, publish a post and answer challenge to build karma baseline
                const firstPost = await publishPostWithChallengeAnswer(context.subplebbit.address, context.plebbit, author, "2");
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, firstPost);

                // Upvote the post to give author postScore = 1
                await publishVoteWithChallengeAnswer(
                    context.plebbit,
                    {
                        communityAddress: context.subplebbit.address,
                        commentCid: firstPost.cid,
                        vote: 1,
                        signer: voter
                    },
                    "2"
                );

                // Wait for karma to be aggregated
                await resolveWhenConditionIsTrue({
                    toUpdate: context.subplebbit,
                    predicate: async () => {
                        const authorData = (context.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(author.address);
                        return authorData?.postScore === 1;
                    }
                });

                // Verify author has postScore = 1
                const authorDataBefore = (context.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(author.address);
                expect(authorDataBefore?.postScore).to.equal(1);

                // Now publish a second post - author should be EXCLUDED from challenge (no challenge received)
                let challengeReceived = false;
                const secondPost = await context.plebbit.createComment({
                    communityAddress: context.subplebbit.address,
                    signer: author,
                    title: "Second post",
                    content: "Should be excluded from challenge"
                });

                secondPost.once("challenge", async (challengeMessage: DecryptedChallengeMessageType) => {
                    challengeReceived = true;
                    // Answer anyway in case we're wrong
                    await secondPost.publishChallengeAnswers(["2"]);
                });

                await secondPost.publish();

                await new Promise<void>((resolve, reject) => {
                    secondPost.once("challengeverification", (msg: ChallengeVerificationMessageType) => {
                        if (msg.challengeSuccess) resolve();
                        else reject(new Error(`Challenge failed: ${JSON.stringify(msg.challengeErrors)}`));
                    });
                });

                expect(challengeReceived, "Author with enough karma should be excluded from challenge").to.be.false;

                await firstPost.stop();
                await secondPost.stop();
            } finally {
                await context.cleanup();
            }
        });

        it("karma aggregates across anonymized identities for challenge exclusion in per-post mode", async () => {
            const context = await createSubplebbitWithChallengeExclusion({
                pseudonymityMode: "per-post",
                challengeExclude: [{ postScore: 3 }]
            });

            try {
                const author = await context.plebbit.createSigner();
                const voter = await context.plebbit.createSigner();

                // Publish post1 and upvote (postScore = 1)
                const post1 = await publishPostWithChallengeAnswer(context.subplebbit.address, context.plebbit, author, "2");
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post1);

                await publishVoteWithChallengeAnswer(
                    context.plebbit,
                    { communityAddress: context.subplebbit.address, commentCid: post1.cid, vote: 1, signer: voter },
                    "2"
                );

                // Publish post2 (new alias) and upvote (total postScore = 2)
                const post2 = await publishPostWithChallengeAnswer(context.subplebbit.address, context.plebbit, author, "2");
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post2);

                await publishVoteWithChallengeAnswer(
                    context.plebbit,
                    { communityAddress: context.subplebbit.address, commentCid: post2.cid, vote: 1, signer: voter },
                    "2"
                );

                // Publish post3 (new alias) and upvote (total postScore = 3)
                const post3 = await publishPostWithChallengeAnswer(context.subplebbit.address, context.plebbit, author, "2");
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post3);

                await publishVoteWithChallengeAnswer(
                    context.plebbit,
                    { communityAddress: context.subplebbit.address, commentCid: post3.cid, vote: 1, signer: voter },
                    "2"
                );

                // Wait for aggregated karma to reach 3
                await resolveWhenConditionIsTrue({
                    toUpdate: context.subplebbit,
                    predicate: async () => {
                        const authorData = (context.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(author.address);
                        return authorData?.postScore === 3;
                    }
                });

                // Verify karma aggregation works correctly
                const authorData = (context.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(author.address);
                expect(authorData?.postScore).to.equal(3);

                // Now publish post4 - should be EXCLUDED because aggregated karma = 3
                let challengeReceived = false;
                const post4 = await context.plebbit.createComment({
                    communityAddress: context.subplebbit.address,
                    signer: author,
                    title: "Fourth post",
                    content: "Should be excluded"
                });

                post4.once("challenge", async () => {
                    challengeReceived = true;
                    await post4.publishChallengeAnswers(["2"]);
                });

                await post4.publish();

                await new Promise<void>((resolve, reject) => {
                    post4.once("challengeverification", (msg: ChallengeVerificationMessageType) => {
                        if (msg.challengeSuccess) resolve();
                        else reject(new Error(`Challenge failed`));
                    });
                });

                expect(challengeReceived, "Author with aggregated karma across aliases should be excluded").to.be.false;

                await post1.stop();
                await post2.stop();
                await post3.stop();
                await post4.stop();
            } finally {
                await context.cleanup();
            }
        });

        it("replyScore exclusion works with per-post pseudonymity mode", async () => {
            const context = await createSubplebbitWithChallengeExclusion({
                pseudonymityMode: "per-post",
                challengeExclude: [{ replyScore: 1 }]
            });

            try {
                const author = await context.plebbit.createSigner();
                const voter = await context.plebbit.createSigner();

                // Create a post first
                const post = await publishPostWithChallengeAnswer(context.subplebbit.address, context.plebbit, author, "2");
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

                // Publish a reply and upvote it
                const reply = await publishReplyWithChallengeAnswer(post, context.plebbit, author, "2");
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, reply);

                await publishVoteWithChallengeAnswer(
                    context.plebbit,
                    { communityAddress: context.subplebbit.address, commentCid: reply.cid, vote: 1, signer: voter },
                    "2"
                );

                // Wait for replyScore to be aggregated
                await resolveWhenConditionIsTrue({
                    toUpdate: context.subplebbit,
                    predicate: async () => {
                        const authorData = (context.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(author.address);
                        return authorData?.replyScore === 1;
                    }
                });

                // Now publish another post - should be excluded based on replyScore
                let challengeReceived = false;
                const post2 = await context.plebbit.createComment({
                    communityAddress: context.subplebbit.address,
                    signer: author,
                    title: "Second post",
                    content: "Should be excluded due to replyScore"
                });

                post2.once("challenge", async () => {
                    challengeReceived = true;
                    await post2.publishChallengeAnswers(["2"]);
                });

                await post2.publish();

                await new Promise<void>((resolve, reject) => {
                    post2.once("challengeverification", (msg: ChallengeVerificationMessageType) => {
                        if (msg.challengeSuccess) resolve();
                        else reject(new Error(`Challenge failed`));
                    });
                });

                expect(challengeReceived, "Author with replyScore should be excluded").to.be.false;

                await post.stop();
                await reply.stop();
                await post2.stop();
            } finally {
                await context.cleanup();
            }
        });

        it("firstCommentTimestamp exclusion works with per-post pseudonymity mode", async () => {
            const context = await createSubplebbitWithChallengeExclusion({
                pseudonymityMode: "per-post",
                // Exclude authors who have been active for at least 1 second
                challengeExclude: [{ firstCommentTimestamp: 1 }]
            });

            try {
                const author = await context.plebbit.createSigner();

                // Publish first post to establish firstCommentTimestamp
                const firstPost = await publishPostWithChallengeAnswer(context.subplebbit.address, context.plebbit, author, "2");
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, firstPost);

                // Wait a bit for timestamp to be old enough
                await new Promise((resolve) => setTimeout(resolve, 1500));

                // Verify author has a firstCommentTimestamp
                const authorData = (context.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(author.address);
                expect(authorData?.firstCommentTimestamp).to.be.a("number");

                // Now publish second post - should be excluded based on firstCommentTimestamp
                let challengeReceived = false;
                const secondPost = await context.plebbit.createComment({
                    communityAddress: context.subplebbit.address,
                    signer: author,
                    title: "Second post",
                    content: "Should be excluded due to firstCommentTimestamp"
                });

                secondPost.once("challenge", async () => {
                    challengeReceived = true;
                    await secondPost.publishChallengeAnswers(["2"]);
                });

                await secondPost.publish();

                await new Promise<void>((resolve, reject) => {
                    secondPost.once("challengeverification", (msg: ChallengeVerificationMessageType) => {
                        if (msg.challengeSuccess) resolve();
                        else reject(new Error(`Challenge failed`));
                    });
                });

                expect(challengeReceived, "Author with old enough firstCommentTimestamp should be excluded").to.be.false;

                await firstPost.stop();
                await secondPost.stop();
            } finally {
                await context.cleanup();
            }
        });
    });

    describe("per-reply pseudonymity mode", () => {
        it("moderators are excluded from role-based challenges in per-reply mode", async () => {
            const context = await createSubplebbitWithChallengeExclusion({
                pseudonymityMode: "per-reply",
                challengeExclude: [{ role: ["moderator"] }]
            });

            try {
                const moderator = await context.plebbit.createSigner();

                await context.subplebbit.edit({
                    roles: {
                        ...(context.subplebbit.roles || {}),
                        [moderator.address]: { role: "moderator" }
                    }
                });
                await resolveWhenConditionIsTrue({
                    toUpdate: context.subplebbit,
                    predicate: async () => context.subplebbit.roles?.[moderator.address]?.role === "moderator"
                });

                const moderatorPublication = await publishPostAndTrackChallenge(context.subplebbit.address, context.plebbit, moderator, {
                    title: "Moderator post",
                    content: "Moderator should be excluded from challenge"
                });
                expect(moderatorPublication.challengeReceived, "Moderator should be excluded from the challenge").to.be.false;

                await moderatorPublication.post.stop();
            } finally {
                await context.cleanup();
            }
        });

        it("author with enough karma is excluded from challenge in per-reply mode", async () => {
            const context = await createSubplebbitWithChallengeExclusion({
                pseudonymityMode: "per-reply",
                challengeExclude: [{ postScore: 1 }]
            });

            try {
                const author = await context.plebbit.createSigner();
                const voter = await context.plebbit.createSigner();

                // Publish a post and upvote it
                const post = await publishPostWithChallengeAnswer(context.subplebbit.address, context.plebbit, author, "2");
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

                await publishVoteWithChallengeAnswer(
                    context.plebbit,
                    { communityAddress: context.subplebbit.address, commentCid: post.cid, vote: 1, signer: voter },
                    "2"
                );

                // Wait for karma to be aggregated
                await resolveWhenConditionIsTrue({
                    toUpdate: context.subplebbit,
                    predicate: async () => {
                        const authorData = (context.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(author.address);
                        return authorData?.postScore === 1;
                    }
                });

                // Now publish second post - in per-reply mode, each comment gets a new alias
                // but karma should still be looked up from original author
                let challengeReceived = false;
                const secondPost = await context.plebbit.createComment({
                    communityAddress: context.subplebbit.address,
                    signer: author,
                    title: "Second post",
                    content: "Should be excluded"
                });

                secondPost.once("challenge", async () => {
                    challengeReceived = true;
                    await secondPost.publishChallengeAnswers(["2"]);
                });

                await secondPost.publish();

                await new Promise<void>((resolve, reject) => {
                    secondPost.once("challengeverification", (msg: ChallengeVerificationMessageType) => {
                        if (msg.challengeSuccess) resolve();
                        else reject(new Error(`Challenge failed`));
                    });
                });

                expect(challengeReceived, "Author with enough karma should be excluded in per-reply mode").to.be.false;

                await post.stop();
                await secondPost.stop();
            } finally {
                await context.cleanup();
            }
        });

        it("karma aggregates across per-reply aliases for challenge exclusion", async () => {
            const context = await createSubplebbitWithChallengeExclusion({
                pseudonymityMode: "per-reply",
                challengeExclude: [{ replyScore: 2 }]
            });

            try {
                const author = await context.plebbit.createSigner();
                const voter = await context.plebbit.createSigner();

                // Create a base post
                const post = await publishPostWithChallengeAnswer(context.subplebbit.address, context.plebbit, author, "2");
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

                // Publish reply1 (gets new alias) and upvote
                const reply1 = await publishReplyWithChallengeAnswer(post, context.plebbit, author, "2");
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, reply1);

                await publishVoteWithChallengeAnswer(
                    context.plebbit,
                    { communityAddress: context.subplebbit.address, commentCid: reply1.cid, vote: 1, signer: voter },
                    "2"
                );

                // Publish reply2 (gets new alias) and upvote
                const reply2 = await publishReplyWithChallengeAnswer(post, context.plebbit, author, "2");
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, reply2);

                await publishVoteWithChallengeAnswer(
                    context.plebbit,
                    { communityAddress: context.subplebbit.address, commentCid: reply2.cid, vote: 1, signer: voter },
                    "2"
                );

                // Wait for aggregated replyScore = 2
                await resolveWhenConditionIsTrue({
                    toUpdate: context.subplebbit,
                    predicate: async () => {
                        const authorData = (context.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(author.address);
                        return authorData?.replyScore === 2;
                    }
                });

                // Verify aggregation
                const authorData = (context.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(author.address);
                expect(authorData?.replyScore).to.equal(2);

                // Now publish reply3 - should be excluded
                let challengeReceived = false;
                const reply3 = await context.plebbit.createComment({
                    communityAddress: context.subplebbit.address,
                    parentCid: post.cid,
                    postCid: post.cid,
                    signer: author,
                    content: "Should be excluded"
                });

                reply3.once("challenge", async () => {
                    challengeReceived = true;
                    await reply3.publishChallengeAnswers(["2"]);
                });

                await reply3.publish();

                await new Promise<void>((resolve, reject) => {
                    reply3.once("challengeverification", (msg: ChallengeVerificationMessageType) => {
                        if (msg.challengeSuccess) resolve();
                        else reject(new Error(`Challenge failed`));
                    });
                });

                expect(challengeReceived, "Author with aggregated replyScore across per-reply aliases should be excluded").to.be.false;

                await post.stop();
                await reply1.stop();
                await reply2.stop();
                await reply3.stop();
            } finally {
                await context.cleanup();
            }
        });
    });

    describe("per-author pseudonymity mode", () => {
        it("moderators are excluded from role-based challenges in per-author mode", async () => {
            const context = await createSubplebbitWithChallengeExclusion({
                pseudonymityMode: "per-author",
                challengeExclude: [{ role: ["moderator"] }]
            });

            try {
                const moderator = await context.plebbit.createSigner();

                await context.subplebbit.edit({
                    roles: {
                        ...(context.subplebbit.roles || {}),
                        [moderator.address]: { role: "moderator" }
                    }
                });
                await resolveWhenConditionIsTrue({
                    toUpdate: context.subplebbit,
                    predicate: async () => context.subplebbit.roles?.[moderator.address]?.role === "moderator"
                });

                const moderatorPublication = await publishPostAndTrackChallenge(context.subplebbit.address, context.plebbit, moderator, {
                    title: "Moderator post",
                    content: "Moderator should be excluded from challenge"
                });
                expect(moderatorPublication.challengeReceived, "Moderator should be excluded from the challenge").to.be.false;

                await moderatorPublication.post.stop();
            } finally {
                await context.cleanup();
            }
        });

        it("author with enough karma is excluded from challenge in per-author mode", async () => {
            const context = await createSubplebbitWithChallengeExclusion({
                pseudonymityMode: "per-author",
                challengeExclude: [{ postScore: 1 }]
            });

            try {
                const author = await context.plebbit.createSigner();
                const voter = await context.plebbit.createSigner();

                // Publish a post and upvote it
                const post = await publishPostWithChallengeAnswer(context.subplebbit.address, context.plebbit, author, "2");
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

                await publishVoteWithChallengeAnswer(
                    context.plebbit,
                    { communityAddress: context.subplebbit.address, commentCid: post.cid, vote: 1, signer: voter },
                    "2"
                );

                // Wait for karma
                await resolveWhenConditionIsTrue({
                    toUpdate: context.subplebbit,
                    predicate: async () => {
                        const authorData = (context.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(author.address);
                        return authorData?.postScore === 1;
                    }
                });

                // Now publish second post - in per-author mode, same alias is used
                let challengeReceived = false;
                const secondPost = await context.plebbit.createComment({
                    communityAddress: context.subplebbit.address,
                    signer: author,
                    title: "Second post",
                    content: "Should be excluded"
                });

                secondPost.once("challenge", async () => {
                    challengeReceived = true;
                    await secondPost.publishChallengeAnswers(["2"]);
                });

                await secondPost.publish();

                await new Promise<void>((resolve, reject) => {
                    secondPost.once("challengeverification", (msg: ChallengeVerificationMessageType) => {
                        if (msg.challengeSuccess) resolve();
                        else reject(new Error(`Challenge failed`));
                    });
                });

                expect(challengeReceived, "Author with enough karma should be excluded in per-author mode").to.be.false;

                await post.stop();
                await secondPost.stop();
            } finally {
                await context.cleanup();
            }
        });

        it("per-author mode uses same alias but still correctly tracks karma for exclusion", async () => {
            const context = await createSubplebbitWithChallengeExclusion({
                pseudonymityMode: "per-author",
                challengeExclude: [{ postScore: 2, replyScore: 1 }]
            });

            try {
                const author = await context.plebbit.createSigner();
                const voter = await context.plebbit.createSigner();

                // Publish post1 and upvote
                const post1 = await publishPostWithChallengeAnswer(context.subplebbit.address, context.plebbit, author, "2");
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post1);

                await publishVoteWithChallengeAnswer(
                    context.plebbit,
                    { communityAddress: context.subplebbit.address, commentCid: post1.cid, vote: 1, signer: voter },
                    "2"
                );

                // Publish reply and upvote
                const reply = await publishReplyWithChallengeAnswer(post1, context.plebbit, author, "2");
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, reply);

                await publishVoteWithChallengeAnswer(
                    context.plebbit,
                    { communityAddress: context.subplebbit.address, commentCid: reply.cid, vote: 1, signer: voter },
                    "2"
                );

                // Publish post2 and upvote
                const post2 = await publishPostWithChallengeAnswer(context.subplebbit.address, context.plebbit, author, "2");
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post2);

                await publishVoteWithChallengeAnswer(
                    context.plebbit,
                    { communityAddress: context.subplebbit.address, commentCid: post2.cid, vote: 1, signer: voter },
                    "2"
                );

                // Wait for karma: postScore=2, replyScore=1
                await resolveWhenConditionIsTrue({
                    toUpdate: context.subplebbit,
                    predicate: async () => {
                        const authorData = (context.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(author.address);
                        return authorData?.postScore === 2 && authorData?.replyScore === 1;
                    }
                });

                // Verify
                const authorData = (context.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(author.address);
                expect(authorData?.postScore).to.equal(2);
                expect(authorData?.replyScore).to.equal(1);

                // Now publish post3 - should be excluded (meets both criteria)
                let challengeReceived = false;
                const post3 = await context.plebbit.createComment({
                    communityAddress: context.subplebbit.address,
                    signer: author,
                    title: "Third post",
                    content: "Should be excluded"
                });

                post3.once("challenge", async () => {
                    challengeReceived = true;
                    await post3.publishChallengeAnswers(["2"]);
                });

                await post3.publish();

                await new Promise<void>((resolve, reject) => {
                    post3.once("challengeverification", (msg: ChallengeVerificationMessageType) => {
                        if (msg.challengeSuccess) resolve();
                        else reject(new Error(`Challenge failed`));
                    });
                });

                expect(challengeReceived, "Author meeting combined karma criteria should be excluded").to.be.false;

                await post1.stop();
                await reply.stop();
                await post2.stop();
                await post3.stop();
            } finally {
                await context.cleanup();
            }
        });
    });

    describe("challengerequest event receives aggregated author.subplebbit values", () => {
        it("challengerequest contains aggregated karma across all per-post aliases", async () => {
            // This test verifies that the challengerequest event (which is what challenge APIs receive)
            // contains the AGGREGATED author.subplebbit values across all aliases, not isolated per-alias values

            const context = await createSubplebbitWithChallengeExclusion({
                pseudonymityMode: "per-post",
                challengeExclude: [{ postScore: 10 }] // High threshold so we always get a challenge
            });

            try {
                const author = await context.plebbit.createSigner();
                const voter = await context.plebbit.createSigner();

                // Publish post1 (gets alias1) and upvote it
                const post1 = await publishPostWithChallengeAnswer(context.subplebbit.address, context.plebbit, author, "2");
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post1);

                await publishVoteWithChallengeAnswer(
                    context.plebbit,
                    { communityAddress: context.subplebbit.address, commentCid: post1.cid, vote: 1, signer: voter },
                    "2"
                );

                // Publish post2 (gets alias2) and upvote it
                const post2 = await publishPostWithChallengeAnswer(context.subplebbit.address, context.plebbit, author, "2");
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post2);

                await publishVoteWithChallengeAnswer(
                    context.plebbit,
                    { communityAddress: context.subplebbit.address, commentCid: post2.cid, vote: 1, signer: voter },
                    "2"
                );

                // Wait for aggregated karma to reach 2
                await resolveWhenConditionIsTrue({
                    toUpdate: context.subplebbit,
                    predicate: async () => {
                        const authorData = (context.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(author.address);
                        return authorData?.postScore === 2;
                    }
                });

                // Capture the challengerequest event when publishing post3
                const challengeRequestPromise = new Promise<DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor>((resolve) => {
                    context.subplebbit.once("challengerequest", resolve);
                });

                const post3 = await context.plebbit.createComment({
                    communityAddress: context.subplebbit.address,
                    signer: author,
                    title: "Third post",
                    content: "Check challengerequest values"
                });

                post3.once("challenge", async () => {
                    await post3.publishChallengeAnswers(["2"]);
                });

                await post3.publish();

                const challengerequest = await challengeRequestPromise;

                // Verify challengerequest contains the ORIGINAL author address, not alias
                expect(challengerequest.comment?.author.address).to.equal(author.address);

                // Verify challengerequest contains AGGREGATED karma (2), not per-alias karma (0)
                expect(challengerequest.comment?.author.subplebbit?.postScore).to.equal(2);
                expect(challengerequest.comment?.author.subplebbit?.replyScore).to.equal(0);

                await new Promise<void>((resolve, reject) => {
                    post3.once("challengeverification", (msg: ChallengeVerificationMessageType) => {
                        if (msg.challengeSuccess) resolve();
                        else reject(new Error(`Challenge failed`));
                    });
                });

                await post1.stop();
                await post2.stop();
                await post3.stop();
            } finally {
                await context.cleanup();
            }
        });

        it("challengerequest contains aggregated karma across all per-reply aliases", async () => {
            const context = await createSubplebbitWithChallengeExclusion({
                pseudonymityMode: "per-reply",
                challengeExclude: [{ replyScore: 10 }] // High threshold so we always get a challenge
            });

            try {
                const author = await context.plebbit.createSigner();
                const voter = await context.plebbit.createSigner();

                // Create a base post
                const post = await publishPostWithChallengeAnswer(context.subplebbit.address, context.plebbit, author, "2");
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

                // Publish reply1 (gets alias1) and upvote it
                const reply1 = await publishReplyWithChallengeAnswer(post, context.plebbit, author, "2");
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, reply1);

                await publishVoteWithChallengeAnswer(
                    context.plebbit,
                    { communityAddress: context.subplebbit.address, commentCid: reply1.cid, vote: 1, signer: voter },
                    "2"
                );

                // Publish reply2 (gets alias2) and upvote it
                const reply2 = await publishReplyWithChallengeAnswer(post, context.plebbit, author, "2");
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, reply2);

                await publishVoteWithChallengeAnswer(
                    context.plebbit,
                    { communityAddress: context.subplebbit.address, commentCid: reply2.cid, vote: 1, signer: voter },
                    "2"
                );

                // Wait for aggregated replyScore to reach 2
                await resolveWhenConditionIsTrue({
                    toUpdate: context.subplebbit,
                    predicate: async () => {
                        const authorData = (context.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(author.address);
                        return authorData?.replyScore === 2;
                    }
                });

                // Capture the challengerequest event when publishing reply3
                const challengeRequestPromise = new Promise<DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor>((resolve) => {
                    context.subplebbit.once("challengerequest", resolve);
                });

                const reply3 = await context.plebbit.createComment({
                    communityAddress: context.subplebbit.address,
                    parentCid: post.cid,
                    postCid: post.cid,
                    signer: author,
                    content: "Check challengerequest values"
                });

                reply3.once("challenge", async () => {
                    await reply3.publishChallengeAnswers(["2"]);
                });

                await reply3.publish();

                const challengerequest = await challengeRequestPromise;

                // Verify challengerequest contains the ORIGINAL author address, not alias
                expect(challengerequest.comment?.author.address).to.equal(author.address);

                // Verify challengerequest contains AGGREGATED karma (2), not per-alias karma (0)
                expect(challengerequest.comment?.author.subplebbit?.replyScore).to.equal(2);

                await new Promise<void>((resolve, reject) => {
                    reply3.once("challengeverification", (msg: ChallengeVerificationMessageType) => {
                        if (msg.challengeSuccess) resolve();
                        else reject(new Error(`Challenge failed`));
                    });
                });

                await post.stop();
                await reply1.stop();
                await reply2.stop();
                await reply3.stop();
            } finally {
                await context.cleanup();
            }
        });
    });
});
