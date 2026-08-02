// Crossposts (issue #32) — schema-level behavior of the `crosspost` field.
// These are pure schema tests: no community, no network.
import { describe, it, expect } from "vitest";
import {
    CommentIpfsSchema,
    CommentSignedPropertyNames,
    CommentPubsubMessageReservedFields,
    CommentIpfsReservedFields
} from "../../../dist/node/publications/comment/schema.js";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import validCommentIpfsFixture from "../../fixtures/signatures/comment/commentUpdate/valid_comment_ipfs.json" with { type: "json" };

const sig = {
    type: "ed25519",
    signature: "aGVsbG8=",
    publicKey: "cHVibGlj",
    signedPropertyNames: ["content", "title", "author", "protocolVersion", "timestamp"]
};

const embedded = () => ({
    content: "the original comment",
    signature: { ...sig },
    depth: 0,
    timestamp: 1700000000,
    protocolVersion: "1.0.0",
    communityPublicKey: "somePublicKey"
});

const crossposting = (comment: object = embedded()) => ({
    title: "a repost",
    signature: { ...sig },
    depth: 0,
    timestamp: 1700000001,
    protocolVersion: "1.0.0",
    communityPublicKey: "anotherPublicKey",
    crosspost: { cid: "QmYjtig7VJQ6XsnUjqqJvj7QaMcCAwtrgNdahSiFofrE7o", comment }
});

describe("crosspost field on CreateCommentOptionsSchema", () => {
    it("crosspost is optional — a comment without it parses", () => {
        const withoutCrosspost = crossposting();
        delete (withoutCrosspost as Record<string, unknown>).crosspost;
        expect(CommentIpfsSchema.loose().safeParse(withoutCrosspost).success).to.be.true;
    });

    it("crosspost requires both cid and comment — neither alone parses", () => {
        const onlyCid = { ...crossposting(), crosspost: { cid: "QmYjtig7VJQ6XsnUjqqJvj7QaMcCAwtrgNdahSiFofrE7o" } };
        expect(CommentIpfsSchema.loose().safeParse(onlyCid).success).to.be.false;
        const onlyComment = { ...crossposting(), crosspost: { comment: embedded() } };
        expect(CommentIpfsSchema.loose().safeParse(onlyComment).success).to.be.false;
    });

    it("crosspost.cid must be a valid CID string", () => {
        const badCid = { ...crossposting(), crosspost: { cid: "", comment: embedded() } };
        expect(CommentIpfsSchema.loose().safeParse(badCid).success).to.be.false;
    });

    it("crosspost.comment must be a full CommentIpfs (depth is required)", () => {
        const noDepth = embedded();
        delete (noDepth as Record<string, unknown>).depth;
        expect(CommentIpfsSchema.loose().safeParse(crossposting(noDepth)).success).to.be.false;
    });

    it("a real CommentIpfs fixture is accepted as the embedded record", () => {
        expect(CommentIpfsSchema.loose().safeParse(crossposting(validCommentIpfsFixture)).success).to.be.true;
    });
});

// CommentSignedPropertyNames is keys(omit(CreateCommentOptionsSchema.shape, ...)) and the
// reserved-field lists are `difference` computations against the same shape, so adding the field to
// the shape is meant to be enough. This is the guard against a refactor breaking that derivation.
describe("derived lists pick up crosspost with no hand-editing", () => {
    it("crosspost is in CommentSignedPropertyNames", () => {
        expect(CommentSignedPropertyNames).to.include("crosspost");
    });

    it("crosspost is NOT in CommentPubsubMessageReservedFields", () => {
        expect(CommentPubsubMessageReservedFields).to.not.include("crosspost");
    });

    it("crosspost is NOT in CommentIpfsReservedFields", () => {
        expect(CommentIpfsReservedFields).to.not.include("crosspost");
    });

    it("crosspost is treated exactly like the other author-signed wire fields", () => {
        // quotedCids is the closest existing precedent — an author-signed reference field on
        // CreateCommentOptions. crosspost must land in the same buckets, or it is being special-cased
        // somewhere it should not be.
        for (const list of [CommentPubsubMessageReservedFields, CommentIpfsReservedFields])
            expect(list.includes("crosspost")).to.equal(list.includes("quotedCids"));
        expect(CommentSignedPropertyNames.includes("crosspost")).to.equal(CommentSignedPropertyNames.includes("quotedCids"));
    });
});

