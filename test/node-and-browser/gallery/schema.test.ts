// comment.gallery (issue #436): schema-level behavior. Pure schema tests, no community, no network.
// The client checks structure only; whether each url is https and of media is the community's job.
import { describe, it, expect } from "vitest";
import {
    CommentIpfsSchema,
    CommentIpfsWithRefinementSchema,
    CommentSignedPropertyNames,
    CreateCommentOptionsWithRefinementSchema,
    CommentPubsubMessageWithFlexibleAuthorRefinementSchema
} from "../../../dist/node/publications/comment/schema.js";
import { messages } from "../../../dist/node/errors.js";
import signers from "../../fixtures/signers.js";

const sig = {
    type: "ed25519",
    signature: "aGVsbG8=",
    publicKey: "cHVibGlj",
    signedPropertyNames: ["gallery", "author", "protocolVersion", "timestamp"]
};

const item = (overrides: Record<string, unknown> = {}) => ({ url: "https://example.com/a.png", htmlTagName: "img", ...overrides });

const commentIpfs = (gallery: unknown) => ({
    gallery,
    signature: { ...sig },
    depth: 0,
    timestamp: 1700000000,
    protocolVersion: "1.0.0",
    communityPublicKey: "somePublicKey"
});

const createOptions = (gallery?: unknown) => ({
    signer: { privateKey: signers[0].privateKey, type: "ed25519" },
    communityPublicKey: signers[1].publicKey,
    ...(gallery ? { gallery } : {})
});

describe("comment.gallery schema", () => {
    it("gallery is in CommentSignedPropertyNames", () => {
        expect(CommentSignedPropertyNames).to.include("gallery");
    });

    it("accepts items with url and htmlTagName only", () => {
        const gallery = [item(), item({ url: "https://example.com/b.mp4", htmlTagName: "video" }), item({ htmlTagName: "audio" })];
        expect(CommentIpfsSchema.safeParse(commentIpfs(gallery)).success).to.be.true;
    });

    it("accepts optional width, height and alt", () => {
        const gallery = [item({ width: 800, height: 600, alt: "a cat on a chair" })];
        expect(CommentIpfsSchema.safeParse(commentIpfs(gallery)).success).to.be.true;
    });

    it("an empty gallery is invalid", () => {
        expect(CommentIpfsSchema.safeParse(commentIpfs([])).success).to.be.false;
    });

    it("htmlTagName is required and must be img, video or audio", () => {
        expect(CommentIpfsSchema.safeParse(commentIpfs([{ url: "https://example.com/a.png" }])).success).to.be.false;
        expect(CommentIpfsSchema.safeParse(commentIpfs([item({ htmlTagName: "iframe" })])).success).to.be.false;
    });

    it("url must be 1-2000 chars", () => {
        expect(CommentIpfsSchema.safeParse(commentIpfs([item({ url: "" })])).success).to.be.false;
        const longUrl = "https://example.com/" + "a".repeat(2000) + ".png";
        expect(CommentIpfsSchema.safeParse(commentIpfs([item({ url: longUrl })])).success).to.be.false;
    });

    it("width and height must be positive", () => {
        expect(CommentIpfsSchema.safeParse(commentIpfs([item({ width: 0 })])).success).to.be.false;
        expect(CommentIpfsSchema.safeParse(commentIpfs([item({ height: -1 })])).success).to.be.false;
    });

    it("alt is at most 1000 chars", () => {
        expect(CommentIpfsSchema.safeParse(commentIpfs([item({ alt: "a".repeat(1000) })])).success).to.be.true;
        expect(CommentIpfsSchema.safeParse(commentIpfs([item({ alt: "a".repeat(1001) })])).success).to.be.false;
    });

    // The client does not check that the url is https or of media: that runs community-side on publish,
    // so a later change to the media extension list can't break already-published comments.
    it("does not check the url is https or of media", () => {
        expect(CommentIpfsSchema.safeParse(commentIpfs([item({ url: "http://example.com/page.html" })])).success).to.be.true;
    });

    // Items are author-signed. Zod's default strip would delete item props a later protocol version adds,
    // which changes the CID a community reconstructs from its DB row (same reason as CrosspostSchema).
    it("keeps unknown props inside items when parsing", () => {
        const gallery = [item({ caption: { text: "added by a later version" } })];
        const parsed = CommentIpfsSchema.strip().parse(commentIpfs(gallery));
        expect(parsed.gallery).to.deep.equal(gallery);
    });
});

describe("a gallery alone counts as content", () => {
    it("CreateCommentOptionsWithRefinementSchema accepts a gallery-only comment", () => {
        const res = CreateCommentOptionsWithRefinementSchema.safeParse(createOptions([item()]));
        expect(res.success, JSON.stringify(res.error?.issues)).to.be.true;
    });

    it("CommentIpfsWithRefinementSchema accepts a gallery-only comment", () => {
        expect(CommentIpfsWithRefinementSchema.safeParse(commentIpfs([item()])).success).to.be.true;
    });

    it("CommentPubsubMessageWithFlexibleAuthorRefinementSchema accepts a gallery-only comment", () => {
        const { depth, ...pubsub } = commentIpfs([item()]);
        expect(CommentPubsubMessageWithFlexibleAuthorRefinementSchema.safeParse(pubsub).success).to.be.true;
    });

    it("a comment with no content, link, title, crosspost or gallery is still rejected", () => {
        const res = CreateCommentOptionsWithRefinementSchema.safeParse(createOptions());
        expect(res.success).to.be.false;
        expect(res.error!.issues.map((issue) => issue.message)).to.include(messages.ERR_COMMENT_HAS_NO_CONTENT_LINK_TITLE);
    });
});
