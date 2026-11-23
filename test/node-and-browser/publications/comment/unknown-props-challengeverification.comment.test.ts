// The publisher's own instance copies unknown props from the decrypted challenge verification: the
// `comment` (through _initIpfsProps) and the `commentUpdate` the community sends back. A community the
// author publishes to can therefore break the author's own instance at the moment the publish succeeds,
// which the report saw as an uncaught throw from the publish teardown.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mockRemotePKC, generateMockPost } from "../../../../dist/node/test/test-util.js";
import { HOSTILE_VALUE, hostileNamesFor, recordWith, valueFor, objectPrototypeIsClean } from "../../../helpers/hostile-props.js";
import validCommentUpdateFixture from "../../../fixtures/signatures/comment/commentUpdate/valid_comment_update.json" with { type: "json" };
import { CommentIpfsSchema, CommentUpdateSchema, CommentUpdateForChallengeVerificationSchema } from "../../../../dist/node/publications/comment/schema.js";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsType } from "../../../../dist/node/publications/comment/types.js";

const CID = "QmeaD98zCjbs3h9GSCMixCGxMSJC3vUgW2i9pZoJpwkN7u";
const COMMUNITY = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";
type Bag = Record<string, unknown>;
const asBag = (x: object): Bag => <Bag>(<unknown>x);

async function setup(): Promise<{ pkc: PKC; record: CommentIpfsType }> {
    const pkc = await mockRemotePKC();
    const post = await generateMockPost({ communityAddress: COMMUNITY, pkc });
    if (!post.raw.pubsubMessageToPublish) {
        await post._initCommunity();
        await post._signPublicationWithCommunityFields();
    }
    return { pkc, record: <CommentIpfsType>structuredClone(post.raw.pubsubMessageToPublish) };
}

type Verification = { _updateCommentPropsFromDecryptedChallengeVerification(v: unknown): Promise<void> };

describe("challenge-verification unknown props that collide with a member of the Comment instance", () => {
    let pkc: PKC;
    let record: CommentIpfsType;
    let hostileNames: string[];
    beforeAll(async () => {
        ({ pkc, record } = await setup());
        hostileNames = hostileNamesFor({
            instance: await pkc.createComment({ cid: CID }),
            knownKeys: [
                ...Object.keys(CommentUpdateForChallengeVerificationSchema.shape),
                ...Object.keys(CommentIpfsSchema.shape),
                ...Object.keys(record)
            ]
        });
    });
    afterAll(async () => {
        await pkc.destroy();
    });

    const commentUpdateWith = (name: string) =>
        recordWith({
            record: { cid: CID, protocolVersion: record.protocolVersion, signature: record.signature },
            name,
            value: valueFor(name)
        });

    it("the commentUpdate sent by the community leaves every member of the instance alone", async () => {
        for (const name of hostileNames) {
            const comment = <Comment>await pkc.createComment({ cid: CID });
            const prototypeBefore = Object.getPrototypeOf(comment);
            const memberBefore = asBag(comment)[name];
            try {
                await (<Verification>(<unknown>comment))._updateCommentPropsFromDecryptedChallengeVerification({
                    comment: record,
                    commentUpdate: commentUpdateWith(name)
                });
            } catch (e) {
                expect.soft((<Error>e).message, `[${name}] verification handling threw`).toBe("did not throw");
                continue;
            }
            expect.soft(Object.getPrototypeOf(comment), `[${name}] prototype of the instance`).toBe(prototypeBefore);
            expect.soft(asBag(comment)[name], `[${name}] member must keep its value`).toBe(memberBefore);
            expect.soft(asBag(comment).polluted, `[${name}] polluted through the prototype`).toBeUndefined();
        }
        expect.soft(objectPrototypeIsClean(), "Object.prototype polluted").toBe(true);
    });

    it("the comment echoed back (the author's own poisoned record) leaves every member alone", async () => {
        for (const name of hostileNames) {
            const comment = <Comment>await pkc.createComment({ cid: CID });
            const memberBefore = asBag(comment)[name];
            try {
                await (<Verification>(<unknown>comment))._updateCommentPropsFromDecryptedChallengeVerification({
                    comment: recordWith({ record, name, value: valueFor(name) }),
                    commentUpdate: commentUpdateWith("noCollision")
                });
            } catch (e) {
                expect.soft((<Error>e).message, `[${name}] verification handling threw`).toBe("did not throw");
                continue;
            }
            expect.soft(asBag(comment)[name], `[${name}] member must keep its value`).toBe(memberBefore);
        }
    });
});
