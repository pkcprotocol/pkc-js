// Test foundations for author-communities (issue #31, docs/protocol/author-communities.md).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: resolving an author-community through the type-blind read surface. There is no
// pkc.getAuthor and no getCommunity variant for profiles: getCommunity resolves both kinds and the
// returned instance carries the runtime-only `type` derived from which envelope key was present.
// Also covers the delegated (anchor -> minter) and non-delegated (own-node, single hop) shapes
// across every resolution path.
import { describe, it } from "vitest";

describe("getCommunity resolving an author-community", () => {
    it.todo("resolves the author's identity IPNS name to an AuthorCommunityIpfs via the envelope");
    it.todo("resolves a domain address (e.g. name.bso) via its text record to the author-community");
    it.todo("surfaces runtime-only type derived from the envelope key presence (never a wire field)");
    it.todo("narrows to the author-community shape on type without a dedicated method");
    it.todo("resolves a normal community through the same call, returning the community type");
    it.todo("ignores a record older than the one already held in memory (updatedAt freshness)");
    it.todo("exposes no getAuthor method on the pkc instance (type-blind surface only)");
});

// The anchor is the author's identity key, so a profile is resolved from the very key that signs the
// author's comments: getPKCAddressFromPublicKeySync(comment.signature.publicKey). author.publicKey
// and author.address are runtime-only (AuthorReservedFields) and never appear on the wire.
describe("resolving a profile from a comment", () => {
    it.todo("derives the profile's IPNS name from comment.signature.publicKey, not from a wire author field");
    it.todo("uses author.name as the profile address when the author has a domain");
    it.todo("rejects a comment carrying author.publicKey or author.address on the wire (reserved fields)");
});

describe("author-community over a delegated chain (anchor -> minter)", () => {
    it.todo("walks the single An -> Mn hop and verifies the content signature against the terminal minter key");
    it.todo("keeps author identity as the anchor: community.publicKey derives from ipnsHops[0], never from signature.publicKey");
    it.todo("rejects content whose signer is not the terminal of the validated chain");
    it.todo("rejects a chain longer than MAX_IPNS_HOPS with ERR_IPNS_MAX_HOPS_EXCEEDED");
    it.todo("resolves after the author rotates the anchor to a new minter Mn'");
    it.todo("still resolves an anchor record published with the effectively-infinite EOL constant");
});

describe("author-community over a non-delegated own-node profile (degenerate single hop)", () => {
    it.todo("resolves in a single hop when the record is signed by the anchor key itself");
    it.todo("verifies the content signature directly against the anchor (terminal equals anchor)");
});

describe("author-community per resolution path", () => {
    it.todo("resolves via kubo RPC (hop-by-hop, recursive: false)");
    it.todo("resolves via helia/libp2p (single record per call, per-hop topic warmup)");
    it.todo("resolves via gateway tier 1 (single plain GET) when non-delegated");
    it.todo("escalates to gateway tier 2 (?format=ipns-record chain validation) when the content signer differs from the anchor");
    it.todo("rejects a gateway serving a forged chain with ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID");
    it.todo("returns the same derived type on every resolution path");
});

// type is derived at load time, so every transport that surfaces a community instance must carry it.
describe("type propagation across community variants", () => {
    it.todo("a local author-community instance exposes the author type");
    it.todo("a RemoteCommunity loaded from an { authorCommunity } envelope exposes the author type");
    it.todo("an RPC client community mirrors the type the RPC server derived");
    it.todo("communityUpdateSubscribe emits updates for an author-community unchanged (type-blind)");
    it.todo("list output includes the derived type for both community kinds");
});
