// Test foundations for author-communities (issue #31, docs/protocol/author-communities.md).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: creating an author-community via the shared create path and the derived runtime kind.
// There is no createAuthor method and no kind wire field: kind is derived from which envelope
// key the record carries and surfaced as a runtime-only instance field.
import { describe, it } from "vitest";

describe("creating an author-community (shared createCommunity, local non-wire option)", () => {
    it.todo("creates an author-community through the shared create path with a local creation option (no createAuthor method)");
    it.todo("binds the author-community to an existing author signer instead of minting a fresh community key");
    it.todo("the resulting record publishes under author.publicKey (the anchor An)");
    it.todo("emits an { authorCommunity } envelope, never a bare record");
    it.todo("persists the discriminating bit in the community's local settings, never in the signed record");
    it.todo("rejects creating an author-community for a domain already used by a full community (no shared domains)");
});

describe("AuthorLocalCommunity subclass (thin subclass of LocalCommunity)", () => {
    it.todo("createCommunity with the author kind option instantiates AuthorLocalCommunity");
    it.todo("inherits pubsub, challenge pipeline, DB handler, lifecycle, and export unchanged");
    it.todo("preloads the new sort in the published record instead of the community default hot");
    it.todo("validates and signs against AuthorCommunityIpfsSchema and publishes the authorCommunity envelope key");
    it.todo("the update loop skips cross-posted rows (foreign communityPublicKey) when generating CommentUpdates");
});

describe("default challenges: owner-only top level via the built-in fail challenge", () => {
    it.todo("creation seeds settings.challenges with the fail challenge and its two excludes");
    it.todo("a non-owner top-level Comment over pubsub is rejected by the default fail challenge");
    it.todo("a non-owner reply is excluded from the fail challenge via the publicationType exclude");
    it.todo("the owner's top-level Comment passes via the owner-address exclude (signature-backed)");
    it.todo("owner CommentEdit, CommentModeration, and CommunityEdit pass via the excludes");
    it.todo("reply challenges (e.g. a captcha) can be configured alongside the seeded fail challenge");
});

describe("runtime-only community.kind", () => {
    it.todo("a loaded { community } envelope yields a community-kind instance");
    it.todo("a loaded { authorCommunity } envelope yields an author-kind instance");
    it.todo("kind is never present in the signed wire record");
    it.todo("kind is excluded from signed-property computation and accounted for in the reserved-field lists");
    it.todo("a local author-community instance exposes the same derived kind as a remote one");
});

describe("author-community lifecycle (shared, kind-blind methods)", () => {
    it.todo("start() runs both pubsub topics: the IPNS-over-pubsub record topic and the challenge/publication topic");
    it.todo("stop() tears down both topics");
    it.todo("delete() removes the author-community and its DB");
    it.todo("list surfaces both kinds and includes the derived kind for each entry");
    it.todo("uses the same per-community sqlite DB layout as a full community");
    it.todo("communityUpdateSubscribe streams author-community record updates unchanged (kind-blind)");
});

describe("record generation", () => {
    it.todo("generates the single new-sorted feed via the existing page generator");
    it.todo("caps the root object at 1 MiB and spills overflow into pageCids chunks");
    it.todo("republishes the IPNS record after feed changes");
    it.todo("signs the record with the anchor key when running non-delegated (own node)");
});
