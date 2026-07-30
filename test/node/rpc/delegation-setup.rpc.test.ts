// Test foundations for the RPC half of delegation setup (issue #234).
// Design-only scaffolding: every case is it.todo until implemented.
//
// The implementation lives on LocalCommunity and is forwarded by RpcLocalCommunity, mirroring
// startCommunity/stopCommunity, so an in-process self-hosted node needs no RPC at all.
// RPC params follow the existing community-scoped shape {name?, publicKey?}, where publicKey is An.
import { describe, it } from "vitest";

describe("RPC method surface", () => {
    it.todo("prepareAnchorPublish is addressable as {name?, publicKey?} with publicKey being the anchor");
    it.todo("publishAnchorRecord takes the signed record bytes and the same community identifier");
    it.todo("createCommunity over RPC accepts an anchor publicKey and returns Mn plus the bootstrap fields");
    it.todo("errors surface as PKC errors with details, not as bare JSON-RPC failures");
});

describe("RpcLocalCommunity forwards both methods", () => {
    it.todo("a browser or CLI client calls the identical method regardless of transport");
    it.todo("an in-process node performs the same operations with no RPC client configured");
    it.todo("the two paths produce byte-identical anchor records for the same inputs");
});

describe("the server never sees the anchor private key", () => {
    it.todo("no RPC param carries As");
    it.todo("the server rejects an anchor record it cannot verify rather than re-signing anything");
});

describe("a client that cannot stay online", () => {
    it.todo("the node keeps re-providing the anchor record after the client disconnects");
    it.todo("a client that never publishes the anchor record leaves a half-created community, not a broken one");
});
