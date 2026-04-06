import { beforeEach, afterEach, describe, it } from "vitest";
import assert from "assert";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { describeSkipIfRpc } from "../../../dist/node/test/test-util.js";

import type {
    CommentsTableRowInsert,
    CommentUpdatesTableRowInsert,
    CommentUpdateType
} from "../../../dist/node/publications/comment/types.js";
import type { VotesTableRowInsert } from "../../../dist/node/publications/vote/types.js";

const PROTOCOL_VERSION = "1.0.0";

type InsertedComment = Pick<
    CommentsTableRowInsert,
    "cid" | "depth" | "parentCid" | "postCid" | "timestamp" | "authorSignerAddress" | "number" | "postNumber"
>;

interface InsertCommentOptions
    extends Partial<Pick<CommentsTableRowInsert, "cid" | "depth" | "parentCid" | "postCid" | "timestamp" | "authorSignerAddress">> {
    overrides?: Partial<CommentsTableRowInsert>;
}

type InsertCommentUpdateOptions = Partial<CommentUpdatesTableRowInsert>;

type InsertVoteOptions = Partial<Pick<VotesTableRowInsert, "vote" | "authorSignerAddress" | "timestamp" | "insertedAt">>;

type CalculatedCommentUpdate = Omit<CommentUpdateType, "signature" | "updatedAt" | "replies" | "protocolVersion">;

type AssignedNumbers = Pick<CommentsTableRowInsert, "number" | "postNumber">;

