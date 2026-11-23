import { beforeEach, afterEach, it, expect } from "vitest";
import assert from "assert";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import signers from "../../fixtures/signers.js";
import { CommentUpdateChallengeReservedFieldNames, CommentUpdateSchema } from "../../../dist/node/publications/comment/schema.js";
import { ModeratorOptionsSchema } from "../../../dist/node/publications/comment-moderation/schema.js";

import type { CommentsTableRow, CommentsTableRowInsert } from "../../../dist/node/publications/comment/types.js";
import type { CommentModerationsTableRowInsert } from "../../../dist/node/publications/comment-moderation/types.js";

const PROTOCOL_VERSION = "1.0.0";
const COMMENT_CID = "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f";
const SIGNATURE = { type: "ed25519", signature: "sig", publicKey: "pk", signedPropertyNames: [] as string[] };

// commentUpdate.authorBanExpiresAt (issue #363) says which comment a mod banned the author from. It is the newest
// author.banExpiresAt published on that comment's own cid, while author.community.banExpiresAt is the newest across
// all of the author's comments and so cannot tell the offending comment from the rest.
// Uses DbHandler directly (Node-only), so it cannot run under RPC.
describeSkipIfRpc("db-handler: commentUpdate.authorBanExpiresAt marks the comment a ban was published on", () => {
    let dbHandler: DbHandler | undefined;
    let communityAddress: string;
    let cidCounter = 0;
    let clock = 1_700_000_000;
    const AUTHOR = "12D3KooBannedAuthor";
    const FUTURE = 4_000_000_000;
    const PAST = 1_600_000_000;

    const tick = (): number => ++clock;

    beforeEach(async () => {
        communityAddress = `12D3KooBanMarkCommunity${Date.now()}`;
        dbHandler = new DbHandler({ address: communityAddress, _pkc: { noData: true } } as never);
        await dbHandler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        await dbHandler.createOrMigrateTablesIfNeeded();
    });

    afterEach(async () => {
        if (dbHandler) await dbHandler.destoryConnection();
        dbHandler = undefined;
        cidCounter = 0;
    });

    const insertComment = (authorSignerAddress = AUTHOR): CommentsTableRow => {
        assert(dbHandler);
        const cid = `QmBanMark${(cidCounter++).toString().padStart(4, "0")}`;
        const timestamp = tick();
        dbHandler.insertComments([
            {
                cid,
                authorSignerAddress,
                author: { address: authorSignerAddress },
                content: `content-${cid}`,
                title: `title-${cid}`,
                communityPublicKey: communityAddress,
                timestamp,
                depth: 0,
                postCid: cid,
                signature: SIGNATURE,
                protocolVersion: PROTOCOL_VERSION,
                ...dbHandler.getNextCommentNumbers(0),
                insertedAt: timestamp
            } as CommentsTableRowInsert
        ]);
        const row = dbHandler.queryComment(cid);
        assert(row);
        return row;
    };

    const moderate = (comment: CommentsTableRow, commentModeration: Record<string, unknown>, targetAuthorSignerAddress = AUTHOR): void => {
        assert(dbHandler);
        dbHandler.insertCommentModerations([
            {
                commentCid: comment.cid,
                author: { address: "12D3KooMod" },
                signature: { ...SIGNATURE, signature: `sig-${tick()}` },
                modSignerAddress: "12D3KooMod",
                protocolVersion: PROTOCOL_VERSION,
                communityPublicKey: communityAddress,
                timestamp: tick(),
                commentModeration,
                insertedAt: clock,
                targetAuthorSignerAddress
            } as unknown as CommentModerationsTableRowInsert
        ]);
    };

    const calculate = (comment: CommentsTableRow) => {
        assert(dbHandler);
        return dbHandler.queryCalculatedCommentUpdate({ comment });
    };

    it("a ban marks the comment it was published on and none of the author's other comments", () => {
        const banned = insertComment();
        const other = insertComment();
        moderate(banned, { author: { banExpiresAt: FUTURE } });

        expect(calculate(banned).authorBanExpiresAt).to.equal(FUTURE);
        expect(calculate(other).authorBanExpiresAt).to.be.undefined;
        // The author aggregate is unchanged: it still lands on every comment of the author
        expect(calculate(banned).author.community.banExpiresAt).to.equal(FUTURE);
        expect(calculate(other).author.community.banExpiresAt).to.equal(FUTURE);
    });

    it("the batched calculation carries the same mark", () => {
        assert(dbHandler);
        const banned = insertComment();
        const other = insertComment();
        moderate(banned, { author: { banExpiresAt: FUTURE } });

        const batched = dbHandler.queryCalculatedCommentUpdates({ comments: [banned, other] });
        expect(batched.get(banned.cid)!.authorBanExpiresAt).to.equal(FUTURE);
        expect(batched.get(other.cid)!.authorBanExpiresAt).to.be.undefined;
    });

    it("a comment with no ban moderation has no mark, whatever else was moderated on it", () => {
        const comment = insertComment();
        moderate(comment, { removed: true, reason: "spam" });
        moderate(comment, { author: { flairs: [{ text: "flair" }] } });

        expect(calculate(comment).authorBanExpiresAt).to.be.undefined;
        expect(calculate(comment)).to.not.have.property("authorBanExpiresAt", 0);
    });

    it("a later moderation on the same comment that carries no ban leaves the mark", () => {
        const banned = insertComment();
        moderate(banned, { author: { banExpiresAt: FUTURE } });
        moderate(banned, { removed: true, reason: "removed after the ban" });
        moderate(banned, { author: { flairs: [{ text: "flair" }] } });

        expect(calculate(banned).authorBanExpiresAt).to.equal(FUTURE);
    });

    it("the mark follows the newest ban published on that comment, not a newer ban published on another one", () => {
        const first = insertComment();
        const second = insertComment();
        moderate(first, { author: { banExpiresAt: FUTURE } });
        moderate(second, { author: { banExpiresAt: FUTURE + 500 } });

        expect(calculate(first).authorBanExpiresAt).to.equal(FUTURE);
        expect(calculate(second).authorBanExpiresAt).to.equal(FUTURE + 500);
        expect(calculate(first).author.community.banExpiresAt, "the aggregate is the newest ban").to.equal(FUTURE + 500);

        moderate(first, { author: { banExpiresAt: FUTURE + 1000 } });
        expect(calculate(first).authorBanExpiresAt, "a re-ban on the same comment replaces its value").to.equal(FUTURE + 1000);
    });

    it("an unban (a timestamp in the past) on the marked comment lifts the ban and keeps the mark", () => {
        const banned = insertComment();
        moderate(banned, { author: { banExpiresAt: FUTURE } });
        moderate(banned, { author: { banExpiresAt: PAST } });

        const update = calculate(banned);
        expect(update.authorBanExpiresAt, "the mark stays, its value is the past timestamp").to.equal(PAST);
        expect(update.author.community.banExpiresAt).to.equal(PAST);
    });

    it("an unban on another comment marks that comment too: any moderation carrying a timestamp does", () => {
        const banned = insertComment();
        const other = insertComment();
        moderate(banned, { author: { banExpiresAt: FUTURE } });
        moderate(other, { author: { banExpiresAt: PAST } });

        expect(calculate(banned).authorBanExpiresAt).to.equal(FUTURE);
        expect(calculate(other).authorBanExpiresAt).to.equal(PAST);
    });

    it("0 on the marked comment removes the mark and leaves the ban running", () => {
        const banned = insertComment();
        const other = insertComment();
        moderate(banned, { author: { banExpiresAt: FUTURE } });
        moderate(banned, { author: { banExpiresAt: 0 } });

        for (const comment of [banned, other]) {
            const update = calculate(comment);
            expect(update.authorBanExpiresAt).to.be.undefined;
            expect(update, "no published field ever carries 0").to.not.have.property("authorBanExpiresAt", 0);
            expect(update.author.community.banExpiresAt, "0 never touches the ban").to.equal(FUTURE);
        }
        assert(dbHandler);
        expect(dbHandler.queryAuthorModEdits({ authorSignerAddresses: [AUTHOR] }).banExpiresAt).to.equal(FUTURE);
        const batched = dbHandler.queryCalculatedCommentUpdates({ comments: [banned, other] });
        expect(batched.get(other.cid)!.author.community.banExpiresAt, "the batched calculation agrees").to.equal(FUTURE);
    });

    it("0 on a comment with no mark changes nothing", () => {
        const banned = insertComment();
        const other = insertComment();
        moderate(banned, { author: { banExpiresAt: FUTURE } });
        moderate(other, { author: { banExpiresAt: 0 } });

        expect(calculate(banned).authorBanExpiresAt).to.equal(FUTURE);
        expect(calculate(other).authorBanExpiresAt).to.be.undefined;
        expect(calculate(banned).author.community.banExpiresAt).to.equal(FUTURE);
        expect(calculate(other).author.community.banExpiresAt).to.equal(FUTURE);
    });

    it("0 with no ban ever published leaves the author without a ban", () => {
        const comment = insertComment();
        moderate(comment, { author: { banExpiresAt: 0 } });

        expect(calculate(comment).authorBanExpiresAt).to.be.undefined;
        expect(calculate(comment).author.community.banExpiresAt).to.be.undefined;
    });

    it("0 clears the mark a pre-filled ban left on another comment, and the ban stays", () => {
        const banned = insertComment();
        const removedLater = insertComment();
        moderate(banned, { author: { banExpiresAt: FUTURE } });
        // A client that sends the author's ban along with every moderation marks this comment too
        moderate(removedLater, { removed: true, author: { banExpiresAt: FUTURE } });
        expect(calculate(removedLater).authorBanExpiresAt).to.equal(FUTURE);

        moderate(removedLater, { author: { banExpiresAt: 0 } });
        expect(calculate(removedLater).authorBanExpiresAt).to.be.undefined;
        expect(calculate(banned).authorBanExpiresAt).to.equal(FUTURE);
        expect(calculate(banned).author.community.banExpiresAt).to.equal(FUTURE);
    });

    it("moving the mark to another comment keeps the author banned in either order", () => {
        for (const zeroFirst of [true, false]) {
            const wrongPost = insertComment();
            const rightPost = insertComment();
            moderate(wrongPost, { author: { banExpiresAt: FUTURE } });
            if (zeroFirst) moderate(wrongPost, { author: { banExpiresAt: 0 } });
            expect(calculate(rightPost).author.community.banExpiresAt, "banned before the move ends").to.equal(FUTURE);
            moderate(rightPost, { author: { banExpiresAt: FUTURE + 500 } });
            if (!zeroFirst) moderate(wrongPost, { author: { banExpiresAt: 0 } });

            expect(calculate(wrongPost).authorBanExpiresAt, `0 first: ${zeroFirst}`).to.be.undefined;
            expect(calculate(rightPost).authorBanExpiresAt, `0 first: ${zeroFirst}`).to.equal(FUTURE + 500);
            expect(calculate(wrongPost).author.community.banExpiresAt, `0 first: ${zeroFirst}`).to.equal(FUTURE + 500);
        }
    });

    it("an unban then 0 on the same comment undoes a ban: no mark, and the ban is lifted", () => {
        const banned = insertComment();
        moderate(banned, { author: { banExpiresAt: FUTURE } });
        moderate(banned, { author: { banExpiresAt: PAST } });
        moderate(banned, { author: { banExpiresAt: 0 } });

        const update = calculate(banned);
        expect(update.authorBanExpiresAt).to.be.undefined;
        expect(update.author.community.banExpiresAt, "the lifted ban's past timestamp stays on the author").to.equal(PAST);
    });

    it("in the other order the unban marks the comment again, and another 0 clears it", () => {
        const banned = insertComment();
        moderate(banned, { author: { banExpiresAt: FUTURE } });
        moderate(banned, { author: { banExpiresAt: 0 } });
        moderate(banned, { author: { banExpiresAt: PAST } });

        expect(calculate(banned).authorBanExpiresAt, "a leftover mark, not a running ban").to.equal(PAST);
        expect(calculate(banned).author.community.banExpiresAt).to.equal(PAST);

        moderate(banned, { author: { banExpiresAt: 0 } });
        expect(calculate(banned).authorBanExpiresAt).to.be.undefined;
        expect(calculate(banned).author.community.banExpiresAt).to.equal(PAST);
    });

    it("a ban published after a 0 on the same comment marks it again", () => {
        const banned = insertComment();
        moderate(banned, { author: { banExpiresAt: FUTURE } });
        moderate(banned, { author: { banExpiresAt: 0 } });
        moderate(banned, { author: { banExpiresAt: FUTURE + 500 } });

        expect(calculate(banned).authorBanExpiresAt).to.equal(FUTURE + 500);
        expect(calculate(banned).author.community.banExpiresAt).to.equal(FUTURE + 500);
    });

    it("a ban published on an alias comment marks that comment only, while the aggregate reaches the author's other alias comments", () => {
        assert(dbHandler);
        // per-author pseudonymity: both comments are signed by the same alias, the ban targets the original author
        const ALIAS = "12D3KooAliasOfBannedAuthor";
        const original = signers[0];
        const banned = insertComment(ALIAS);
        const other = insertComment(ALIAS);
        for (const comment of [banned, other])
            dbHandler.insertPseudonymityAliases([
                {
                    commentCid: comment.cid,
                    aliasPrivateKey: "alias-private-key",
                    originalAuthorPublicKey: original.publicKey,
                    originalAuthorName: null,
                    mode: "per-author",
                    insertedAt: tick()
                }
            ]);
        const originalAddress = original.address;
        moderate(banned, { author: { banExpiresAt: FUTURE } }, originalAddress);

        expect(calculate(banned).authorBanExpiresAt).to.equal(FUTURE);
        expect(calculate(other).authorBanExpiresAt).to.be.undefined;
        expect(calculate(other).author.community.banExpiresAt, "the ban on the original author reaches the alias").to.equal(FUTURE);
    });

    it("a challenge cannot seed the mark", () => {
        expect(CommentUpdateChallengeReservedFieldNames).to.include("authorBanExpiresAt");
        assert(dbHandler);
        const comment = insertComment();
        const update = dbHandler.queryCalculatedCommentUpdate({
            comment: { ...comment, challengeCommentUpdate: { authorBanExpiresAt: FUTURE } }
        });
        expect(update.authorBanExpiresAt).to.be.undefined;
    });

    it("the stored CommentUpdate row keeps the mark", () => {
        assert(dbHandler);
        const comment = insertComment();
        dbHandler.upsertCommentUpdates([
            {
                cid: comment.cid,
                upvoteCount: 0,
                downvoteCount: 0,
                replyCount: 0,
                childCount: 0,
                authorBanExpiresAt: FUTURE,
                updatedAt: tick(),
                protocolVersion: PROTOCOL_VERSION,
                signature: SIGNATURE,
                postUpdatesBucket: 0,
                publishedToPostUpdatesMFS: false,
                insertedAt: clock
            }
        ]);
        expect(dbHandler.queryStoredCommentUpdate({ cid: comment.cid })?.authorBanExpiresAt).to.equal(FUTURE);
    });
});

