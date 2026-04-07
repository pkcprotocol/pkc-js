import { describe, it, expect } from "vitest";
import "../../../dist/node/test/test-util.js"; // must import first to avoid circular dep issues
import { mapPageIpfsCommentToPageJsonComment, mapModqueuePageIpfsCommentToModQueuePageJsonComment } from "../../../dist/node/pages/util.js";
import type { PageIpfs, ModQueuePageIpfs } from "../../../dist/node/pages/types.js";

// Minimal page comment fixture with author.community in commentUpdate
function makePageIpfsComment(extraCommentUpdateAuthorFields?: Record<string, unknown>): PageIpfs["comments"][0] {
    return {
        comment: {
            author: { displayName: "TestUser" },
            content: "test content",
            depth: 0,
            protocolVersion: "1.0.0",
            signature: {
                publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0",
                signature: "gwJxMTDNb5dV+pA5ztgseaQYxRF18AaqvMal45K7yV6YBHpahLmDN1rVyjXK4ZWeOYH8V90FaMDwolfGtOD6Cg",
                signedPropertyNames: ["content", "title", "author", "subplebbitAddress", "protocolVersion", "timestamp"],
                type: "ed25519"
            },
            communityPublicKey: "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR",
            timestamp: 1728396704,
            title: "Test post"
        },
        commentUpdate: {
            author: {
                community: {
                    firstCommentTimestamp: 1725537080,
                    lastCommentCid: "Qmc93vcfpHhcscUMvXaJJTpk9CxCyMniAtxCmREF8LSBbS",
                    postScore: 5,
                    replyScore: 10
                },
                ...extraCommentUpdateAuthorFields
            },
            cid: "QmQ9mK33zshLf4Bj8dVSQimdbyXGgw5QFRoUQpsCqqz6We",
            downvoteCount: 1,
            upvoteCount: 3,
            replyCount: 0,
            updatedAt: 1725537110,
            protocolVersion: "1.0.0",
            signature: {
                publicKey: "tkPPciAVI7kfzmSHjazd0ekx8z9bCt9RlE5RnEpFRGo",
                signature: "4YgWlGdkFIjBT8L4bS8AT9PTXDYmUtVGz0NGtvSw5uggCJCq2wdNUeId4CVyWPQoifys44N7UvCsG2qO3YcNBw",
                signedPropertyNames: ["cid", "upvoteCount", "downvoteCount", "replyCount", "updatedAt", "author", "protocolVersion"],
                type: "ed25519"
            }
        }
    } as PageIpfs["comments"][0];
}

describe("commentUpdate.author fields are preserved in page mapping", () => {
    it("mapPageIpfsCommentToPageJsonComment preserves author.community from commentUpdate", () => {
        const pageComment = makePageIpfsComment();
        const result = mapPageIpfsCommentToPageJsonComment(pageComment);

        expect(result.author.community).to.be.an("object");
        expect(result.author.community.postScore).to.equal(5);
        expect(result.author.community.replyScore).to.equal(10);
        expect(result.author.community.firstCommentTimestamp).to.equal(1725537080);
        expect(result.author.community.lastCommentCid).to.equal("Qmc93vcfpHhcscUMvXaJJTpk9CxCyMniAtxCmREF8LSBbS");
    });

    it("mapPageIpfsCommentToPageJsonComment preserves arbitrary commentUpdate.author fields", () => {
        const pageComment = makePageIpfsComment({ someFutureField: { score: 42 } });
        const result = mapPageIpfsCommentToPageJsonComment(pageComment);

        expect((result.author as any).someFutureField).to.deep.equal({ score: 42 });
        // community should still be present too
        expect(result.author.community).to.be.an("object");
        expect(result.author.community.postScore).to.equal(5);
    });

    it("mapModqueuePageIpfsCommentToModQueuePageJsonComment preserves author.community from commentUpdate", () => {
        const pageComment = makePageIpfsComment();
        const modqueueComment = {
            comment: pageComment.comment,
            commentUpdate: {
                ...pageComment.commentUpdate,
                pendingApproval: true as const
            }
        } as ModQueuePageIpfs["comments"][0];

        const result = mapModqueuePageIpfsCommentToModQueuePageJsonComment(modqueueComment);

        expect(result.author.community).to.be.an("object");
        expect(result.author.community.postScore).to.equal(5);
        expect(result.author.community.replyScore).to.equal(10);
        expect(result.author.community.firstCommentTimestamp).to.equal(1725537080);
        expect(result.author.community.lastCommentCid).to.equal("Qmc93vcfpHhcscUMvXaJJTpk9CxCyMniAtxCmREF8LSBbS");
    });

    it("mapModqueuePageIpfsCommentToModQueuePageJsonComment preserves arbitrary commentUpdate.author fields", () => {
        const pageComment = makePageIpfsComment({ someFutureField: { score: 42 } });
        const modqueueComment = {
            comment: pageComment.comment,
            commentUpdate: {
                ...pageComment.commentUpdate,
                pendingApproval: true as const
            }
        } as ModQueuePageIpfs["comments"][0];

        const result = mapModqueuePageIpfsCommentToModQueuePageJsonComment(modqueueComment);

        expect((result.author as any).someFutureField).to.deep.equal({ score: 42 });
        expect(result.author.community).to.be.an("object");
        expect(result.author.community.postScore).to.equal(5);
    });
});
