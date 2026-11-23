// A record whose top-level keys would replace a member of an instance is invalid: a key named like an object member
// (`toString`, `constructor`, `__proto__`) or starting with `_` is refused by the forbidden-key rule, and a key that
// is a member of a Comment (`update`, `stop`, `emit`, ...) is refused through the reserved-field lists. A
// community refuses it at acceptance and every reader refuses it at the gate. The benign unknown prop (a newer protocol
// field) stays valid. The members of a live Comment are compared with the reserved list, so a method added to Comment
// without being reserved fails here.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mockRemotePKC, generateMockPost } from "../../dist/node/test/test-util.js";
import {
    signCommentUpdate,
    verifyCommentUpdate,
    verifyCommentIpfs,
    verifyCommentPubsubMessage
} from "../../dist/node/signer/signatures.js";
import {
    parseCommentIpfsSchemaWithPKCErrorIfItFails,
    parseCommentUpdateSchemaWithPKCErrorIfItFails
} from "../../dist/node/schema/schema-util.js";
import {
    CommentPubsubMessageReservedFields,
    CommentIpfsReservedFields,
    CommentUpdateReservedFields,
    CommentIpfsSchema,
    CommentUpdateSchema,
    CommentPubsubMessagePublicationSchema
} from "../../dist/node/publications/comment/schema.js";
import { messages } from "../../dist/node/errors.js";
import { resignVerbatim } from "../helpers/resign-verbatim.js";
import type { WirePublication } from "../helpers/resign-verbatim.js";
import { memberNamesOf, HOSTILE_VALUE } from "../helpers/hostile-props.js";
import signers from "../fixtures/signers.js";
import validCommentFixture from "../fixtures/signatures/comment/commentUpdate/valid_comment_ipfs.json" with { type: "json" };
import validCommentUpdateFixture from "../fixtures/signatures/comment/commentUpdate/valid_comment_update.json" with { type: "json" };
import type { PKC } from "../../dist/node/pkc/pkc.js";
import type { Comment } from "../../dist/node/publications/comment/comment.js";
import type { CommentUpdateType, CommentPubsubMessagePublication, CommentIpfsType } from "../../dist/node/publications/comment/types.js";

const COMMUNITY = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";
type Bag = Record<string, unknown>;
const FORBIDDEN = ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__", "_private", "_clientsManager"];
const MEMBERS = ["update", "stop", "publish", "emit", "on", "once", "off", "listeners", "getType", "setCid"];

// a computed key through a JSON round trip makes "__proto__" an own property, as a wire record has it
const withKey = (record: object, name: string): Bag =>
    <Bag>JSON.parse(JSON.stringify({ ...record, [name]: name === "__proto__" ? { polluted: true } : HOSTILE_VALUE }));

describe("the members of a Comment are reserved", () => {
    let pkc: PKC;
    beforeAll(async () => {
        pkc = await mockRemotePKC();
    });
    afterAll(async () => {
        await pkc.destroy();
    });

    it("every public member of a live Comment is reserved or a field of a record", async () => {
        const comment = await pkc.createComment({ cid: "QmeaD98zCjbs3h9GSCMixCGxMSJC3vUgW2i9pZoJpwkN7u" });
        const recordFields = new Set<string>([
            ...Object.keys(CommentIpfsSchema.shape),
            ...Object.keys(CommentUpdateSchema.shape),
            ...Object.keys(CommentPubsubMessagePublicationSchema.shape)
        ]);
        const reserved = new Set<string>(CommentPubsubMessageReservedFields);
        const unprotected = memberNamesOf(comment).filter(
            (name) => !name.startsWith("_") && !(name in Object.prototype) && !reserved.has(name) && !recordFields.has(name)
        );
        expect(unprotected, "members of a Comment that a record could still name: add them to additionalCommentReservedFields").toEqual([]);
    });

    it("the list reaches CommentIpfs and CommentUpdate", () => {
        for (const name of MEMBERS) {
            expect(CommentIpfsReservedFields as readonly string[], `${name} in CommentIpfsReservedFields`).toContain(name);
            expect(CommentUpdateReservedFields as readonly string[], `${name} in CommentUpdateReservedFields`).toContain(name);
        }
    });
});

