import { afterEach, beforeEach, expect, it } from "vitest";
import { DbHandler } from "../../../../dist/node/runtime/node/community/db-handler.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import type { CommentsTableRowInsert, CommentUpdatesTableRowInsert } from "../../../../dist/node/publications/comment/types.js";
import type { RepliesPagesTypeIpfs } from "../../../../dist/node/pages/types.js";

// resolveRepliesCidRefsForEntries used to bind one SQL variable per listed child CID in a single `IN (...)`, and
// markCommentsAsPublishedToPostUpdates one per updated comment. SQLite caps a statement at 32766 variables, so a
// board whose posts list more preloaded children than that in total (a few thousand posts with a few dozen replies
// each) crashed every publish, and a cycle updating every comment crashed after it, with "too many SQL variables"
// (issue #351).
// This is a pure DB test: the query runs the same way inside the RPC server, so nothing here depends on the transport.
describeSkipIfRpc("db-handler cid lists above the SQLite variable cap", () => {
    let dbHandler: DbHandler;
    const communityAddress = `test-sub-${Date.now()}-${Math.random()}`;
    const protocolVersion = "1.0.0";
    const signature = { type: "ed25519", signature: "sig", publicKey: "pk", signedPropertyNames: [] as string[] };
    const POSTS = 400;
    const REPLIES_PER_POST = 100; // 40k listed children, above the 32766 cap

    beforeEach(async () => {
        const fakeCommunity = { address: communityAddress, _pkc: { noData: true } };
        dbHandler = new DbHandler(fakeCommunity as DbHandler["_community"]);
        await dbHandler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        await dbHandler.createOrMigrateTablesIfNeeded();
    });

    afterEach(async () => {
        await dbHandler.destoryConnection();
    });

    const cidOf = (n: number) => `Qm${n.toString(36).padStart(44, "0")}`;

    function seed() {
        const comments: CommentsTableRowInsert[] = [];
        const updates: CommentUpdatesTableRowInsert[] = [];
        const now = Math.floor(Date.now() / 1000);
        let counter = 0;
        for (let p = 0; p < POSTS; p++) {
            const postCid = cidOf(++counter);
            const childCids: string[] = [];
            comments.push(<CommentsTableRowInsert>(<unknown>{
                cid: postCid,
                authorSignerAddress: `author-${postCid}`,
                author: { address: `author-${postCid}` },
                parentCid: null,
                postCid,
                depth: 0,
                title: `post ${p}`,
                content: "x",
                communityPublicKey: communityAddress,
                timestamp: now - POSTS + p,
                signature,
                protocolVersion,
                insertedAt: now
            }));
            for (let r = 0; r < REPLIES_PER_POST; r++) {
                const cid = cidOf(++counter);
                childCids.push(cid);
                comments.push(<CommentsTableRowInsert>(<unknown>{
                    cid,
                    authorSignerAddress: `author-${cid}`,
                    author: { address: `author-${cid}` },
                    parentCid: postCid,
                    postCid,
                    depth: 1,
                    content: `reply ${r} of ${p}`,
                    communityPublicKey: communityAddress,
                    timestamp: now + r,
                    signature,
                    protocolVersion,
                    insertedAt: now
                }));
                updates.push(<CommentUpdatesTableRowInsert>(<unknown>{
                    cid,
                    upvoteCount: 0,
                    downvoteCount: 0,
                    replyCount: 0,
                    childCount: 0,
                    updatedAt: now + r,
                    protocolVersion,
                    signature,
                    author: { community: {} },
                    publishedToPostUpdatesMFS: true,
                    insertedAt: now
                }));
            }
            updates.push(<CommentUpdatesTableRowInsert>(<unknown>{
                cid: postCid,
                upvoteCount: 0,
                downvoteCount: 0,
                replyCount: REPLIES_PER_POST,
                childCount: REPLIES_PER_POST,
                updatedAt: now,
                protocolVersion,
                signature,
                author: { community: {} },
                replies: { best: { commentCids: [...childCids].reverse() } },
                lastReplyTimestamp: now + REPLIES_PER_POST - 1,
                publishedToPostUpdatesMFS: true,
                insertedAt: now
            }));
        }
        dbHandler.insertComments(comments);
        dbHandler.upsertCommentUpdates(updates);
    }

    it("marks, force-updates and loads more comments than one statement may bind", () => {
        seed();
        const cids = (dbHandler["_db"].prepare("SELECT cid FROM commentUpdates").all() as { cid: string }[]).map((r) => r.cid);
        expect(cids.length).to.be.greaterThan(32766);
        dbHandler.forceUpdateOnAllCommentsWithCid(cids);
        const unpublished = () =>
            (
                dbHandler["_db"].prepare("SELECT COUNT(*) AS n FROM commentUpdates WHERE publishedToPostUpdatesMFS = 0").get() as {
                    n: number;
                }
            ).n;
        expect(unpublished()).to.equal(cids.length);
        dbHandler.markCommentsAsPublishedToPostUpdates(cids);
        expect(unpublished()).to.equal(0);
        const byCids = dbHandler.queryCommentAndCommentUpdateByCids(cids, {
            commentUpdateCols: ["cid", "upvoteCount"],
            commentIpfsCols: ["depth", "timestamp"]
        });
        expect(byCids.length).to.equal(cids.length);
    });

    it("resolves every post's preloaded children in commentCids order when their total exceeds 32766", () => {
        seed();
        const posts = dbHandler.queryPosts({
            parentCid: null,
            excludeRemovedComments: true,
            excludeDeletedComments: true,
            excludeCommentPendingApproval: true,
            excludeCommentWithApprovedFalse: true,
            excludeCommentsWithDifferentCommunityAddress: true
        });
        expect(posts).to.have.length(POSTS);
        const resolved = dbHandler.resolveRepliesCidRefsForEntries(posts);
        expect(resolved).to.have.length(POSTS);
        for (const [index, entry] of resolved.entries()) {
            const stored = posts[index].commentUpdate.replies as unknown as { best: { commentCids: string[] } };
            const replies = entry.commentUpdate.replies as RepliesPagesTypeIpfs | undefined;
            const page = replies?.pages?.best;
            expect(page, `post ${index} best page`).to.exist;
            expect(page!.comments.map((c) => c.commentUpdate.cid)).to.deep.equal(stored.best.commentCids);
            expect(page!.comments.every((c) => c.comment.parentCid === entry.commentUpdate.cid)).to.be.true;
            expect(replies?.pageCids).to.be.undefined;
        }
    });
});
