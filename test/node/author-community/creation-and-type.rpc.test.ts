// Test foundations for author-communities (issue #31, docs/protocol/author-communities.md).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: the client <-> RPC server round trip for creation and the derived type.
//
// creation-and-type.test.ts covers the same-process path. This file is the RPC dimension, which is
// where the design's two halves can silently disagree: creation takes the discriminating bit as a
// LOCAL, non-wire option -- createCommunity({ type: "authorCommunity" }), defaulting to "community"
// -- while reads derive community.type from which envelope key the record carries. Over RPC those
// halves sit on opposite sides of a socket:
//   - the creation option must cross the RPC boundary as a method param and be persisted in the
//     SERVER's local settings (it is local to the community, not to the process that asked),
//   - the derived type must cross back as a runtime-only field on every instance the client sees,
//   - and neither may ever reach the signed record.
// A server that ignored the option, or a client that dropped the derived type, would leave every
// same-process test green.
import { describe, it } from "vitest";

describe("createCommunity({ type: 'authorCommunity' }) over RPC", () => {
    it.todo("an RPC client createCommunity with the author type option creates an author-community on the server");
    it.todo("the option travels as an RPC method param (the client never constructs the community locally)");
    it.todo("the server instantiates AuthorLocalCommunity, not LocalCommunity, for the created address");
    it.todo("createCommunity with no type option creates a full community (default 'community', existing call sites unchanged)");
    it.todo("createCommunity({ type: 'community' }) is equivalent to omitting the option");
    it.todo("rejects an unknown type value with a schema error before creating anything");
    it.todo("the created author-community is addressed by the anchor author.publicKey, not a freshly minted community key");
    it.todo("binds to an existing author signer supplied by the client over RPC");
});

describe("the creation option is local and server-persisted, never wire", () => {
    it.todo("the server persists the type in the community's local settings, not in the signed record");
    it.todo("the published record carries the { authorCommunity } envelope key and no type field");
    it.todo(
        "a server restart re-instantiates AuthorLocalCommunity from the persisted local settings without the client re-sending the option"
    );
    it.todo("the client cannot change an existing community's type by passing the option to a later call");
    it.todo("two RPC clients pointed at the same server see the same persisted type for the same address");
});

describe("derived community.type crosses back to the RPC client", () => {
    it.todo("the instance returned by createCommunity over RPC exposes type 'authorCommunity'");
    it.todo("the instance returned by createCommunity over RPC for a full community exposes type 'community'");
    it.todo("getCommunity over RPC exposes the type the server derived from the envelope key");
    it.todo("an RPC client instance exposes the same type as the same-process instance for the same record");
    it.todo("type survives the RPC serialization round trip (not dropped as a runtime-only field)");
    it.todo("type is excluded from signed-property computation on both sides");
    it.todo("type is accounted for in the RPC-side reserved-field lists (never echoed back into a wire record)");
    it.todo("community.type === 'authorCommunity' narrows the returned union natively (no getAuthor method exists)");
});

describe("type-blind lifecycle methods over RPC", () => {
    it.todo("startCommunity starts an author-community by address with no type param");
    it.todo("stopCommunity stops it by address with no type param");
    it.todo("deleteCommunity deletes it and its DB by address with no type param");
    it.todo("list over RPC returns both kinds and includes the derived type per entry");
    it.todo("communityUpdateSubscribe over RPC streams author-community record updates unchanged");
    it.todo("a stale RPC client that predates the type field still drives a full community unchanged");
});

describe("multi-tenant server hosting both kinds", () => {
    it.todo("a server hosting full communities and author-communities creates each with the right class");
    it.todo("creating an author-community does not change the type of an existing full community");
    it.todo("list distinguishes the two kinds on the same daemon");
    it.todo("rejects creating an author-community for a domain already used by a full community (no shared domains)");
});

describe("e2e over RPC: create, publish, load back", () => {
    it.todo("client creates an author-community over RPC and the server mints the { authorCommunity } envelope");
    it.todo(
        "the owner publishes a native Comment through the RPC client and it passes the seeded fail challenge via the owner-address exclude"
    );
    it.todo("the server regenerates the single new-sorted feed and republishes the IPNS record");
    it.todo("a separate reader resolves the address and loads the record back with type 'authorCommunity'");
    it.todo("the reader verifies the record against the anchor and the pages with the author-community page verifier");
    it.todo("the same flow through a same-process community produces an equivalent record (RPC parity)");
});