describe("top-level forbidden and member keys, through the gates", () => {
    let pkc: PKC;
    let clientsManager: Comment["_clientsManager"];
    let post: Comment;
    let wire: Bag;

    const resigned = async (name: string): Promise<CommentPubsubMessagePublication> => {
        const record = withKey(wire, name);
        await resignVerbatim(<WirePublication>(<unknown>record), post.signer!);
        return <CommentPubsubMessagePublication>(<unknown>record);
    };

    beforeAll(async () => {
        pkc = await mockRemotePKC();
        post = <Comment>await generateMockPost({ communityAddress: COMMUNITY, pkc });
        if (!post.raw.pubsubMessageToPublish) {
            await post._initCommunity();
            await post._signPublicationWithCommunityFields();
        }
        wire = <Bag>structuredClone(post.raw.pubsubMessageToPublish!);
        clientsManager = post._clientsManager;
    });
    afterAll(async () => {
        await pkc.destroy();
    });

    it("control: a benign unknown prop verifies and parses", async () => {
        const record = await resigned("extraProp");
        expect(await verifyCommentPubsubMessage({ comment: record, resolveAuthorNames: false, clientsManager })).toEqual({ valid: true });
        expect(() => parseCommentIpfsSchemaWithPKCErrorIfItFails(<never>withKey(validCommentFixture, "extraProp"))).not.toThrow();
        expect(() => parseCommentUpdateSchemaWithPKCErrorIfItFails(<never>withKey(validCommentUpdateFixture, "extraProp"))).not.toThrow();
    });

    for (const name of FORBIDDEN) {
        it(`${name}: verifyCommentPubsubMessage refuses a signed comment that carries it`, async () => {
            const res = await verifyCommentPubsubMessage({ comment: await resigned(name), resolveAuthorNames: false, clientsManager });
            expect(res.valid).toBe(false);
            if (name !== "__proto__") expect(res).toEqual({ valid: false, reason: messages.ERR_PUBLICATION_INCLUDES_FORBIDDEN_KEY });
        });

        it(`${name}: both parsers refuse it`, () => {
            expect(() => parseCommentIpfsSchemaWithPKCErrorIfItFails(<never>withKey(validCommentFixture, name))).toThrow(
                /named like a member/i
            );
            expect(() => parseCommentUpdateSchemaWithPKCErrorIfItFails(<never>withKey(validCommentUpdateFixture, name))).toThrow(
                /named like a member/i
            );
        });

        it(`${name}: verifyCommentUpdate refuses a community-signed update that carries it`, async () => {
            const signer = signers[0];
            const community = { address: signer.address, signature: { publicKey: signer.publicKey }, pubsubTopic: signer.address };
            const update = <CommentUpdateType>(<unknown>withKey(validCommentUpdateFixture, name));
            update.signature = await signCommentUpdate({ update, signer });
            const res = await verifyCommentUpdate({
                update,
                resolveAuthorNames: false,
                clientsManager,
                community: <never>community,
                comment: { cid: update.cid, postCid: <string>(<unknown>undefined), depth: 0, signature: validCommentFixture.signature },
                validatePages: false,
                validateUpdateSignature: true
            });
            expect(res.valid).toBe(false);
        });
    }

    for (const name of MEMBERS) {
        it(`${name}: a member of a Comment is refused as a key of a CommentIpfs and of a CommentUpdate`, async () => {
            const ipfs = <CommentIpfsType>(<unknown>withKey(validCommentFixture, name));
            const res = await verifyCommentIpfs({
                comment: ipfs,
                calculatedCommentCid: "QmeaD98zCjbs3h9GSCMixCGxMSJC3vUgW2i9pZoJpwkN7u",
                resolveAuthorNames: false,
                clientsManager
            });
            expect(res).toEqual({ valid: false, reason: messages.ERR_COMMENT_IPFS_RECORD_INCLUDES_RESERVED_FIELD });

            const signer = signers[0];
            const community = { address: signer.address, signature: { publicKey: signer.publicKey }, pubsubTopic: signer.address };
            const update = <CommentUpdateType>(<unknown>withKey(validCommentUpdateFixture, name));
            update.signature = await signCommentUpdate({ update, signer });
            const updateRes = await verifyCommentUpdate({
                update,
                resolveAuthorNames: false,
                clientsManager,
                community: <never>community,
                comment: { cid: update.cid, postCid: <string>(<unknown>undefined), depth: 0, signature: validCommentFixture.signature },
                validatePages: false,
                validateUpdateSignature: true
            });
            expect(updateRes).toEqual({ valid: false, reason: messages.ERR_COMMENT_UPDATE_RECORD_INCLUDES_RESERVED_FIELD });
        });
    }
});
