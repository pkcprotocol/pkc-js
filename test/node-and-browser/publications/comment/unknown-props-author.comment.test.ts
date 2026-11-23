// `comment.author` is merged from the wire record, the CommentUpdate and the challenge verification with
// Object.assign(this.author, ...) and no reserved-name filter at all. A key such as `__proto__` or
// `constructor` inside an author object is the nested form of the instance collision, and it is
// reachable from the author's own signed record.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mockRemotePKC, generateMockPost } from "../../../../dist/node/test/test-util.js";
import { HOSTILE_VALUE, hostileNamesFor, recordWith, valueFor, objectPrototypeIsClean } from "../../../helpers/hostile-props.js";
import validCommentUpdateFixture from "../../../fixtures/signatures/comment/commentUpdate/valid_comment_update.json" with { type: "json" };
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

describe("author props that collide with prototype members", () => {
    let pkc: PKC;
    let record: CommentIpfsType;
    beforeAll(async () => {
        ({ pkc, record } = await setup());
    });
    afterAll(async () => {
        await pkc.destroy();
    });

    const authorWith = (name: string) => recordWith({ record: record.author, name, value: valueFor(name) });
    const NAMES = ["__proto__", "constructor", "toString", "hasOwnProperty"];

    it("CommentIpfs author", async () => {
        for (const name of NAMES) {
            const comment = <Comment>await pkc.createComment({ cid: CID });
            comment._initIpfsProps({ ...record, author: authorWith(name) });
            const author = asBag(comment.author);
            expect.soft(Object.getPrototypeOf(comment.author), `[${name}] author prototype`).toBe(Object.prototype);
            expect.soft(author.polluted, `[${name}] author polluted`).toBeUndefined();
            expect.soft(author[name] === HOSTILE_VALUE, `[${name}] must not overwrite the inherited member`).toBe(false);
            expect.soft(objectPrototypeIsClean(), `[${name}] Object.prototype`).toBe(true);
        }
    });

    it("CommentUpdate author", async () => {
        for (const name of NAMES) {
            const comment = <Comment>await pkc.createComment({ cid: CID });
            comment._initIpfsProps(record);
            comment._initCommentUpdate(<never>{ ...validCommentUpdateFixture, author: authorWith(name) });
            const author = asBag(comment.author);
            expect.soft(Object.getPrototypeOf(comment.author), `[${name}] author prototype`).toBe(Object.prototype);
            expect.soft(author.polluted, `[${name}] author polluted`).toBeUndefined();
            expect.soft(author[name] === HOSTILE_VALUE, `[${name}] must not overwrite the inherited member`).toBe(false);
            expect.soft(objectPrototypeIsClean(), `[${name}] Object.prototype`).toBe(true);
        }
    });

    it("benign author extra prop still lands on comment.author", async () => {
        const comment = <Comment>await pkc.createComment({ cid: CID });
        comment._initIpfsProps({ ...record, author: { ...record.author, extraProp: "1234" } });
        expect(asBag(comment.author).extraProp).toBe("1234");
    });
});
