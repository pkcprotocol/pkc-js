// Test foundations for author-communities (issue #31, docs/protocol/author-communities.md).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: native content (sole-host posts/replies) through the existing publication types.
// Owner-only top level is enforced write-side by default challenge config, not by a code-level
// exemption: the seeded `fail` challenge passes only via its owner-address exclude, which is
// signature-backed because the author address is verified against the signature before challenges
// run. The owner therefore goes through the normal challenge pipeline and is excluded from it.
import { describe, it } from "vitest";

describe("owner native posts (Comment, excluded from the seeded fail challenge)", () => {
    it.todo("accepts an owner-signed top-level Comment via the owner-address exclude, through the normal pipeline");
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

// Owner moderation is authorized by the seeded roles entry, not by a code-level owner exemption:
// isPublicationAuthorPartOfRoles returns false when community.roles is undefined.
describe("owner moderation via existing publication types", () => {
    it.todo("deletes a native post via CommentEdit with deleted set (standard author delete)");
    it.todo("removes a foreign reply via CommentModeration with removed set, authorized by the owner role");
    it.todo("rejects the owner's CommentModeration if the roles map is missing its entry");
    it.todo("edits profile metadata via CommunityEdit, authorized by the owner role");
    it.todo("rejects a non-owner CommentModeration and a non-owner CommunityEdit");
    it.todo("removed native content disappears from the generated feed pages");
});
