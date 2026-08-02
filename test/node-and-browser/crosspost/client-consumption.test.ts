// Test foundations for crossposts (issue #32).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: what a client may and may not conclude from a crosspost, and how it gets the rest.
//
// pkc-js ships tier 1 only. There is no tier-2 helper and none is needed: a client that wants the
// referenced comment's live state builds an instance from the embedded record and updates it —
//
//   const original = await pkc.createComment({ cid: comment.crosspost.cid, raw: { comment: comment.crosspost.comment } });
//   await original.update();
//
// which loads the CommentUpdate from the community named in the embedded record and verifies its
// signature through the existing path. Because cid is inside CommentUpdateSignedPropertyNames and
// the CID hashes the entire record, a valid update is that community attesting to exactly these
// bytes, unsigned extras included.
import { describe, it } from "vitest";

describe("crosspost is exposed on the Comment instance", () => {
    it.todo("comment.crosspost is set from CommentIpfs");
    it.todo("comment.crosspost is set from a comment inside a page");
    it.todo("comment.crosspost is set on the instance before publishing (deferred signing)");
    it.todo("comment.raw.comment.crosspost matches comment.crosspost");
    it.todo("comment.crosspost is undefined on a comment that is not a crosspost");
    it.todo("crosspost survives toJSON / createComment round-tripping");
});

describe("building an instance for the referenced comment", () => {
    it.todo("createComment({ cid: crosspost.cid, raw: { comment: crosspost.comment } }) returns a usable instance");
    it.todo("the instance's community is the one named in the embedded record, not the crossposting community");
    it.todo("calling update() on it loads the referenced comment's CommentUpdate");
    it.todo("the loaded CommentUpdate's signature is verified against the referenced community");
    it.todo("a CommentUpdate signed by the wrong community is rejected");
    it.todo("a CommentUpdate whose cid does not match crosspost.cid is rejected");
    it.todo("update() failing (community offline) does not invalidate the crosspost itself");
});

// Everything below is unsigned by the author and therefore attacker-chosen until the referenced
// community's CommentUpdate is loaded and verified. Whoever builds the crosspost picks both the
// bytes and the cid, so the tier-1 cid check does not constrain these.
describe("what tier 1 does NOT establish", () => {
    it.todo("thumbnailUrl/thumbnailUrlWidth/thumbnailUrlHeight on the embedded record are attacker-chosen at tier 1");
    it.todo("depth on the embedded record is attacker-chosen at tier 1");
    it.todo("previousCid on the embedded record is attacker-chosen at tier 1");
    it.todo("pseudonymityMode on the embedded record is attacker-chosen at tier 1");
    it.todo("'crossposted from C' is an author claim at tier 1, not a fact");
    it.todo("the referenced community accepting the comment is not established at tier 1");
    it.todo("karma and removal/deletion state are unavailable at tier 1 by definition");
});

// crosspost and quotedCids are both author-signed references and are not interchangeable.
//   quotedCids: 'my text refers to these comments' — zero or many, inline, no embedding.
//   crosspost:  'this post IS a repost of that comment' — exactly one, embedded, the post's identity.
describe("crosspost vs quotedCids", () => {
    it.todo("a comment can carry both crosspost and quotedCids");
    it.todo("quotedCids does not embed anything and stays reference-only");
    it.todo("crosspost is a single object, not an array");
    it.todo("quotedCids validation (same-thread, exists, not pending) does not apply to crosspost.cid");
});
