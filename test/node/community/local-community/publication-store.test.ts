// Unit tests for src/runtime/node/community/local-community/publication-store.ts.
// storeComment/storeCommentEdit/storeCommentModeration/storeVote/storeCommunityEdit
// chain DB writes + IPFS add/pin + signing + role checks, so they are best covered
// by the integration suite (test/node/publications/, test/challenges/).
// Unit tests here focus on the pure-ish helpers:
//   - isPublicationPost / isPublicationReply (pure predicates)
//   - calculateLinkProps (pure short-circuit when settings.fetchThumbnailUrls is off)
//   - calculateReplyProps / calculateLatestPostProps (DB-only, stubbable)
//   - resolveAliasPrivateKeyForCommentPublication (mode-driven branches)
// plus storeCommentModeration approving a pending comment that leaves the database while its IPFS add is
// in flight, on an in-memory DbHandler.

import { describe, it, expect, vi } from "vitest";
import {
    calculateLatestPostProps,
    calculateLinkProps,
    calculateReplyProps,
    isPublicationPost,
    isPublicationReply,
    prepareCommentEditWithAlias,
    prepareCommentWithAnonymity,
    resolveAliasPrivateKeyForCommentPublication,
    storeComment,
    storeCommentEdit,
    storeCommentModeration,
    storeCommunityEditPublication,
    storePublication,
    storeVote
} from "../../../../dist/node/runtime/node/community/local-community/publication-store.js";
import { DbHandler } from "../../../../dist/node/runtime/node/community/db-handler.js";
import { unpinStaleCids } from "../../../../dist/node/runtime/node/community/local-community/cleanup.js";
import signers from "../../../fixtures/signers.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { CommentPubsubMessagePublication, CommentsTableRowInsert } from "../../../../dist/node/publications/comment/types.js";
import type { CommentModerationPubsubMessagePublication } from "../../../../dist/node/publications/comment-moderation/types.js";

describe("publication-store: export shape", () => {
    it("exports all publication-store helpers", () => {
        expect(typeof calculateLatestPostProps).to.equal("function");
        expect(typeof calculateLinkProps).to.equal("function");
        expect(typeof calculateReplyProps).to.equal("function");
        expect(typeof isPublicationPost).to.equal("function");
        expect(typeof isPublicationReply).to.equal("function");
        expect(typeof prepareCommentEditWithAlias).to.equal("function");
        expect(typeof prepareCommentWithAnonymity).to.equal("function");
        expect(typeof resolveAliasPrivateKeyForCommentPublication).to.equal("function");
        expect(typeof storeComment).to.equal("function");
        expect(typeof storeCommentEdit).to.equal("function");
        expect(typeof storeCommentModeration).to.equal("function");
        expect(typeof storeCommunityEditPublication).to.equal("function");
        expect(typeof storePublication).to.equal("function");
        expect(typeof storeVote).to.equal("function");
    });
});

describe("publication-store: isPublicationPost / isPublicationReply", () => {
    it("classifies a comment with no parentCid as a post", () => {
        const post = { parentCid: undefined } as unknown as CommentPubsubMessagePublication;
        expect(isPublicationPost(post)).to.equal(true);
        expect(isPublicationReply(post)).to.equal(false);
    });

    it("classifies a comment with a parentCid as a reply", () => {
        const reply = { parentCid: "QmParent" } as unknown as CommentPubsubMessagePublication;
        expect(isPublicationReply(reply)).to.equal(true);
        expect(isPublicationPost(reply)).to.equal(false);
    });

    it("treats an empty-string parentCid as a post (Boolean coercion)", () => {
        const post = { parentCid: "" } as unknown as CommentPubsubMessagePublication;
        expect(isPublicationPost(post)).to.equal(true);
        expect(isPublicationReply(post)).to.equal(false);
    });
});

