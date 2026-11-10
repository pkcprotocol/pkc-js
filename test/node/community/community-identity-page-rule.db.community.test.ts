// Issue #401: which rows a community's pages, counts and stats include, by the comment's signed community fields and the
// community's current address. The rule is always on and mirrors client page verification (verifyPageComment), so the
// server never hides a row a client would accept and never publishes one a client would reject:
// - a community with a name: a row with a communityName must carry that name or its .eth/.bso alias; rows without a name pass
// - a community without a name: a row with a communityPublicKey must carry the community's key; rows without a key pass
// The rows below are the shapes a community's database can hold: key + name (published under a name), key only (published
// while the community had no name), and name only (migrated pre-v37 domain rows, whose communityPublicKey is NULL).
// Swapping the fake community's address replays every address change on the same rows.
import { it, describe, beforeAll, afterAll, expect } from "vitest";
import Logger from "@pkcprotocol/pkc-logger";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { applyPageSortExclusions } from "../../../dist/node/pages/page-sort-scoring.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";

import type Database from "better-sqlite3";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

// Local-community helpers log through community._log (issue #493); fakes get the process-default root
const testLog = Logger({ namespace: "pkc-js:test:community-identity-page-rule" });

const COMMUNITY_KEY = "12D3KooWCommunityIdentityRuleKey";
const NAME_A = "board-a.bso";
const NAME_A_ALIAS = "board-a.eth";
const NAME_B = "board-b.bso";

const now = Math.floor(Date.now() / 1000);

type RowShape = { communityPublicKey: string | null; communityName: string | null };

// Every post shape; each post's cid names its shape
const POSTS: Record<string, RowShape> = {
    QmPostKeyOnly: { communityPublicKey: COMMUNITY_KEY, communityName: null },
    QmPostKeyAndNameA: { communityPublicKey: COMMUNITY_KEY, communityName: NAME_A },
    QmPostKeyAndNameAAlias: { communityPublicKey: COMMUNITY_KEY, communityName: NAME_A_ALIAS },
    QmPostKeyAndNameB: { communityPublicKey: COMMUNITY_KEY, communityName: NAME_B },
    QmPostLegacyNameA: { communityPublicKey: null, communityName: NAME_A },
    QmPostLegacyNameB: { communityPublicKey: null, communityName: NAME_B }
};
// Replies under QmPostKeyOnly, one per shape, so its replyCount and lastReplyTimestamp show which replies count
const PARENT_CID = "QmPostKeyOnly";
const REPLIES: Record<string, RowShape & { timestamp: number }> = {
    QmReplyKeyOnly: { communityPublicKey: COMMUNITY_KEY, communityName: null, timestamp: now + 1 },
    QmReplyKeyAndNameA: { communityPublicKey: COMMUNITY_KEY, communityName: NAME_A, timestamp: now + 2 },
    QmReplyKeyAndNameB: { communityPublicKey: COMMUNITY_KEY, communityName: NAME_B, timestamp: now + 3 },
    QmReplyLegacyNameA: { communityPublicKey: null, communityName: NAME_A, timestamp: now + 4 }
};

// Which rows each community address must include
const CASES: { address: string; description: string; posts: string[]; replies: string[] }[] = [
    {
        address: COMMUNITY_KEY,
        description:
            "no name (never had one, or dropped it): every row passes, since the name is not checked and every key is the community's",
        posts: Object.keys(POSTS),
        replies: Object.keys(REPLIES)
    },
    {
        address: NAME_A,
        description: `named ${NAME_A}: rows named ${NAME_A} or its alias and rows without a name`,
        posts: ["QmPostKeyOnly", "QmPostKeyAndNameA", "QmPostKeyAndNameAAlias", "QmPostLegacyNameA"],
        replies: ["QmReplyKeyOnly", "QmReplyKeyAndNameA", "QmReplyLegacyNameA"]
    },
    {
        address: NAME_A_ALIAS,
        description: `named ${NAME_A_ALIAS}: the alias admits the same rows as ${NAME_A}`,
        posts: ["QmPostKeyOnly", "QmPostKeyAndNameA", "QmPostKeyAndNameAAlias", "QmPostLegacyNameA"],
        replies: ["QmReplyKeyOnly", "QmReplyKeyAndNameA", "QmReplyLegacyNameA"]
    },
    {
        address: NAME_B,
        description: `renamed to ${NAME_B}: rows named ${NAME_A} drop out, rows without a name stay`,
        posts: ["QmPostKeyOnly", "QmPostKeyAndNameB", "QmPostLegacyNameB"],
        replies: ["QmReplyKeyOnly", "QmReplyKeyAndNameB"]
    }
];