// Schemas only, no DbHandler, but kept next to the calculation they describe. Skipped under RPC with the suite above
// because this file runs in the Node-only DB group.
describeSkipIfRpc("schemas: author.banExpiresAt 0 is a moderation input only", () => {
    it("commentModeration.author.banExpiresAt accepts a timestamp and 0, and rejects a negative or fractional value", () => {
        for (const banExpiresAt of [4_000_000_000, 1, 0])
            expect(ModeratorOptionsSchema.safeParse({ author: { banExpiresAt } }).success, `banExpiresAt ${banExpiresAt}`).to.be.true;
        for (const banExpiresAt of [-1, 1.5, null, "0"])
            expect(ModeratorOptionsSchema.safeParse({ author: { banExpiresAt } }).success, `banExpiresAt ${banExpiresAt}`).to.be.false;
    });

    it("CommentUpdate accepts authorBanExpiresAt as a positive timestamp and never as 0", () => {
        const community = { postScore: 0, replyScore: 0, firstCommentTimestamp: 1_700_000_000, lastCommentCid: COMMENT_CID };
        const commentUpdate = {
            cid: COMMENT_CID,
            upvoteCount: 0,
            downvoteCount: 0,
            replyCount: 0,
            updatedAt: 1_700_000_000,
            author: { community },
            signature: SIGNATURE,
            protocolVersion: PROTOCOL_VERSION
        };
        expect(CommentUpdateSchema.safeParse(commentUpdate).success, "the base record is valid").to.be.true;
        expect(CommentUpdateSchema.safeParse({ ...commentUpdate, authorBanExpiresAt: 4_000_000_000 }).success).to.be.true;
        expect(CommentUpdateSchema.safeParse({ ...commentUpdate, authorBanExpiresAt: 0 }).success).to.be.false;
        expect(CommentUpdateSchema.safeParse({ ...commentUpdate, author: { community: { ...community, banExpiresAt: 0 } } }).success).to.be
            .false;
    });
});