describe("publication-store: calculateLinkProps", () => {
    it("returns undefined when no link is provided", async () => {
        const community = { settings: { fetchThumbnailUrls: true } } as unknown as LocalCommunity;
        const result = await calculateLinkProps(community, undefined);
        expect(result).to.equal(undefined);
    });

    it("returns undefined when settings.fetchThumbnailUrls is disabled", async () => {
        const community = { settings: { fetchThumbnailUrls: false } } as unknown as LocalCommunity;
        const result = await calculateLinkProps(community, "https://example.com/foo.png");
        expect(result).to.equal(undefined);
    });

    it("returns undefined when settings is undefined", async () => {
        const community = { settings: undefined } as unknown as LocalCommunity;
        const result = await calculateLinkProps(community, "https://example.com/foo.png");
        expect(result).to.equal(undefined);
    });
});

describe("publication-store: calculateLatestPostProps", () => {
    it("returns depth=0 and the latest post cid from the DB", async () => {
        const createTransaction = vi.fn();
        const commitTransaction = vi.fn();
        const queryLatestPostCid = vi.fn().mockReturnValue({ cid: "QmLatestPost" });
        const community = {
            _dbHandler: { createTransaction, commitTransaction, queryLatestPostCid }
        } as unknown as LocalCommunity;

        const props = await calculateLatestPostProps(community);
        expect(props).to.deep.equal({ depth: 0, previousCid: "QmLatestPost" });
        expect(createTransaction).toHaveBeenCalledOnce();
        expect(commitTransaction).toHaveBeenCalledOnce();
    });

    it("returns previousCid undefined when there is no prior post", async () => {
        const community = {
            _dbHandler: {
                createTransaction: vi.fn(),
                commitTransaction: vi.fn(),
                queryLatestPostCid: vi.fn().mockReturnValue(undefined)
            }
        } as unknown as LocalCommunity;

        const props = await calculateLatestPostProps(community);
        expect(props).to.deep.equal({ depth: 0, previousCid: undefined });
    });
});

describe("publication-store: calculateReplyProps", () => {
    it("throws if the reply has no parentCid", async () => {
        const community = {
            _dbHandler: { createTransaction: vi.fn(), commitTransaction: vi.fn() }
        } as unknown as LocalCommunity;
        await expect(
            calculateReplyProps(community, { parentCid: undefined } as unknown as CommentPubsubMessagePublication)
        ).rejects.toThrow("Reply has to have parentCid");
    });

    it("throws if the parent is not found in the DB", async () => {
        const community = {
            _dbHandler: {
                createTransaction: vi.fn(),
                commitTransaction: vi.fn(),
                queryCommentsUnderComment: vi.fn().mockReturnValue([]),
                queryComment: vi.fn().mockReturnValue(undefined)
            }
        } as unknown as LocalCommunity;
        await expect(
            calculateReplyProps(community, { parentCid: "QmMissingParent" } as unknown as CommentPubsubMessagePublication)
        ).rejects.toThrow("Failed to find parent of reply");
    });

    it("returns depth = parent.depth + 1 and inherits postCid", async () => {
        const community = {
            _dbHandler: {
                createTransaction: vi.fn(),
                commitTransaction: vi.fn(),
                queryCommentsUnderComment: vi.fn().mockReturnValue([{ cid: "QmExistingSibling" }]),
                queryComment: vi.fn().mockReturnValue({ depth: 2, postCid: "QmOriginalPost" })
            }
        } as unknown as LocalCommunity;
        const props = await calculateReplyProps(community, { parentCid: "QmParent" } as unknown as CommentPubsubMessagePublication);
        expect(props).to.deep.equal({ depth: 3, postCid: "QmOriginalPost", previousCid: "QmExistingSibling" });
    });
});

