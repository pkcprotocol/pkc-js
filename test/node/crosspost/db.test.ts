// Test foundations for crossposts (issue #32).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: persistence of the crosspost field on the community side.
//
// crosspost is stored as a single JSON column on the comments table so the embedded record
// round-trips verbatim. Reads need no special handling — parseDbResponses parses JSON columns
// generically and deriveCommentIpfsFromCommentTableRow picks by keys(CommentIpfsSchema.shape).
import { describe, it } from "vitest";

describe("crosspost column on the comments table", () => {
    it.todo("the column exists after createOrMigrateTablesIfNeeded");
    it.todo("a comment without a crosspost stores NULL");
    it.todo("a crossposting comment stores the full crosspost object as JSON");
    it.todo("dbHandler.queryComment returns crosspost as an object, not a string");
    it.todo("the returned crosspost.comment is deep-equal to what was published");
    it.todo("a crosspost chain round-trips through the column intact");
    it.todo("an embedded record with extra props round-trips with those props intact");
});

// This is the regression guard for the nested-strip footgun. storePublication runs
// CommentIpfsSchema.strip().parse() before building the row; zod's strip behavior is per-schema,
// so a nested crosspost.comment left at the default would have its unknown props silently deleted.
// The row is what deriveCommentIpfsFromCommentTableRow reconstructs the CID from during page
// generation, so any loss here changes the CID, breaks pages, and gets the comment purged by
// _purgeCommentsWithInvalidSchemaOrSignature.
describe("CID stability through the db round trip", () => {
    it.todo("deriveCommentIpfsFromCommentTableRow reproduces the original CID for a crossposting comment");
    it.todo("the reconstructed CommentIpfs is byte-identical to the one that was hashed");
    it.todo("an embedded record with extra props still reproduces the original CID");
    it.todo("a chained crosspost still reproduces the original CID");
    it.todo("strip() on the outer comment does not remove props inside crosspost.comment");
    it.todo("_purgeCommentsWithInvalidSchemaOrSignature does not purge a valid crossposting comment");
    it.todo("page generation emits the crossposting comment with its crosspost intact");
});

describe("DB migration", () => {
    it.todo("an old-schema db migrates and gains the crosspost column");
    it.todo("existing comments migrate with crosspost NULL");
    it.todo("migrated comments still reproduce their original CIDs");
    it.todo("migrated comments are not purged by the post-migration signature sweep");
    it.todo("a crossposting comment inserted before migration survives it intact");
});

describe("crosspost under pseudonymityMode in the db", () => {
    it.todo("the stored outer comment carries the alias signature");
    it.todo("the stored crosspost.comment carries the original author's signature");
    it.todo("originalCommentSignatureEncoded is set for the outer comment only");
    it.todo("the anonymized row still reproduces its CID");
});
