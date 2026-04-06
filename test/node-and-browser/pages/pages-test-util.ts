import { loadAllUniqueCommentsUnderCommentInstance } from "../../../dist/node/test/test-util.js";
import { TIMEFRAMES_TO_SECONDS, POSTS_SORT_TYPES, POST_REPLIES_SORT_TYPES } from "../../../dist/node/pages/util.js";
import signers from "../../fixtures/signers.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { CommentWithinRepliesPostsPageJson } from "../../../dist/node/publications/comment/types.js";

const defaultCommunityAddress = signers[0].address;

export const testCommentFieldsInPageJson = (
    comment: CommentWithinRepliesPostsPageJson,
    expectedCommunityAddress: string = defaultCommunityAddress
) => {
    if (!comment.link && !comment.content && !comment.title) expect.fail("Comment should either have link, content or title defined");
    expect(comment.author.address).to.be.a("string");
    expect(comment.cid).to.be.a("string");
    expect(comment.shortCid).to.be.a("string");
    if (!comment.link) expect(comment.content).to.be.a("string");
    expect(comment.depth).to.be.a("number");

    if (comment.depth === 0) {
        // A post
        expect(comment.postCid).to.equal(comment.cid);
        expect(comment.title).to.be.a("string");
    }
    if (comment.depth === 1) expect(comment.postCid).to.equal(comment.parentCid);

    expect(comment.protocolVersion).to.be.a("string");
    expect(comment.replyCount).to.be.a("number");
    expect(comment.childCount).to.be.a("number");

    expect(comment.signature).to.be.a("object");
    expect(comment.communityAddress).to.equal(expectedCommunityAddress);
    expect(comment.timestamp).to.be.a("number");

    // Verify CommentUpdate fields
    expect(comment.updatedAt).to.be.a("number");
    expect(comment.author.subplebbit).to.be.a("object");
    expect(comment.author.subplebbit.postScore).to.be.a("number");
    expect(comment.author.subplebbit.replyScore).to.be.a("number");
    expect(comment.author.subplebbit.firstCommentTimestamp).to.be.a("number");
    expect(comment.author.subplebbit.lastCommentCid).to.be.a("string");
    expect(comment.author.shortAddress).to.be.a("string");

    expect(comment.downvoteCount).to.be.a("number");
    expect(comment.upvoteCount).to.be.a("number");
    if (!comment.link) expect(comment.raw.comment.content).to.be.a("string");
    // TODO verify flairs here when implemented

    if (comment.edit) {
        expect(comment.author.address).to.equal(comment.author.address);
        expect((comment.edit as any).authorAddress).to.be.undefined; // Shouldn't be included (extra from db)
        expect((comment.edit as any).challengeRequestId).to.be.undefined;
        expect(comment.edit.commentCid).to.equal(comment.cid);
        expect(comment.edit.signature).to.be.a("object");
        // edit is in wire format — communityAddress is runtime-only, check wire fields instead
        const editCommunityAddr =
            (comment.edit as any).communityName || (comment.edit as any).communityPublicKey || (comment.edit as any).subplebbitAddress;
        expect(editCommunityAddr).to.equal(comment.communityAddress);
        expect(comment.timestamp).to.be.a("number");
    }

    // Props that shouldn't be there
    expect((comment as any).ipnsKeyName).to.be.undefined;
    expect((comment as any).challengeRequestId).to.be.undefined;
    expect((comment as any).signer).to.be.undefined;
    expect((comment as any)._signer).to.be.undefined;
    expect((comment as any).pendingApproval).to.not.exist;
};

export const testCommentFieldsInModQueuePageJson = (comment: Record<string, any>, communityAddress: string) => {
    if (!comment.link && !comment.content && !comment.title)
        expect.fail("Pending Comment should either have link, content or title defined");
    expect(comment.author.address).to.be.a("string");
    expect(comment.cid).to.be.a("string");
    expect(comment.shortCid).to.be.a("string");
    if (!comment.link) expect(comment.content).to.be.a("string");
    expect(comment.depth).to.be.a("number");

    if (comment.depth === 0) {
        // A post
        expect(comment.postCid).to.equal(comment.cid);
        expect(comment.title).to.be.a("string");
    }
    if (comment.depth === 1) expect(comment.postCid).to.equal(comment.parentCid);
    else expect(comment.postCid).to.be.a("string");

    expect(comment.protocolVersion).to.be.a("string");
    expect(comment.replyCount).to.be.undefined;
    expect(comment.childCount).to.be.undefined;

    expect(comment.signature).to.be.a("object");
    expect(comment.communityAddress).to.equal(communityAddress);
    expect(comment.timestamp).to.be.a("number");

    // Verify CommentUpdate fields
    expect(comment.updatedAt).to.be.undefined; // may change later
    expect(comment.author.subplebbit).to.be.a("object");
    expect(comment.author.subplebbit.postScore).to.be.a("number");
    expect(comment.author.subplebbit.replyScore).to.be.a("number");
    expect(comment.author.subplebbit.firstCommentTimestamp).to.be.a("number");
    expect(comment.author.subplebbit.lastCommentCid).to.be.a("string");
    expect(comment.author.shortAddress).to.be.a("string");

    expect(comment.downvoteCount).to.be.undefined;
    expect(comment.upvoteCount).to.be.undefined;
    if (!comment.link) expect(comment.raw.comment.content).to.be.a("string");
    // TODO verify flairs here when implemented

    expect(comment.edit).to.be.undefined;

    // Props that shouldn't be there
    expect(comment.ipnsKeyName).to.be.undefined;
    expect(comment.challengeRequestId).to.be.undefined;
    expect(comment.signer).to.be.undefined;
    expect(comment._signer).to.be.undefined;
    expect(comment.pendingApproval).to.be.true;
};

