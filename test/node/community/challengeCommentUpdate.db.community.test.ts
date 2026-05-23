import { beforeEach, afterEach, describe, expect, it } from "vitest";
import assert from "assert";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";

import type {
    CommentsTableRowInsert,
    CommentUpdatesTableRowInsert,
    CommentUpdateType
} from "../../../dist/node/publications/comment/types.js";
import type { CommentModerationsTableRowInsert } from "../../../dist/node/publications/comment-moderation/types.js";

const PROTOCOL_VERSION = "1.0.0";

type CalculatedCommentUpdate = Omit<CommentUpdateType, "signature" | "updatedAt" | "replies" | "protocolVersion">;

// Exercises the integration-lite path that the full end-to-end test would cover:
//  - storeComment persisting `challengeCommentUpdate` JSON on the comments row
//  - queryCalculatedCommentUpdate seeding the calculated update with that JSON
//  - per-field override: a mod publishing a commentModeration with `reason` overwrites only the
//    `reason` field; other challenge-supplied keys persist across regenerations
// Skipped under RPC: constructs a DbHandler in-process and calls dbHandler/queryCalculatedCommentUpdate
// directly. RPC clients have no access to the community's local DB.
describeSkipIfRpc("queryCalculatedCommentUpdate seeded with challengeCommentUpdate", () => {
    let dbHandler: DbHandler | undefined;
    let communityAddress: string;
    let cidCounter = 0;

    const nextCid = (): string => `QmTest${(cidCounter++).toString().padStart(4, "0")}`;
    const now = (): number => Math.floor(Date.now() / 1000);

    async function createTestDbHandler(): Promise<DbHandler> {
        communityAddress = `test-sub-${Date.now()}-${Math.random()}`;
        const fakePKC = { noData: true };
        const fakeCommunity = { address: communityAddress, _pkc: fakePKC };
        const handler = new DbHandler(fakeCommunity as never);
        await handler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        await handler.createOrMigrateTablesIfNeeded();
        return handler;
    }

    const insertPost = (
        challengeCommentUpdate?: Record<string, unknown>,
        authorSignerAddressOverride?: string
    ): { cid: string; authorSignerAddress: string; timestamp: number } => {
        assert(dbHandler);
        const cid = nextCid();
        const timestamp = now();
        const authorSignerAddress = authorSignerAddressOverride ?? `12D3KooAuthor${cid}`;
        const assignedNumbers = dbHandler.getNextCommentNumbers(0);
        const row: CommentsTableRowInsert = {
            cid,
            authorSignerAddress,
            author: { address: authorSignerAddress },
            content: `content-${cid}`,
            title: `title-${cid}`,
            communityPublicKey: communityAddress,
            timestamp,
            depth: 0,
            postCid: cid,
            signature: { type: "ed25519", signature: "sig", publicKey: "pk", signedPropertyNames: [] },
            protocolVersion: PROTOCOL_VERSION,
            number: assignedNumbers.number,
            postNumber: assignedNumbers.postNumber,
            insertedAt: timestamp,
            challengeCommentUpdate
        };
        dbHandler.insertComments([row]);
        // Seed a minimum CommentUpdate row so queryCalculatedCommentUpdate can compute everything
        // (counts, etc.). Mirrors how calculateNewCommentUpdate uses an existing update as base.
        const updateRow: CommentUpdatesTableRowInsert = {
            cid,
            upvoteCount: 0,
            downvoteCount: 0,
            replyCount: 0,
            childCount: 0,
            updatedAt: timestamp,
            protocolVersion: PROTOCOL_VERSION,
            signature: { type: "ed25519", signature: "sig", publicKey: "pk", signedPropertyNames: [] },
            author: { community: { postScore: 0, replyScore: 0, lastCommentCid: cid, firstCommentTimestamp: timestamp } },
            publishedToPostUpdatesMFS: false,
            insertedAt: timestamp
        };
        dbHandler.upsertCommentUpdates([updateRow]);
        return { cid, authorSignerAddress, timestamp };
    };

    const insertModeration = (commentCid: string, moderation: Record<string, unknown>): void => {
        assert(dbHandler);
        dbHandler.insertCommentModerations([
            {
                commentCid,
                author: { address: `12D3KooModAuthor${commentCid}` },
                signature: "sig",
                modSignerAddress: `12D3KooMod${commentCid}`,
                protocolVersion: PROTOCOL_VERSION,
                communityPublicKey: communityAddress,
                timestamp: now(),
                commentModeration: moderation,
                insertedAt: now()
            } as unknown as CommentModerationsTableRowInsert
        ]);
    };

    const calculate = (comment: { cid: string; authorSignerAddress: string; timestamp: number }): CalculatedCommentUpdate => {
        assert(dbHandler);
        const row = dbHandler.queryComment(comment.cid);
        assert(row, "comment row missing");
        return dbHandler.queryCalculatedCommentUpdate({ comment: row });
    };

    beforeEach(async () => {
        dbHandler = await createTestDbHandler();
    });

    afterEach(async () => {
        if (dbHandler) {
            await dbHandler.destoryConnection();
            dbHandler = undefined;
        }
        cidCounter = 0;
    });

    it("persists challengeCommentUpdate JSON and re-reads it as an object", () => {
        const challengeCommentUpdate = { reason: "Verified country", countryCode: "FR" };
        const comment = insertPost(challengeCommentUpdate);
        const row = dbHandler!.queryComment(comment.cid);
        expect(row?.challengeCommentUpdate).to.deep.equal(challengeCommentUpdate);
    });

    it("seeds the calculated commentUpdate with challenge-supplied fields when no mod has published", () => {
        const challengeCommentUpdate = { reason: "Verified country", countryCode: "FR" };
        const comment = insertPost(challengeCommentUpdate);
        const calculated = calculate(comment) as CalculatedCommentUpdate & { countryCode?: string };
        expect(calculated.reason).to.equal("Verified country");
        expect(calculated.countryCode).to.equal("FR");
    });

    it("mod-published reason overrides the challenge's reason (per-field, only matching key)", () => {
        const challengeCommentUpdate = { reason: "Verified country", countryCode: "FR" };
        const comment = insertPost(challengeCommentUpdate);

        insertModeration(comment.cid, { reason: "Mod override" });

        const calculated = calculate(comment) as CalculatedCommentUpdate & { countryCode?: string };
        // Mod-published reason wins
        expect(calculated.reason).to.equal("Mod override");
        // Untouched challenge field persists
        expect(calculated.countryCode).to.equal("FR");
    });

    it("mod publishing a different field (spoiler) leaves challenge's reason intact", () => {
        const challengeCommentUpdate = { reason: "Verified country" };
        const comment = insertPost(challengeCommentUpdate);

        insertModeration(comment.cid, { spoiler: true });

        const calculated = calculate(comment);
        expect(calculated.spoiler).to.equal(true);
        // reason was never touched by a mod, so the challenge value persists
        expect(calculated.reason).to.equal("Verified country");
    });

    it("no challengeCommentUpdate stored → calculated update has no challenge fields", () => {
        const comment = insertPost(undefined);
        const calculated = calculate(comment) as CalculatedCommentUpdate & { countryCode?: string };
        expect(calculated.reason).to.equal(undefined);
        expect(calculated.countryCode).to.equal(undefined);
    });

    it("merges challenge-supplied author.community.<newKey> underneath computed authorCommunity", () => {
        // Challenge can extend author.community with novel keys (e.g. countryCode). Schema-defined
        // keys (postScore, replyScore, flairs, ...) are blocked by validateChallengeResultExtras
        // upstream, so the merge here only needs to carry through extras.
        const challengeCommentUpdate = { author: { community: { countryCode: "FR" } } };
        const comment = insertPost(challengeCommentUpdate);
        const calculated = calculate(comment) as CalculatedCommentUpdate & {
            author: { community: { countryCode?: string; postScore?: number; replyScore?: number } };
        };
        expect(calculated.author.community.countryCode).to.equal("FR");
        // Computed authorCommunity fields still present (and would win if challenge tried to set them).
        expect(typeof calculated.author.community.postScore).to.equal("number");
        expect(typeof calculated.author.community.replyScore).to.equal("number");
    });

    it("author.community.<newKey> is per-comment (each comment carries its own challengeCommentUpdate)", () => {
        // Same author, two posts, two different challenge runs producing different countryCode values.
        // Each post's calculated update reflects only its own challengeCommentUpdate row.
        const sharedAuthor = "12D3KooAuthorShared";
        const commentA = insertPost({ author: { community: { countryCode: "FR" } } }, sharedAuthor);
        const commentB = insertPost({ author: { community: { countryCode: "US" } } }, sharedAuthor);

        const calcA = calculate(commentA) as CalculatedCommentUpdate & {
            author: { community: { countryCode?: string } };
        };
        const calcB = calculate(commentB) as CalculatedCommentUpdate & {
            author: { community: { countryCode?: string } };
        };
        expect(calcA.author.community.countryCode).to.equal("FR");
        expect(calcB.author.community.countryCode).to.equal("US");
    });

    it("challenge-supplied author.community.flairs persists when no mod publishes author.flairs", () => {
        const challengeFlairs = [{ text: "🇫🇷 FR" }];
        const comment = insertPost({ author: { community: { flairs: challengeFlairs } } });
        const calculated = calculate(comment) as CalculatedCommentUpdate & {
            author: { community: { flairs?: { text: string }[] } };
        };
        expect(calculated.author.community.flairs).to.deep.equal(challengeFlairs);
    });

    it("mod-published commentModeration.author.flairs overrides challenge's author.community.flairs", () => {
        const challengeFlairs = [{ text: "🇫🇷 FR" }];
        const comment = insertPost({ author: { community: { flairs: challengeFlairs, countryCode: "FR" } } });

        const modFlairs = [{ text: "VERIFIED" }];
        assert(dbHandler);
        dbHandler.insertCommentModerations([
            {
                commentCid: comment.cid,
                author: { address: `12D3KooModAuthor${comment.cid}` },
                signature: "sig",
                modSignerAddress: `12D3KooMod${comment.cid}`,
                protocolVersion: PROTOCOL_VERSION,
                communityPublicKey: communityAddress,
                timestamp: now(),
                commentModeration: { author: { flairs: modFlairs } },
                targetAuthorSignerAddress: comment.authorSignerAddress,
                insertedAt: now()
            } as unknown as CommentModerationsTableRowInsert
        ]);

        const calculated = calculate(comment) as CalculatedCommentUpdate & {
            author: { community: { flairs?: { text: string }[]; countryCode?: string } };
        };
        // Mod-published author flairs win
        expect(calculated.author.community.flairs).to.deep.equal(modFlairs);
        // Untouched challenge field under the same author.community object persists
        expect(calculated.author.community.countryCode).to.equal("FR");
    });

    it("mod publishing a different field (spoiler) leaves challenge's author.community.flairs intact", () => {
        const challengeFlairs = [{ text: "🇫🇷 FR" }];
        const comment = insertPost({ author: { community: { flairs: challengeFlairs } } });

        insertModeration(comment.cid, { spoiler: true });

        const calculated = calculate(comment) as CalculatedCommentUpdate & {
            author: { community: { flairs?: { text: string }[] } };
        };
        expect(calculated.spoiler).to.equal(true);
        expect(calculated.author.community.flairs).to.deep.equal(challengeFlairs);
    });
});