describe("publication-store: resolveAliasPrivateKeyForCommentPublication", () => {
    it("returns the existing per-post alias when one exists for that postCid", async () => {
        const community = {
            _dbHandler: {
                queryPseudonymityAliasForPost: vi.fn().mockReturnValue({ aliasPrivateKey: "existingKey" })
            },
            _pkc: { createSigner: vi.fn() }
        } as unknown as LocalCommunity;

        const key = await resolveAliasPrivateKeyForCommentPublication(community, {
            mode: "per-post",
            originalAuthorPublicKey: "origPub",
            postCid: "QmPost"
        });
        expect(key).to.equal("existingKey");
    });

    it("generates a fresh alias on per-reply mode (every call gets a new signer)", async () => {
        const createSigner = vi.fn().mockResolvedValue({ privateKey: "freshReplyKey" });
        const community = {
            _dbHandler: {},
            _pkc: { createSigner }
        } as unknown as LocalCommunity;

        const key = await resolveAliasPrivateKeyForCommentPublication(community, {
            mode: "per-reply",
            originalAuthorPublicKey: "origPub"
        });
        expect(key).to.equal("freshReplyKey");
        expect(createSigner).toHaveBeenCalledOnce();
    });

    it("reuses the existing per-author alias when one exists", async () => {
        const createSigner = vi.fn();
        const community = {
            _dbHandler: {
                queryPseudonymityAliasForAuthor: vi.fn().mockReturnValue({ aliasPrivateKey: "existingAuthorKey" })
            },
            _pkc: { createSigner }
        } as unknown as LocalCommunity;

        const key = await resolveAliasPrivateKeyForCommentPublication(community, {
            mode: "per-author",
            originalAuthorPublicKey: "origPub"
        });
        expect(key).to.equal("existingAuthorKey");
        expect(createSigner).not.toHaveBeenCalled();
    });

    it("throws for unsupported modes", async () => {
        const community = {
            _dbHandler: {},
            _pkc: { createSigner: vi.fn() }
        } as unknown as LocalCommunity;

        await expect(
            resolveAliasPrivateKeyForCommentPublication(community, {
                mode: "unsupported-mode" as unknown as "per-post",
                originalAuthorPublicKey: "origPub"
            })
        ).rejects.toThrow(/Unsupported pseudonymityMode/);
    });
});

