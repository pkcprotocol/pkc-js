// Test foundations for crossposts (issue #32).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: publishing a crosspost end to end. Mirrors quotedCids.test.ts, which is the closest
// existing precedent for an author-signed reference field added to CreateCommentOptions.
//
// The crossposting comment may be a post or a reply — unlike quotedCids, which is replies-only.
import { describe, it } from "vitest";

describe("publishing a crosspost", () => {
    it.todo("a post carrying a valid crosspost is accepted");
    it.todo("a reply carrying a valid crosspost is accepted");
    it.todo("crosspost is present on pubsubMessageToPublish after publishing");
    it.todo("crosspost is present in the resulting CommentIpfs");
    it.todo("crosspost fetched back from IPFS is byte-identical to what was published");
    it.todo("crosspost survives a community restart and is served from pages unchanged");
    it.todo("a crosspost of a comment from a different community is accepted");
    it.todo("a crosspost of a comment from this same community is accepted");
    it.todo("a comment whose only content is a crosspost (no title/content/link) — decide and pin the behavior");
});

describe("the community enforces tier 1 at acceptance", () => {
    it.todo("a crosspost with a cid that does not match the embedded bytes is rejected");
    it.todo("a crosspost whose embedded record has a broken author signature is rejected");
    it.todo("a crosspost whose embedded record carries a reserved field is rejected");
    it.todo("acceptance does not fetch the referenced community");
    it.todo("acceptance succeeds while the referenced community is offline");
    it.todo("the challenge failure reason is the specific crosspost message");
});

describe("chains", () => {
    it.todo("crossposting a crosspost is accepted");
    it.todo("a three-deep chain is accepted while under 40kb");
    it.todo("a chain that pushes the publication over 40kb is rejected with ERR_REQUEST_PUBLICATION_OVER_ALLOWED_SIZE");
    it.todo("the size limit is measured on the whole publication, so nesting eats the content budget");
});

// The outer comment is re-signed with an alias signer under pseudonymity; the embedded record is
// cloned untouched, so its own signature survives.
describe("crossposts under pseudonymityMode", () => {
    it.todo("a crosspost published to a community with pseudonymityMode is accepted");
    it.todo("the outer comment's signature is the alias signer's");
    it.todo("the embedded record's author and signature are unchanged by anonymization");
    it.todo("the embedded record still verifies at tier 1 after anonymization");
    it.todo("originalCommentSignatureEncoded is set on the outer comment only");
});

describe("moderating a crosspost as if it were a normal comment", () => {
    it.todo("a mod can remove a crossposting comment");
    it.todo("a mod can lock/pin/flag a crossposting comment");
    it.todo("an author can edit the crossposting comment's own content");
    it.todo("editing the crossposting comment does not alter the embedded record");
    it.todo("the crossposting comment can be voted on independently of the referenced comment");
    it.todo("removing the crossposting comment has no effect on the referenced comment");
});
