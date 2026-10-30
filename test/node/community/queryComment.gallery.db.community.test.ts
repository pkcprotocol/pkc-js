// Test that dbHandler.queryComment returns gallery as a proper array, not a JSON string (issue #436)

import { mockPKC, publishRandomPost, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { deriveCommentIpfsFromCommentTableRow } from "../../../dist/node/runtime/node/util.js";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { it, beforeAll, afterAll, expect } from "vitest";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

// Reads the community's DbHandler directly, which only exists in the process that runs the community, so it cannot run under RPC.
describeSkipIfRpc("dbHandler.queryComment returns gallery as array", async () => {
    let pkc: PKCType;
    let community: LocalCommunity;
    let postWithGallery: Comment;
    let postWithoutGallery: Comment;
    const gallery = [
        { url: "https://example.com/a.png", htmlTagName: "img" as const, width: 10, height: 20, alt: "first" },
        { url: "https://example.com/b.webm", htmlTagName: "video" as const }
    ];

    beforeAll(async () => {
        pkc = await mockPKC();
        community = (await pkc.createCommunity()) as LocalCommunity;
        await community.edit({ settings: { challenges: [] }, features: { maxPostGalleryItems: 2 } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        postWithGallery = await publishRandomPost({ communityAddress: community.address, pkc, postProps: { gallery } });
        postWithoutGallery = await publishRandomPost({ communityAddress: community.address, pkc });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("queryComment returns gallery as a proper array, not a JSON string", () => {
        const row = community._dbHandler.queryComment(postWithGallery.cid!);
        expect(row).to.exist;
        expect(row!.gallery).to.be.an("array");
        expect(row!.gallery).to.deep.equal(gallery);
        expect(row!.extraProps?.gallery).to.be.undefined;
    });

    it("the row rebuilds into the CommentIpfs the post was published with", async () => {
        const row = community._dbHandler.queryComment(postWithGallery.cid!);
        const rebuilt = deriveCommentIpfsFromCommentTableRow(row!);
        expect(await calculateIpfsHash(deterministicStringify(rebuilt)!)).to.equal(postWithGallery.cid);
    });

    it("queryComment returns undefined gallery for comments without one", () => {
        const row = community._dbHandler.queryComment(postWithoutGallery.cid!);
        expect(row).to.exist;
        expect(row!.gallery).to.be.undefined;
    });
});
