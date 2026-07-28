// Test foundations for author-communities (issue #31, docs/protocol/author-communities.md).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: storage. Native content uses the standard per-community tables; cross-posts get their own
// table and never enter `comments`, because that table is built for content this community hosts:
//   - postCid TEXT NOT NULL REFERENCES comments(cid), parentCid TEXT NULLABLE REFERENCES comments(cid)
//     -> a cross-posted reply's parent/post rows live in a foreign community and do not exist locally
//   - commentUpdates is keyed cid REFERENCES comments(cid) and holds node-signed updates
//     -> a cross-post's update is foreign-signed and must never be regenerated
//   - author counts/scores, firstCommentTimestamp, number/postNumber, lastPostCid/lastCommentCid and
//     statsCid all count rows in `comments` -> cross-posts would inflate every one of them
import { describe, it } from "vitest";

// The cross-post table is NOT a mirror of `comments`. That table decomposes a publication into ~30
// typed columns because the node owns the content: it scores it, regenerates and re-signs its
// CommentUpdate, and rebuilds the wire record via deriveCommentIpfsFromCommentTableRow(). For a
// cross-post the node only orders it and embeds it verbatim, so the raw wire records are stored as
// JSON and only the query surface gets columns.
// Storage rule: keep the records verbatim plus node-local bookkeeping, derive everything else.
describe("cross-post table", () => {
    it.todo("stores the author-signed CommentIpfs as raw JSON, byte-identical to what was synced");
    it.todo("stores the optional community-signed CommentUpdate as raw JSON, byte-identical");
    it.todo("keys rows by the cid derived from the raw comment bytes, never a client-supplied cid");
    it.todo("stores a cross-posted reply's embedded ancestors as JSON with a refresh stamp");
    it.todo("keeps refresh bookkeeping per row (last attempt, last success, failure count)");
    it.todo("replaces mod-state in place when a newer CommentUpdate arrives");
    it.todo("deletes a row on omission from the next sync (declarative snapshot)");
});

// timestamp and communityPublicKey are VIRTUAL generated columns over the comment JSON, so they are
// indexable without being a second copy that can drift from the signed bytes.
describe("derived columns instead of duplicated ones", () => {
    it.todo("exposes timestamp as a generated column reading json_extract(comment, '$.timestamp')");
    it.todo("exposes communityPublicKey as a generated column reading json_extract(comment, '$.communityPublicKey')");
    it.todo("orders the feed by the generated timestamp using its index");
    it.todo("batches the refresh job by the generated communityPublicKey using its index");
    it.todo("a generated column cannot drift from the stored record (no separate write path)");
    it.todo("stores no communityName column (only read while parsing during verification)");
    it.todo("stores no depth column (rendering information, never queried)");
    it.todo("stores no commentUpdateUpdatedAt column (monotonicity is a per-row check on a loaded row)");
    it.todo("stores cid as a real column since it is a hash of the bytes, not a field of them");
});

describe("cross-post table shape", () => {
    it.todo("declares no foreign keys (every reference points outside this database)");
    it.todo("stores a cross-post whose parent and post do not exist locally");
    it.todo("does not give parentCid or postCid their own columns (they live in the raw JSON)");
    it.todo("round-trips a comment carrying fields this node does not know (forward compatibility)");
    it.todo("re-embeds a stored entry into a page byte-identically, so its signature still verifies");
    it.todo("parses comment, commentUpdate, and ancestors as JSON columns, not strings");
});

describe("cross-posts never enter the comments table", () => {
    it.todo("inserting a cross-posted reply into comments would violate the parentCid foreign key");
    it.todo("inserting a cross-posted reply into comments would violate the postCid foreign key");
    it.todo("a cross-post never gets a row in commentUpdates (its update is foreign-signed)");
    it.todo("the update loop has no cross-posted rows to skip: it only ever sees native content");
});

describe("per-community aggregates stay native-only", () => {
    it.todo("queryAuthorPublicationCounts ignores cross-posts");
    it.todo("author postScore/replyScore on the profile derive from native content only");
    it.todo("firstCommentTimestamp is unaffected by cross-posts");
    it.todo("the number/postNumber counters are unaffected by cross-posts");
    it.todo("lastPostCid/lastCommentCid point at native content only");
    it.todo("statsCid counts native content only");
    it.todo("challenge excludes reading author scores see native-only values");
});

describe("native content uses the standard tables", () => {
    it.todo("an owner native post is an ordinary comments row with the anchor as communityPublicKey");
    it.todo("a foreign reply to a native post is an ordinary comments row with normal parent linkage");
    it.todo("native CommentUpdates are generated and signed by the running node like any community");
});

// AGENTS.md: bumping DB_VERSION requires a migration test that builds the old schema, inserts
// representative rows, migrates via createOrMigrateTablesIfNeeded(), and asserts the result.
describe("DB_VERSION migration for the cross-post table", () => {
    it.todo("bumps DB_VERSION when the cross-post table is added");
    it.todo("migrates an existing community DB with no cross-post table without data loss");
    it.todo("creates the cross-post table on migration and leaves comments/commentUpdates untouched");
    it.todo("migrating twice is a no-op");
});

// The cross-post table is part of the shared schema and is created in every community DB, empty for
// normal communities. Making it conditional on type would let one DB_VERSION describe two different
// databases and force every later migration to branch.
describe("one shared schema, type-blind lifecycle", () => {
    it.todo("createOrMigrateTablesIfNeeded creates the cross-post table for a normal community too");
    it.todo("the table stays empty for a normal community and nothing reads it");
    it.todo("one DB_VERSION describes one schema regardless of type");
    it.todo("author-communities use the same per-community sqlite DB path layout");
    it.todo("cross-post queries live alongside the shared handler rather than in a forked db-handler");
    it.todo("exportCommunity exports native content and cross-posts in one sqlite backup");
    it.todo("deleteCommunity removes the author-community DB including its cross-post table");
});