const activeScore = async (comment: CommentWithinRepliesPostsPageJson, plebbit: PKC): Promise<number> => {
    if (!comment.replies) return comment.timestamp;
    let maxTimestamp = comment.timestamp;

    const commentInstance = await plebbit.createComment(comment);
    const updateMaxTimestamp = async (localComments: CommentWithinRepliesPostsPageJson[]) => {
        for (const localComment of localComments) {
            if (localComment.deleted || localComment.removed) continue; // shouldn't count
            if (localComment.timestamp > maxTimestamp) maxTimestamp = localComment.timestamp;
            if (localComment.replies) {
                const localCommentInstance = await plebbit.createComment(localComment);
                const childrenComments = await loadAllUniqueCommentsUnderCommentInstance(localCommentInstance);
                await updateMaxTimestamp(childrenComments);
            }
        }
    };

    const childrenComments = await loadAllUniqueCommentsUnderCommentInstance(commentInstance);
    if (comment.replyCount > 0 && childrenComments.length === 0) expect.fail("Comment has replyCount but no replies");

    await updateMaxTimestamp(childrenComments);
    return maxTimestamp;
};

export const testPageCommentsIfSortedCorrectly = async (
    sortedComments: CommentWithinRepliesPostsPageJson[],
    sortName: string,
    subplebbit: RemoteCommunity
) => {
    const currentTimeframe = Object.keys(TIMEFRAMES_TO_SECONDS).filter((timeframe: string) =>
        sortName.toLowerCase().includes(timeframe.toLowerCase())
    )[0];
    const expectedCommunityAddress = subplebbit?.address || defaultCommunityAddress;

    for (let j = 0; j < sortedComments.length - 1; j++) {
        // Check if timestamp is within [timestamp() - timeframe, subplebbit.updatedAt]
        testCommentFieldsInPageJson(sortedComments[j], expectedCommunityAddress);
        if (currentTimeframe && !sortedComments[j].pinned && currentTimeframe !== "ALL") {
            const syncIntervalSeconds = 5 * 60;

            const sortStart =
                subplebbit.updatedAt! - TIMEFRAMES_TO_SECONDS[currentTimeframe as keyof typeof TIMEFRAMES_TO_SECONDS] - syncIntervalSeconds; // Should probably add extra buffer here
            const errMsg = `${sortName} sort includes posts from different timeframes`;
            expect(sortedComments[j].timestamp).to.be.greaterThanOrEqual(sortStart, errMsg);
            expect(sortedComments[j].timestamp).to.be.lessThanOrEqual(subplebbit.updatedAt!, errMsg);
            expect(sortedComments[j + 1].timestamp).to.be.greaterThanOrEqual(sortStart, errMsg);
            expect(sortedComments[j + 1].timestamp).to.be.lessThanOrEqual(subplebbit.updatedAt!, errMsg);
        }
        if (sortedComments[j].pinned || sortedComments[j + 1].pinned) continue; // Ignore pinned posts as they don't follow regular sorting

        const sort = { ...POSTS_SORT_TYPES, ...POST_REPLIES_SORT_TYPES }[sortName];
        let scoreA: number, scoreB: number;
        if (sortName === "active") {
            scoreA = await activeScore(sortedComments[j], (subplebbit as any)._plebbit);
            scoreB = await activeScore(sortedComments[j + 1], (subplebbit as any)._plebbit);
        } else {
            scoreA = sort.score(sortedComments[j].raw);
            scoreB = sort.score(sortedComments[j + 1].raw);
        }
        expect(scoreA).to.be.greaterThanOrEqual(scoreB);
    }
};
