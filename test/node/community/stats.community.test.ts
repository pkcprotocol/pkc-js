import assert from "assert";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { TIMEFRAMES_TO_SECONDS } from "../../../dist/node/pages/util.js";
import { describe, it, beforeEach, afterEach } from "vitest";
import type { CommunityStats } from "../../../dist/node/community/types.js";
import type {
    CommentsTableRow,
    CommentsTableRowInsert,
    CommentUpdatesTableRowInsert
} from "../../../dist/node/publications/comment/types.js";
import type { VotesTableRowInsert } from "../../../dist/node/publications/vote/types.js";
import signers from "../../fixtures/signers.js";

const PROTOCOL_VERSION = "1.0.0";
const BUFFER_SECONDS = 60;

const activeUserCountKeys: (keyof CommunityStats)[] = [
    "allActiveUserCount",
    "yearActiveUserCount",
    "monthActiveUserCount",
    "weekActiveUserCount",
    "dayActiveUserCount",
    "hourActiveUserCount"
];

const replyCountKeys: (keyof CommunityStats)[] = [
    "allReplyCount",
    "yearReplyCount",
    "monthReplyCount",
    "weekReplyCount",
    "dayReplyCount",
    "hourReplyCount"
];

const postCountKeys: (keyof CommunityStats)[] = [
    "allPostCount",
    "yearPostCount",
    "monthPostCount",
    "weekPostCount",
    "dayPostCount",
    "hourPostCount"
];

// Type aliases derived from pkc-js types
type InsertedComment = Pick<CommentsTableRow, "cid" | "depth" | "parentCid" | "postCid" | "timestamp" | "authorSignerAddress">;

type InsertCommentOptions = Partial<
    Pick<CommentsTableRowInsert, "depth" | "parentCid" | "postCid" | "authorSignerAddress" | "timestamp">
> & {
    parent?: InsertedComment | null;
    overrides?: Partial<CommentsTableRowInsert>;
};

type InsertReplyOptions = Omit<InsertCommentOptions, "parent"> & { parent: InsertedComment };

type InsertVoteOptions = Partial<Pick<VotesTableRowInsert, "authorSignerAddress" | "timestamp" | "vote">>;

type InsertCommentUpdateOptions = Partial<Omit<CommentUpdatesTableRowInsert, "cid" | "protocolVersion" | "signature" | "author">>;

function createMockEdit(comment: InsertedComment, subAddress: string, deleted: boolean): NonNullable<CommentUpdatesTableRowInsert["edit"]> {
    return {
        timestamp: Math.floor(Date.now() / 1000),
        signature: {
            type: "ed25519",
            signature: "sig",
            publicKey: "pk",
            signedPropertyNames: []
        },
        communityPublicKey: subAddress,
        protocolVersion: PROTOCOL_VERSION,
        commentCid: comment.cid,
        author: { address: comment.authorSignerAddress },
        deleted
    };
}

async function createTestDbHandler(): Promise<{ dbHandler: DbHandler; communityAddress: string }> {
    const communityAddress = `test-sub-${Date.now()}-${Math.random()}`;
    const fakePKC = { noData: true };
    const fakeCommunity = { address: communityAddress, _pkc: fakePKC };
    const handler = new DbHandler(fakeCommunity as DbHandler extends { _community: infer T } ? T : never);
    await handler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
    await handler.createOrMigrateTablesIfNeeded();
    return { dbHandler: handler, communityAddress: communityAddress };
}

