// Backward compatibility: an unknown prop that does not collide with anything must keep landing on the
// instance, on every path that copies one, because that is how a client reads a field from a newer
// protocol version. The collision fix must not turn the copy off.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mockRemotePKC, generateMockPost } from "../../../../dist/node/test/test-util.js";
import validCommentUpdateFixture from "../../../fixtures/signatures/comment/commentUpdate/valid_comment_update.json" with { type: "json" };
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsType, CommentUpdateType } from "../../../../dist/node/publications/comment/types.js";

const CID = "QmeaD98zCjbs3h9GSCMixCGxMSJC3vUgW2i9pZoJpwkN7u";
type Bag = Record<string, unknown>;
const asBag = (x: object): Bag => <Bag>(<unknown>x);

describe("benign unknown props still land on the Comment instance", () => {
    let pkc: PKC;
    let record: CommentIpfsType;
    beforeAll(async () => {
        pkc = await mockRemotePKC();
        const post = await generateMockPost({ communityAddress: "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR", pkc });
        if (!post.raw.pubsubMessageToPublish) {
            await post._initCommunity();
            await post._signPublicationWithCommunityFields();
        }
        record = <CommentIpfsType>structuredClone(post.raw.pubsubMessageToPublish);
    });
    afterAll(async () => {
        await pkc.destroy();
    });

    it("CommentIpfs extra prop", async () => {
        const comment = <Comment>await pkc.createComment({ cid: CID });
        comment._initIpfsProps(<CommentIpfsType>{ ...record, extraProp: "1234" });
        expect(asBag(comment).extraProp).toBe("1234");
    });

    it("CommentUpdate extra prop", async () => {
        const comment = <Comment>await pkc.createComment({ cid: CID });
        comment._initIpfsProps(record);
        comment._initCommentUpdate(<CommentUpdateType>{ ...validCommentUpdateFixture, extraProp: "1234" });
        expect(asBag(comment).extraProp).toBe("1234");
    });

    it("challenge-verification commentUpdate extra prop", async () => {
        const comment = <Comment>await pkc.createComment({ cid: CID });
        const withPrivate = <{ _updateCommentPropsFromDecryptedChallengeVerification(v: unknown): Promise<void> }>(<unknown>comment);
        await withPrivate._updateCommentPropsFromDecryptedChallengeVerification({
            comment: record,
            commentUpdate: { cid: CID, protocolVersion: record.protocolVersion, signature: record.signature, extraProp: "1234" }
        });
        expect(asBag(comment).extraProp).toBe("1234");
    });
});
