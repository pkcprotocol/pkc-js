// Test foundations for author-communities (issue #31, docs/protocol/author-communities.md).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: the cross-post sync RPC pair. The RPC server hosts many author-communities
// (multi-tenant, like full communities), so both methods are keyed by the target profile:
//   listAuthorComments({ authorPublicKey, authorName? })            -> stored raw CommentIpfs[]
//   syncAuthorComments({ authorPublicKey, authorName?, comments })  -> declarative snapshot of raw wire comments
// Method names TBD. Wire params identify the profile by publicKey (+ optional domain name),
// never by address: address is runtime-only (docs/protocol/wire-vs-runtime.md).
import { describe, it } from "vitest";

describe("listAuthorComments({ authorPublicKey, authorName? })", () => {
    it.todo("returns the stored raw CommentIpfs[] for the given author-community");
    it.todo("returns raw wire comments only (no runtime-only fields)");
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
    it.todo("accepts comments without a CommentUpdate (client never ships mod-state)");
    it.todo("throws a descriptive error for an authorPublicKey the server does not host");
    it.todo("cannot write into a different hosted profile than the one the comments' author key matches");
    it.todo("enforces a bounded input size (comment count / byte caps)");
});

describe("syncAuthorComments declarative snapshot semantics", () => {
    it.todo("adds comments whose CIDs are not yet stored");
    it.todo("removes stored entries whose CIDs are omitted from the synced list");
    it.todo("is idempotent: syncing the same list twice changes nothing");
    it.todo("keys entries by the CID derived from the raw comment bytes");
    it.todo("reads communityPublicKey off each comment to learn its canonical community");
    it.todo("does not fetch from the network during sync (comment bytes arrive in the call)");
    it.todo("succeeds while the canonical foreign community is unreachable");
    it.todo("regenerates the new feed and republishes the record after a sync that changed the set");
    it.todo("does not republish when the synced list matches the stored set");
});

describe("multi-device merge flow", () => {
    it.todo("a fresh client lists stored comments, unions with its local comments by CID, then syncs the merged list");
    it.todo("a client syncing without merging first would drop the server-only entries (documented footgun the list/merge flow avoids)");
    it.todo("two devices syncing merged lists converge to the union of their comments");
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
