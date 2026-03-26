import { DbHandler } from "../../../dist/node/runtime/node/subplebbit/db-handler.js";
import assert from "assert";
import { describeSkipIfRpc } from "../../../dist/node/test/test-util.js";
import type Database from "better-sqlite3";
import type { CommentsTableRowInsert, CommentUpdatesTableRowInsert } from "../../../dist/node/publications/comment/types.js";
import type { VotesTableRowInsert } from "../../../dist/node/publications/vote/types.js";
import type { CommentEditsTableRowInsert } from "../../../dist/node/publications/comment-edit/types.js";
import type { CommentModerationsTableRowInsert } from "../../../dist/node/publications/comment-moderation/types.js";

type InsertCommentResult = Pick<CommentsTableRowInsert, "cid" | "timestamp" | "depth" | "parentCid" | "postCid">;
type InsertCommentUpdateResult = Pick<CommentUpdatesTableRowInsert, "updatedAt">;
type InsertVoteResult = Pick<VotesTableRowInsert, "insertedAt">;
type InsertCommentEditResult = Pick<CommentEditsTableRowInsert, "insertedAt">;
type InsertCommentModerationResult = Pick<CommentModerationsTableRowInsert, "insertedAt">;

interface InsertCommentOptions extends Partial<Pick<CommentsTableRowInsert, "cid" | "depth" | "parentCid" | "postCid" | "timestamp">> {
    overrides?: Partial<CommentsTableRowInsert>;
}

// Extends from CommentUpdatesTableRowInsert for compatible fields, overrides for SQLite-style values
interface InsertCommentUpdateOptions
    extends Partial<
        Pick<
            CommentUpdatesTableRowInsert,
            | "updatedAt"
            | "replyCount"
            | "childCount"
            | "upvoteCount"
            | "downvoteCount"
            | "lastChildCid"
            | "lastReplyTimestamp"
            | "postUpdatesBucket"
            | "insertedAt"
        >
    > {
    // These fields differ from plebbit-js types: booleans stored as numbers, objects as JSON strings
    publishedToPostUpdatesMFS?: number;
    removed?: number | null;
    approved?: number | null;
    replies?: string | null;
    edit?: string | null;
}

type InsertVoteOptions = Partial<Pick<VotesTableRowInsert, "authorSignerAddress" | "vote" | "insertedAt" | "timestamp">>;

type InsertCommentEditOptions = Partial<Pick<CommentEditsTableRowInsert, "insertedAt" | "timestamp" | "authorSignerAddress">>;

interface InsertCommentModerationOptions
    extends Partial<Pick<CommentModerationsTableRowInsert, "insertedAt" | "timestamp" | "modSignerAddress">> {
    moderation?: CommentModerationsTableRowInsert["commentModeration"];
}

