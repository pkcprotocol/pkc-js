// Test foundations for delegation setup (issue #234): telling a pkc-js node "run this community for
// me, I keep the anchor key". Design-only scaffolding: every case is it.todo until implemented.
// See docs/protocol/delegated-ipns.md. Kind-blind: serves delegated community and authorCommunity alike.
//
// An/As = anchor keypair (identity, owner-held, never leaves the client).
// Mn/Ms = minter keypair (generated and held by the node, rotatable).
// The node-side identity split is issue #233, see local-community/delegated-community.test.ts.
import { describe, it } from "vitest";

// DO THIS FIRST. name.publish cannot publish bytes signed by a key the node does not hold, so the
// anchor record has to go out through routing.put. If that does not reach the routers and the
// ipns-over-pubsub topic on our kubo config, the whole "the node keeps the anchor alive" design
// changes shape, and that should be discovered before any API is written.
describe("spike: publishing a foreign pre-signed IPNS record through kubo", () => {
    it.todo("routing.put accepts a record signed by a key that is not in the node's keystore");
    it.todo("the record is then retrievable from the HTTP routers");
    it.todo("the record is served on the name's ipns-over-pubsub topic to a fresh subscriber");
    it.todo("a second node with no prior knowledge resolves /ipns/An to /ipns/Mn");
    it.todo("re-putting the same bytes on a schedule keeps it retrievable");
});

describe("createCommunity with an anchor publicKey instead of a signer", () => {
    it.todo("generates Mn/Ms on the node and keys the community by the anchor");
    it.todo("returns Mn, pubsubTopic and encryption so the client can bootstrap before the first mint");
    it.todo("returns nextSequence 0, so a first anchor publish needs no extra round trip");
    it.todo("returns Mn alone when the community is created read-only (all-or-none, per #229)");
    it.todo("rejects passing both a signer and an anchor publicKey");
    it.todo("today's signer-only and no-argument calls are unchanged");
    it.todo("the community is not resolvable yet: nothing points An anywhere");
});

describe("prepareAnchorPublish", () => {
    it.todo("returns the persisted anchor record's sequence plus a margin when the node has one");
    it.todo("falls back to a live lookup of /ipns/An on a node that has never seen the record");
    it.todo("takes the max across its persisted record and the network lookup");
    it.todo("returns 0 only for an anchor with no history");
    it.todo("errors rather than returning 0 when the anchor has history but the lookup comes back empty");
    it.todo("does no network I/O on the client: the node is the online party");
});

// The client signs, never publishes. Must be browser-safe (no node-only imports), since a browser
// client holding As is the primary case.
describe("signing an anchor record client-side", () => {
    it.todo("signs a record with an arbitrary signer, value /ipns/Mn");
    it.todo("uses the shared infinite-EOL constant, not a per-call-site validity");
    it.todo("uses the sequence handed back by prepareAnchorPublish");
    it.todo("the produced record passes ipnsValidator against An's routing key");
    it.todo("the anchor private key never leaves the client (nothing sends As over the RPC)");
    it.todo("a client-side sequence counter, when present, is taken as a max() input and not as truth");
});

describe("publishAnchorRecord", () => {
    it.todo("accepts a record signed by An that points at the node's own Mn");
    it.todo("rejects a record signed by any other key");
    it.todo("rejects a record pointing at a different minter");
    it.todo("rejects a sequence equal to or lower than the highest already accepted (replay/rollback)");
    it.todo("rejects malformed record bytes");
    it.todo("persists the accepted record and the highest accepted sequence");
    it.todo("keeps the anchor record in a slot distinct from LAST_IPNS_RECORD (its own minter record)");
    it.todo("never needs As: the node can refuse to serve the binding but cannot forge or replace it");
});

describe("after the anchor record is published", () => {
    it.todo("/ipns/An resolves to the community record");
    it.todo("a remote client loads the community with identity An and content signed by Mn");
    it.todo("the node subscribes to An's ipns-over-pubsub topic in addition to Mn's");
    it.todo("the record stays retrievable across a node restart");
    it.todo("the client can then read pubsubTopic and encryption from the record, not from the create response");
});

describe("rotation and revocation", () => {
    it.todo("creating on a second node and publishing An -> Mn' moves hosting with no address change");
    it.todo("the new node learns the current sequence from the network when it has no persisted record");
    it.todo("the old minter keeps Ms but nothing points at it");
    it.todo("readers pick up the new binding within the anchor record TTL");
    it.todo("exportCommunity plus rotation makes hosting portable");
});

describe("half-created communities", () => {
    it.todo("a community created with an anchor but no published anchor record is listed as not resolvable");
    it.todo("start/stop/delete behave sanely on it");
    it.todo("publishing the anchor record later completes it with no re-create");
});

describe("the surface is type-blind and community-scoped", () => {
    it.todo("the same methods serve a delegated community and a delegated authorCommunity");
    it.todo("nothing in the flow is author-specific");
});
