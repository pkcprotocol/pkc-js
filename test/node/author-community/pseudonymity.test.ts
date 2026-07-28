// Test foundations for author-communities (issue #31, docs/protocol/author-communities.md).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: features.pseudonymityMode on an author-community. It is inherited unchanged, so the
// per-mode behavior mirrors test/node/community/features/{per-post,per-reply,per-author}.pseudonymityMode.community.features.ts;
// what is tested here is the interaction with the three author-community-specific rules:
//
//   1. Only the anchor may author a top-level post, so pseudonymity applies to replies.
//   2. The owner is never aliased on their own profile. This falls out of the existing rule rather
//      than a special case: prepareCommentWithAnonymity() skips authors holding owner/admin/moderator,
//      and the profile seeds the owner into roles.
//   3. A cross-post published into a pseudonymity-enabled foreign community is alias-signed THERE
//      (publication-store re-signs the comment with a fresh alias signer), so its canonical bytes do
//      not verify against the anchor An and it cannot be synced onto the profile.
import { describe, it } from "vitest";

describe("pseudonymityMode on an author-community (replies)", () => {
    it.todo("per-author: a foreign replier gets a stable alias address across their replies to this profile");
    it.todo("per-reply: a foreign replier gets a new alias address for each reply");
    it.todo("per-post: a foreign replier's alias is stable within a post thread and differs across threads");
    it.todo("the stored reply is alias-signed with originalCommentSignatureEncoded retained, as in any community");
    it.todo("the alias address appears in the generated feed pages, not the replier's real address");
    it.todo("a replier can edit their own pseudonymous reply (authorized against the original author key)");
    it.todo("a replier's vote on native content is handled as in any community");
    it.todo("mod actions on a pseudonymous reply work as in any community");
    it.todo("turning the feature off stops aliasing new replies and leaves existing aliases intact");
});

// prepareCommentWithAnonymity() returns early for owner/admin/moderator, and the profile seeds the
// owner into roles, so the two decisions hold each other up.
describe("the owner is never aliased on their own profile", () => {
    it.todo("the owner's native post keeps the anchor's identity with pseudonymityMode enabled");
    it.todo("the owner's own reply in their own thread is not aliased either");
    it.todo("this uses the existing mods-are-never-pseudonymized rule, with no author-community branch");
    it.todo("a profile whose roles map is missing the owner entry would alias the owner's own posts");
    it.todo("such an aliased owner post is then rejected by the read-side owner-only invariant");
    it.todo("a delegated mod (future) added to roles is likewise not aliased");
});

describe("owner-only top level with pseudonymity enabled", () => {
    it.todo("only the anchor may author a top-level post, regardless of pseudonymityMode");
    it.todo("a foreign author cannot obtain a top-level post via pseudonymity");
    it.todo("the read-side owner-only invariant still checks top-level entries against the anchor");
    it.todo("aliased replies do not violate the invariant (replies are unconstrained)");
});

// The direction that actually bites: the owner posting INTO a pseudonymous community.
describe("cross-posts published under pseudonymity", () => {
    it.todo("the foreign community re-signs the owner's comment with an alias signer, so the canonical bytes are alias-signed");
    it.todo("that comment does not verify against the profile's anchor An");
    it.todo("syncAuthorComments rejects it (comment not signed by the addressed authorPublicKey)");
    it.todo("the rejection is what preserves the anonymity the foreign community granted");
    it.todo("the client filters pseudonymous comments out before syncing rather than relying on the reject");
    it.todo("the locally held pre-alias comment is not syncable either (its cid is not the canonical one)");
    it.todo("a non-pseudonymous cross-post to a different community still syncs normally");
    it.todo("a community that enables pseudonymity later does not retroactively invalidate already-synced entries");
});
