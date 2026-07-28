// Test foundations for author-communities (issue #31, docs/protocol/author-communities.md).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: read-side verification of the embedded feed (three states) and karma computation.
import { describe, it } from "vitest";

describe("embedded feed entry verification (cross-posted entries)", () => {
    it.todo("verifies the embedded CommentIpfs signature against the author key");
    it.todo("verifies the embedded CommentUpdate signature against the canonical (foreign) community key");
    it.todo("rejects an entry whose embedded CommentIpfs was tampered with by the minter");
    it.todo("rejects an entry whose embedded CommentUpdate was tampered with by the minter");
    it.todo("treats the embedded CommentUpdate as a refreshable snapshot, not the live state");
});

describe("owner-only top level (verification-time invariant)", () => {
    it.todo("accepts a feed whose top-level entries are all authored by the resolved anchor key");
    it.todo("rejects a record whose inline new page contains a top-level entry with author.publicKey !== anchor");
    it.todo("rejects a loaded pageCids chunk containing a foreign-authored top-level entry (not just the inline page)");
    it.todo("accepts foreign-authored replies under an owner top-level entry (replies are unconstrained)");
    it.todo("checks against the resolved anchor from the IPNS name, not any field inside the record");
    it.todo("a misconfigured minter that accepted a foreign top-level post produces a record readers reject");
});

describe("three renderable feed states", () => {
    it.todo("state live: CommentIpfs signature valid and live CommentUpdate loads clean");
    it.todo("state removed: live CommentUpdate loads with removed/deleted set");
    it.todo("state unknown: no verifiable CommentUpdate at all (none embedded, none loadable live)");
    it.todo("state unknown is rendered as unverified, never collapsed to purged");
    it.todo("an entry with an embedded CommentUpdate whose community signature fails is state unknown, not state live");
    it.todo("native entries are live iff present in the feed (sole host), never state unknown");
    it.todo("a removed native entry means the owner or a moderator deleted it");
});

// The embedded snapshot's community signature is what makes it verifiable, not the community's
// reachability, so a dead community's cross-posts stay renderable instead of being pinned in
// state unknown. Only possible because the client can seed mod-state via syncAuthorComments.
describe("verified snapshot from an unreachable or dead community", () => {
    it.todo("renders as state live from the embedded CommentUpdate alone when the canonical community never resolves");
    it.todo("renders as state removed from an embedded CommentUpdate with removed/deleted set, community unreachable");
    it.todo("marks such an entry as last-known rather than live (not known-current)");
    it.todo("prefers the live CommentUpdate over the embedded snapshot when the community does resolve");
});

describe("karma", () => {
    it.todo("computes karma only from independently verified entries (state live)");
    it.todo("never computes karma from raw self-attested embedded snapshots");
    it.todo("a profile cannot inflate karma via forged or inflated embedded CommentUpdates");
    it.todo("a transient canonical-community outage (state unknown) does not delete history from the rendered feed");
    it.todo("counts a community-signed embedded snapshot: signature-verified is what independently verified means, not fetched-live");
    it.todo("a stale-but-signed snapshot may lag the live score until refreshed (accepted: embedded snapshots always drift)");
    it.todo("aggregates over the entries the client has loaded, since there is no signed profile-wide total");
    it.todo("the record carries no minter-computed karma total (that would be self-attestation by the owner's delegate)");
    it.todo("iterating every pageCids chunk yields the profile's full karma");
    it.todo("a sum over the inline first page alone is a partial total, not the profile's karma");
    it.todo("loading a further pageCids chunk extends the aggregate rather than correcting it");
});

describe("feed shape", () => {
    it.todo("mixes posts and replies in the single new feed, sorted by timestamp");
    it.todo("renders a profile in one fetch from the inline first page (no N round-trips to N communities)");
    it.todo("loads deeper feed pages via pageCids chunks");
});
