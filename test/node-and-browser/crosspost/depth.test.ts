// Crosspost chain depth cap (issue #250). Pure unit tests: no community, no network.
//
// The 40kb publication limit bounds the publish path only. Every client path that ingests a
// CommentIpfs allows 1MB, and a deep chain is cheap to mint, so without a cap a record no community
// would ever accept still reaches zod's recursive parse, which overflows the stack at roughly 1000
// levels and throws a RangeError rather than a PKCError, at a depth that varies by engine.
//
// MAX_CROSSPOST_DEPTH is the hard cap every client enforces on every ingest path. What matters and is
// pinned below: the check runs *before* the recursive parse (a check after it would never be
// reached), and it rejects rather than truncating. See docs/protocol/crossposts.md.
import { describe, it, expect } from "vitest";
import {
    MAX_CROSSPOST_DEPTH,
    crosspostChainDepthUpTo,
    deepestCrosspostChainInPageUpTo,
    deepestCrosspostChainInCommentUpdateUpTo,
    effectiveMaxCrosspostDepth
} from "../../../dist/node/publications/comment/crosspost-depth.js";
import {
    parseCommentIpfsSchemaWithPKCErrorIfItFails,
    parseCommentUpdateSchemaWithPKCErrorIfItFails,
    parsePageIpfsSchemaWithPKCErrorIfItFails,
    parseModQueuePageIpfsSchemaWithPKCErrorIfItFails,
    parseCommentPubsubMessagePublicationWithPKCErrorIfItFails,
    parseCreateCommentOptionsSchemaWithPKCErrorIfItFails,
    parseRpcCommentEventWithPKCErrorIfItFails
} from "../../../dist/node/schema/schema-util.js";
import { PKCError } from "../../../dist/node/pkc-error.js";

const CID = "QmYjtig7VJQ6XsnUjqqJvj7QaMcCAwtrgNdahSiFofrE7o";

const sig = {
    type: "ed25519",
    signature: "aGVsbG8=",
    publicKey: "cHVibGlj",
    signedPropertyNames: ["content", "title", "author", "protocolVersion", "timestamp", "crosspost"]
};

const record = (extra: object = {}) => ({
    content: "a comment",
    signature: { ...sig },
    depth: 0,
    timestamp: 1700000000,
    protocolVersion: "1.0.0",
    communityPublicKey: "somePublicKey",
    ...extra
});

// A record whose crosspost chain is exactly `levels` embedded records deep.
const chainOfDepth = (levels: number) => {
    let comment: Record<string, unknown> = record();
    for (let i = 0; i < levels; i++) comment = record({ crosspost: { cid: CID, comment } });
    return comment;
};

const pageWith = (comment: object) => ({ comments: [{ comment, commentUpdate: { cid: CID } }] });

const expectRejectedForDepth = (fn: () => unknown) => {
    let thrown: unknown;
    try {
        fn();
    } catch (e) {
        thrown = e;
    }
    expect(thrown).to.be.instanceOf(PKCError);
    expect((thrown as PKCError).code).to.equal("ERR_CROSSPOST_CHAIN_EXCEEDS_MAX_DEPTH");
    expect((thrown as PKCError).details.maxCrosspostDepth).to.equal(MAX_CROSSPOST_DEPTH);
};

describe("crosspostChainDepthUpTo", () => {
    it("counts embedded records, not comment.depth", () => {
        expect(crosspostChainDepthUpTo(chainOfDepth(0))).to.equal(0);
        expect(crosspostChainDepthUpTo(chainOfDepth(1))).to.equal(1);
        expect(crosspostChainDepthUpTo(chainOfDepth(3))).to.equal(3);
    });

    it("stops counting at the cap rather than walking the whole chain", () => {
        // The point of stopping: an attacker-minted 100k-level chain must not cost 100k iterations
        // just to be refused. The returned number is therefore a bound, not the true depth.
        expect(crosspostChainDepthUpTo(chainOfDepth(50))).to.equal(MAX_CROSSPOST_DEPTH + 1);
    });

    it("tolerates raw unvalidated json, since it runs before any parse", () => {
        expect(crosspostChainDepthUpTo(undefined)).to.equal(0);
        expect(crosspostChainDepthUpTo({ crosspost: null })).to.equal(0);
        expect(crosspostChainDepthUpTo({ crosspost: "not an object" })).to.equal(0);
        expect(crosspostChainDepthUpTo({ crosspost: { cid: CID } })).to.equal(1); // no `comment` key at all
    });
});

describe("effectiveMaxCrosspostDepth", () => {
    it("defaults to the protocol cap when the community sets nothing", () => {
        expect(effectiveMaxCrosspostDepth(undefined)).to.equal(MAX_CROSSPOST_DEPTH);
    });

    it("lets a community tighten below the cap", () => {
        expect(effectiveMaxCrosspostDepth(1)).to.equal(1);
        expect(effectiveMaxCrosspostDepth(0)).to.equal(0);
    });

    it("clamps down, never up: a community cannot accept chains clients will not load", () => {
        expect(effectiveMaxCrosspostDepth(MAX_CROSSPOST_DEPTH + 1)).to.equal(MAX_CROSSPOST_DEPTH);
        expect(effectiveMaxCrosspostDepth(1000)).to.equal(MAX_CROSSPOST_DEPTH);
    });

    it("degrades a nonsense value to the cap instead of throwing", () => {
        // The schema deliberately does not bound this field, so a value from a future protocol
        // version reaches here rather than failing the whole community record.
        expect(effectiveMaxCrosspostDepth(-1)).to.equal(MAX_CROSSPOST_DEPTH);
        expect(effectiveMaxCrosspostDepth(2.5)).to.equal(MAX_CROSSPOST_DEPTH);
    });
});

