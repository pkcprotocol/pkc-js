// An unknown prop on a loaded record (one signed by the author, or one the community adds to a
// CommentUpdate) is copied onto the Comment instance so a newer protocol field is readable before this
// client knows about it. The copy was a bare Object.assign, so a prop named like a member of the instance
// (a method such as `update`, a private field such as `_clientsManager`, or `__proto__`) replaced that
// member on every reader that loaded the comment. This file covers the author-signed CommentIpfs path
// (_initIpfsProps); sibling files cover the CommentUpdate, challenge-verification, author and
// other-record paths. One file per vector because the runner forces --bail 1; the cases inside a file
// are soft assertions so one run reports every colliding name.
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

describe("CommentIpfs unknown props that collide with a member of the Comment instance", () => {
    let pkc: PKC;
    let record: CommentIpfsType;
    let hostileNames: string[];

    beforeAll(async () => {
        ({ pkc, record } = await setup());
        hostileNames = hostileNamesFor({ instance: await pkc.createComment({ cid: CID }), knownKeys: [...Object.keys(record), ...Object.keys(CommentIpfsSchema.shape)] });
    });
    afterAll(async () => {
        await pkc.destroy();
    });

    it("the table covers the instance (guards against it silently going empty)", () => {
        expect(hostileNames.length).toBeGreaterThan(20);
        for (const name of ["update", "stop", "_clientsManager", "__proto__"]) expect(hostileNames).toContain(name);
    });

    it("_initIpfsProps leaves every member of the instance alone, whatever the record calls its unknown props", async () => {
        const objectPrototypeKeysBefore = Reflect.ownKeys(Object.prototype).length;
        for (const name of hostileNames) {
            const comment = <Comment>await pkc.createComment({ cid: CID });
            const prototypeBefore = Object.getPrototypeOf(comment);
            const memberBefore = asBag(comment)[name];
            try {
                comment._initIpfsProps(recordWith({ record, name, value: valueFor(name) }));
            } catch (e) {
                expect.soft((<Error>e).message, `[${name}] _initIpfsProps threw`).toBe("did not throw");
                continue;
            }
            expect.soft(Object.getPrototypeOf(comment), `[${name}] prototype of the instance`).toBe(prototypeBefore);
            expect.soft(asBag(comment)[name], `[${name}] member must keep its value`).toBe(memberBefore);
            expect.soft(asBag(comment).polluted, `[${name}] polluted through the prototype`).toBeUndefined();
        }
        expect.soft(Reflect.ownKeys(Object.prototype).length, "Object.prototype gained a key").toBe(objectPrototypeKeysBefore);
        expect.soft(objectPrototypeIsClean(), "Object.prototype polluted").toBe(true);
    });
});
