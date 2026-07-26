// Test foundations for author-communities (issue #31, docs/protocol/author-communities.md).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: the hasAuthorCommunity signed hint on the wire author object (field name TBD).
import { describe, it } from "vitest";

describe("hasAuthorCommunity hint (signed field on AuthorPubsubSchema)", () => {
    it.todo("is part of the author signed-property list (covered by the publication signature)");
    it.todo("a third party cannot forge the hint onto someone else's comment (signature breaks)");
    it.todo("is fixed per-comment at publish time");
    it.todo("presence means consumers try resolving author.publicKey and tolerate failure");
    it.todo("absence means consumers do not attempt profile resolution");
    it.todo("is accounted for in the relevant reserved-field lists (runtime vs wire)");
    it.todo("older publications without the field still verify (backward compatible)");
});
