// Test foundations for crossposts (issue #32).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: the `crosspost` field on CreateCommentOptionsSchema and everything derived from it.
//
// Shape:
//   crosspost: { cid: CidString, comment: CommentIpfs }   // optional, the full record verbatim
//
// The field lives on CreateCommentOptionsSchema, which is a self-cycle: CommentIpfsSchema is
// derived from it (CreateCommentOptions -> CommentPubsubMessagePublication ->
// CommentPubsubMessageWithFlexibleAuthor -> CommentIpfs). A plain `z.lazy` getter is not enough
// here (unlike CommentUpdate.replies, whose cycle runs through the pages schema) — it collapses
// CommentSignedPropertyNames, commentPubsubKeys and CommentIpfsSchema to `any`. The cycle has to
// be severed with an explicitly annotated z.ZodType plus a hand-declared interface, and the two
// kept honest by a bidirectional type assertion.
import { describe, it } from "vitest";

describe("crosspost field on CreateCommentOptionsSchema", () => {
    it.todo("crosspost is optional — a comment without it parses");
    it.todo("crosspost requires both cid and comment — neither alone parses");
    it.todo("crosspost.cid must be a valid CID string");
    it.todo("crosspost.comment must be a full CommentIpfs (signature, depth, timestamp present)");
    it.todo("an unknown key directly on crosspost (beside cid/comment) is rejected");
});

// CommentSignedPropertyNames is keys(omit(CreateCommentOptionsSchema.shape, keysToOmitFromSignedPropertyNames)),
// and CommentIpfsReservedFields / CommentPubsubMessageReservedFields are `difference` computations
// against the same shape. Adding the field to the shape is supposed to be enough. These cases exist
// to catch a refactor that quietly breaks that derivation.
describe("derived lists pick up crosspost with no hand-editing", () => {
    it.todo("crosspost is in CommentSignedPropertyNames");
    it.todo("crosspost is NOT in CommentPubsubMessageReservedFields");
    it.todo("crosspost is NOT in CommentIpfsReservedFields");
    it.todo("crosspost is in the signature.signedPropertyNames of a published crossposting comment");
});

// The embedded record is content-addressed by crosspost.cid, so ANY normalization of it breaks the
// crosspost. This is the single most dangerous property of the design: zod's strip behavior is
// per-schema, so a nested schema left at the default (strip) would silently delete author-signed
// extra props on the embedded record. crosspost.comment must be loose everywhere it appears.
describe("the embedded record is never normalized", () => {
    it.todo("crosspost.comment is parsed loosely — unknown props on the embedded record are preserved");
    it.todo("an embedded record carrying author-signed extra props parses and keeps them byte-for-byte");
    it.todo("CommentIpfsSchema.strip().parse() on the outer comment does not strip inside crosspost.comment");
    it.todo("the parse helpers return the original object, so the embedded record survives round-tripping");
    it.todo("deterministicStringify of the parsed comment equals deterministicStringify of the input");
});

// Chains nest records. No explicit depth cap: the 40kb publication limit bounds publishing, and each
// level of nesting eats the budget for the next.
describe("crosspost chains (crossposting a crosspost)", () => {
    it.todo("a comment whose crosspost.comment itself has a crosspost parses");
    it.todo("a three-deep chain parses and each level is reachable");
    it.todo("no artificial nesting-depth limit is enforced by the schema");
    it.todo("a chain that would exceed 40kb cannot be published (bounded by the size limit, not a depth cap)");
});

// The recursion is severed with an annotated z.ZodType + hand-declared interface. If the interface
// and the inferred schema type ever drift, the crosspost branch of CommentIpfs silently stops
// matching the rest of it.
describe("recursive type declaration stays in sync with the schema", () => {
    it.todo("the hand-declared crosspost interface is structurally equal to z.infer<typeof CommentIpfsSchema>");
    it.todo("CommentIpfsType retains concrete field types (has not degraded to any)");
    it.todo("nested access through crosspost.comment.crosspost.comment is typed");
});