function createFakeCommunity(address: string) {
    return {
        address,
        _pkc: { noData: true },
        _cidsToUnPin: new Set<string>(),
        _blocksToRm: [] as string[],
        _mfsPathsToRemove: new Set<string>(),
        _log: testLog,
        _clientsManager: {},
        _calculateLocalMfsPathForCommentUpdate: () => "",
        _addOldPageCidsToCidsToUnpin: async () => {},
        _addAllCidsUnderPurgedCommentToBeRemoved: () => {}
    };
}

type DbHandlerPrivate = { _db: Database.Database; _community: ReturnType<typeof createFakeCommunity> };
const getPrivate = (handler: DbHandler) => handler as unknown as DbHandlerPrivate;

const signatureFor = (cid: string) => ({
    type: "ed25519",
    signature: `sig-${cid}`,
    publicKey: `pk-${cid}`,
    signedPropertyNames: ["communityPublicKey", "communityName", "content", "author", "timestamp", "title", "parentCid", "postCid"]
});

// No reserved exclusion is on, so the only thing deciding a row's presence is the community identity rule. The cast
// covers both sides of #401: before it, PageOptions also carries excludeCommentsWithDifferentCommunityAddress.
const pageOptions = (parentCid: string | null) =>
    ({
        parentCid,
        excludeRemovedComments: false,
        excludeDeletedComments: false,
        excludeCommentPendingApproval: false,
        excludeCommentWithApprovedFalse: false,
        baseTimestamp: now + 100
    }) as Parameters<DbHandler["queryPageComments"]>[0];

const noExclusions = {
    excludeRemovedComments: false,
    excludeDeletedComments: false,
    excludeCommentPendingApproval: false,
    excludeCommentWithApprovedFalse: false
} as Parameters<typeof applyPageSortExclusions>[0]["exclusions"];

