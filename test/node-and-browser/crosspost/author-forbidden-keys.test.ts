// A key inside an `author` object that is named like a member of an object (toString, constructor, __proto__, ...)
// or starts with an underscore makes the record invalid. unknown-props-schema-gate covers the top-level author of
// a comment; this file covers the places the same author object travels: every level of an embedded crosspost
// chain, and the author of every other publication type. Each case is reached the way a hostile author reaches it:
// a record signed verbatim with the key inside, so the signature is valid and only the key can fail it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { mockRemotePKC, generateMockPost } from "../../../dist/node/test/test-util.js";
import { verifyCommentPubsubMessage, verifyVote } from "../../../dist/node/signer/signatures.js";
import { parseCommentIpfsSchemaWithPKCErrorIfItFails } from "../../../dist/node/schema/schema-util.js";
import { cloneCrosspostForRuntime } from "../../../dist/node/publications/comment/crosspost-runtime.js";
import { messages } from "../../../dist/node/errors.js";
import { resignVerbatim } from "../../helpers/resign-verbatim.js";
import type { WirePublication } from "../../helpers/resign-verbatim.js";
import { HOSTILE_VALUE, objectPrototypeIsClean } from "../../helpers/hostile-props.js";
import validCommentFixture from "../../fixtures/signatures/comment/commentUpdate/valid_comment_ipfs.json" with { type: "json" };
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { CommentPubsubMessagePublication } from "../../../dist/node/publications/comment/types.js";
import Logger from "@pkcprotocol/pkc-logger";

const testLog = Logger({ namespace: "pkc-js:test:author-forbidden-keys" });

const COMMUNITY = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";
const NAMES = ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__", "_private"];
type Bag = Record<string, unknown>;

// A computed key through a JSON round trip makes "__proto__" an own property, as a wire record has it
const withAuthorKey = (record: object, name: string): Bag => {
    const author = <Bag>(<Bag>record).author;
    return <Bag>(
        JSON.parse(JSON.stringify({ ...record, author: { ...author, [name]: name === "__proto__" ? { polluted: true } : HOSTILE_VALUE } }))
    );
};

