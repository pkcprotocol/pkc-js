// Test foundations for author-communities (issue #31, docs/protocol/author-communities.md).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: the cross-post sync RPC pair. The RPC server hosts many author-communities
// (multi-tenant, like full communities), so both methods are keyed by the target profile:
//   listAuthorComments({ authorPublicKey, authorName? })            -> stored entries
//   syncAuthorComments({ authorPublicKey, authorName?, comments })  -> declarative snapshot of entries
// An entry is the PageIpfs comment shape ({ comment, commentUpdate }, see PageIpfsSchema) with
// commentUpdate relaxed to optional: the client seeds community-signed mod-state the minter may
// never be able to fetch, and a freshly published comment has no CommentUpdate yet.
// Method names TBD. Wire params identify the profile by publicKey (+ optional domain name),
// never by address: address is runtime-only (docs/protocol/wire-vs-runtime.md).
import { describe, it } from "vitest";

describe("listAuthorComments({ authorPublicKey, authorName? })", () => {
    it.todo("returns the stored entries for the given author-community");
    it.todo("returns raw wire comments only (no runtime-only fields)");
    it.todo("returns the same entry shape syncAuthorComments accepts (round-trip never strips commentUpdate)");
    it.todo("omits commentUpdate on entries the minter has no mod-state for");
    it.todo("returns an empty list for a freshly created author-community");
    it.todo("only returns comments belonging to the addressed profile, not other hosted profiles");
    it.todo("throws a descriptive error for an authorPublicKey the server does not host");
    it.todo("identifies the profile by authorPublicKey, with authorName as the optional domain");
    it.todo("throws when authorName does not belong to the given authorPublicKey (mismatch gate)");
    it.todo("does not accept an address param (wire schema identifies by publicKey, not address)");
});

describe("syncAuthorComments({ authorPublicKey, authorName?, comments }) validation gates", () => {
    it.todo("rejects a comment not signed by the addressed authorPublicKey (An)");
    it.todo("rejects a comment with an invalid signature");
    it.todo("rejects comments carrying runtime-only fields (raw wire shape enforced)");
    it.todo("accepts an entry with no commentUpdate (comment not yet updated by its host community)");
    it.todo("accepts an entry whose commentUpdate is validly signed by the comment's communityPublicKey");
    it.todo("rejects a commentUpdate whose community signature is invalid");
    it.todo("rejects a commentUpdate signed by a community other than the comment's communityPublicKey");
    it.todo("rejects a commentUpdate carrying runtime-only fields (raw wire shape enforced)");
    it.todo("throws a descriptive error for an authorPublicKey the server does not host");
    it.todo("cannot write into a different hosted profile than the one the comments' author key matches");
    it.todo("enforces a bounded input size as a byte cap, not only an entry count (a CommentUpdate can embed a preloaded replies page)");
});

// commentUpdate.cid is a signed field of CommentUpdate, so signature-plus-match is what proves the
// hosting community signed THIS mod-state for THIS comment. A valid signature alone attests the
// mod-state, never the pairing the client chose, so the server must derive the CID itself.
describe("syncAuthorComments comment <-> commentUpdate CID pairing", () => {
    it.todo("derives the cid from the raw comments[x].comment bytes rather than trusting any client-supplied cid");
    it.todo("accepts an entry whose derived comment cid equals comments[x].commentUpdate.cid");
    it.todo("rejects an entry whose derived comment cid differs from comments[x].commentUpdate.cid");
    it.todo("rejects a genuine, validly community-signed CommentUpdate stapled onto a different comment (karma inflation)");
    it.todo("skips the pairing check for entries where commentUpdate is undefined");
    it.todo("checks the pairing per entry: one mismatched entry does not silently pass inside an otherwise valid list");
    it.todo("rejects a commentUpdate whose cid is well-formed but belongs to a comment not in the synced list");
});

describe("syncAuthorComments declarative snapshot semantics", () => {
    it.todo("adds comments whose CIDs are not yet stored");
    it.todo("removes stored entries whose CIDs are omitted from the synced list");
    it.todo("is idempotent: syncing the same list twice changes nothing");
    it.todo("keys entries by the CID derived from the raw comment bytes");
    it.todo("reads communityPublicKey off each comment to learn its canonical community");
    it.todo("does not fetch from the network during sync (comment and commentUpdate bytes arrive in the call)");
    it.todo("succeeds while the canonical foreign community is unreachable");
    it.todo("regenerates the new feed and republishes the record after a sync that changed the set");
    it.todo("does not republish when the synced list matches the stored set");
    it.todo("republishes when a sync changes only an entry's commentUpdate, not the CID set");
});

// Mod-state is content of an entry; membership in the feed is presence in the sync list.
// Conflating the two is the failure mode carrying commentUpdate invites.
describe("client-seeded mod-state", () => {
    it.todo("stores a pushed commentUpdate and embeds it in the new feed on the next mint");
    it.todo("fills in mod-state on a later sync for an entry first synced without a commentUpdate");
    it.todo("keeps a pushed snapshot as last-known state while the canonical community stays unreachable");
    it.todo("lets the minter's refresh job overwrite a pushed snapshot with a newer fetched one");
    it.todo("does not drop an entry whose commentUpdate is absent and unfetchable (renders as read-side state 3)");
});

describe("commentUpdate monotonicity (anti-rollback)", () => {
    it.todo("accepts a pushed commentUpdate with a higher updatedAt than the stored one");
    it.todo("ignores a pushed commentUpdate with a lower updatedAt than the stored one");
    it.todo("ignores a pushed commentUpdate with an equal updatedAt (no-op, stays idempotent)");
    it.todo("does not un-remove a moderated comment when the author pushes a pre-removal snapshot");
    it.todo("applies the same max(stored, pushed) rule to the minter's own fetched updates");
});

describe("removal works while the foreign community is down", () => {
    it.todo("omitting a cross-post drops it from the feed with its canonical community unreachable");
    it.todo("omitting a cross-post drops it from the feed with its canonical community permanently gone");
    it.todo("does not treat a pushed commentUpdate with deleted/removed set as a request to drop the entry");
    it.todo("re-syncing a previously omitted comment restores it to the feed");
});

describe("multi-device merge flow", () => {
    it.todo("a fresh client lists stored entries, unions with its local comments by CID, then syncs the merged list");
    it.todo("a client syncing without merging first would drop the server-only entries (documented footgun the list/merge flow avoids)");
    it.todo("two devices syncing merged lists converge to the union of their comments");
    it.todo("merging two entries for the same CID keeps the commentUpdate with the higher updatedAt");
    it.todo("merging an entry that has a commentUpdate with one that has none keeps the commentUpdate");
});

describe("sync authorization model", () => {
    it.todo("private RPC is local-only and trusts its clients: no per-call ownership proof required");
    it.todo("signature gates still stop content forgery even from a trusted transport");
    it.todo("forge-tier ownership enforcement (must own the author key to sync) lives above the pkc-js method schema");
});

describe("multi-tenant isolation", () => {
    it.todo("the server hosts multiple author-communities alongside full communities");
    it.todo("a sync to one profile never mutates another profile's feed");
    it.todo("list/sync round-trips address the correct profile when several share the daemon");
});
