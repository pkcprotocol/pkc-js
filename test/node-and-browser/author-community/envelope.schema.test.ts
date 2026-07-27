// Test foundations for author-communities (issue #31, docs/protocol/author-communities.md).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: the IpnsRecordEnvelope ({ authorCommunity? | community? }) and the AuthorCommunityIpfs schema.
import { describe, it } from "vitest";

describe("IpnsRecordEnvelope schema", () => {
    it.todo("parses an envelope with only { authorCommunity } present");
    it.todo("parses an envelope with only { community } present");
    it.todo("rejects an envelope with both authorCommunity and community present (v1 exactly-one rule)");
    it.todo("rejects an envelope with neither authorCommunity nor community present");
    it.todo("rejects an envelope with unknown top-level keys");
    it.todo("read-side dispatches on key presence, not on a type discriminator field");
});

describe("AuthorCommunityIpfs schema", () => {
    it.todo("keeps challenges (public challenge requirements a replying author reads)");
    it.todo("keeps encryption (the key a replying author encrypts publications with)");
    it.todo("keeps pubsubTopic (the challenge/publication topic the minter runs)");
    it.todo("does not carry a multi-roles map (owner collapses to self)");
    it.todo("carries profile metadata fields (displayName, avatar, wallets, bio/links)");
    it.todo("carries posts as { pages: { new }, pageCids: { new } }, reusing the community posts structure");
    it.todo("only exposes the single new sort, not hot/top/controversial");
    it.todo("carries stats, createdAt, updatedAt, signature, protocolVersion");
    it.todo("rejects a record missing signature");
    it.todo("rejects a record missing protocolVersion");
    it.todo("defines AuthorCommunitySignedPropertyNames as all fields minus signature");
});

describe("read-only mode wire shape (issue #229)", () => {
    it.todo("parses a record omitting pubsubTopic, challenges, and encryption together");
    it.todo("rejects a record with pubsubTopic absent but encryption present (all-or-none refine)");
    it.todo("rejects a record with pubsubTopic absent but challenges present (all-or-none refine)");
    it.todo("parses a reply-able record with the full pubsubTopic/challenges/encryption trio present");
});

describe("AuthorCommunityIpfs size caps", () => {
    it.todo("accepts a root object (metadata + inline new page + pageCids) up to 1 MiB");
    it.todo("rejects a root object above 1 MiB, matching the LocalCommunity root cap");
    it.todo("does not apply the 40 KiB comment publication cap to the record itself");
    it.todo("spills feed overflow into pageCids chunks instead of growing the root unboundedly");
});

describe("envelope wire-format break for communities (coordinated flag-day)", () => {
    it.todo("a pre-envelope loader fails to parse an enveloped { community } record");
    it.todo("the envelope-aware loader still parses a bare pre-envelope CommunityIpfs record during the transition");
    it.todo("the flag-day is gated on a protocolVersion bump");
});
