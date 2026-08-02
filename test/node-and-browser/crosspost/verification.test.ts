// Test foundations for crossposts (issue #32).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: tier-1 verification of the embedded record — local, no network.
//
// Tier 1 proves who wrote the embedded content and that they *claim* it was posted to
// crosspost.comment's community. It proves nothing about the fields the hosting community added
// and the author never signed (depth, thumbnailUrl*, previousCid, pseudonymityMode), and nothing
// about that community having accepted the comment at all.
//
//   1. CID(deterministicStringify(crosspost.comment)) === crosspost.cid
//   2. the embedded record's author signature verifies
//   3. the embedded record carries no reserved/runtime fields
//
// Placed on verifyCommentPubsubMessage rather than verifyCommentIpfs, so the one call site covers
// both the community's acceptance path and every client fetch path (verifyCommentIpfs delegates).
import { describe, it } from "vitest";

describe("tier 1 check 1: cid matches the embedded bytes", () => {
    it.todo("a crosspost whose cid is the hash of crosspost.comment verifies");
    it.todo("a crosspost whose cid points at different bytes is rejected");
    it.todo("mutating any field of crosspost.comment without updating cid is rejected");
    it.todo("mutating cid without changing crosspost.comment is rejected");
    it.todo("an embedded record with extra props hashes with those props included");
    it.todo("the rejection reason is the crosspost cid-mismatch message, not a generic signature error");
});

describe("tier 1 check 2: the embedded record's author signature", () => {
    it.todo("a valid embedded record verifies");
    it.todo("an embedded record with a tampered content field is rejected");
    it.todo("an embedded record signed by a different key than it claims is rejected");
    it.todo("an embedded record whose signedPropertyNames omit a present field is rejected");
    it.todo("the embedded record's author signature is verified independently of the outer comment's");
    it.todo("a valid embedded record inside an outer comment with a broken signature is still rejected overall");
});

describe("tier 1 check 3: no reserved fields on the embedded record", () => {
    it.todo("an embedded record with a CommentIpfsReservedFields key is rejected");
    it.todo("an embedded record with a reserved author field (e.g. nameResolved) is rejected");
    it.todo("an embedded record with legitimate CommentIpfs fields (depth, previousCid) is accepted");
});

// The embedded record belongs to a different community by construction. verifyCommentIpfs compares
// the record's community against the instance's; that comparison must not be applied to the
// embedded record or every crosspost from another community fails.
describe("the embedded record is not checked against the host community", () => {
    it.todo("communityNameFromInstance is not propagated into the embedded record's verification");
    it.todo("a crosspost of a comment from a different community verifies");
    it.todo("a crosspost of a comment from a community with a rotated key verifies");
    it.todo("crossposting a comment from the host community itself is allowed (not treated as a mismatch)");
});

describe("chains verify recursively", () => {
    it.todo("a two-level chain verifies at every level");
    it.todo("a broken signature at the innermost level fails the whole outer comment");
    it.todo("a cid mismatch at an intermediate level fails the whole outer comment");
    it.todo("no depth cap is enforced during verification");
});

// The tier-1 result is what the community enforces at acceptance. It never fetches the referenced
// community, so accepting a publication does not depend on a third party's uptime.
describe("verification does no network I/O", () => {
    it.todo("tier-1 verification of a crosspost makes no gateway or IPFS request");
    it.todo("a crosspost referencing a community that is offline still verifies at tier 1");
    it.todo("a crosspost referencing a cid that no longer exists anywhere still verifies at tier 1");
});