describe("deepestCrosspostChainInPageUpTo", () => {
    it("finds the deepest chain across the comments of a page", () => {
        const page = { comments: [{ comment: chainOfDepth(1) }, { comment: chainOfDepth(4) }, { comment: chainOfDepth(2) }] };
        expect(deepestCrosspostChainInPageUpTo(page)).to.equal(4);
    });

    it("descends into the reply pages nested in a comment's CommentUpdate", () => {
        // A chain hiding in a nested reply page is ingested by the same 1MB fetch as the page itself,
        // so it has to be found there too rather than only at the top level.
        const page = {
            comments: [
                {
                    comment: chainOfDepth(1),
                    commentUpdate: { replies: { pages: { best: { comments: [{ comment: chainOfDepth(5) }] } } } }
                }
            ]
        };
        expect(deepestCrosspostChainInPageUpTo(page)).to.equal(5);
    });

    it("returns 0 for a page whose comments carry no crossposts", () => {
        expect(deepestCrosspostChainInPageUpTo(pageWith(record()))).to.equal(0);
    });
});

describe("deepestCrosspostChainInCommentUpdateUpTo", () => {
    it("finds a chain hiding in the reply pages a CommentUpdate carries", () => {
        // A CommentUpdate is fetched under the same 1MB cap as anything else, so this is an ingest
        // path in its own right rather than only a field of one.
        const commentUpdate = { replies: { pages: { best: { comments: [{ comment: chainOfDepth(6) }] } } } };
        expect(deepestCrosspostChainInCommentUpdateUpTo(commentUpdate)).to.equal(6);
    });

    it("returns 0 for a CommentUpdate with no reply pages", () => {
        expect(deepestCrosspostChainInCommentUpdateUpTo({ cid: CID })).to.equal(0);
    });
});

describe("the ingest paths reject an over-deep chain", () => {
    it("parseCommentIpfsSchemaWithPKCErrorIfItFails", () => {
        expectRejectedForDepth(() => parseCommentIpfsSchemaWithPKCErrorIfItFails(chainOfDepth(MAX_CROSSPOST_DEPTH + 1) as never));
    });

    it("parseCommentPubsubMessagePublicationWithPKCErrorIfItFails, which is the community's acceptance path", () => {
        expectRejectedForDepth(() =>
            parseCommentPubsubMessagePublicationWithPKCErrorIfItFails(chainOfDepth(MAX_CROSSPOST_DEPTH + 1) as never)
        );
    });

    it("parseCreateCommentOptionsSchemaWithPKCErrorIfItFails, so an author finds out before burning a challenge", () => {
        expectRejectedForDepth(() => parseCreateCommentOptionsSchemaWithPKCErrorIfItFails(chainOfDepth(MAX_CROSSPOST_DEPTH + 1) as never));
    });

    it("parsePageIpfsSchemaWithPKCErrorIfItFails", () => {
        expectRejectedForDepth(() => parsePageIpfsSchemaWithPKCErrorIfItFails(pageWith(chainOfDepth(MAX_CROSSPOST_DEPTH + 1)) as never));
    });

    it("parseModQueuePageIpfsSchemaWithPKCErrorIfItFails", () => {
        expectRejectedForDepth(() =>
            parseModQueuePageIpfsSchemaWithPKCErrorIfItFails(pageWith(chainOfDepth(MAX_CROSSPOST_DEPTH + 1)) as never)
        );
    });

    it("parseCommentUpdateSchemaWithPKCErrorIfItFails, for a chain nested in the reply pages", () => {
        expectRejectedForDepth(() =>
            parseCommentUpdateSchemaWithPKCErrorIfItFails({
                replies: { pages: { best: { comments: [{ comment: chainOfDepth(MAX_CROSSPOST_DEPTH + 1) }] } } }
            } as never)
        );
    });

    it("parseRpcCommentEventWithPKCErrorIfItFails, so an RPC client is not left to blow its own stack", () => {
        expectRejectedForDepth(() =>
            parseRpcCommentEventWithPKCErrorIfItFails({ comment: chainOfDepth(MAX_CROSSPOST_DEPTH + 1) } as never)
        );
    });

    it("rejects before the recursive parse, so a chain deep enough to overflow the stack is still a PKCError", () => {
        // The regression this exists for: safeParse converts a ZodError but lets a RangeError escape
        // as itself, so at ~1000 levels the stack overflow used to propagate raw out of
        // pkc.getComment, Comment.update() and page parsing. A depth check placed after the parse
        // would never run. 2000 levels is well past the overflow point on every engine we target.
        expectRejectedForDepth(() => parseCommentIpfsSchemaWithPKCErrorIfItFails(chainOfDepth(2000) as never));
    });
});