describeSkipIfRpc("db-handler.queryCommentsToBeUpdated", function () {
    let dbHandler: DbHandler | undefined;
    let communityAddress: string;
    let cidCounter = 0;
    const protocolVersion = "1.0.0";

    const nextCid = (prefix = "QmTest"): string => `${prefix}${(cidCounter++).toString().padStart(4, "0")}`;
    const currentTimestamp = (): number => Math.floor(Date.now() / 1000);

    async function createTestDbHandler(): Promise<DbHandler> {
        communityAddress = `test-sub-${Date.now()}-${Math.random()}`;
        const fakePlebbit = { noData: true };
        const fakeSubplebbit = { address: communityAddress, _plebbit: fakePlebbit };
        const handler = new DbHandler(fakeSubplebbit as DbHandler["_subplebbit"]);
        await handler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        await handler.createOrMigrateTablesIfNeeded();
        return handler;
    }

    const insertComment = ({
        cid = nextCid(),
        depth = 0,
        parentCid = null,
        postCid,
        timestamp,
        overrides = {}
    }: InsertCommentOptions = {}): InsertCommentResult => {
        const resolvedTimestamp = timestamp ?? currentTimestamp();
        const resolvedPostCid = postCid ?? (depth === 0 ? cid : parentCid ?? nextCid("post"));
        const authorSignerAddress = overrides.authorSignerAddress ?? `12D3KooAuthor${cid}`;

        const baseComment = {
            cid,
            authorSignerAddress,
            author: overrides.author ?? { address: authorSignerAddress },
            content: overrides.content ?? `content-${cid}`,
            title: depth === 0 ? overrides.title ?? `title-${cid}` : undefined,
            communityPublicKey: communityAddress,
            timestamp: resolvedTimestamp,
            depth,
            postCid: resolvedPostCid,
            parentCid: depth === 0 ? null : parentCid,
            signature: overrides.signature ?? { type: "ed25519", signature: "sig", publicKey: "pk", signedPropertyNames: [] },
            protocolVersion,
            pendingApproval: overrides.pendingApproval ?? null,
            insertedAt: overrides.insertedAt ?? resolvedTimestamp
        } as unknown as CommentsTableRowInsert;

        dbHandler!.insertComments([baseComment]);
        return { cid, timestamp: resolvedTimestamp, depth, parentCid: depth === 0 ? null : parentCid, postCid: resolvedPostCid };
    };

    const insertCommentUpdate = (
        comment: InsertCommentResult,
        {
            updatedAt = currentTimestamp(),
            publishedToPostUpdatesMFS = 0,
            replyCount = 0,
            childCount = 0,
            upvoteCount = 0,
            downvoteCount = 0,
            lastChildCid = null,
            replies = null,
            lastReplyTimestamp = null,
            postUpdatesBucket = 0,
            removed = null,
            approved = null,
            edit = null,
            insertedAt
        }: InsertCommentUpdateOptions = {}
    ): InsertCommentUpdateResult => {
        const resolvedInsertedAt = insertedAt ?? currentTimestamp();
        dbHandler!.upsertCommentUpdates([
            {
                cid: comment.cid,
                upvoteCount,
                downvoteCount,
                replyCount,
                childCount,
                updatedAt,
                protocolVersion,
                signature: "sig",
                author: { subplebbit: { firstCommentTimestamp: comment.timestamp, lastCommentCid: comment.cid } },
                replies,
                lastChildCid,
                lastReplyTimestamp,
                postUpdatesBucket,
                removed,
                approved,
                edit,
                publishedToPostUpdatesMFS,
                insertedAt: resolvedInsertedAt
            } as unknown as CommentUpdatesTableRowInsert
        ]);
        return { updatedAt };
    };

    const insertVote = (
        comment: InsertCommentResult,
        { authorSignerAddress = `12D3KooVote${comment.cid}`, vote = 1, insertedAt, timestamp }: InsertVoteOptions = {}
    ): InsertVoteResult => {
        const resolvedTimestamp = timestamp ?? currentTimestamp();
        const resolvedInsertedAt = insertedAt ?? resolvedTimestamp;
        dbHandler!.insertVotes([
            {
                commentCid: comment.cid,
                authorSignerAddress,
                vote,
                timestamp: resolvedTimestamp,
                protocolVersion,
                insertedAt: resolvedInsertedAt
            } as VotesTableRowInsert
        ]);
        return { insertedAt: resolvedInsertedAt };
    };

    const insertCommentEdit = (
        comment: InsertCommentResult,
        { insertedAt, timestamp, authorSignerAddress = `12D3KooEdit${comment.cid}` }: InsertCommentEditOptions = {}
    ): InsertCommentEditResult => {
        const resolvedTimestamp = timestamp ?? currentTimestamp();
        const resolvedInsertedAt = insertedAt ?? resolvedTimestamp;
        dbHandler!.insertCommentEdits([
            {
                commentCid: comment.cid,
                authorSignerAddress,
                author: { address: authorSignerAddress },
                signature: "sig",
                protocolVersion,
                communityPublicKey: communityAddress,
                timestamp: resolvedTimestamp,
                content: `edit-${comment.cid}`,
                reason: null,
                deleted: 0,
                flairs: null,
                spoiler: 0,
                nsfw: 0,
                isAuthorEdit: 1,
                insertedAt: resolvedInsertedAt
            } as unknown as CommentEditsTableRowInsert
        ]);
        return { insertedAt: resolvedInsertedAt };
    };

    const insertCommentModeration = (
        comment: InsertCommentResult,
        {
            insertedAt,
            timestamp,
            modSignerAddress = `12D3KooMod${comment.cid}`,
            moderation = { approved: true }
        }: InsertCommentModerationOptions = {}
    ): InsertCommentModerationResult => {
        const resolvedTimestamp = timestamp ?? currentTimestamp();
        const resolvedInsertedAt = insertedAt ?? resolvedTimestamp;
        dbHandler!.insertCommentModerations([
            {
                commentCid: comment.cid,
                author: { address: `12D3KooModAuthor${comment.cid}` },
                signature: "sig",
                modSignerAddress,
                protocolVersion,
                communityPublicKey: communityAddress,
                timestamp: resolvedTimestamp,
                commentModeration: moderation,
                insertedAt: resolvedInsertedAt
            } as unknown as CommentModerationsTableRowInsert
        ]);
        return { insertedAt: resolvedInsertedAt };
    };

    beforeEach(async () => {
        dbHandler = await createTestDbHandler();
        assert(dbHandler, "DbHandler failed to initialize");
    });

    afterEach(async () => {
        if (dbHandler) {
            await dbHandler.destoryConnection();
            dbHandler = undefined;
        }
        cidCounter = 0;
    });

    const commentCidsNeedingUpdate = (): string[] => dbHandler!.queryCommentsToBeUpdated().map((comment) => comment.cid);

    it("includes comments that do not yet have a stored comment update row", async () => {
        const post = insertComment();

        const cids = commentCidsNeedingUpdate();
        expect(cids).to.include(post.cid);
    });

    it("enqueues all comments of an author when one of their comments requires an update", async () => {
        const sharedAuthor = "12D3KooAuthorShared";
        const postNeedingUpdate = insertComment({
            overrides: { authorSignerAddress: sharedAuthor, author: { address: sharedAuthor } }
        });
        insertCommentUpdate(postNeedingUpdate, { publishedToPostUpdatesMFS: 0 });

        const upToDatePost = insertComment({
            overrides: { authorSignerAddress: sharedAuthor, author: { address: sharedAuthor } }
        });
        insertCommentUpdate(upToDatePost, { publishedToPostUpdatesMFS: 1, updatedAt: currentTimestamp() + 5 });

        const cids = commentCidsNeedingUpdate();
        expect(cids).to.include(postNeedingUpdate.cid, "author's comment needing update should be present");
        expect(cids).to.include(upToDatePost.cid, "other comments by same author should also be enqueued");
    });

    it("fails to include a post with a newer vote when commentUpdates.updatedAt is ahead by more than one second (captures regression)", async () => {
        const post = insertComment();
        const futureTime = currentTimestamp() + 10;
        insertCommentUpdate(post, { publishedToPostUpdatesMFS: 1, updatedAt: futureTime });
        insertVote(post, { insertedAt: futureTime - 5 });

        const cids = commentCidsNeedingUpdate();

        expect(cids).to.include(
            post.cid,
            "queryCommentsToBeUpdated should include the post because a newer vote exists even when updatedAt is ahead"
        );
    });

    it("includes parents of replies that require an update", async () => {
        const post = insertComment();
        insertCommentUpdate(post, { publishedToPostUpdatesMFS: 1, updatedAt: currentTimestamp() });

        const reply = insertComment({ depth: 1, parentCid: post.cid, postCid: post.cid, timestamp: currentTimestamp() + 5 });
        insertCommentUpdate(reply, { publishedToPostUpdatesMFS: 0, updatedAt: reply.timestamp });

        const cids = commentCidsNeedingUpdate();

        expect(cids).to.include(reply.cid);
        expect(cids).to.include(post.cid, "parent comment should be enqueued when a child reply needs an update");
    });

    it("includes comments when a new comment edit is inserted after the stored update", async () => {
        const post = insertComment();
        const { updatedAt } = insertCommentUpdate(post, { publishedToPostUpdatesMFS: 1, updatedAt: currentTimestamp() });

        insertCommentEdit(post, { insertedAt: updatedAt + 5 });

        const cids = commentCidsNeedingUpdate();
        expect(cids).to.include(post.cid);
    });

    it("includes comments when a new moderation is recorded after the stored update", async () => {
        const post = insertComment();
        const { updatedAt } = insertCommentUpdate(post, { publishedToPostUpdatesMFS: 1, updatedAt: currentTimestamp() });

        insertCommentModeration(post, { insertedAt: updatedAt + 5, moderation: { approved: false } });

        const cids = commentCidsNeedingUpdate();
        expect(cids).to.include(post.cid);
    });

    it("includes comments when a mod adds flairs via moderation after the stored update", async () => {
        const post = insertComment();
        const { updatedAt } = insertCommentUpdate(post, { publishedToPostUpdatesMFS: 1, updatedAt: currentTimestamp() });

        insertCommentModeration(post, {
            insertedAt: updatedAt + 5,
            moderation: { flairs: [{ text: "Important" }, { text: "Verified", backgroundColor: "#00ff00" }] }
        });

        const cids = commentCidsNeedingUpdate();
        expect(cids).to.include(post.cid, "comment should be enqueued when a mod adds flairs via moderation");
    });

    it("includes comments when new child comments arrive after the stored update", async () => {
        const post = insertComment();
        const { updatedAt } = insertCommentUpdate(post, { publishedToPostUpdatesMFS: 1, updatedAt: currentTimestamp() });

        const newTimestamp = updatedAt + 10;
        insertComment({
            depth: 1,
            parentCid: post.cid,
            postCid: post.cid,
            timestamp: newTimestamp,
            overrides: { insertedAt: newTimestamp }
        });

        const cids = commentCidsNeedingUpdate();
        expect(cids).to.include(post.cid);
    });

    it("propagates updates through ancestor chain for deep replies", async () => {
        const baseTimestamp = currentTimestamp();
        const post = insertComment({ timestamp: baseTimestamp });
        insertCommentUpdate(post, { publishedToPostUpdatesMFS: 1, updatedAt: baseTimestamp, insertedAt: baseTimestamp });

        const depth1 = insertComment({
            depth: 1,
            parentCid: post.cid,
            postCid: post.cid,
            timestamp: baseTimestamp + 1,
            overrides: { insertedAt: baseTimestamp + 1 }
        });
        insertCommentUpdate(depth1, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: baseTimestamp + 1,
            insertedAt: baseTimestamp + 1
        });

        const depth2 = insertComment({
            depth: 2,
            parentCid: depth1.cid,
            postCid: post.cid,
            timestamp: baseTimestamp + 2,
            overrides: { insertedAt: baseTimestamp + 2 }
        });
        insertCommentUpdate(depth2, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: baseTimestamp + 2,
            insertedAt: baseTimestamp + 2
        });

        const depth3Timestamp = baseTimestamp + 5;
        insertComment({
            depth: 3,
            parentCid: depth2.cid,
            postCid: post.cid,
            timestamp: depth3Timestamp,
            overrides: { insertedAt: depth3Timestamp }
        });

        const cids = commentCidsNeedingUpdate();
        expect(cids).to.include(depth2.cid, "direct parent of the deep reply should be scheduled for update");
        expect(cids).to.include(depth1.cid, "grandparent comment should be scheduled via parent chain");
        expect(cids).to.include(post.cid, "post should be scheduled via parent chain");
    });

    it("requeues parent when replies JSON references a deleted child", async () => {
        const post = insertComment();
        insertCommentUpdate(post, { publishedToPostUpdatesMFS: 1, replyCount: 1, childCount: 1, lastChildCid: post.cid });

        const parent = insertComment({
            depth: 1,
            parentCid: post.cid,
            postCid: post.cid,
            timestamp: currentTimestamp() + 1,
            overrides: { insertedAt: currentTimestamp() + 1 }
        });

        const staleChildCid = nextCid("purged");
        const staleReplies = JSON.stringify({
            pages: {
                best: {
                    comments: [
                        {
                            comment: {
                                cid: staleChildCid,
                                parentCid: parent.cid,
                                postCid: post.cid,
                                depth: parent.depth + 1,
                                communityAddress: communityAddress
                            },
                            commentUpdate: {
                                cid: staleChildCid,
                                replyCount: 0,
                                childCount: 0,
                                updatedAt: currentTimestamp(),
                                protocolVersion,
                                author: { subplebbit: { firstCommentTimestamp: currentTimestamp(), lastCommentCid: staleChildCid } }
                            }
                        }
                    ]
                }
            }
        });

        insertCommentUpdate(parent, {
            publishedToPostUpdatesMFS: 1,
            replyCount: 1,
            childCount: 1,
            lastChildCid: staleChildCid,
            replies: staleReplies
        });

        const cids = commentCidsNeedingUpdate();
        expect(cids).to.include(
            parent.cid,
            "parent comment should be enqueued because replies JSON still references the purged child comment"
        );
    });

    it("requeues parent when replies JSON embeds stale child updatedAt", async () => {
        const post = insertComment();
        insertCommentUpdate(post, { publishedToPostUpdatesMFS: 1, replyCount: 1, childCount: 1, lastChildCid: post.cid });

        const parent = insertComment({
            depth: 1,
            parentCid: post.cid,
            postCid: post.cid,
            timestamp: currentTimestamp() + 1,
            overrides: { insertedAt: currentTimestamp() + 1 }
        });

        const child = insertComment({
            depth: 2,
            parentCid: parent.cid,
            postCid: post.cid,
            timestamp: currentTimestamp() + 2,
            overrides: { insertedAt: currentTimestamp() + 2 }
        });

        const childInitialUpdatedAt = currentTimestamp() + 3;
        insertCommentUpdate(child, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: childInitialUpdatedAt,
            insertedAt: childInitialUpdatedAt
        });

        const repliesSnapshot = JSON.stringify({
            pages: {
                best: {
                    comments: [
                        {
                            comment: {
                                cid: child.cid,
                                parentCid: parent.cid,
                                postCid: post.cid,
                                depth: child.depth,
                                communityAddress: communityAddress
                            },
                            commentUpdate: {
                                cid: child.cid,
                                replyCount: 0,
                                childCount: 0,
                                updatedAt: childInitialUpdatedAt,
                                protocolVersion,
                                author: {
                                    subplebbit: {
                                        firstCommentTimestamp: child.timestamp,
                                        lastCommentCid: child.cid
                                    }
                                }
                            }
                        }
                    ]
                }
            }
        });

        insertCommentUpdate(parent, {
            publishedToPostUpdatesMFS: 1,
            replyCount: 1,
            childCount: 1,
            lastChildCid: child.cid,
            replies: repliesSnapshot
        });

        const childNewUpdatedAt = childInitialUpdatedAt + 10;
        insertCommentUpdate(child, {
            publishedToPostUpdatesMFS: 0,
            updatedAt: childNewUpdatedAt,
            insertedAt: childNewUpdatedAt
        });

        const cids = commentCidsNeedingUpdate();
        expect(cids).to.include(parent.cid, "parent comment should be enqueued because replies JSON embeds outdated child updatedAt");
    });

    it("includes post ancestor when childCount is stale after a child was removed", async () => {
        const baseTimestamp = currentTimestamp();
        const post = insertComment({ timestamp: baseTimestamp, overrides: { insertedAt: baseTimestamp } });

        const reply = insertComment({
            depth: 1,
            parentCid: post.cid,
            postCid: post.cid,
            timestamp: baseTimestamp + 1,
            overrides: { insertedAt: baseTimestamp + 1 }
        });

        const child = insertComment({
            depth: 2,
            parentCid: reply.cid,
            postCid: post.cid,
            timestamp: baseTimestamp + 2,
            overrides: { insertedAt: baseTimestamp + 2 }
        });

        const childInitialUpdatedAt = baseTimestamp + 3;
        insertCommentUpdate(child, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: childInitialUpdatedAt,
            insertedAt: childInitialUpdatedAt
        });

        const postUpdateInsertedAt = baseTimestamp + 5;
        insertCommentUpdate(post, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: postUpdateInsertedAt,
            insertedAt: postUpdateInsertedAt,
            childCount: 1,
            lastChildCid: reply.cid,
            replyCount: 1
        });

        const replyUpdateInsertedAt = baseTimestamp + 6;
        insertCommentUpdate(reply, {
            publishedToPostUpdatesMFS: 1,
            replyCount: 1,
            childCount: 1,
            lastChildCid: child.cid,
            updatedAt: replyUpdateInsertedAt,
            insertedAt: replyUpdateInsertedAt
        });

        // Child gets removed later, but parent/post are not updated afterwards
        const childRemovalUpdatedAt = baseTimestamp + 10;
        insertCommentUpdate(child, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: childRemovalUpdatedAt,
            insertedAt: childRemovalUpdatedAt,
            removed: 1
        });

        const cids = commentCidsNeedingUpdate();
        expect(cids).to.include(reply.cid, "reply should be enqueued because its childCount is stale after removal");
        expect(cids).to.include(post.cid, "post should be enqueued when descendant childCount becomes stale");
    });

    it("includes post ancestor when lastChildCid is stale but childCount is correct", async () => {
        const baseTimestamp = currentTimestamp();
        const post = insertComment({ timestamp: baseTimestamp, overrides: { insertedAt: baseTimestamp } });

        const reply = insertComment({
            depth: 1,
            parentCid: post.cid,
            postCid: post.cid,
            timestamp: baseTimestamp + 1,
            overrides: { insertedAt: baseTimestamp + 1 }
        });

        const olderChild = insertComment({
            depth: 2,
            parentCid: reply.cid,
            postCid: post.cid,
            timestamp: baseTimestamp + 2,
            overrides: { insertedAt: baseTimestamp + 2 }
        });
        insertCommentUpdate(olderChild, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: baseTimestamp + 3,
            insertedAt: baseTimestamp + 3
        });

        const newerChild = insertComment({
            depth: 2,
            parentCid: reply.cid,
            postCid: post.cid,
            timestamp: baseTimestamp + 4,
            overrides: { insertedAt: baseTimestamp + 4 }
        });
        insertCommentUpdate(newerChild, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: baseTimestamp + 5,
            insertedAt: baseTimestamp + 5
        });

        const postUpdateInsertedAt = baseTimestamp + 6;
        insertCommentUpdate(post, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: postUpdateInsertedAt,
            insertedAt: postUpdateInsertedAt,
            childCount: 1,
            lastChildCid: reply.cid,
            replyCount: 1
        });

        const replyUpdateInsertedAt = baseTimestamp + 7;
        insertCommentUpdate(reply, {
            publishedToPostUpdatesMFS: 1,
            replyCount: 2,
            childCount: 2,
            // Intentionally stale lastChildCid (should be newerChild)
            lastChildCid: olderChild.cid,
            updatedAt: replyUpdateInsertedAt,
            insertedAt: replyUpdateInsertedAt
        });

        const cids = commentCidsNeedingUpdate();
        expect(cids).to.include(reply.cid, "reply should be enqueued because its lastChildCid is stale");
        expect(cids).to.include(post.cid, "post should be enqueued when descendant lastChildCid is stale");
    });

    it("requeues parent when replies JSON references a child whose comment update row was purged", async () => {
        const post = insertComment();
        insertCommentUpdate(post, { publishedToPostUpdatesMFS: 1, replyCount: 1, childCount: 1, lastChildCid: post.cid });

        const parent = insertComment({ depth: 1, parentCid: post.cid, postCid: post.cid });
        const child = insertComment({ depth: 2, parentCid: parent.cid, postCid: post.cid });

        const childUpdatedAt = currentTimestamp();
        insertCommentUpdate(child, {
            publishedToPostUpdatesMFS: 1,
            replyCount: 0,
            childCount: 0,
            updatedAt: childUpdatedAt,
            insertedAt: childUpdatedAt
        });

        const repliesSnapshot = JSON.stringify({
            pages: {
                best: {
                    comments: [
                        {
                            comment: {
                                cid: child.cid,
                                parentCid: parent.cid,
                                postCid: post.cid,
                                depth: child.depth,
                                communityAddress: communityAddress
                            },
                            commentUpdate: {
                                cid: child.cid,
                                replyCount: 0,
                                childCount: 0,
                                updatedAt: childUpdatedAt,
                                protocolVersion,
                                author: {
                                    subplebbit: {
                                        firstCommentTimestamp: child.timestamp,
                                        lastCommentCid: child.cid
                                    }
                                }
                            }
                        }
                    ]
                }
            }
        });

        insertCommentUpdate(parent, {
            publishedToPostUpdatesMFS: 1,
            replyCount: 1,
            childCount: 1,
            lastChildCid: child.cid,
            replies: repliesSnapshot
        });

        (dbHandler as unknown as { _db: Database.Database })._db.prepare(`DELETE FROM commentUpdates WHERE cid = ?`).run(child.cid);

        const cids = commentCidsNeedingUpdate();
        expect(cids).to.include(
            parent.cid,
            "parent comment should be enqueued because replies JSON references a child without a stored comment update row"
        );
    });

    it("requeues parent when child comment is marked removed but replies still include it", async () => {
        const post = insertComment();
        insertCommentUpdate(post, { publishedToPostUpdatesMFS: 1, replyCount: 1, childCount: 1, lastChildCid: post.cid });

        const parent = insertComment({ depth: 1, parentCid: post.cid, postCid: post.cid });
        const child = insertComment({ depth: 2, parentCid: parent.cid, postCid: post.cid });

        const childUpdatedAt = currentTimestamp();
        insertCommentUpdate(child, {
            publishedToPostUpdatesMFS: 1,
            replyCount: 0,
            childCount: 0,
            updatedAt: childUpdatedAt,
            insertedAt: childUpdatedAt
        });

        const repliesSnapshot = JSON.stringify({
            pages: {
                best: {
                    comments: [
                        {
                            comment: {
                                cid: child.cid,
                                parentCid: parent.cid,
                                postCid: post.cid,
                                depth: child.depth,
                                communityAddress: communityAddress
                            },
                            commentUpdate: {
                                cid: child.cid,
                                replyCount: 0,
                                childCount: 0,
                                updatedAt: childUpdatedAt,
                                protocolVersion,
                                author: {
                                    subplebbit: {
                                        firstCommentTimestamp: child.timestamp,
                                        lastCommentCid: child.cid
                                    }
                                }
                            }
                        }
                    ]
                }
            }
        });

        insertCommentUpdate(parent, {
            publishedToPostUpdatesMFS: 1,
            replyCount: 1,
            childCount: 1,
            lastChildCid: child.cid,
            replies: repliesSnapshot
        });

        const removalUpdatedAt = childUpdatedAt + 5;
        insertCommentUpdate(child, {
            publishedToPostUpdatesMFS: 0,
            replyCount: 0,
            childCount: 0,
            removed: 1,
            updatedAt: removalUpdatedAt,
            insertedAt: removalUpdatedAt
        });

        const cids = commentCidsNeedingUpdate();
        expect(cids).to.include(parent.cid, "parent comment should be enqueued because a child present in replies has been marked removed");
    });

    it("requeues parent when child comment is deleted via edit but replies still include it", async () => {
        const post = insertComment();
        insertCommentUpdate(post, { publishedToPostUpdatesMFS: 1, replyCount: 1, childCount: 1, lastChildCid: post.cid });

        const parent = insertComment({ depth: 1, parentCid: post.cid, postCid: post.cid });
        const child = insertComment({ depth: 2, parentCid: parent.cid, postCid: post.cid });

        const childUpdatedAt = currentTimestamp();
        insertCommentUpdate(child, {
            publishedToPostUpdatesMFS: 1,
            replyCount: 0,
            childCount: 0,
            updatedAt: childUpdatedAt,
            insertedAt: childUpdatedAt
        });

        const repliesSnapshot = JSON.stringify({
            pages: {
                best: {
                    comments: [
                        {
                            comment: {
                                cid: child.cid,
                                parentCid: parent.cid,
                                postCid: post.cid,
                                depth: child.depth,
                                communityAddress: communityAddress
                            },
                            commentUpdate: {
                                cid: child.cid,
                                replyCount: 0,
                                childCount: 0,
                                updatedAt: childUpdatedAt,
                                protocolVersion,
                                author: {
                                    subplebbit: {
                                        firstCommentTimestamp: child.timestamp,
                                        lastCommentCid: child.cid
                                    }
                                }
                            }
                        }
                    ]
                }
            }
        });

        insertCommentUpdate(parent, {
            publishedToPostUpdatesMFS: 1,
            replyCount: 1,
            childCount: 1,
            lastChildCid: child.cid,
            replies: repliesSnapshot
        });

        const deletionUpdatedAt = childUpdatedAt + 5;
        insertCommentUpdate(child, {
            publishedToPostUpdatesMFS: 0,
            replyCount: 0,
            childCount: 0,
            updatedAt: deletionUpdatedAt,
            insertedAt: deletionUpdatedAt,
            edit: JSON.stringify({ deleted: true })
        });

        const cids = commentCidsNeedingUpdate();
        expect(cids).to.include(parent.cid, "parent comment should be enqueued because a child present in replies has been deleted");
    });

    it("requeues parent when replies JSON includes a pending-approval child", async () => {
        const post = insertComment();
        insertCommentUpdate(post, { publishedToPostUpdatesMFS: 1, replyCount: 1, childCount: 1, lastChildCid: post.cid });

        const parent = insertComment({ depth: 1, parentCid: post.cid, postCid: post.cid });
        const pendingChild = insertComment({
            depth: 2,
            parentCid: parent.cid,
            postCid: post.cid,
            overrides: { pendingApproval: true }
        });

        const childUpdatedAt = currentTimestamp();
        insertCommentUpdate(pendingChild, {
            publishedToPostUpdatesMFS: 1,
            replyCount: 0,
            childCount: 0,
            updatedAt: childUpdatedAt,
            insertedAt: childUpdatedAt
        });

        const repliesSnapshot = JSON.stringify({
            pages: {
                best: {
                    comments: [
                        {
                            comment: {
                                cid: pendingChild.cid,
                                parentCid: parent.cid,
                                postCid: post.cid,
                                depth: pendingChild.depth,
                                communityAddress: communityAddress
                            },
                            commentUpdate: {
                                cid: pendingChild.cid,
                                replyCount: 0,
                                childCount: 0,
                                updatedAt: childUpdatedAt,
                                protocolVersion,
                                author: {
                                    subplebbit: {
                                        firstCommentTimestamp: pendingChild.timestamp,
                                        lastCommentCid: pendingChild.cid
                                    }
                                }
                            }
                        }
                    ]
                }
            }
        });

        insertCommentUpdate(parent, {
            publishedToPostUpdatesMFS: 1,
            replyCount: 1,
            childCount: 1,
            lastChildCid: pendingChild.cid,
            replies: repliesSnapshot
        });

        const cids = commentCidsNeedingUpdate();
        expect(cids).to.include(
            parent.cid,
            "parent comment should be enqueued because replies include a pending approval child that is filtered out of counts"
        );
    });

    it("includes parents of author_to_update comments even when parent is by different author", async () => {
        // Setup: Author A has comments under parents by different authors (B and C)
        // When author A's comment gets a vote, ALL of A's comments are updated via authors_to_update
        // But the PARENTS by B and C must also be included to avoid stale replies cascade
        //
        // Key: The parent commentUpdates must have insertedAt AFTER their children were inserted,
        // otherwise the parents get picked up via "new child" detection instead of parent_chain.

        const baseTimestamp = currentTimestamp();
        const authorA = "12D3KooWAuthorA";
        const authorB = "12D3KooWAuthorB";
        const authorC = "12D3KooWAuthorC";

        // Post by author B
        const postByB = insertComment({
            timestamp: baseTimestamp,
            overrides: { authorSignerAddress: authorB, author: { address: authorB }, insertedAt: baseTimestamp }
        });

        // Post by author C
        const postByC = insertComment({
            timestamp: baseTimestamp + 1,
            overrides: { authorSignerAddress: authorC, author: { address: authorC }, insertedAt: baseTimestamp + 1 }
        });

        // Reply by author A under post by B
        const replyA1 = insertComment({
            depth: 1,
            parentCid: postByB.cid,
            postCid: postByB.cid,
            timestamp: baseTimestamp + 2,
            overrides: { authorSignerAddress: authorA, author: { address: authorA }, insertedAt: baseTimestamp + 2 }
        });

        // Reply by author A under post by C
        const replyA2 = insertComment({
            depth: 1,
            parentCid: postByC.cid,
            postCid: postByC.cid,
            timestamp: baseTimestamp + 3,
            overrides: { authorSignerAddress: authorA, author: { address: authorA }, insertedAt: baseTimestamp + 3 }
        });

        // Now insert commentUpdates for all comments AFTER all comments are inserted
        // This simulates a "steady state" where everything has been published
        // Must set lastChildCid correctly or stale_last_child_cids will trigger
        const steadyStateTime = baseTimestamp + 100;

        insertCommentUpdate(postByB, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: steadyStateTime,
            insertedAt: steadyStateTime,
            childCount: 1,
            replyCount: 1,
            lastChildCid: replyA1.cid
        });

        insertCommentUpdate(postByC, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: steadyStateTime + 1,
            insertedAt: steadyStateTime + 1,
            childCount: 1,
            replyCount: 1,
            lastChildCid: replyA2.cid
        });

        insertCommentUpdate(replyA1, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: steadyStateTime + 2,
            insertedAt: steadyStateTime + 2
        });

        insertCommentUpdate(replyA2, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: steadyStateTime + 3,
            insertedAt: steadyStateTime + 3
        });

        // Now trigger an update for author A by inserting a vote on replyA1
        const voteInsertedAt = steadyStateTime + 10;
        insertVote(replyA1, { insertedAt: voteInsertedAt });

        const cids = commentCidsNeedingUpdate();

        // replyA1 should be included (has new vote)
        expect(cids).to.include(replyA1.cid, "replyA1 should be included because it has a new vote");

        // replyA2 should be included (same author as replyA1)
        expect(cids).to.include(replyA2.cid, "replyA2 should be included because author A needs author.subplebbit update");

        // postByB should be included (parent of replyA1 which is in base_updates via vote)
        expect(cids).to.include(postByB.cid, "postByB should be included as parent of replyA1");

        // CRITICAL: postByC should ALSO be included (parent of replyA2 which is added via authors_to_update)
        // This is the bug - currently postByC is NOT included because parent_chain only comes from base_updates
        expect(cids).to.include(postByC.cid, "postByC should be included as parent of replyA2 (replyA2 is added via authors_to_update)");
    });

    it("includes deep ancestor chain for author comments added via authors_to_update", async () => {
        // When author A's comment at depth 3 is added via authors_to_update,
        // all ancestors (depth 2, 1, 0) should be included

        const baseTimestamp = currentTimestamp();
        const authorA = "12D3KooWAuthorA";
        const authorB = "12D3KooWAuthorB";
        const authorC = "12D3KooWAuthorC";
        const authorD = "12D3KooWAuthorD";
        const steadyStateTime = baseTimestamp + 100;

        // Post by author B (depth 0)
        const post = insertComment({
            timestamp: baseTimestamp,
            overrides: { authorSignerAddress: authorB, author: { address: authorB }, insertedAt: baseTimestamp }
        });

        // Reply by author C (depth 1)
        const depth1Reply = insertComment({
            depth: 1,
            parentCid: post.cid,
            postCid: post.cid,
            timestamp: baseTimestamp + 1,
            overrides: { authorSignerAddress: authorC, author: { address: authorC }, insertedAt: baseTimestamp + 1 }
        });

        // Reply by author D (depth 2)
        const depth2Reply = insertComment({
            depth: 2,
            parentCid: depth1Reply.cid,
            postCid: post.cid,
            timestamp: baseTimestamp + 2,
            overrides: { authorSignerAddress: authorD, author: { address: authorD }, insertedAt: baseTimestamp + 2 }
        });

        // Reply by author A (depth 3) - this is the one that will be added via authors_to_update
        const depth3Reply = insertComment({
            depth: 3,
            parentCid: depth2Reply.cid,
            postCid: post.cid,
            timestamp: baseTimestamp + 3,
            overrides: { authorSignerAddress: authorA, author: { address: authorA }, insertedAt: baseTimestamp + 3 }
        });

        // Another post by author A (depth 0) - the trigger comment
        const triggerPost = insertComment({
            timestamp: baseTimestamp + 4,
            overrides: { authorSignerAddress: authorA, author: { address: authorA }, insertedAt: baseTimestamp + 4 }
        });

        // Insert all commentUpdates in steady state
        insertCommentUpdate(post, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: steadyStateTime,
            insertedAt: steadyStateTime,
            childCount: 1,
            replyCount: 1,
            lastChildCid: depth1Reply.cid
        });

        insertCommentUpdate(depth1Reply, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: steadyStateTime + 1,
            insertedAt: steadyStateTime + 1,
            childCount: 1,
            replyCount: 1,
            lastChildCid: depth2Reply.cid
        });

        insertCommentUpdate(depth2Reply, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: steadyStateTime + 2,
            insertedAt: steadyStateTime + 2,
            childCount: 1,
            replyCount: 1,
            lastChildCid: depth3Reply.cid
        });

        insertCommentUpdate(depth3Reply, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: steadyStateTime + 3,
            insertedAt: steadyStateTime + 3
        });

        insertCommentUpdate(triggerPost, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: steadyStateTime + 4,
            insertedAt: steadyStateTime + 4
        });

        // Trigger update for author A by inserting a vote on triggerPost
        const voteInsertedAt = steadyStateTime + 10;
        insertVote(triggerPost, { insertedAt: voteInsertedAt });

        const cids = commentCidsNeedingUpdate();

        // triggerPost and depth3Reply should be included (author A's comments)
        expect(cids).to.include(triggerPost.cid, "triggerPost should be included (has new vote)");
        expect(cids).to.include(depth3Reply.cid, "depth3Reply should be included (author A via authors_to_update)");

        // All ancestors of depth3Reply should be included
        expect(cids).to.include(depth2Reply.cid, "depth2Reply should be included as parent of depth3Reply");
        expect(cids).to.include(depth1Reply.cid, "depth1Reply should be included as ancestor of depth3Reply");
        expect(cids).to.include(post.cid, "post should be included as ancestor of depth3Reply");
    });

    it("does not include pending approval comments in authors_to_update cascade", async () => {
        // If an author has a pending approval comment, it should not be included
        // when their other comments trigger an update

        const baseTimestamp = currentTimestamp();
        const authorA = "12D3KooWAuthorA";
        const authorB = "12D3KooWAuthorB";
        const steadyStateTime = baseTimestamp + 100;

        // Post by author B
        const postByB = insertComment({
            timestamp: baseTimestamp,
            overrides: { authorSignerAddress: authorB, author: { address: authorB }, insertedAt: baseTimestamp }
        });

        // Approved reply by author A
        const approvedReply = insertComment({
            depth: 1,
            parentCid: postByB.cid,
            postCid: postByB.cid,
            timestamp: baseTimestamp + 1,
            overrides: { authorSignerAddress: authorA, author: { address: authorA }, insertedAt: baseTimestamp + 1 }
        });

        // Pending approval reply by author A (under a different parent to isolate the test)
        const anotherPost = insertComment({
            timestamp: baseTimestamp + 2,
            overrides: { authorSignerAddress: authorB, author: { address: authorB }, insertedAt: baseTimestamp + 2 }
        });

        const pendingReply = insertComment({
            depth: 1,
            parentCid: anotherPost.cid,
            postCid: anotherPost.cid,
            timestamp: baseTimestamp + 3,
            overrides: {
                authorSignerAddress: authorA,
                author: { address: authorA },
                insertedAt: baseTimestamp + 3,
                pendingApproval: true
            }
        });

        // Insert commentUpdates in steady state
        insertCommentUpdate(postByB, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: steadyStateTime,
            insertedAt: steadyStateTime,
            childCount: 1,
            replyCount: 1,
            lastChildCid: approvedReply.cid
        });

        insertCommentUpdate(approvedReply, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: steadyStateTime + 1,
            insertedAt: steadyStateTime + 1
        });

        insertCommentUpdate(anotherPost, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: steadyStateTime + 2,
            insertedAt: steadyStateTime + 2,
            childCount: 0, // pending reply not counted
            replyCount: 0
        });

        insertCommentUpdate(pendingReply, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: steadyStateTime + 3,
            insertedAt: steadyStateTime + 3
        });

        // Trigger update for author A
        const voteInsertedAt = steadyStateTime + 10;
        insertVote(approvedReply, { insertedAt: voteInsertedAt });

        const cids = commentCidsNeedingUpdate();

        // approvedReply should be included
        expect(cids).to.include(approvedReply.cid, "approvedReply should be included (has new vote)");

        // pendingReply should NOT be included (pending approval)
        expect(cids).to.not.include(pendingReply.cid, "pendingReply should NOT be included (pending approval)");

        // anotherPost should NOT be included (its only child is pending, so no parent chain needed)
        expect(cids).to.not.include(anotherPost.cid, "anotherPost should NOT be included (no approved children needing update)");
    });

    it("handles authors with multiple comments under same parent correctly", async () => {
        // If author A has multiple comments under the same parent,
        // the parent should only be included once

        const baseTimestamp = currentTimestamp();
        const authorA = "12D3KooWAuthorA";
        const authorB = "12D3KooWAuthorB";
        const steadyStateTime = baseTimestamp + 100;

        // Post by author B
        const post = insertComment({
            timestamp: baseTimestamp,
            overrides: { authorSignerAddress: authorB, author: { address: authorB }, insertedAt: baseTimestamp }
        });

        // Multiple replies by author A under same post
        const replyA1 = insertComment({
            depth: 1,
            parentCid: post.cid,
            postCid: post.cid,
            timestamp: baseTimestamp + 1,
            overrides: { authorSignerAddress: authorA, author: { address: authorA }, insertedAt: baseTimestamp + 1 }
        });

        const replyA2 = insertComment({
            depth: 1,
            parentCid: post.cid,
            postCid: post.cid,
            timestamp: baseTimestamp + 2,
            overrides: { authorSignerAddress: authorA, author: { address: authorA }, insertedAt: baseTimestamp + 2 }
        });

        const replyA3 = insertComment({
            depth: 1,
            parentCid: post.cid,
            postCid: post.cid,
            timestamp: baseTimestamp + 3,
            overrides: { authorSignerAddress: authorA, author: { address: authorA }, insertedAt: baseTimestamp + 3 }
        });

        // Insert commentUpdates in steady state
        insertCommentUpdate(post, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: steadyStateTime,
            insertedAt: steadyStateTime,
            childCount: 3,
            replyCount: 3,
            lastChildCid: replyA3.cid
        });

        insertCommentUpdate(replyA1, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: steadyStateTime + 1,
            insertedAt: steadyStateTime + 1
        });

        insertCommentUpdate(replyA2, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: steadyStateTime + 2,
            insertedAt: steadyStateTime + 2
        });

        insertCommentUpdate(replyA3, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: steadyStateTime + 3,
            insertedAt: steadyStateTime + 3
        });

        // Trigger update for author A
        const voteInsertedAt = steadyStateTime + 10;
        insertVote(replyA1, { insertedAt: voteInsertedAt });

        const cids = commentCidsNeedingUpdate();

        // All of author A's replies should be included
        expect(cids).to.include(replyA1.cid, "replyA1 should be included");
        expect(cids).to.include(replyA2.cid, "replyA2 should be included");
        expect(cids).to.include(replyA3.cid, "replyA3 should be included");

        // Parent should be included exactly once
        expect(cids).to.include(post.cid, "post should be included as parent");

        // Count occurrences of post.cid - should be exactly 1
        const postOccurrences = cids.filter((cid) => cid === post.cid).length;
        expect(postOccurrences).to.equal(1, "post should appear exactly once in the result");
    });

    it("includes post ancestor when replies JSON is stale even if all updates were already published", async () => {
        const baseTimestamp = currentTimestamp();
        const post = insertComment({ timestamp: baseTimestamp, overrides: { insertedAt: baseTimestamp } });

        const reply = insertComment({
            depth: 1,
            parentCid: post.cid,
            postCid: post.cid,
            timestamp: baseTimestamp + 1,
            overrides: { insertedAt: baseTimestamp + 1 }
        });
        const child = insertComment({
            depth: 2,
            parentCid: reply.cid,
            postCid: post.cid,
            timestamp: baseTimestamp + 2,
            overrides: { insertedAt: baseTimestamp + 2 }
        });

        const childInitialUpdatedAt = baseTimestamp + 3;
        insertCommentUpdate(child, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: childInitialUpdatedAt,
            insertedAt: childInitialUpdatedAt
        });

        const postUpdateInsertedAt = baseTimestamp + 5;
        insertCommentUpdate(post, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: postUpdateInsertedAt,
            insertedAt: postUpdateInsertedAt,
            childCount: 1,
            lastChildCid: reply.cid,
            replyCount: 1
        });

        const repliesSnapshot = JSON.stringify({
            pages: {
                best: {
                    comments: [
                        {
                            comment: {
                                cid: child.cid,
                                parentCid: reply.cid,
                                postCid: post.cid,
                                depth: child.depth,
                                communityAddress: communityAddress
                            },
                            commentUpdate: {
                                cid: child.cid,
                                replyCount: 0,
                                childCount: 0,
                                updatedAt: childInitialUpdatedAt,
                                protocolVersion,
                                author: {
                                    subplebbit: {
                                        firstCommentTimestamp: child.timestamp,
                                        lastCommentCid: child.cid
                                    }
                                }
                            }
                        }
                    ]
                }
            }
        });

        const replyUpdateInsertedAt = baseTimestamp + 6;
        insertCommentUpdate(reply, {
            publishedToPostUpdatesMFS: 1,
            replyCount: 1,
            childCount: 1,
            lastChildCid: child.cid,
            replies: repliesSnapshot,
            updatedAt: replyUpdateInsertedAt,
            insertedAt: replyUpdateInsertedAt
        });

        const childNewUpdatedAt = childInitialUpdatedAt + 10;
        insertCommentUpdate(child, {
            publishedToPostUpdatesMFS: 1,
            updatedAt: childNewUpdatedAt,
            insertedAt: childNewUpdatedAt
        });

        const cids = commentCidsNeedingUpdate();
        expect(cids).to.include(reply.cid, "reply should be enqueued because its replies JSON is stale");
        expect(cids).to.include(post.cid, "post should also be enqueued when descendant replies JSON becomes stale");
    });
});