describe("forbidden author keys in crossposts and in every publication type", () => {
    let pkc: PKC;

    const signedPost = async (props?: {
        crosspost?: unknown;
        authorKey?: string;
    }): Promise<{ comment: Comment; wire: CommentPubsubMessagePublication }> => {
        const comment = <Comment>await generateMockPost({
            communityAddress: COMMUNITY,
            pkc,
            postProps: undefined
        });
        if (!comment.raw.pubsubMessageToPublish) {
            await comment._initCommunity();
            await comment._signPublicationWithCommunityFields();
        }
        let wire = <Bag>structuredClone(comment.raw.pubsubMessageToPublish!);
        // the crosspost and the author key go in verbatim and the record is re-signed: createComment would normalize
        // an embedded record and drop an own "__proto__" key before it is signed
        if (props?.crosspost) wire = <Bag>JSON.parse(JSON.stringify({ ...wire, crosspost: props.crosspost }));
        if (props?.authorKey) wire = withAuthorKey(wire, props.authorKey);
        if (props?.crosspost || props?.authorKey) await resignVerbatim(<WirePublication>(<unknown>wire), comment.signer!);
        return { comment, wire: <CommentPubsubMessagePublication>(<unknown>wire) };
    };

    // The record an outer comment embeds: { cid, comment } with cid the hash of the embedded bytes
    const embedded = async (wire: CommentPubsubMessagePublication) => {
        const comment = <Bag>JSON.parse(JSON.stringify({ ...wire, depth: 0 }));
        return { cid: await calculateIpfsHash(deterministicStringify(comment)!), comment };
    };

    const verify = (comment: CommentPubsubMessagePublication) =>
        verifyCommentPubsubMessage({ comment, resolveAuthorNames: false, clientsManager: pkcClientsManager() });
    let clientsManagerHolder: Comment["_clientsManager"];
    const pkcClientsManager = () => clientsManagerHolder;

    beforeAll(async () => {
        pkc = await mockRemotePKC();
        clientsManagerHolder = (await signedPost()).comment._clientsManager;
    });
    afterAll(async () => {
        await pkc.destroy();
    });

    it("control: a crosspost whose embedded author carries a benign extra key verifies", async () => {
        const inner = await signedPost({ authorKey: "extraProp" });
        const outer = await signedPost({ crosspost: await embedded(inner.wire) });
        expect(await verify(outer.wire)).toEqual({ valid: true });
    });

    it("control: a benign extra key two levels down verifies, so the level 2 rejections are about the key", async () => {
        const deepest = await signedPost({ authorKey: "extraProp" });
        const middle = await signedPost({ crosspost: await embedded(deepest.wire) });
        const outer = await signedPost({ crosspost: await embedded(middle.wire) });
        expect(await verify(outer.wire)).toEqual({ valid: true });
    });

    it("control: the CommentIpfs parser accepts a crosspost whose embedded author carries a benign extra key", async () => {
        const inner = await signedPost({ authorKey: "extraProp" });
        const record = { ...validCommentFixture, crosspost: await embedded(inner.wire) };
        expect(() => parseCommentIpfsSchemaWithPKCErrorIfItFails(<never>record)).not.toThrow();
    });

    for (const name of NAMES) {
        it(`level 1: an embedded author with ${name} is rejected by verification`, async () => {
            const inner = await signedPost({ authorKey: name });
            // the embedded record is genuinely signed: only the key can be what fails
            expect(await verify(inner.wire)).toMatchObject({ valid: false });
            const outer = await signedPost({ crosspost: await embedded(inner.wire) });
            expect(await verify(outer.wire)).toEqual({
                valid: false,
                reason: messages.ERR_CROSSPOST_COMMENT_AUTHOR_INCLUDES_FORBIDDEN_KEY
            });
        });

        it(`level 2: an author with ${name} two levels down is rejected by verification`, async () => {
            const deepest = await signedPost({ authorKey: name });
            const middle = await signedPost({ crosspost: await embedded(deepest.wire) });
            const outer = await signedPost({ crosspost: await embedded(middle.wire) });
            const res = await verify(outer.wire);
            // a nested level reports through the crosspost signature check of the level above it, by existing design
            expect(res.valid).toBe(false);
            expect([
                messages.ERR_CROSSPOST_COMMENT_AUTHOR_INCLUDES_FORBIDDEN_KEY,
                messages.ERR_CROSSPOST_COMMENT_SIGNATURE_IS_INVALID
            ]).toContain((<{ reason: string }>res).reason);
        });

        it(`the CommentIpfs parser rejects a hostile ${name} at level 1 and at level 2`, async () => {
            const hostile = await signedPost({ authorKey: name });
            const level1 = { ...validCommentFixture, crosspost: await embedded(hostile.wire) };
            expect(() => parseCommentIpfsSchemaWithPKCErrorIfItFails(<never>level1)).toThrow(/named like a member/i);
            const middle = await signedPost({ crosspost: await embedded(hostile.wire) });
            const level2 = { ...validCommentFixture, crosspost: await embedded(middle.wire) };
            expect(() => parseCommentIpfsSchemaWithPKCErrorIfItFails(<never>level2)).toThrow(/named like a member/i);
        });

        it(`the runtime copy of a crosspost chain does not take ${name} as a member of the author`, () => {
            const hostile = withAuthorKey(validCommentFixture, name);
            const chain = { cid: "a", comment: { ...hostile, crosspost: { cid: "b", comment: withAuthorKey(validCommentFixture, name) } } };
            const copy = cloneCrosspostForRuntime(<never>chain, testLog);
            for (const level of [copy, copy.comment.crosspost!]) {
                const author = <Bag>(<unknown>level.comment.author);
                expect(author[name] === HOSTILE_VALUE, `${name} became a member of the copied author`).toBe(false);
                expect(Object.getPrototypeOf(author)).toBe(Object.prototype);
                expect(author.polluted).toBeUndefined();
            }
            expect(objectPrototypeIsClean()).toBe(true);
        });

        it(`a top-level comment author with ${name} is rejected by verifyCommentPubsubMessage`, async () => {
            const post = await signedPost({ authorKey: name });
            expect(await verify(post.wire)).toEqual({ valid: false, reason: messages.ERR_PUBLICATION_AUTHOR_INCLUDES_FORBIDDEN_KEY });
        });

        it(`a vote whose author has ${name} is rejected by verifyVote`, async () => {
            const vote = await pkc.createVote({
                author: { displayName: "voter" },
                signer: await pkc.createSigner(),
                commentCid: "QmeaD98zCjbs3h9GSCMixCGxMSJC3vUgW2i9pZoJpwkN7u",
                vote: 1,
                communityAddress: COMMUNITY
            });
            if (!vote.raw.pubsubMessageToPublish) {
                await vote._initCommunity();
                await vote._signPublicationWithCommunityFields();
            }
            const wire = withAuthorKey(structuredClone(vote.raw.pubsubMessageToPublish!), name);
            await resignVerbatim(<WirePublication>(<unknown>wire), vote.signer!);
            const res = await verifyVote({ vote: <never>wire, resolveAuthorNames: false, clientsManager: pkcClientsManager() });
            expect(res).toEqual({ valid: false, reason: messages.ERR_PUBLICATION_AUTHOR_INCLUDES_FORBIDDEN_KEY });
        });
    }
});
