// Test foundations for author-communities (issue #31, docs/protocol/author-communities.md).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: pkc.getAuthor(address) resolution across all transports, delegated (anchor -> minter)
// and non-delegated (own-node, single hop) publishing shapes.
import { describe, it } from "vitest";

describe("pkc.getAuthor(address)", () => {
    it.todo("resolves author.publicKey (IPNS name) to an AuthorCommunityIpfs via the envelope");
    it.todo("resolves a domain address (e.g. name.bso) via its text record to the author-community");
    it.todo("throws a descriptive error when the resolved envelope contains { community } instead of { authorCommunity }");
    it.todo("the loaded instance exposes runtime-only kind derived from the envelope key presence (never a wire field)");
    it.todo("getAuthor, if provided, is cosmetic sugar over the kind-blind load path, not a separate resolution path");
    it.todo("ignores a record older than the one already held in memory (updatedAt freshness)");
});

describe("getAuthor over a delegated chain (anchor -> minter)", () => {
    it.todo("walks the single An -> Mn hop and verifies the content signature against the terminal minter key");
    it.todo("keeps author identity as the anchor: author.address/publicKey derive from ipnsHops[0]");
    it.todo("rejects content whose signer is not the terminal of the validated chain");
    it.todo("rejects a chain longer than MAX_IPNS_HOPS with ERR_IPNS_MAX_HOPS_EXCEEDED");
    it.todo("fails with the expired-record error when the anchor record EOL has lapsed (liveness cliff)");
    it.todo("resolves after the author rotates the anchor to a new minter Mn'");
});

describe("getAuthor over a non-delegated own-node profile (degenerate single hop)", () => {
    it.todo("resolves in a single hop when the record is signed by the anchor key itself");
    it.todo("verifies the content signature directly against author.publicKey (terminal equals anchor)");
});

describe("getAuthor per resolution path", () => {
    it.todo("resolves via kubo RPC (hop-by-hop, recursive: false)");
    it.todo("resolves via helia/libp2p (single record per call, per-hop topic warmup)");
    it.todo("resolves via gateway tier 1 (single plain GET) when non-delegated");
    it.todo("escalates to gateway tier 2 (?format=ipns-record chain validation) when the content signer differs from the anchor");
    it.todo("rejects a gateway serving a forged chain with ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID");
});