describeSkipIfRpc("db-handler.queryCalculatedCommentUpdate", () => {
    let _dbHandler: DbHandler | undefined;
    let communityAddress: string;
    let cidCounter = 0;

    const nextCid = (prefix = "QmTest"): string => `${prefix}${(cidCounter++).toString().padStart(4, "0")}`;
    const currentTimestamp = (): number => Math.floor(Date.now() / 1000);

    async function createTestDbHandler(): Promise<DbHandler> {
        communityAddress = `test-sub-${Date.now()}-${Math.random()}`;
        const fakePlebbit = { noData: true };
        const fakeSubplebbit = { address: communityAddress, _plebbit: fakePlebbit };
        const handler = new DbHandler(fakeSubplebbit as never);
        await handler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        await handler.createOrMigrateTablesIfNeeded();
        return handler;
    }

    const insertComment = ({
        cid = nextCid(),
        depth = 0,
        parentCid = null,
        postCid,
        timestamp = currentTimestamp(),
        authorSignerAddress = `12D3KooAuthor${cid}`,
        overrides = {}
    }: InsertCommentOptions = {}): InsertedComment => {
        assert(_dbHandler, "DbHandler not initialised");
        const resolvedPostCid = postCid ?? (depth === 0 ? cid : parentCid ?? nextCid("post"));
        const pendingApproval = overrides["pendingApproval"] ?? null;
        const shouldAssignNumbers = !pendingApproval;
        const assignedNumbers: AssignedNumbers = shouldAssignNumbers ? _dbHandler.getNextCommentNumbers(depth) : {};
        const comment: CommentsTableRowInsert = {
            cid,
            authorSignerAddress,
            author: { address: authorSignerAddress },
            content: overrides["content"] ?? `content-${cid}`,
            title: depth === 0 ? overrides["title"] ?? `title-${cid}` : undefined,
            communityPublicKey: communityAddress,
            timestamp,
            depth,
            postCid: resolvedPostCid,
            parentCid: depth === 0 ? undefined : parentCid ?? undefined,
            signature: overrides["signature"] ?? { type: "ed25519", signature: "sig", publicKey: "pk", signedPropertyNames: [] },
            protocolVersion: PROTOCOL_VERSION,
            pendingApproval: pendingApproval ?? undefined,
            number: assignedNumbers.number,
            postNumber: assignedNumbers.postNumber,
            insertedAt: overrides["insertedAt"] ?? timestamp,
            extraProps: overrides["extraProps"] ?? undefined,
            flairs: overrides["flairs"] ?? undefined,
            spoiler: overrides["spoiler"],
            nsfw: overrides["nsfw"]
        };
        _dbHandler.insertComments([comment]);
        return {
            cid,
            depth,
            parentCid: depth === 0 ? null : parentCid ?? null,
            postCid: resolvedPostCid,
            timestamp,
            authorSignerAddress,
            number: assignedNumbers.number,
            postNumber: assignedNumbers.postNumber
        };
    };

    const insertCommentUpdate = (comment: InsertedComment, options: InsertCommentUpdateOptions = {}): void => {
        const {
            updatedAt = currentTimestamp(),
            replyCount = 0,
            childCount = 0,
            upvoteCount = 0,
            downvoteCount = 0,
            lastChildCid = null,
            lastReplyTimestamp = null,
            postUpdatesBucket = 0,
            removed = null,
            approved = null,
            edit = null,
            replies = null,
            publishedToPostUpdatesMFS = false,
            insertedAt
        } = options;
        assert(_dbHandler, "DbHandler not initialised");
        const resolvedInsertedAt = insertedAt ?? currentTimestamp();
        _dbHandler.upsertCommentUpdates([
            {
                cid: comment.cid,
                upvoteCount,
                downvoteCount,
                replyCount,
                childCount,
                updatedAt,
                protocolVersion: PROTOCOL_VERSION,
                signature: { type: "ed25519", signature: "sig", publicKey: "pk", signedPropertyNames: [] },
                author: {
                    subplebbit: {
                        postScore: 0,
                        replyScore: 0,
                        lastCommentCid: comment.cid,
                        firstCommentTimestamp: comment.timestamp
                    }
                },
                replies: replies ?? undefined,
                lastChildCid: lastChildCid ?? undefined,
                lastReplyTimestamp: lastReplyTimestamp ?? undefined,
                postUpdatesBucket,
                removed: removed ?? undefined,
                approved: approved ?? undefined,
                edit: edit ?? undefined,
                publishedToPostUpdatesMFS,
                insertedAt: resolvedInsertedAt
            }
        ]);
    };

    const insertVote = (comment: InsertedComment, options: InsertVoteOptions = {}): void => {
        const { vote = 1, authorSignerAddress = `12D3KooVote${comment.cid}`, timestamp = currentTimestamp(), insertedAt } = options;
        assert(_dbHandler, "DbHandler not initialised");
        const resolvedInsertedAt = insertedAt ?? timestamp;
        const voteRecord: VotesTableRowInsert = {
            commentCid: comment.cid,
            authorSignerAddress,
            vote,
            timestamp,
            protocolVersion: PROTOCOL_VERSION,
            insertedAt: resolvedInsertedAt
        };
        _dbHandler.insertVotes([voteRecord]);
    };

    const queryCalculated = (comment: InsertedComment): CalculatedCommentUpdate => {
        assert(_dbHandler, "DbHandler not initialised");
        return _dbHandler.queryCalculatedCommentUpdate({
            comment: {
                cid: comment.cid,
                authorSignerAddress: comment.authorSignerAddress,
                timestamp: comment.timestamp
            }
        });
    };

    const createCommentWithUpdate = (options?: InsertCommentOptions): InsertedComment => {
        const comment = insertComment(options ?? {});
        insertCommentUpdate(comment);
        return comment;
    };

    beforeEach(async () => {
        _dbHandler = await createTestDbHandler();
        assert(_dbHandler, "Failed to initialise DbHandler");
    });

    afterEach(async () => {
        if (_dbHandler) {
            await _dbHandler.destoryConnection();
            _dbHandler = undefined;
        }
        cidCounter = 0;
    });

    describe("replyCount", () => {
        it("counts direct replies", () => {
            const post = createCommentWithUpdate({ depth: 0 });
            let postCalculated = queryCalculated(post);
            expect(postCalculated.replyCount).to.equal(0);
            expect(postCalculated.childCount).to.equal(0);

            const reply = createCommentWithUpdate({ depth: 1, parentCid: post.cid, postCid: post.cid });

            postCalculated = queryCalculated(post);
            expect(postCalculated.replyCount).to.equal(1);
            expect(postCalculated.childCount).to.equal(1);

            const replyCalculated = queryCalculated(reply);
            expect(replyCalculated.replyCount).to.equal(0);
            expect(replyCalculated.childCount).to.equal(0);
        });

        it("counts nested replies recursively", () => {
            const post = createCommentWithUpdate({ depth: 0 });
            let postCalculated = queryCalculated(post);
            expect(postCalculated.replyCount).to.equal(0);
            expect(postCalculated.childCount).to.equal(0);

            const reply = createCommentWithUpdate({ depth: 1, parentCid: post.cid, postCid: post.cid });
            postCalculated = queryCalculated(post);
            expect(postCalculated.replyCount).to.equal(1);
            expect(postCalculated.childCount).to.equal(1);

            let replyCalculated = queryCalculated(reply);
            expect(replyCalculated.replyCount).to.equal(0);
            expect(replyCalculated.childCount).to.equal(0);

            const nestedReply = createCommentWithUpdate({
                depth: 2,
                parentCid: reply.cid,
                postCid: post.cid
            });

            postCalculated = queryCalculated(post);
            expect(postCalculated.replyCount).to.equal(2);
            expect(postCalculated.childCount).to.equal(1);

            replyCalculated = queryCalculated(reply);
            expect(replyCalculated.replyCount).to.equal(1);
            expect(replyCalculated.childCount).to.equal(1);

            const nestedCalculated = queryCalculated(nestedReply);
            expect(nestedCalculated.replyCount).to.equal(0);
        });
    });

    describe("lastChildCid", () => {
        it("points to the latest direct child", () => {
            const post = createCommentWithUpdate({ depth: 0 });
            let calculated = queryCalculated(post);
            expect(calculated.lastChildCid).to.be.undefined;

            const firstReply = createCommentWithUpdate({ depth: 1, parentCid: post.cid, postCid: post.cid });
            calculated = queryCalculated(post);
            expect(calculated.lastChildCid).to.equal(firstReply.cid);

            const secondReply = createCommentWithUpdate({ depth: 1, parentCid: post.cid, postCid: post.cid });

            calculated = queryCalculated(post);
            expect(calculated.lastChildCid).to.equal(secondReply.cid);
        });

        it("ignores nested replies when computing lastChildCid", () => {
            const post = createCommentWithUpdate({ depth: 0 });
            let calculated = queryCalculated(post);
            expect(calculated.lastChildCid).to.be.undefined;

            const directReply = createCommentWithUpdate({ depth: 1, parentCid: post.cid, postCid: post.cid });
            calculated = queryCalculated(post);
            expect(calculated.lastChildCid).to.equal(directReply.cid);

            createCommentWithUpdate({ depth: 2, parentCid: directReply.cid, postCid: post.cid });

            calculated = queryCalculated(post);
            expect(calculated.lastChildCid).to.equal(directReply.cid);
        });
    });

    describe("number and postNumber", () => {
        it("assigns sequential number values to approved comments", () => {
            const post = createCommentWithUpdate({ depth: 0 });
            const reply = createCommentWithUpdate({ depth: 1, parentCid: post.cid, postCid: post.cid });

            const postCalculated = queryCalculated(post);
            const replyCalculated = queryCalculated(reply);

            expect(postCalculated.number).to.equal(post.number);
            expect(replyCalculated.number).to.equal(reply.number);
            expect(postCalculated.postNumber).to.equal(post.postNumber);
            expect(replyCalculated.postNumber).to.be.undefined;
        });

        it("assigns sequential postNumber values only to posts", () => {
            const firstPost = createCommentWithUpdate({ depth: 0 });
            createCommentWithUpdate({ depth: 1, parentCid: firstPost.cid, postCid: firstPost.cid });
            const secondPost = createCommentWithUpdate({ depth: 0 });

            const firstPostCalculated = queryCalculated(firstPost);
            const secondPostCalculated = queryCalculated(secondPost);

            expect(firstPostCalculated.postNumber).to.equal(firstPost.postNumber);
            expect(secondPostCalculated.postNumber).to.equal(secondPost.postNumber);
        });

        it("never assigns postNumber to replies even if more posts are added later", () => {
            const firstPost = createCommentWithUpdate({ depth: 0 });
            const reply = createCommentWithUpdate({ depth: 1, parentCid: firstPost.cid, postCid: firstPost.cid });
            createCommentWithUpdate({ depth: 0 });

            const replyCalculated = queryCalculated(reply);
            expect(replyCalculated.postNumber).to.be.undefined;
            expect(replyCalculated.number).to.equal(reply.number);
        });

        it("computes postNumber ignoring replies interleaved between posts", () => {
            const postA = createCommentWithUpdate({ depth: 0 });
            createCommentWithUpdate({ depth: 1, parentCid: postA.cid, postCid: postA.cid });
            const postB = createCommentWithUpdate({ depth: 0 });
            createCommentWithUpdate({ depth: 1, parentCid: postB.cid, postCid: postB.cid });
            const postC = createCommentWithUpdate({ depth: 0 });

            const postACalc = queryCalculated(postA);
            const postBCalc = queryCalculated(postB);
            const postCCalc = queryCalculated(postC);

            expect(postACalc.postNumber).to.equal(postA.postNumber);
            expect(postBCalc.postNumber).to.equal(postB.postNumber);
            expect(postCCalc.postNumber).to.equal(postC.postNumber);
        });

        it("assigns numbers across posts and replies in insertion order", () => {
            const postA = createCommentWithUpdate({ depth: 0 });
            const replyA = createCommentWithUpdate({ depth: 1, parentCid: postA.cid, postCid: postA.cid });
            const postB = createCommentWithUpdate({ depth: 0 });

            const replyACalc = queryCalculated(replyA);
            const postBCalc = queryCalculated(postB);

            expect(replyACalc.number).to.equal(postA.number! + 1);
            expect(replyACalc.postNumber).to.be.undefined;
            expect(postBCalc.number).to.equal(replyACalc.number! + 1);
            expect(postBCalc.postNumber).to.equal(postA.postNumber! + 1);
        });

        it("ignores pending posts when assigning numbers and assigns them on approval", () => {
            const pendingPost = insertComment({ depth: 0, overrides: { pendingApproval: true } });
            insertCommentUpdate(pendingPost);

            const approvedPost = createCommentWithUpdate({ depth: 0 });
            const approvedCalc = queryCalculated(approvedPost);
            expect(approvedCalc.number).to.equal(approvedPost.number);
            expect(approvedCalc.postNumber).to.equal(approvedPost.postNumber);

            _dbHandler!.approvePendingComment({ cid: pendingPost.cid });
            const pendingCalc = queryCalculated(pendingPost);
            expect(pendingCalc.number).to.equal(approvedPost.number! + 1);
            expect(pendingCalc.postNumber).to.equal(approvedPost.postNumber! + 1);

            const approvedRecalc = queryCalculated(approvedPost);
            expect(approvedRecalc.number).to.equal(approvedPost.number);
            expect(approvedRecalc.postNumber).to.equal(approvedPost.postNumber);
        });

        it("ignores pending replies when assigning numbers and assigns them on approval", () => {
            const post = createCommentWithUpdate({ depth: 0 });

            const pendingReply = insertComment({
                depth: 1,
                parentCid: post.cid,
                postCid: post.cid,
                overrides: { pendingApproval: true }
            });
            insertCommentUpdate(pendingReply);

            const approvedReply = createCommentWithUpdate({ depth: 1, parentCid: post.cid, postCid: post.cid });
            const approvedCalc = queryCalculated(approvedReply);
            expect(approvedCalc.number).to.equal(post.number! + 1);
            expect(approvedCalc.postNumber).to.be.undefined;

            _dbHandler!.approvePendingComment({ cid: pendingReply.cid });
            const pendingCalc = queryCalculated(pendingReply);
            expect(pendingCalc.number).to.equal(approvedCalc.number! + 1);
            expect(pendingCalc.postNumber).to.be.undefined;
        });

        it("does not surface numbers for pending comments even if stored", () => {
            const pendingPost = insertComment({ depth: 0, overrides: { pendingApproval: true } });
            insertCommentUpdate(pendingPost);
            // Access internal _db for test manipulation
            const db = (_dbHandler as unknown as { _db: { prepare: (sql: string) => { run: (...args: (string | number)[]) => void } } })
                ._db;
            db.prepare(`UPDATE comments SET number = ?, postNumber = ? WHERE cid = ?`).run(7, 3, pendingPost.cid);
            db.prepare(`UPDATE commentUpdates SET number = ?, postNumber = ? WHERE cid = ?`).run(7, 3, pendingPost.cid);

            const calculated = queryCalculated(pendingPost);
            expect(calculated.number).to.be.undefined;
            expect(calculated.postNumber).to.be.undefined;
        });

        it("returns stored numbers even when commentUpdates row is missing", () => {
            const post = insertComment({ depth: 0 });

            const calculated = queryCalculated(post);
            expect(calculated.number).to.equal(post.number);
            expect(calculated.postNumber).to.equal(post.postNumber);
        });

        it("prefers stored number and postNumber values from comments", () => {
            const post = createCommentWithUpdate({ depth: 0 });
            // Access internal _db for test manipulation
            const db = (
                _dbHandler as unknown as {
                    _db: {
                        prepare: (sql: string) => {
                            get: (cid: string) => { number: number; postNumber: number };
                            run: (...args: (string | number)[]) => void;
                        };
                    };
                }
            )._db;
            const commentRow = db.prepare(`SELECT number, postNumber FROM comments WHERE cid = ?`).get(post.cid);
            db.prepare(`UPDATE commentUpdates SET number = ?, postNumber = ? WHERE cid = ?`).run(42, 7, post.cid);

            const calculated = queryCalculated(post);
            expect(calculated.number).to.equal(commentRow.number);
            expect(calculated.postNumber).to.equal(commentRow.postNumber);
        });
    });

    describe("lastReplyTimestamp", () => {
        it("tracks the timestamp of the latest direct reply", () => {
            const post = createCommentWithUpdate({ depth: 0, timestamp: 1_700_000_000 });
            let calculated = queryCalculated(post);
            expect(calculated.lastReplyTimestamp).to.be.undefined;

            const replyTimestamp = 1_700_000_100;
            createCommentWithUpdate({
                depth: 1,
                parentCid: post.cid,
                postCid: post.cid,
                timestamp: replyTimestamp
            });

            calculated = queryCalculated(post);
            expect(calculated.lastReplyTimestamp).to.equal(replyTimestamp);
        });

        it("tracks nested reply timestamps", () => {
            const post = createCommentWithUpdate({ depth: 0, timestamp: 1_700_000_000 });
            const directReply = createCommentWithUpdate({
                depth: 1,
                parentCid: post.cid,
                postCid: post.cid,
                timestamp: 1_700_000_050
            });
            let calculated = queryCalculated(post);
            expect(calculated.lastReplyTimestamp).to.equal(1_700_000_050);

            const nestedTimestamp = 1_700_000_200;
            createCommentWithUpdate({
                depth: 2,
                parentCid: directReply.cid,
                postCid: post.cid,
                timestamp: nestedTimestamp
            });

            calculated = queryCalculated(post);
            expect(calculated.lastReplyTimestamp).to.equal(nestedTimestamp);
        });
    });

    describe("author.subplebbit aggregation", () => {
        it("postScore increases with an upvote to a post", () => {
            const authorSignerAddress = "author-post-upvote";
            const post = createCommentWithUpdate({ depth: 0, authorSignerAddress });

            let calculated = queryCalculated(post);
            expect(calculated.upvoteCount).to.equal(0);
            expect(calculated.author?.subplebbit?.postScore).to.equal(0);
            expect(calculated.author?.subplebbit?.replyScore).to.equal(0);

            insertVote(post, { vote: 1 });

            calculated = queryCalculated(post);

            expect(calculated.upvoteCount).to.equal(1);
            expect(calculated.author?.subplebbit?.postScore).to.equal(1);
            expect(calculated.author?.subplebbit?.replyScore).to.equal(0);
        });

        it("aggregates postScore across multiple posts", () => {
            const authorSignerAddress = "author-two-posts";
            const firstPost = createCommentWithUpdate({ depth: 0, authorSignerAddress, timestamp: 100 });
            let firstCalculated = queryCalculated(firstPost);
            expect(firstCalculated.author?.subplebbit?.postScore).to.equal(0);
            expect(firstCalculated.author?.subplebbit?.replyScore).to.equal(0);

            insertVote(firstPost, { vote: 1 });

            firstCalculated = queryCalculated(firstPost);
            expect(firstCalculated.author?.subplebbit?.postScore).to.equal(1);
            expect(firstCalculated.author?.subplebbit?.replyScore).to.equal(0);

            const secondPost = createCommentWithUpdate({ depth: 0, authorSignerAddress, timestamp: 200 });
            let secondCalculated = queryCalculated(secondPost);
            expect(secondCalculated.author?.subplebbit?.postScore).to.equal(1);
            expect(secondCalculated.author?.subplebbit?.replyScore).to.equal(0);
            insertVote(secondPost, { vote: 1 });

            firstCalculated = queryCalculated(firstPost);
            secondCalculated = queryCalculated(secondPost);

            expect(firstCalculated.author?.subplebbit?.postScore).to.equal(2);
            expect(firstCalculated.author?.subplebbit?.replyScore).to.equal(0);
            expect(secondCalculated.author?.subplebbit?.postScore).to.equal(2);
            expect(secondCalculated.author?.subplebbit?.replyScore).to.equal(0);
            expect(secondCalculated.author?.subplebbit?.firstCommentTimestamp).to.equal(100);
        });

        it("replyScore increases with upvotes to replies", () => {
            const authorSignerAddress = "author-replies";
            const post = createCommentWithUpdate({ depth: 0, authorSignerAddress, timestamp: 1_000 });
            let postCalculated = queryCalculated(post);
            expect(postCalculated.author?.subplebbit?.postScore).to.equal(0);
            expect(postCalculated.author?.subplebbit?.replyScore).to.equal(0);
            insertVote(post, { vote: 1 });
            postCalculated = queryCalculated(post);
            expect(postCalculated.author?.subplebbit?.postScore).to.equal(1);
            expect(postCalculated.author?.subplebbit?.replyScore).to.equal(0);

            const reply = createCommentWithUpdate({
                depth: 1,
                parentCid: post.cid,
                postCid: post.cid,
                authorSignerAddress,
                timestamp: 2_000
            });
            let replyCalculated = queryCalculated(reply);
            expect(replyCalculated.author?.subplebbit?.postScore).to.equal(1);
            expect(replyCalculated.author?.subplebbit?.replyScore).to.equal(0);
            insertVote(reply, { vote: 1 });

            postCalculated = queryCalculated(post);
            replyCalculated = queryCalculated(reply);

            expect(postCalculated.author?.subplebbit?.postScore).to.equal(1);
            expect(postCalculated.author?.subplebbit?.replyScore).to.equal(1);
            expect(replyCalculated.author?.subplebbit?.postScore).to.equal(1);
            expect(replyCalculated.author?.subplebbit?.replyScore).to.equal(1);
            expect(replyCalculated.author?.subplebbit?.firstCommentTimestamp).to.equal(1_000);
        });

        it("lastCommentCid reflects the author's latest comment", () => {
            const authorSignerAddress = "author-last-comment";
            const firstPost = createCommentWithUpdate({ depth: 0, authorSignerAddress, timestamp: 10 });
            let firstCalculated = queryCalculated(firstPost);
            expect(firstCalculated.author?.subplebbit?.lastCommentCid).to.equal(firstPost.cid);

            const secondPost = createCommentWithUpdate({ depth: 0, authorSignerAddress, timestamp: 20 });

            firstCalculated = queryCalculated(firstPost);
            const secondCalculated = queryCalculated(secondPost);

            expect(firstCalculated.author?.subplebbit?.lastCommentCid).to.equal(secondPost.cid);
            expect(secondCalculated.author?.subplebbit?.lastCommentCid).to.equal(secondPost.cid);
        });

        it("lastCommentCid updates when the author publishes a reply", () => {
            const authorSignerAddress = "author-reply-last-comment";
            const post = createCommentWithUpdate({ depth: 0, authorSignerAddress, timestamp: 10 });
            let postCalculated = queryCalculated(post);
            expect(postCalculated.author?.subplebbit?.lastCommentCid).to.equal(post.cid);

            const reply = createCommentWithUpdate({
                depth: 1,
                parentCid: post.cid,
                postCid: post.cid,
                authorSignerAddress,
                timestamp: 20
            });

            postCalculated = queryCalculated(post);
            const replyCalculated = queryCalculated(reply);

            expect(postCalculated.author?.subplebbit?.lastCommentCid).to.equal(reply.cid);
            expect(replyCalculated.author?.subplebbit?.lastCommentCid).to.equal(reply.cid);
        });

        it("firstCommentTimestamp remains the first comment from the author", () => {
            const authorSignerAddress = "author-first-timestamp";
            const firstPost = createCommentWithUpdate({ depth: 0, authorSignerAddress, timestamp: 50 });
            const firstCalculated = queryCalculated(firstPost);
            expect(firstCalculated.author?.subplebbit?.firstCommentTimestamp).to.equal(50);

            const secondPost = createCommentWithUpdate({ depth: 0, authorSignerAddress, timestamp: 100 });

            const secondCalculated = queryCalculated(secondPost);

            expect(secondCalculated.author?.subplebbit?.firstCommentTimestamp).to.equal(50);
        });
    });

    describe("childCount", () => {
        it("increases with direct replies", () => {
            const post = createCommentWithUpdate({ depth: 0 });
            let calculated = queryCalculated(post);
            expect(calculated.childCount).to.equal(0);
            expect(calculated.replyCount).to.equal(0);

            createCommentWithUpdate({ depth: 1, parentCid: post.cid, postCid: post.cid });

            calculated = queryCalculated(post);

            expect(calculated.childCount).to.equal(1);
            expect(calculated.replyCount).to.equal(1);
        });

        it("does not increase with replies of replies", () => {
            const post = createCommentWithUpdate({ depth: 0 });
            let postCalculated = queryCalculated(post);
            expect(postCalculated.childCount).to.equal(0);
            expect(postCalculated.replyCount).to.equal(0);

            const reply = createCommentWithUpdate({ depth: 1, parentCid: post.cid, postCid: post.cid });
            postCalculated = queryCalculated(post);
            expect(postCalculated.childCount).to.equal(1);
            expect(postCalculated.replyCount).to.equal(1);

            let replyCalculated = queryCalculated(reply);
            expect(replyCalculated.childCount).to.equal(0);
            expect(replyCalculated.replyCount).to.equal(0);

            createCommentWithUpdate({ depth: 2, parentCid: reply.cid, postCid: post.cid });

            postCalculated = queryCalculated(post);
            replyCalculated = queryCalculated(reply);

            expect(postCalculated.childCount).to.equal(1);
            expect(postCalculated.replyCount).to.equal(2);
            expect(replyCalculated.childCount).to.equal(1);
            expect(replyCalculated.replyCount).to.equal(1);
        });

        it("counts multiple direct replies separately", () => {
            const post = createCommentWithUpdate({ depth: 0 });
            let calculated = queryCalculated(post);
            expect(calculated.childCount).to.equal(0);
            expect(calculated.replyCount).to.equal(0);

            createCommentWithUpdate({ depth: 1, parentCid: post.cid, postCid: post.cid });
            calculated = queryCalculated(post);
            expect(calculated.childCount).to.equal(1);
            expect(calculated.replyCount).to.equal(1);

            createCommentWithUpdate({ depth: 1, parentCid: post.cid, postCid: post.cid });
            calculated = queryCalculated(post);

            expect(calculated.childCount).to.equal(2);
            expect(calculated.replyCount).to.equal(2);
        });
    });
});
