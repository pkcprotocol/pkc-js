// Test foundations for author-communities (issue #31, docs/protocol/author-communities.md).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: the dedicated verifier for author-community feed pages.
//
// The shared page verifier cannot be reused as is. Given a page and its community it enforces:
//   1. every entry's communityPublicKey equals the page's community
//      (ERR_COMMENT_IN_PAGE_BELONG_TO_DIFFERENT_COMMUNITY) -> every cross-post fails
//   2. depth > 0 entries have parent context with matching depth/parentCid/postCid
//      -> a cross-posted reply carried as a top-level feed entry fails
//   3. depth === 0 entries carry no postCid -> holds fine
//   4. each entry's CommentUpdate verifies against THIS community -> a cross-post's update is
//      signed by its foreign host, so it fails
//
// ModQueuePageIpfs is the precedent to copy: it already models a page whose entries have mixed
// depths, unrelated parentCids and no shared postCid, and the shared verifier already branches for
// it. verifyAuthorCommunityPage is that branch plus per-entry community routing and the owner-only
// invariant in place of the parent-relationship checks.
import { describe, it } from "vitest";

describe("the shared page verifier rejects author-community feed pages", () => {
    it.todo("rejects a cross-posted entry with ERR_COMMENT_IN_PAGE_BELONG_TO_DIFFERENT_COMMUNITY");
    it.todo("rejects a cross-posted reply carried at top level (depth > 0 with no parent context)");
    it.todo("fails to verify a cross-post's CommentUpdate against the page's own community");
    it.todo("this is why author-community pages need their own verifier, not a relaxed shared one");
});

describe("verifyAuthorCommunityPage: per-entry community routing", () => {
    it.todo("verifies each entry's CommentIpfs against its author signature");
    it.todo("verifies a cross-posted entry's CommentUpdate against the community named by comment.communityPublicKey");
    it.todo("verifies a native entry's CommentUpdate against the author-community itself");
    it.todo("rejects an entry whose CommentUpdate is signed by a community other than its communityPublicKey");
    it.todo("rejects an entry whose CommentIpfs was tampered with");
    it.todo("routes per entry: a mixed page of native and cross-posted entries verifies entry by entry");
    it.todo("tolerates a rotated community key via areEquivalentCommunityAddresses (rotation is not fatal)");
});

// communityName is the strict half of the pair: a publicKey mismatch is tolerated because a
// community may rotate its key, a name mismatch is not because a domain is the stable identity.
// Applied per entry, never ignored when present.
describe("verifyAuthorCommunityPage: communityName checks", () => {
    it.todo("rejects a native entry whose communityName differs from the profile's community.name");
    it.todo("accepts a native entry whose communityName equals the profile's community.name");
    it.todo("matches names via areEquivalentCommunityAddresses, not raw string equality");
    it.todo("falls back to matching the anchor publicKey when the profile has no domain");
    it.todo("rejects a cross-posted entry whose communityName resolves to a different publicKey than it claims");
    it.todo("accepts a cross-posted entry whose communityName resolves to its communityPublicKey");
    it.todo("verifies a cross-posted entry by key with nameResolved false when its communityName cannot be resolved now");
    it.todo("never ignores a present communityName (an unchecked name would fake the hosting community)");
    it.todo("accepts an entry that carries no communityName at all (key-only community)");
});

// The feed relates entries to the profile by authorship, not by thread position.
describe("verifyAuthorCommunityPage: mixed depths (mod-queue precedent)", () => {
    it.todo("accepts a page mixing depth 0 posts and depth > 0 replies, like a mod queue page");
    it.todo("accepts entries with unrelated parentCids and no shared postCid");
    it.todo("does not require parent context for a top-level feed entry with depth > 0");
    it.todo("still rejects a depth 0 entry that carries a postCid");
    it.todo("still applies the shared verifier inside a CommentUpdate's own preloaded replies pages");
});

describe("verifyAuthorCommunityPage: owner-only invariant replaces parent checks", () => {
    it.todo("rejects a page containing a top-level entry authored by a key other than the resolved anchor");
    it.todo("accepts a page whose top-level entries are all authored by the anchor");
    it.todo("checks against the anchor from the resolved IPNS name, not any field inside the page");
    it.todo("applies to the inline first page and to every loaded pageCids chunk");
    it.todo("does not constrain authorship inside an entry's preloaded replies (replies are open)");
});

describe("verifyAuthorCommunityPage: entry payload", () => {
    it.todo("verifies an entry whose CommentUpdate embeds a preloaded replies page");
    it.todo("does not require a CommentUpdate to be present on every entry (read-side state 3)");
    it.todo("rejects an entry carrying runtime-only fields");
});
