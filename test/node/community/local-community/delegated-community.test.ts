// Test foundations for a delegated LocalCommunity (issue #233): the anchor An is the community
// identity, the minter Mn is the signing key that lives on the node.
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// See docs/protocol/delegated-ipns.md. Kind-blind: nothing here is author-community specific.
//
// Naming: An/As = anchor keypair (identity, owner-held), Mn/Ms = minter keypair (node-held, rotatable).
// Setup over RPC lives in test/node/community/delegation-setup.test.ts (issue #234).
import { describe, it } from "vitest";

describe("anchor as persisted local state", () => {
    it.todo("persists the anchor in the internal community record at creation");
    it.todo("replays the anchor into ipnsHops on load, so identity survives a restart");
    it.todo("sets ipnsHops to [anchor, signer.address] at init");
    it.todo("rejects creating a delegated community with no anchor publicKey");
    it.todo("rejects an anchor publicKey equal to the community's own signer address");
    it.todo("does not publish the anchor on the wire (never appears in CommunityIpfs)");
});

describe("identity reports the anchor, not the signer", () => {
    it.todo("community.publicKey is the anchor");
    it.todo("community.address is the anchor (or its domain)");
    it.todo("community.signer.address stays the minter");
    it.todo("the community data directory is keyed by the anchor, matching what readers resolve");
    it.todo("listCommunities reports the anchor address");
});

describe("a non-delegated community is the degenerate case", () => {
    it.todo("identity is unchanged when no anchor is set");
    it.todo("ipnsHops is absent or single-element, and every rule above collapses to current behavior");
});

describe("publication acceptance compares against the anchor", () => {
    it.todo("accepts a publication whose communityPublicKey is the anchor");
    it.todo("rejects a publication whose communityPublicKey is the minter");
    it.todo("rejects a publication whose communityPublicKey is an unrelated key");
    it.todo("accepts comments, replies, votes, edits and moderations alike (no per-type special case)");
});

describe("the publication store labels content with the anchor", () => {
    it.todo("a stored CommentIpfs carries the anchor as communityPublicKey");
    it.todo("a stored CommentEdit carries the anchor as communityPublicKey");
    it.todo("a stored CommentModeration carries the anchor as communityPublicKey");
    it.todo("stored content needs no rewrite after a minter rotation");
});

// Only identity moves to the anchor. Everything the minter key produces stays minter-derived.
describe("minter-derived state stays minter-derived", () => {
    it.todo("encryption.publicKey is the minter's public key");
    it.todo("the published record's signature.publicKey derives to the minter");
    it.todo("signer.ipnsKeyName is the minter, so kubo publishes under Mn");
    it.todo("the backfilled pubsubTopic is the minter address");
    it.todo("ipnsName stays the minter on a publisher, and does NOT follow ipnsHops[0]");
    it.todo("ipnsPubsubTopic and ipnsPubsubTopicRoutingCid stay derived from the minter");
});

// _communityChallengeMsgSignerAddress derives the expected signer from encryption.publicKey
// (see #236), which is the minter. Nothing on master exercises it with signer != anchor.
describe("challenge exchange with signer != anchor", () => {
    it.todo("a remote publisher completes a full challenge exchange against a delegated community");
    it.todo("the challenge and challengeverification messages verify against the minter address");
    it.todo("the owner's in-process publish works through the local shortcut");
    it.todo("a challenge message signed by the anchor key is rejected");
});

describe("reading back what a delegated community publishes", () => {
    it.todo("a RemoteCommunity resolving the chain reports the anchor as its identity");
    it.todo("the record verifies with content signed by the minter");
    it.todo("comments published to the delegated community load with the anchor as communityPublicKey");
});

describe("minter rotation", () => {
    it.todo("the community address is unchanged after rotating to a new minter");
    it.todo("previously stored content still resolves and verifies");
    it.todo("the pubsubTopic changes with the minter, and a reader that re-resolves picks it up");
});

describe("export and import", () => {
    it.todo("exportCommunity carries the anchor");
    it.todo("importing an exported delegated community restores identity without the anchor's private key");
});