// crosspost.cid hashes the entire embedded record, so ANY normalization of it breaks the crosspost.
// Zod's strip behavior is per-schema, which is why crosspost.comment is declared .loose().
describe("the embedded record is never normalized", () => {
    it("unknown props on the embedded record are preserved by a loose parse", () => {
        const withExtra = { ...embedded(), someAuthorSignedExtra: { a: 1 } };
        const parsed = CommentIpfsSchema.loose().parse(crossposting(withExtra)) as Record<string, any>;
        expect(parsed.crosspost.comment.someAuthorSignedExtra).to.deep.equal({ a: 1 });
    });

    it("CommentIpfsSchema.strip().parse() does not strip inside crosspost.comment", () => {
        // This is the exact call storePublication makes before building the comments row. If the
        // nested schema were left at zod's default, the extra prop would vanish here, the row would
        // reconstruct to different bytes, and the comment's CID would change.
        const withExtra = { ...embedded(), someAuthorSignedExtra: { a: 1 } };
        const stripped = CommentIpfsSchema.strip().parse(crossposting(withExtra)) as Record<string, any>;
        expect(stripped.crosspost.comment.someAuthorSignedExtra).to.deep.equal({ a: 1 });
    });

    it("strip() still removes unknown props at the top level (existing behavior unchanged)", () => {
        const stripped = CommentIpfsSchema.strip().parse({ ...crossposting(), outerJunk: 1 }) as Record<string, any>;
        expect(stripped.outerJunk).to.be.undefined;
    });

    it("a strip() round trip leaves the embedded record byte-identical", () => {
        const withExtra = { ...embedded(), someAuthorSignedExtra: { a: 1 }, another: "x" };
        const input = crossposting(withExtra);
        const stripped = CommentIpfsSchema.strip().parse(input) as Record<string, any>;
        expect(deterministicStringify(stripped.crosspost.comment)).to.equal(deterministicStringify(withExtra));
    });
});

// Chains nest records. No depth cap: the 40kb publication limit is the only bound.
describe("crosspost chains (crossposting a crosspost)", () => {
    it("a comment whose crosspost.comment itself has a crosspost parses", () => {
        const parsed = CommentIpfsSchema.loose().parse(crossposting(crossposting())) as Record<string, any>;
        expect(parsed.crosspost.comment.crosspost.comment.content).to.equal("the original comment");
    });

    it("a four-deep chain parses and every level is reachable", () => {
        const chain = crossposting(crossposting(crossposting()));
        const parsed = CommentIpfsSchema.loose().parse(chain) as Record<string, any>;
        expect(parsed.crosspost.comment.crosspost.comment.crosspost.comment.content).to.equal("the original comment");
    });

    it("no artificial nesting-depth limit is enforced by the schema", () => {
        let record: Record<string, any> = embedded();
        for (let i = 0; i < 25; i++) record = crossposting(record);
        expect(CommentIpfsSchema.loose().safeParse(record).success).to.be.true;
    });

    it("a chain preserves extra props at every level", () => {
        const inner = { ...embedded(), innerExtra: 1 };
        const mid = { ...crossposting(inner), midExtra: 2 };
        const parsed = CommentIpfsSchema.strip().parse(crossposting(mid)) as Record<string, any>;
        expect(parsed.crosspost.comment.midExtra).to.equal(2);
        expect(parsed.crosspost.comment.crosspost.comment.innerExtra).to.equal(1);
    });
});
