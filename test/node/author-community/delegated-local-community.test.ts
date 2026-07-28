// Test foundations for author-communities (issue #31, docs/protocol/author-communities.md).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: the delegated LocalCommunity prerequisite, where the node's signing key (minter Mn) is
// NOT the community's identity (anchor An). This is a type-blind LocalCommunity capability that
// author-communities depend on, not an author-community feature.
//
// Current behavior this replaces:
//   - publication acceptance requires publication.communityPublicKey === community.signer.address
//   - the publication store backfills communityPublicKey from community.signer.address
// With signer = Mn and identity = An, both reject or mislabel every remote publication, since a
// client resolves the anchor and addresses its publications to An.
//
// The read side already behaves correctly: community.publicKey is derived from ipnsHops[0] (the
// anchor) and never from signature.publicKey, so identity never becomes the minter.
import { describe, it } from "vitest";

describe("anchor identity on a delegated LocalCommunity", () => {
    it.todo("takes the anchor publicKey as a local creation option and persists it in local settings");
    it.todo("exposes community.publicKey as the anchor An, not the signer's address Mn");
    it.todo("exposes community.address as the anchor (or its domain), matching what readers resolve");
    it.todo("keeps signer, encryption, and pubsubTopic derived from the minter key");
    it.todo("signs the published record with the minter key while identity stays the anchor");
    it.todo("does not derive the anchor from the signer (a delegated node cannot compute its own identity)");
    it.todo("a non-delegated community keeps signer and anchor identical (degenerate case, behavior unchanged)");
});

describe("publication acceptance addressed to the anchor", () => {
    it.todo("accepts a Comment whose communityPublicKey equals community.publicKey (the anchor)");
    it.todo("rejects a Comment whose communityPublicKey equals the minter's address Mn");
    it.todo("rejects a Comment addressed to an unrelated publicKey");
    it.todo("accepts Vote, CommentEdit, CommentModeration, and CommunityEdit addressed to the anchor");
    it.todo("a non-delegated community still accepts publications addressed to its signer address (unchanged)");
});

describe("stored publications keep the anchor", () => {
    it.todo("backfills a missing communityPublicKey from community.publicKey, not from signer.address");
    it.todo("stores native comments with communityPublicKey equal to the anchor");
    it.todo("generated CommentUpdates reference the anchor as the community, while being minter-signed");
    it.todo("stored content survives a minter rotation without rewriting communityPublicKey");
});

// pkc-js must be able to run the whole delegated shape on its own, with no forge involved.
describe("round trip: publish and load back a delegated community", () => {
    it.todo("creates a delegated community, publishes a record, and loads it back through getCommunity");
    it.todo("the loaded instance reports the anchor as publicKey and the minter as the content signer");
    it.todo("a remote client can publish a Comment to it and see it appear in the community's pages");
    it.todo("loading reports ipnsHops as [anchor, minter]");
    it.todo("rotating the anchor to Mn' makes readers load content signed by Mn'");
    it.todo("the old minter's records stop being accepted after rotation (readers follow the new binding)");
});