describeSkipIfRpc("community identity rule for page rows, counts and stats (#401)", () => {
    let dbHandler: DbHandler;

    beforeAll(async () => {
        dbHandler = new DbHandler(createFakeCommunity(COMMUNITY_KEY) as unknown as LocalCommunity);
        await dbHandler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        await dbHandler.createOrMigrateTablesIfNeeded();

        const insert = (
            cid: string,
            shape: RowShape,
            opts: { depth: number; parentCid: string | null; postCid: string; timestamp: number }
        ) =>
            dbHandler.insertComments([
                {
                    cid,
                    authorSignerAddress: `12D3KooWAuthor-${cid}`,
                    author: { address: `12D3KooWAuthor-${cid}` },
                    link: null,
                    linkWidth: null,
                    linkHeight: null,
                    thumbnailUrl: null,
                    thumbnailUrlWidth: null,
                    thumbnailUrlHeight: null,
                    parentCid: opts.parentCid,
                    postCid: opts.postCid,
                    previousCid: null,
                    ...(shape.communityPublicKey ? { communityPublicKey: shape.communityPublicKey } : {}),
                    ...(shape.communityName ? { communityName: shape.communityName } : {}),
                    content: `content of ${cid}`,
                    timestamp: opts.timestamp,
                    signature: signatureFor(cid),
                    title: opts.depth === 0 ? `title of ${cid}` : null,
                    depth: opts.depth,
                    linkHtmlTagName: null,
                    flairs: null,
                    spoiler: false,
                    pendingApproval: false,
                    nsfw: false,
                    extraProps: null,
                    protocolVersion: "1.0.0",
                    insertedAt: now
                } as Parameters<DbHandler["insertComments"]>[0][0]
            ]);

        for (const [cid, shape] of Object.entries(POSTS)) insert(cid, shape, { depth: 0, parentCid: null, postCid: cid, timestamp: now });
        for (const [cid, reply] of Object.entries(REPLIES))
            insert(cid, reply, { depth: 1, parentCid: PARENT_CID, postCid: PARENT_CID, timestamp: reply.timestamp });

        const db = getPrivate(dbHandler)._db;
        const insertUpdate = db.prepare(
            `INSERT INTO commentUpdates (cid, upvoteCount, downvoteCount, replyCount, childCount, number, postNumber,
                updatedAt, protocolVersion, signature, publishedToPostUpdatesMFS, insertedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        [...Object.keys(POSTS), ...Object.keys(REPLIES)].forEach((cid, i) =>
            insertUpdate.run(cid, 0, 0, 0, 0, i + 1, 1, now, "1.0.0", JSON.stringify(signatureFor(`update-${cid}`)), 1, now)
        );
    });

    afterAll(() => {
        dbHandler.destoryConnection();
    });

    const withAddress = <T>(address: string, run: () => T): T => {
        const priv = getPrivate(dbHandler);
        const original = priv._community;
        priv._community = createFakeCommunity(address);
        try {
            return run();
        } finally {
            priv._community = original;
        }
    };

    const sorted = (cids: string[]) => [...cids].sort();

    for (const testCase of CASES) {
        describe(`community ${testCase.description}`, () => {
            it(`posts pages include exactly the passing posts`, () => {
                const cids = withAddress(testCase.address, () =>
                    dbHandler.queryPosts(pageOptions(null)).map((post) => post.commentUpdate.cid)
                );
                expect(sorted(cids)).to.deep.equal(sorted(testCase.posts));
            });

            it(`a post's replies page includes exactly the passing replies`, () => {
                const cids = withAddress(testCase.address, () =>
                    dbHandler.queryPageComments(pageOptions(PARENT_CID)).map((reply) => reply.commentUpdate.cid)
                );
                expect(sorted(cids)).to.deep.equal(sorted(testCase.replies));
            });

            it(`a post's flat replies page includes exactly the passing replies`, () => {
                const cids = withAddress(testCase.address, () =>
                    dbHandler
                        .queryFlattenedPageReplies({ ...pageOptions(PARENT_CID), parentCid: PARENT_CID })
                        .map((reply) => reply.commentUpdate.cid)
                );
                expect(sorted(cids)).to.deep.equal(sorted(testCase.replies));
            });

            it(`the parent's replyCount, childCount and lastReplyTimestamp count exactly the passing replies`, () => {
                const update = withAddress(testCase.address, () =>
                    dbHandler.queryCalculatedCommentUpdate({
                        comment: { cid: PARENT_CID, authorSignerAddress: `12D3KooWAuthor-${PARENT_CID}`, timestamp: now }
                    })
                );
                expect(update.replyCount).to.equal(testCase.replies.length);
                expect(update.childCount).to.equal(testCase.replies.length);
                expect(update.lastReplyTimestamp).to.equal(Math.max(...testCase.replies.map((cid) => REPLIES[cid].timestamp)));
            });

            it(`stats count exactly the passing posts`, () => {
                const stats = withAddress(testCase.address, () => dbHandler.queryCommunityStats());
                expect(stats.allPostCount).to.equal(testCase.posts.length);
            });

            it(`the requireReplies JS mirror keeps exactly the passing replies`, () => {
                const replies = dbHandler.queryAllRepliesForPageSort({ postCid: PARENT_CID });
                const kept = applyPageSortExclusions({ comments: replies, exclusions: noExclusions, communityAddress: testCase.address });
                expect(sorted(kept.map((entry) => entry.commentUpdate.cid))).to.deep.equal(sorted(testCase.replies));
            });
        });
    }
});
