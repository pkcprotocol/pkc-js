// Test foundations for author-communities (issue #31, docs/protocol/author-communities.md).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: native content (sole-host posts/replies) through the existing publication types.
// Owner actions authenticate by anchor-key signature instead of a challenge.
import { describe, it } from "vitest";

describe("owner native posts (Comment, challenge-exempt)", () => {
    it.todo("accepts an owner-signed top-level Comment without a challenge exchange (direct accept)");
    it.todo("sets communityPublicKey of native content to the author-community's own anchor public key");
    it.todo("accepts an owner-signed reply to the owner's own post (self-thread)");
    it.todo("folds accepted native content into the new feed on the next record publish");
    it.todo("signs the native CommentUpdate with the record key (minter, or anchor when own-node)");
});

describe("owner-only top level", () => {
    it.todo("rejects a top-level Comment from a foreign author");
    it.todo("rejects a foreign top-level Comment even if it passes the installed challenge");
});

describe("foreign replies (challenge-gated)", () => {
    it.todo("runs the standard challenge exchange for a foreign reply to a native post");
    it.todo("accepts the reply after a passed challenge and hosts it (sole host)");
    it.todo("rejects the reply on a failed challenge");
    it.todo("reads challenges/encryption/pubsubTopic from the AuthorCommunityIpfs record like any community");
    it.todo("challenge-gates votes on native content like any community");
});

describe("owner moderation via existing publication types", () => {
    it.todo("deletes a native post via CommentEdit with deleted set (standard author delete)");
    it.todo("removes a foreign reply via CommentModeration with removed set (owner is the mod)");
    it.todo("removed native content disappears from the generated feed pages");
});
