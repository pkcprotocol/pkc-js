// The observed damage of the collision: after loading a poisoned comment the instance breaks. `update`
// became a string, and `stop()` threw "this._clientsManager._cancelTransientFetchRetry is not a function".
// This asserts the behavior a user depends on, not just that the field survived.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mockRemotePKC, generateMockPost } from "../../../../dist/node/test/test-util.js";
import { stopOutcome, HOSTILE_VALUE, hostileNamesFor, recordWith, valueFor, objectPrototypeIsClean } from "../../../helpers/hostile-props.js";
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

describe("a Comment loaded from a poisoned CommentIpfs record stays usable", () => {
    let pkc: PKC;
    let record: CommentIpfsType;
    beforeAll(async () => {
        ({ pkc, record } = await setup());
    });
    afterAll(async () => {
        await pkc.destroy();
    });

    it("update and stop stay functions, and stop() does not throw", async () => {
        for (const name of ["update", "stop", "_clientsManager", "_wasPublishCalled", "_publishEndedBy", "_updateAttempt"]) {
            const comment = <Comment>await pkc.createComment({ cid: CID });
            comment._initIpfsProps(recordWith({ record, name }));
            expect.soft(typeof comment.update, `[${name}] update must stay a function`).toBe("function");
            expect.soft(typeof comment.stop, `[${name}] stop must stay a function`).toBe("function");
            expect.soft(await stopOutcome(comment), `[${name}] stop() must not throw`).toBeUndefined();
        }
    });
});
