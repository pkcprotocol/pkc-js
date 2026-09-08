import { beforeEach, afterEach, describe, it, expect } from "vitest";
import assert from "assert";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import signers from "../../fixtures/signers.js";

import type {
    CommentsTableRow,
    CommentsTableRowInsert,
    CommentUpdatesTableRowInsert,
    CommunityAuthor
} from "../../../dist/node/publications/comment/types.js";
import type { VotesTableRowInsert } from "../../../dist/node/publications/vote/types.js";
import type { CommentModerationsTableRowInsert } from "../../../dist/node/publications/comment-moderation/types.js";
import type { CommentEditsTableRowInsert } from "../../../dist/node/publications/comment-edit/types.js";

const PROTOCOL_VERSION = "1.0.0";
const SIGNATURE = { type: "ed25519", signature: "sig", publicKey: "pk", signedPropertyNames: [] as string[] };

// The update cycle calculates every flagged comment's CommentUpdate fields with one batched read per statement
// instead of nine statements per comment (issue #352). The batched path must produce, for every comment, exactly
// what the per-comment queryCalculatedCommentUpdate produces, including every precedence rule: latest moderation
// per field, author edits only from the comment's author, approved:false implying removed, challenge-supplied
// fields as the lowest priority, alias karma vs. original-author mod edits, and the recursive counts that ignore
// removed/deleted subtrees. This board exercises each of them at once.
describeSkipIfRpc("db-handler.queryCalculatedCommentUpdates (batched) matches queryCalculatedCommentUpdate", () => {
    let dbHandler: DbHandler | undefined;
    let communityAddress: string;
    let cidCounter = 0;
    let clock = 1_700_000_000;

    const nextCid = (prefix = "QmBatch"): string => `${prefix}${(cidCounter++).toString().padStart(4, "0")}`;
    const tick = (): number => ++clock;

    const originalAuthor = signers[0]; // the original author behind the alias comments
    const AUTHOR_A = originalAuthor.address;
    const AUTHOR_B = "12D3KooAuthorB";
    const AUTHOR_C = "12D3KooAuthorC";
    const AUTHOR_C_DOMAIN = "author-c.bso";
    const ALIAS_ADDRESS = "12D3KooAliasOfA";

    async function createTestDbHandler(): Promise<DbHandler> {
        communityAddress = `12D3KooBatchCommunity${Date.now()}`;
        const fakeCommunity = { address: communityAddress, _pkc: { noData: true } };
        const handler = new DbHandler(fakeCommunity as never);
        await handler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        await handler.createOrMigrateTablesIfNeeded();
        return handler;
    }

    type Seeded = { cid: string; depth: number; parentCid: string | null; postCid: string; timestamp: number; authorSignerAddress: string };

    const insertComment = (
        opts: {
            depth?: number;
            parentCid?: string | null;
            postCid?: string;
            authorSignerAddress?: string;
            authorName?: string;
            pendingApproval?: boolean;
            foreignCommunity?: boolean;
            withUpdate?: boolean;
            challengeCommentUpdate?: Record<string, unknown>;
        } = {}
    ): Seeded => {
        assert(dbHandler);
        const cid = nextCid();
        const depth = opts.depth ?? 0;
        const postCid = opts.postCid ?? (depth === 0 ? cid : opts.parentCid!);
        const timestamp = tick();
        const authorSignerAddress = opts.authorSignerAddress ?? `12D3KooAuthor${cid}`;
        const numbers: { number?: number; postNumber?: number } = opts.pendingApproval ? {} : dbHandler.getNextCommentNumbers(depth);
        const row: CommentsTableRowInsert = {
            cid,
            authorSignerAddress,
            author: { address: authorSignerAddress, ...(opts.authorName ? { name: opts.authorName } : {}) },
            content: `content-${cid}`,
            title: depth === 0 ? `title-${cid}` : undefined,
            communityPublicKey: opts.foreignCommunity ? `12D3KooOtherCommunity` : communityAddress,
            timestamp,
            depth,
            postCid,
            parentCid: depth === 0 ? undefined : opts.parentCid ?? undefined,
            signature: SIGNATURE,
            protocolVersion: PROTOCOL_VERSION,
            pendingApproval: opts.pendingApproval ? true : undefined,
            number: numbers.number,
            postNumber: numbers.postNumber,
            insertedAt: timestamp,
            challengeCommentUpdate: opts.challengeCommentUpdate
        } as CommentsTableRowInsert;
        dbHandler.insertComments([row]);
        if (opts.withUpdate !== false) {
            const update: CommentUpdatesTableRowInsert = {
                cid,
                upvoteCount: 0,
                downvoteCount: 0,
                replyCount: 0,
                childCount: 0,
                updatedAt: timestamp,
                protocolVersion: PROTOCOL_VERSION,
                signature: SIGNATURE,
                author: { community: { postScore: 0, replyScore: 0, lastCommentCid: cid, firstCommentTimestamp: timestamp } },
                postUpdatesBucket: 0,
                publishedToPostUpdatesMFS: false,
                insertedAt: timestamp
            } as CommentUpdatesTableRowInsert;
            dbHandler.upsertCommentUpdates([update]);
        }
        return { cid, depth, parentCid: depth === 0 ? null : opts.parentCid ?? null, postCid, timestamp, authorSignerAddress };
    };

    const vote = (comment: Seeded, value: 1 | -1, n = 1): void => {
        assert(dbHandler);
        const rows: VotesTableRowInsert[] = [];
        for (let i = 0; i < n; i++)
            rows.push({
                commentCid: comment.cid,
                authorSignerAddress: `12D3KooVoter${comment.cid}${value}${i}`,
                vote: value,
                timestamp: tick(),
                protocolVersion: PROTOCOL_VERSION,
                insertedAt: clock
            });
        dbHandler.insertVotes(rows);
    };

    const moderate = (
        comment: Seeded | undefined,
        commentModeration: Record<string, unknown>,
        target: { targetAuthorSignerAddress?: string; targetAuthorDomain?: string } = {}
    ): void => {
        assert(dbHandler);
        const commentCid = comment?.cid ?? nextCid("QmPurged");
        dbHandler.insertCommentModerations([
            {
                commentCid,
                author: { address: `12D3KooMod` },
                signature: SIGNATURE,
                modSignerAddress: `12D3KooMod`,
                protocolVersion: PROTOCOL_VERSION,
                communityPublicKey: communityAddress,
                timestamp: tick(),
                commentModeration,
                insertedAt: clock,
                ...target
            } as unknown as CommentModerationsTableRowInsert
        ]);
    };

    const authorEdit = (comment: Seeded, fields: Record<string, unknown>, opts: { by?: string; isAuthorEdit?: boolean } = {}): void => {
        assert(dbHandler);
        const by = opts.by ?? comment.authorSignerAddress;
        dbHandler.insertCommentEdits([
            {
                commentCid: comment.cid,
                authorSignerAddress: by,
                author: { address: by },
                signature: { ...SIGNATURE, signedPropertyNames: ["commentCid", ...Object.keys(fields)] },
                protocolVersion: PROTOCOL_VERSION,
                communityPublicKey: communityAddress,
                timestamp: tick(),
                isAuthorEdit: opts.isAuthorEdit ?? true,
                insertedAt: clock,
                ...fields
            } as unknown as CommentEditsTableRowInsert
        ]);
    };

    // Every CommentUpdate row also needs the counts the recursive statements read off children (removed, deleted)
    const markUpdate = (comment: Seeded, fields: Record<string, unknown>): void => {
        assert(dbHandler);
        const db = dbHandler["_db"] as { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
        for (const [column, value] of Object.entries(fields))
            db.prepare(`UPDATE commentUpdates SET ${column} = ? WHERE cid = ?`).run(
                typeof value === "object" ? JSON.stringify(value) : value,
                comment.cid
            );
    };

    let seeded: Seeded[];

    // A board with three posts and every wrinkle the calculation has a rule for
    const seedBoard = (): void => {
        seeded = [];
        const add = (c: Seeded) => (seeded.push(c), c);

        // P1 by the original author (signers[0]); a deep thread with removed, deleted, pending, foreign, and update-less replies
        const p1 = add(insertComment({ authorSignerAddress: AUTHOR_A }));
        vote(p1, 1, 3);
        vote(p1, -1, 1);
        moderate(p1, { pinned: true, locked: true });
        moderate(p1, { pinned: false, reason: "latest reason wins" });
        const r1 = add(insertComment({ depth: 1, parentCid: p1.cid, authorSignerAddress: AUTHOR_B }));
        vote(r1, 1, 2);
        const r1a = add(
            insertComment({ depth: 2, parentCid: r1.cid, postCid: p1.cid, authorSignerAddress: AUTHOR_C, authorName: AUTHOR_C_DOMAIN })
        );
        authorEdit(r1a, { deleted: true });
        markUpdate(r1a, { edit: { deleted: true } });
        add(insertComment({ depth: 3, parentCid: r1a.cid, postCid: p1.cid })); // under a deleted reply: excluded from counts
        const r1b = add(insertComment({ depth: 2, parentCid: r1.cid, postCid: p1.cid, authorSignerAddress: AUTHOR_A }));
        vote(r1b, -1, 2);
        add(insertComment({ depth: 3, parentCid: r1b.cid, postCid: p1.cid, authorSignerAddress: AUTHOR_B }));
        const r2 = add(insertComment({ depth: 1, parentCid: p1.cid, authorSignerAddress: AUTHOR_C, authorName: AUTHOR_C_DOMAIN }));
        moderate(r2, { removed: true, reason: "spam" });
        markUpdate(r2, { removed: 1 });
        add(insertComment({ depth: 2, parentCid: r2.cid, postCid: p1.cid })); // under a removed reply
        add(insertComment({ depth: 1, parentCid: p1.cid, pendingApproval: true }));
        add(insertComment({ depth: 1, parentCid: p1.cid, withUpdate: false })); // no CommentUpdate row yet
        add(insertComment({ depth: 1, parentCid: p1.cid, foreignCommunity: true }));

        // P2 by the alias of the original author: karma from the alias only, mod edits from both
        const p2 = add(insertComment({ authorSignerAddress: ALIAS_ADDRESS }));
        dbHandler!.insertPseudonymityAliases([
            {
                commentCid: p2.cid,
                aliasPrivateKey: "alias-private-key",
                originalAuthorPublicKey: originalAuthor.publicKey,
                originalAuthorName: null,
                mode: "per-post",
                insertedAt: tick()
            }
        ]);
        vote(p2, 1, 5);
        moderate(p2, { approved: false }); // implies removed: true unless a flag says otherwise
        moderate(undefined, { author: { banExpiresAt: clock + 100_000 } }, { targetAuthorSignerAddress: AUTHOR_A }); // ban on the original author
        add(insertComment({ depth: 1, parentCid: p2.cid, authorSignerAddress: ALIAS_ADDRESS }));

        // P3 by author C, moderated flairs then a spoiler, author edit with flairs, a non-author edit, a domain-targeted mod edit
        const p3 = add(
            insertComment({
                authorSignerAddress: AUTHOR_C,
                authorName: AUTHOR_C_DOMAIN,
                challengeCommentUpdate: {
                    reason: "from challenge",
                    flairs: [{ text: "challenge flair" }],
                    author: { community: { countryCode: "US" } }
                }
            })
        );
        moderate(p3, { flairs: [{ text: "mod flair" }] });
        moderate(p3, { spoiler: true, nsfw: true });
        authorEdit(p3, { content: "edited", flairs: [{ text: "author flair" }], spoiler: false });
        authorEdit(p3, { content: "not by the author" }, { by: AUTHOR_B, isAuthorEdit: false });
        moderate(undefined, { author: { flairs: [{ text: "domain flair" }] } }, { targetAuthorDomain: AUTHOR_C_DOMAIN });
        const r3 = add(insertComment({ depth: 1, parentCid: p3.cid, authorSignerAddress: AUTHOR_B }));
        moderate(r3, { approved: true });
        add(insertComment({ depth: 2, parentCid: r3.cid, postCid: p3.cid, authorSignerAddress: AUTHOR_A }));
    };

    beforeEach(async () => {
        dbHandler = await createTestDbHandler();
        seedBoard();
    });

    afterEach(async () => {
        if (dbHandler) await dbHandler.destoryConnection();
        dbHandler = undefined;
        cidCounter = 0;
    });

    const rowsOf = (comments: Seeded[]): CommentsTableRow[] =>
        comments.map((c) => {
            const row = dbHandler!.queryComment(c.cid);
            assert(row, `comment ${c.cid} missing`);
            return row;
        });

    it("produces the per-comment result for every comment of the board, in one batch", () => {
        assert(dbHandler);
        const rows = rowsOf(seeded);
        const batched = dbHandler.queryCalculatedCommentUpdates({ comments: rows });
        expect(batched.size).to.equal(rows.length);
        for (const row of rows) {
            const single = dbHandler.queryCalculatedCommentUpdate({ comment: row, authorDomain: row.author.name });
            expect(
                batched.get(row.cid),
                `calculated update of ${row.cid} (depth ${row.depth}, author ${row.authorSignerAddress})`
            ).to.deep.equal(single);
        }
        // The board exercised what it was built to exercise
        const byCid = new Map(rows.map((row) => [row.cid, batched.get(row.cid)!]));
        const p1 = byCid.get(seeded[0].cid)!;
        expect(p1).to.include({ pinned: false, locked: true, reason: "latest reason wins", upvoteCount: 3, downvoteCount: 1 });
        // The counts filter on removed, deleted, address and the presence of a CommentUpdate row, not on pending
        expect(p1.childCount, "removed, update-less and foreign replies are not children; a pending one with a row is").to.equal(2);
        expect(p1.replyCount, "the deleted reply and everything under removed/deleted replies is excluded").to.equal(4);
        const p3 = byCid.get(seeded.find((c) => c.authorSignerAddress === AUTHOR_C && c.depth === 0)!.cid)!;
        expect(p3.flairs, "mod flairs win over the author edit and the challenge").to.deep.equal([{ text: "mod flair" }]);
        expect(p3).to.include({ spoiler: true, nsfw: true, reason: "from challenge" });
        expect(p3.author.community.flairs, "the domain-targeted mod edit reaches author C").to.deep.equal([{ text: "domain flair" }]);
        expect((p3.author.community as { countryCode?: string }).countryCode).to.equal("US");
        const p2 = byCid.get(seeded.find((c) => c.authorSignerAddress === ALIAS_ADDRESS && c.depth === 0)!.cid)!;
        expect(p2).to.include({ approved: false, removed: true, upvoteCount: 5 });
        expect(p2.author.community.postScore, "alias karma counts the alias's own comments only").to.equal(5);
        expect(p2.author.community.banExpiresAt, "the ban on the original author reaches the alias").to.be.a("number");
    });

    it("chunks a batch larger than the SQLite variable cap", () => {
        assert(dbHandler);
        const post = seeded[0];
        const many: Seeded[] = [];
        for (let i = 0; i < 5000; i++)
            many.push(insertComment({ depth: 1, parentCid: post.cid, authorSignerAddress: `12D3KooBulk${i % 25}` }));
        const rows = rowsOf([post, ...many]);
        const batched = dbHandler.queryCalculatedCommentUpdates({ comments: rows });
        expect(batched.size).to.equal(rows.length);
        expect(batched.get(post.cid)!.childCount).to.equal(5002); // the 2 children of the seeded board plus the bulk
        for (const row of rows.slice(-3))
            expect(batched.get(row.cid)).to.deep.equal(
                dbHandler.queryCalculatedCommentUpdate({ comment: row, authorDomain: row.author.name })
            );
    });

    it("reuses a per-cycle author memo instead of aggregating the author again", () => {
        assert(dbHandler);
        const rows = rowsOf(seeded);
        const authorMemo = new Map<string, CommunityAuthor | undefined>();
        const first = dbHandler.queryCalculatedCommentUpdates({ comments: rows, authorMemo });
        expect(authorMemo.size, "one entry per distinct author (address set + domain)").to.be.greaterThan(0);
        // Poison every memo entry: a second batch with the same memo must return the memoised aggregates verbatim
        for (const key of authorMemo.keys()) authorMemo.set(key, { ...authorMemo.get(key)!, postScore: 4242 });
        const second = dbHandler.queryCalculatedCommentUpdates({ comments: rows, authorMemo });
        for (const row of rows) {
            expect(second.get(row.cid)!.author.community.postScore).to.equal(4242);
            expect({ ...second.get(row.cid)!, author: undefined }).to.deep.equal({ ...first.get(row.cid)!, author: undefined });
        }
    });
});
