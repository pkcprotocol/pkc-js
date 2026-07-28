// Test foundations for author-communities (issue #31, docs/protocol/author-communities.md).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: the author.isAuthorCommunity signed hint on the wire author object.
import { describe, it } from "vitest";

describe("author.isAuthorCommunity hint (signed field on AuthorPubsubSchema)", () => {
    it.todo("is part of the author signed-property list (covered by the publication signature)");
    it.todo("a third party cannot forge the hint onto someone else's comment (signature breaks)");
    it.todo("is fixed per-comment at publish time");
    it.todo("presence means consumers try resolving author.publicKey and tolerate failure");
    it.todo("absence means consumers do not attempt profile resolution");
    it.todo("is accounted for in the relevant reserved-field lists (runtime vs wire)");
    it.todo("older publications without the field still verify (backward compatible)");
});

// AuthorPubsubSchema is strict, but comments are parsed through the flexible-author variant
// (AuthorPubsubSchema.loose()), so an unknown author field is tolerated on read and is covered by
// the publication signature. The field must not collide with AuthorReservedFields.
describe("hint compatibility with nodes that predate it", () => {
    it.todo("an old community node accepts a publication carrying the hint as an extra author prop");
    it.todo("the hint is covered by the publication signature, so it round-trips through an old node unchanged");
    it.todo("the hint name is not in AuthorReservedFields (it is a wire field, not a runtime one)");
    it.todo("a new client parses a publication from an old client that has no hint");
});
