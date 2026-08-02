// Test foundations for crossposts (issue #32).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: community.features.noCrossposts, which is already reserved on CommunityFeaturesSchema
// and currently marked "Not implemented".
//
// noCrossposts is an INBOUND rule: it governs what this community accepts, not what other
// communities may do with this community's comments. It is enforced by the community at
// acceptance time, alongside the other feature toggles in checkCommentPublication.
import { describe, it } from "vitest";

describe("community.features.noCrossposts — default and propagation", () => {
    it.todo("features is undefined on a fresh community and crossposts are allowed");
    it.todo("noCrossposts is updated correctly in props after community.edit");
    it.todo("noCrossposts propagates to a remote community instance");
    it.todo("noCrossposts survives a community stop/start");
    it.todo("noCrossposts is no longer marked 'Not implemented' in CommunityFeaturesSchema");
    it.todo("setting noCrossposts: false is equivalent to leaving it unset");
});

describe("noCrossposts: true rejects crossposts", () => {
    it.todo("a post carrying a crosspost is rejected");
    it.todo("a reply carrying a crosspost is rejected");
    it.todo("a crosspost chain is rejected");
    it.todo("the rejection reason is the specific noCrossposts message");
    it.todo("the rejection happens even when the crosspost is otherwise fully valid at tier 1");
    it.todo("the rejection happens even when the crosspost references this same community");
    it.todo("the rejected comment is not written to the db");
    it.todo("the rejected comment's cid is not pinned/left behind in IPFS");
});

describe("noCrossposts: true still allows everything else", () => {
    it.todo("a plain post is accepted");
    it.todo("a plain reply is accepted");
    it.todo("a reply carrying quotedCids is accepted (quotedCids is not a crosspost)");
    it.todo("a post with a link is accepted");
    it.todo("votes, edits and moderations are unaffected");
});

describe("toggling noCrossposts", () => {
    it.todo("enabling it rejects a crosspost that was accepted moments before");
    it.todo("disabling it re-allows crossposts");
    it.todo("crossposts stored while it was off remain in the db after enabling it");
    it.todo("crossposts stored while it was off are still served in pages after enabling it");
    it.todo("crossposts stored while it was off can still be moderated, edited and voted on after enabling it");
    it.todo("enabling it does not purge or invalidate existing crossposts");
});

describe("enforcement is community-side, not client-side", () => {
    it.todo("a client holding a stale community record without noCrossposts is still rejected");
    it.todo("a hand-built publication that bypasses client-side checks is still rejected");
    it.todo("the rejection is delivered as a challenge failure, not a schema error");
});

describe("noCrossposts is inbound only", () => {
    it.todo("a community with noCrossposts can still have its own comments crossposted elsewhere");
    it.todo("a community without noCrossposts accepts a crosspost of a comment from a noCrossposts community");
});

describe("interaction with other features", () => {
    it.todo("noCrossposts combined with pseudonymityMode rejects before anonymization");
    it.todo("noCrossposts combined with requirePostLink reports the crosspost reason for a crossposting post");
    it.todo("noCrossposts combined with noNestedReplies rejects a nested crossposting reply for the crosspost reason");
    it.todo("a malformed crosspost is a schema error regardless of noCrossposts");
});
