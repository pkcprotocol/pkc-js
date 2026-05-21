// Unit tests for src/runtime/node/community/local-community/publication-store.ts.
// storeComment/storeCommentEdit/storeCommentModeration/storeVote/storeCommunityEdit
// chain DB writes + IPFS add/pin + signing + role checks, so they are best covered
// by the integration suite (test/node/publications/, test/challenges/).
// Unit tests here focus on the pure-ish helpers:
//   - isPublicationPost / isPublicationReply (pure predicates)
//   - calculateLinkProps (pure short-circuit when settings.fetchThumbnailUrls is off)
//   - calculateReplyProps / calculateLatestPostProps (DB-only, stubbable)
//   - resolveAliasPrivateKeyForCommentPublication (mode-driven branches)

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
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { CommentPubsubMessagePublication } from "../../../../dist/node/publications/comment/types.js";

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
