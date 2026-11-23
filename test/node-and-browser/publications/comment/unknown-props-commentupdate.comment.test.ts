// The CommentUpdate path (_initCommentUpdate) copies unknown props the same way, but the props here are
// chosen by the COMMUNITY, not by the comment's author: a hostile or compromised community can break every
// reader that loads one of its comments, including comments it did not receive from the attacker.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mockRemotePKC, generateMockPost } from "../../../../dist/node/test/test-util.js";
import { stopOutcome, HOSTILE_VALUE, hostileNamesFor, recordWith, valueFor, objectPrototypeIsClean } from "../../../helpers/hostile-props.js";
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

describe("CommentUpdate unknown props that collide with a member of the Comment instance", () => {
    let pkc: PKC;
    let record: CommentIpfsType;
    let hostileNames: string[];
    beforeAll(async () => {
        ({ pkc, record } = await setup());
        hostileNames = hostileNamesFor({ instance: await pkc.createComment({ cid: CID }), knownKeys: [...Object.keys(validCommentUpdateFixture), ...Object.keys(CommentUpdateSchema.shape)] });
    });
    afterAll(async () => {
        await pkc.destroy();
    });

    it("_initCommentUpdate leaves every member of the instance alone", async () => {
        for (const name of hostileNames) {
            const comment = <Comment>await pkc.createComment({ cid: CID });
            comment._initIpfsProps(record);
            const prototypeBefore = Object.getPrototypeOf(comment);
            const memberBefore = asBag(comment)[name];
            try {
                comment._initCommentUpdate(<never>recordWith({ record: validCommentUpdateFixture, name, value: valueFor(name) }));
            } catch (e) {
                expect.soft((<Error>e).message, `[${name}] _initCommentUpdate threw`).toBe("did not throw");
                continue;
            }
            expect.soft(Object.getPrototypeOf(comment), `[${name}] prototype of the instance`).toBe(prototypeBefore);
            expect.soft(asBag(comment)[name], `[${name}] member must keep its value`).toBe(memberBefore);
            expect.soft(asBag(comment).polluted, `[${name}] polluted through the prototype`).toBeUndefined();
        }
        expect.soft(objectPrototypeIsClean(), "Object.prototype polluted").toBe(true);
    });

    it("a poisoned CommentUpdate leaves stop() working", async () => {
        for (const name of ["update", "stop", "_clientsManager"]) {
            const comment = <Comment>await pkc.createComment({ cid: CID });
            comment._initIpfsProps(record);
            comment._initCommentUpdate(<never>recordWith({ record: validCommentUpdateFixture, name }));
            expect.soft(typeof comment.update, `[${name}] update`).toBe("function");
            expect.soft(await stopOutcome(comment), `[${name}] stop() must not throw`).toBeUndefined();
        }
    });
});