describe(`community.statsCid`, function () {
    let dbHandler: DbHandler | undefined;
    let communityAddress: string;
    let cidCounter = 0;

    function nextCid(prefix = "QmTest"): string {
        return `${prefix}${(cidCounter++).toString().padStart(4, "0")}`;
    }

    function currentTimestamp(): number {
        return Math.floor(Date.now() / 1000);
    }

    function queryStats(): CommunityStats {
        assert(dbHandler, "DbHandler not initialised");
        return dbHandler.queryCommunityStats();
    }

    function insertComment({
        parent,
        depth,
        parentCid,
        postCid,
        authorSignerAddress,
        timestamp = currentTimestamp(),
        overrides = {}
    }: InsertCommentOptions = {}): InsertedComment {
        assert(dbHandler, "DbHandler not initialised");
        const cid = nextCid();
        const resolvedDepth = typeof depth === "number" ? depth : parent ? (parent.depth ?? 0) + 1 : 0;
        const resolvedParentCid = resolvedDepth === 0 ? null : parentCid ?? parent?.cid ?? null;
        const resolvedPostCid = resolvedDepth === 0 ? postCid ?? cid : postCid ?? parent?.postCid ?? resolvedParentCid ?? cid;
        const resolvedAuthorSignerAddress = authorSignerAddress ?? `12D3KooAuthor${cid}`;
        const resolvedAuthor = overrides.author ?? { address: resolvedAuthorSignerAddress };

        const comment: CommentsTableRowInsert = {
            cid,
            authorSignerAddress: resolvedAuthorSignerAddress,
            author: resolvedAuthor,
            parentCid: resolvedParentCid,
            postCid: resolvedPostCid,
            communityPublicKey: overrides.communityPublicKey ?? communityAddress,
            content: overrides.content ?? `content-${cid}`,
            timestamp,
            signature: overrides.signature ?? {
                type: "ed25519",
                signature: "sig",
                publicKey: "pk",
                signedPropertyNames: []
            },
            title: resolvedDepth === 0 ? overrides.title ?? `title-${cid}` : undefined,
            depth: resolvedDepth,
            protocolVersion: PROTOCOL_VERSION,
            insertedAt: overrides.insertedAt ?? timestamp,
            pendingApproval: overrides.pendingApproval
        };

        dbHandler.insertComments([comment]);

        return {
            cid,
            depth: resolvedDepth,
            parentCid: resolvedParentCid,
            postCid: resolvedPostCid,
            timestamp,
            authorSignerAddress: resolvedAuthorSignerAddress
        };
    }

    function insertPost(options: Omit<InsertCommentOptions, "parent" | "depth"> = {}): InsertedComment {
        return insertComment({ ...options, parent: null, depth: 0 });
    }

    function insertReply({ parent, ...options }: InsertReplyOptions): InsertedComment {
        assert(parent, "parent comment is required for replies");
        return insertComment({ parent, ...options });
    }

    function insertCommentUpdate(comment: InsertedComment, options: InsertCommentUpdateOptions = {}): void {
        assert(comment, "comment is required for comment updates");
        assert(dbHandler, "DbHandler not initialised");
        const {
            replyCount = 0,
            childCount = 0,
            upvoteCount = 0,
            downvoteCount = 0,
            removed,
            approved,
            edit,
            lastChildCid,
            lastReplyTimestamp,
            postUpdatesBucket = 0,
            publishedToPostUpdatesMFS = false,
            updatedAt = currentTimestamp(),
            insertedAt
        } = options;
        const resolvedInsertedAt = insertedAt ?? updatedAt;
        const commentUpdate: CommentUpdatesTableRowInsert = {
            cid: comment.cid,
            replyCount,
            childCount,
            upvoteCount,
            downvoteCount,
            removed,
            approved,
            edit,
            lastChildCid,
            lastReplyTimestamp,
            postUpdatesBucket,
            updatedAt,
            protocolVersion: PROTOCOL_VERSION,
            signature: {
                type: "ed25519",
                signature: "sig",
                publicKey: "pk",
                signedPropertyNames: []
            },
            author: {
                community: {
                    postScore: 0,
                    replyScore: 0,
                    lastCommentCid: comment.cid,
                    firstCommentTimestamp: comment.timestamp
                }
            },
            publishedToPostUpdatesMFS,
            insertedAt: resolvedInsertedAt
        };
        dbHandler.upsertCommentUpdates([commentUpdate]);
    }

    function insertVote(comment: InsertedComment, options: InsertVoteOptions = {}): void {
        const { authorSignerAddress, timestamp = currentTimestamp(), vote = 1 } = options;
        assert(comment, "comment is required for votes");
        assert(dbHandler, "DbHandler not initialised");
        const resolvedAuthorSignerAddress = authorSignerAddress ?? `12D3KooVote${comment.cid}`;
        const voteRecord: VotesTableRowInsert = {
            commentCid: comment.cid,
            authorSignerAddress: resolvedAuthorSignerAddress,
            timestamp,
            vote,
            protocolVersion: PROTOCOL_VERSION,
            insertedAt: timestamp
        };
        dbHandler.insertVotes([voteRecord]);
    }

    function insertPseudonymityAlias(opts: {
        commentCid: string;
        originalAuthorSignerPublicKey: string;
        aliasPrivateKey?: string;
        insertedAt?: number;
        mode?: "per-post" | "per-reply" | "per-author";
    }): void {
        assert(dbHandler, "DbHandler not initialised");
        dbHandler.insertPseudonymityAliases([
            {
                commentCid: opts.commentCid,
                aliasPrivateKey: opts.aliasPrivateKey ?? `alias-private-key-${opts.commentCid}`,
                originalAuthorSignerPublicKey: opts.originalAuthorSignerPublicKey,
                originalAuthorDomain: null,
                mode: opts.mode ?? "per-post",
                insertedAt: opts.insertedAt ?? currentTimestamp()
            }
        ]);
    }

    function expectDelta(keys: (keyof CommunityStats)[], before: CommunityStats, after: CommunityStats, delta: number): void {
        keys.forEach((key) => expect(after[key]).to.equal(before[key] + delta));
    }

    beforeEach(async () => {
        const context = await createTestDbHandler();
        dbHandler = context.dbHandler;
        communityAddress = context.communityAddress;
        cidCounter = 0;
    });

    afterEach(async () => {
        if (dbHandler) {
            dbHandler.destoryConnection();
            dbHandler = undefined;
        }
    });

    it(`stats of community is all zeros by default`, () => {
        const stats = queryStats();
        const expectedKeys = activeUserCountKeys.concat(...replyCountKeys).concat(...postCountKeys);
        expect(Object.keys(stats).sort()).to.deep.equal(expectedKeys.sort());
        expectedKeys.forEach((key) => expect(stats[key]).to.equal(0));
    });

    describe(`community.stats.ActiveUserCount`, () => {
        it(`ActiveUserCount should increase by 1 for new post author`, () => {
            const statsBefore = queryStats();
            insertPost({ authorSignerAddress: "author-new-post" });
            const statsAfter = queryStats();
            expectDelta(activeUserCountKeys, statsBefore, statsAfter, 1);
        });

        it(`ActiveUserCount does not increase when an existing user is publishing a new post`, () => {
            const author = "repeat-post-author";
            insertPost({ authorSignerAddress: author });
            const statsBefore = queryStats();
            insertPost({ authorSignerAddress: author });
            const statsAfter = queryStats();
            expectDelta(activeUserCountKeys, statsBefore, statsAfter, 0);
        });

        it(`ActiveUserCount should increase by 1 for author of new reply`, () => {
            const post = insertPost({ authorSignerAddress: "post-owner" });
            const statsBefore = queryStats();
            insertReply({ parent: post, authorSignerAddress: "new-reply-author" });
            const statsAfter = queryStats();
            expectDelta(activeUserCountKeys, statsBefore, statsAfter, 1);
        });

        it(`ActiveUserCount does not increase when an existing user is publishing a new reply`, () => {
            const post = insertPost({ authorSignerAddress: "post-owner" });
            const author = "repeat-replier";
            insertReply({ parent: post, authorSignerAddress: author });
            const statsBefore = queryStats();
            insertReply({ parent: post, authorSignerAddress: author });
            const statsAfter = queryStats();
            expectDelta(activeUserCountKeys, statsBefore, statsAfter, 0);
        });

        it(`ActiveUserCount should increase by 1 for new vote author`, () => {
            const post = insertPost({ authorSignerAddress: "post-owner" });
            const statsBefore = queryStats();
            insertVote(post, { authorSignerAddress: "vote-author-new" });
            const statsAfter = queryStats();
            expectDelta(activeUserCountKeys, statsBefore, statsAfter, 1);
        });

        it(`ActiveUserCount does not increase when an existing user is publishing a new vote`, () => {
            const post = insertPost({ authorSignerAddress: "post-owner" });
            const anotherPost = insertPost({ authorSignerAddress: "second-post-owner" });
            const author = "repeat-voter";
            insertVote(post, { authorSignerAddress: author });
            const statsBefore = queryStats();
            insertVote(anotherPost, { authorSignerAddress: author });
            const statsAfter = queryStats();
            expectDelta(activeUserCountKeys, statsBefore, statsAfter, 0);
        });

        it(`ActiveUserCount dedupes aliases that map to the same original author`, () => {
            const originalSigner = signers[0];
            const statsBefore = queryStats();
            const firstAliasPost = insertPost({ authorSignerAddress: "alias-author-one" });
            insertPseudonymityAlias({
                commentCid: firstAliasPost.cid,
                originalAuthorSignerPublicKey: originalSigner.publicKey
            });
            const secondAliasPost = insertPost({ authorSignerAddress: "alias-author-two" });
            insertPseudonymityAlias({
                commentCid: secondAliasPost.cid,
                originalAuthorSignerPublicKey: originalSigner.publicKey
            });
            const statsAfter = queryStats();
            expectDelta(activeUserCountKeys, statsBefore, statsAfter, 1);
        });

        it(`ActiveUserCount merges pseudonymous history with later non-pseudonymous activity`, () => {
            const originalSigner = signers[1];
            const pseudonymousPost = insertPost({ authorSignerAddress: "alias-transition-author" });
            insertPseudonymityAlias({
                commentCid: pseudonymousPost.cid,
                originalAuthorSignerPublicKey: originalSigner.publicKey
            });
            const statsBefore = queryStats();
            insertPost({ authorSignerAddress: originalSigner.address });
            const statsAfter = queryStats();
            expectDelta(activeUserCountKeys, statsBefore, statsAfter, 0);
        });

        it(`ActiveUserCount dedupes per-reply aliases that map to the same original author`, () => {
            const originalSigner = signers[3];
            const post = insertPost({ authorSignerAddress: "per-reply-thread-owner" });
            const statsBefore = queryStats();
            const firstReply = insertReply({ parent: post, authorSignerAddress: "per-reply-alias-one" });
            insertPseudonymityAlias({
                commentCid: firstReply.cid,
                originalAuthorSignerPublicKey: originalSigner.publicKey,
                mode: "per-reply"
            });
            const secondReply = insertReply({ parent: post, authorSignerAddress: "per-reply-alias-two" });
            insertPseudonymityAlias({
                commentCid: secondReply.cid,
                originalAuthorSignerPublicKey: originalSigner.publicKey,
                mode: "per-reply"
            });
            const statsAfter = queryStats();
            expectDelta(activeUserCountKeys, statsBefore, statsAfter, 1);
        });

        it(`ActiveUserCount merges per-author pseudonymous activity with later non-pseudonymous activity`, () => {
            const originalSigner = signers[4];
            const pseudonymousPost = insertPost({ authorSignerAddress: "per-author-alias" });
            insertPseudonymityAlias({
                commentCid: pseudonymousPost.cid,
                originalAuthorSignerPublicKey: originalSigner.publicKey,
                mode: "per-author"
            });
            const statsBefore = queryStats();
            insertPost({ authorSignerAddress: originalSigner.address });
            const statsAfter = queryStats();
            expectDelta(activeUserCountKeys, statsBefore, statsAfter, 0);
        });

        it(`ActiveUserCount merges pseudonymous comment activity with non-pseudonymous vote activity`, () => {
            const originalSigner = signers[2];
            const post = insertPost({ authorSignerAddress: "vote-target-author" });
            const pseudonymousReply = insertReply({ parent: post, authorSignerAddress: "alias-comment-author" });
            insertPseudonymityAlias({
                commentCid: pseudonymousReply.cid,
                originalAuthorSignerPublicKey: originalSigner.publicKey
            });
            const statsBefore = queryStats();
            insertVote(post, { authorSignerAddress: originalSigner.address });
            const statsAfter = queryStats();
            expectDelta(activeUserCountKeys, statsBefore, statsAfter, 0);
        });

        it(`ActiveUserCount throws when an active alias row has an invalid original signer public key`, () => {
            const pseudonymousPost = insertPost({ authorSignerAddress: "invalid-alias-author" });
            insertPseudonymityAlias({
                commentCid: pseudonymousPost.cid,
                originalAuthorSignerPublicKey: "invalid-public-key"
            });
            expect(() => queryStats()).to.throw("Failed to resolve original author address for alias signer address invalid-alias-author");
        });
    });

    describe(`community.stats.postCount`, () => {
        it(`PostCount should increase by 1 for new post`, () => {
            const statsBefore = queryStats();
            insertPost({ authorSignerAddress: "post-author-1" });
            const statsAfter = queryStats();
            expectDelta(postCountKeys, statsBefore, statsAfter, 1);
        });

        it(`PostCount should increase by 1 for new post with existing user`, () => {
            const author = "post-author-existing";
            insertPost({ authorSignerAddress: author });
            const statsBefore = queryStats();
            insertPost({ authorSignerAddress: author });
            const statsAfter = queryStats();
            expectDelta(postCountKeys, statsBefore, statsAfter, 1);
        });

        it(`PostCount does not increase by 1 for new reply`, () => {
            const post = insertPost({ authorSignerAddress: "post-author" });
            const statsBefore = queryStats();
            insertReply({ parent: post, authorSignerAddress: "reply-author" });
            const statsAfter = queryStats();
            expectDelta(postCountKeys, statsBefore, statsAfter, 0);
        });
    });

    describe(`community.stats.replyCount`, () => {
        it(`replyCount should increase by 1 for new reply`, () => {
            const post = insertPost({ authorSignerAddress: "post-author" });
            const statsBefore = queryStats();
            insertReply({ parent: post, authorSignerAddress: "new-reply-author" });
            const statsAfter = queryStats();
            expectDelta(replyCountKeys, statsBefore, statsAfter, 1);
        });

        it(`ReplyCount should increase by 1 for new reply with existing author`, () => {
            const post = insertPost({ authorSignerAddress: "post-author" });
            const author = "repeat-reply-author";
            insertReply({ parent: post, authorSignerAddress: author });
            const statsBefore = queryStats();
            insertReply({ parent: post, authorSignerAddress: author });
            const statsAfter = queryStats();
            expectDelta(replyCountKeys, statsBefore, statsAfter, 1);
        });

        it(`ReplyCount does not increase by 1 for new post`, () => {
            const statsBefore = queryStats();
            insertPost({ authorSignerAddress: "post-author" });
            const statsAfter = queryStats();
            expectDelta(replyCountKeys, statsBefore, statsAfter, 0);
        });
    });

    describe(`community.stats filters ineligible comments`, () => {
        it(`ignores comments stored under different community address`, () => {
            const statsBefore = queryStats();
            insertPost({
                authorSignerAddress: "foreign-author",
                overrides: { communityPublicKey: "other-community" }
            });
            const statsAfter = queryStats();
            expectDelta(activeUserCountKeys, statsBefore, statsAfter, 0);
            expectDelta(postCountKeys, statsBefore, statsAfter, 0);
            expectDelta(replyCountKeys, statsBefore, statsAfter, 0);
        });

        it(`ignores removed comments`, () => {
            const post = insertPost({ authorSignerAddress: "active-post-author" });
            const statsBefore = queryStats();
            const reply = insertReply({ parent: post, authorSignerAddress: "removed-reply-author" });
            insertCommentUpdate(reply, { removed: true });
            const statsAfter = queryStats();
            expectDelta(activeUserCountKeys, statsBefore, statsAfter, 0);
            expectDelta(replyCountKeys, statsBefore, statsAfter, 0);
        });

        it(`ignores deleted comments`, () => {
            const statsBefore = queryStats();
            const post = insertPost({ authorSignerAddress: "deleted-author" });
            insertCommentUpdate(post, { edit: createMockEdit(post, communityAddress, true) });
            const statsAfter = queryStats();
            expectDelta(activeUserCountKeys, statsBefore, statsAfter, 0);
            expectDelta(postCountKeys, statsBefore, statsAfter, 0);
        });

        it(`ignores comments pending approval`, () => {
            const statsBefore = queryStats();
            insertPost({ authorSignerAddress: "pending-post-author", overrides: { pendingApproval: true } });
            const statsAfter = queryStats();
            expectDelta(activeUserCountKeys, statsBefore, statsAfter, 0);
            expectDelta(postCountKeys, statsBefore, statsAfter, 0);
        });

        it(`ignores replies pending approval`, () => {
            const post = insertPost({ authorSignerAddress: "post-for-pending-reply" });
            const statsBefore = queryStats();
            insertReply({
                parent: post,
                authorSignerAddress: "pending-reply-author",
                overrides: { pendingApproval: true }
            });
            const statsAfter = queryStats();
            expectDelta(replyCountKeys, statsBefore, statsAfter, 0);
            expectDelta(activeUserCountKeys, statsBefore, statsAfter, 0);
        });

        it(`ignores votes tied to comments under different community address`, () => {
            const statsBefore = queryStats();
            const foreignPost = insertPost({
                authorSignerAddress: "foreign-post-vote",
                overrides: { communityPublicKey: "another-sub" }
            });
            insertVote(foreignPost, { authorSignerAddress: "vote-on-foreign" });
            const statsAfter = queryStats();
            expectDelta(activeUserCountKeys, statsBefore, statsAfter, 0);
        });

        it(`ignores votes on removed comments`, () => {
            const post = insertPost({ authorSignerAddress: "removed-post-for-vote" });
            insertCommentUpdate(post, { removed: true });
            const statsBefore = queryStats();
            insertVote(post, { authorSignerAddress: "vote-on-removed" });
            const statsAfter = queryStats();
            expectDelta(activeUserCountKeys, statsBefore, statsAfter, 0);
        });

        it(`respects timeframe boundaries for post counts`, () => {
            const statsBefore = queryStats();
            const timestamp = currentTimestamp() - TIMEFRAMES_TO_SECONDS.HOUR - BUFFER_SECONDS;
            insertPost({ authorSignerAddress: "older-post", timestamp });
            const statsAfter = queryStats();
            expect(statsAfter.hourPostCount).to.equal(statsBefore.hourPostCount);
            expect(statsAfter.dayPostCount).to.equal(statsBefore.dayPostCount + 1);
            expect(statsAfter.weekPostCount).to.equal(statsBefore.weekPostCount + 1);
            expect(statsAfter.monthPostCount).to.equal(statsBefore.monthPostCount + 1);
            expect(statsAfter.yearPostCount).to.equal(statsBefore.yearPostCount + 1);
            expect(statsAfter.allPostCount).to.equal(statsBefore.allPostCount + 1);
        });

        it(`recounts comments when deleted flag is cleared`, () => {
            const statsBefore = queryStats();
            const post = insertPost({ authorSignerAddress: "toggle-deleted-author" });
            const afterInsert = queryStats();
            expectDelta(postCountKeys, statsBefore, afterInsert, 1);

            insertCommentUpdate(post, { edit: createMockEdit(post, communityAddress, true) });
            const afterDelete = queryStats();
            expectDelta(postCountKeys, afterInsert, afterDelete, -1);

            insertCommentUpdate(post, { edit: createMockEdit(post, communityAddress, false) });
            const afterRestore = queryStats();
            expectDelta(postCountKeys, afterDelete, afterRestore, 1);
        });
    });
});