describe("publication-store: storeCommentModeration approving a pending comment", () => {
    // A pending comment is not in IPFS. Approving it adds it (pinned) and only then marks the row approved, and other
    // exchanges run during that add: the comment's author deleting it (storeCommentEdit purges a pending comment at
    // once), a moderator purging or disapproving it, or a newer pending comment evicting it (maxPendingApprovalCount).
    const pendingCommentCid = "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f";
    const moderatorSigner = signers[2];

    const createCommunityWithPendingComment = async ({ duringIpfsAdd }: { duringIpfsAdd: (dbHandler: DbHandler) => void }) => {
        const address = `test-community-${Date.now()}-${Math.random()}`;
        const dbHandler = new DbHandler({ address, _pkc: { noData: true } } as never);
        await dbHandler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        await dbHandler.createOrMigrateTablesIfNeeded();
        const timestamp = Math.floor(Date.now() / 1000);
        const pendingComment: CommentsTableRowInsert = {
            cid: pendingCommentCid,
            authorSignerAddress: signers[1].address,
            content: "pending content",
            communityPublicKey: address,
            timestamp,
            depth: 0,
            postCid: pendingCommentCid,
            signature: { type: "ed25519", signature: "sig", publicKey: signers[1].publicKey, signedPropertyNames: [] },
            protocolVersion: "1.0.0",
            insertedAt: timestamp,
            pendingApproval: true
        };
        dbHandler.insertComments([pendingComment]);
        const pinRm = vi.fn(async (_cid: string, _options: { recursive: boolean }) => undefined);
        const community = {
            address,
            _dbHandler: dbHandler,
            _cidsToUnPin: new Set<string>(),
            _blocksToRm: [] as string[],
            _communityUpdateTrigger: false,
            _clientsManager: { getDefaultKuboRpcClient: () => ({ _client: { pin: { rm: pinRm } } }) },
            // Stands in for the kubo add (pin: true) of the comment, during which the other exchange runs
            _addCommentRowToIPFS: vi.fn(async () => duringIpfsAdd(dbHandler))
        };
        return { community, localCommunity: community as unknown as LocalCommunity, dbHandler, pinRm };
    };

    const createApproval = (): CommentModerationPubsubMessagePublication => ({
        commentCid: pendingCommentCid,
        commentModeration: { approved: true },
        communityPublicKey: signers[0].address,
        timestamp: Math.floor(Date.now() / 1000),
        protocolVersion: "1.0.0",
        signature: {
            type: "ed25519",
            signature: `sig-${Math.random()}`,
            publicKey: moderatorSigner.publicKey,
            signedPropertyNames: ["commentCid", "commentModeration", "communityPublicKey", "timestamp", "protocolVersion"]
        }
    });

    it("fails with the comment-does-not-exist reason and queues the pinned cid for removal when the comment is purged", async () => {
        const { community, localCommunity, dbHandler } = await createCommunityWithPendingComment({
            duringIpfsAdd: (db) => db.purgeComment(pendingCommentCid)
        });

        const approval = createApproval();
        await expect(storeCommentModeration(localCommunity, approval, new Uint8Array([1]))).rejects.toMatchObject({
            code: "ERR_COMMENT_MODERATION_NO_COMMENT_TO_EDIT"
        });

        expect(community._addCommentRowToIPFS).toHaveBeenCalledOnce();
        // The add pinned content that has no row any more: nothing else would ever unpin it
        expect(community._cidsToUnPin.has(pendingCommentCid)).to.equal(true);
        expect(community._blocksToRm).to.include(pendingCommentCid);
        expect(dbHandler.queryComment(pendingCommentCid)).to.equal(undefined);
        // No moderation row is stored for a comment that is gone
        expect(dbHandler.hasCommentModerationWithSignatureEncoded(approval.signature.signature)).to.equal(false);
    });

    it("arms the pending-purge flush, so the next unpin pass unpins the cid even after a block.rm drained it from _blocksToRm", async () => {
        const { community, localCommunity, pinRm } = await createCommunityWithPendingComment({
            duringIpfsAdd: (db) => db.purgeComment(pendingCommentCid)
        });

        await expect(storeCommentModeration(localCommunity, createApproval(), new Uint8Array([1]))).rejects.toMatchObject({
            code: "ERR_COMMENT_MODERATION_NO_COMMENT_TO_EDIT"
        });

        // The approval can fail while a publish cycle sits between its unpinStaleCids and its block.rm. kubo refuses to
        // rm the still-pinned block, but removeBlocksFromKuboNode counts every cid it yields as removed, so the cid
        // leaves _blocksToRm while it is still pinned. Only the pending-purge flag (issue #336) then makes the next
        // pass skip the unpin grace period.
        community._blocksToRm.length = 0;
        await unpinStaleCids(localCommunity);

        expect(pinRm).toHaveBeenCalledWith(pendingCommentCid, { recursive: true });
        expect(community._cidsToUnPin.has(pendingCommentCid)).to.equal(false);
    });

    it("still approves when another moderator approved the comment during the add, and keeps it pinned", async () => {
        const { community, localCommunity, dbHandler } = await createCommunityWithPendingComment({
            duringIpfsAdd: (db) => db.approvePendingComment({ cid: pendingCommentCid })
        });

        await storeCommentModeration(localCommunity, createApproval(), new Uint8Array([1]));

        expect(dbHandler.queryComment(pendingCommentCid)?.pendingApproval).to.not.equal(true);
        expect(community._cidsToUnPin.has(pendingCommentCid)).to.equal(false);
        expect(community._blocksToRm).to.not.include(pendingCommentCid);
    });
});
