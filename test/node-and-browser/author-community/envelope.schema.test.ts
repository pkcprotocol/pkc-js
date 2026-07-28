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
    it.todo("carries profile metadata fields (displayName, avatar, wallets, bio/links)");
    it.todo("carries posts as { pages: { new }, pageCids: { new } }, reusing the community posts structure");
    it.todo("only exposes the single new sort, not hot/top/controversial");
    it.todo("carries statsCid, createdAt, updatedAt, signature, protocolVersion");
    it.todo("rejects a record missing signature");
    it.todo("rejects a record missing protocolVersion");
    it.todo("defines AuthorCommunitySignedPropertyNames as all fields minus signature");
});

// roles is NOT dropped: isPublicationAuthorPartOfRoles returns false when community.roles is
// undefined, and it gates both CommentModeration acceptance and CommunityEdit (owner/admin, and
// owner for role/address edits). Without the map the owner could neither moderate replies on their
// own profile nor edit their own metadata.
describe("AuthorCommunityIpfs roles", () => {
    it.todo("carries a roles map with the same shape as CommunityIpfs (address to role)");
    it.todo("parses a record whose roles map holds exactly one owner entry (v1 seeding)");
    it.todo("parses a record whose roles map holds additional entries (schema does not encode the v1 policy)");
    it.todo("rejects a record with a malformed role value");
});

// The postUpdates MFS bucket tree exists so a client holding one comment CID can find its update
// without traversing pages, which matters at millions of comments. A profile embeds every entry's
// CommentUpdate in its feed pages, so v1 omits the field (future good to have).
describe("AuthorCommunityIpfs omits postUpdates", () => {
    it.todo("does not define postUpdates in the schema shape");
    it.todo("rejects a record carrying postUpdates (strict shape)");
    it.todo("a native comment's CommentUpdate is reachable from the feed page that carries the comment");
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

// Hard flag day in both directions: all clients update together, so there is no transition window
// and no bare-record fallback to maintain.
describe("envelope wire-format break for communities (coordinated flag-day)", () => {
    it.todo("a pre-envelope loader fails to parse an enveloped { community } record");
    it.todo("the envelope-aware loader rejects a bare pre-envelope CommunityIpfs record (no fallback path)");
    it.todo("the envelope-aware publisher never emits a bare record");
    it.todo("the flag-day is gated on a protocolVersion bump");
});
