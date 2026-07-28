// Test foundations for author-communities (issue #31, docs/protocol/author-communities.md).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: the delegated (anchor -> minter) publishing shape for author-communities,
// per docs/protocol/delegated-ipns.md. Delegate-side publishing itself stays out of pkc-js;
// these cases cover the pkc-js side: anchor record handling and delegated loading of profiles.
import { describe, it } from "vitest";

describe("delegated author-community record chain", () => {
    it.todo("the profile record signature derives to the minter key Mn, not the anchor An");
    it.todo("the An -> Mn anchor record is signed by the author's key As, client-side");
    it.todo("the anchor record uses the shared delegated-IPNS anchor EOL constant (no new value)");
    it.todo("the anchor EOL constant is effectively infinite (maximum representable validity)");
    it.todo("author identity stays the anchor: author.address/publicKey never become Mn");
});

describe("anchor publish and rotation (owner own-key actions in pkc-js)", () => {
    it.todo("signs and publishes the initial An -> Mn anchor record at delegation setup");
    it.todo("does not require the owner to re-publish the anchor on a schedule (no renewal obligation)");
    it.todo("rotates An -> Mn' to revoke a delegate; readers then load content signed by Mn'");
    it.todo("a rotation increments the anchor record sequence so honest routers prefer the new binding");
    it.todo("the anchor record still has to be re-provided to routers to stay retrievable (validity is not reachability)");
});

describe("minter rotation and data migration", () => {
    it.todo("exportCommunity works type-blind on an author-community (sqlite backup of the same DB layout)");
    it.todo("the export contains no minter key material (address = anchor, minter key is node-local config)");
    it.todo("restore is file-level: placing the sqlite at the new node's community DB path and starting works (no importCommunity method)");
    it.todo("a restored DB on the new minter preserves native content, including foreign replies");
    it.todo("the normal update loop re-signs regenerated mod-state under the new minter key Mn'");
    it.todo("cross-post entries need no migration: the client re-syncs them after rotation");
});

describe("own-node profile (non-delegated degenerate case)", () => {
    it.todo("a self-hosted profile needs no minter keypair (chain is [An], terminal equals anchor)");
    it.todo("the own-node record is signed directly by the anchor key");
    it.todo("loading an own-node profile costs a single hop on every resolution path");
});
