import {
    mockPlebbit,
    createSubWithNoChallenge,
    generateMockPost,
    generateMockComment,
    publishWithExpectedResult,
    mockPlebbitNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    publishRandomPost
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../../dist/node/pkc/pkc.js";
import type { LocalSubplebbit } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalSubplebbit } from "../../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

describe.concurrent(`subplebbit.features.noImageReplies`, async () => {
    let plebbit: Plebbit;
    let remotePlebbit: Plebbit;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let publishedPost: Comment;

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
        subplebbit = await createSubWithNoChallenge({}, plebbit);
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        // Publish a post first (before enabling the feature)
        publishedPost = await publishRandomPost({ communityAddress: subplebbit.address, plebbit: remotePlebbit });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        expect(subplebbit.features).to.be.undefined;
        await subplebbit.edit({ features: { ...subplebbit.features, noImageReplies: true } });
        expect(subplebbit.features?.noImageReplies).to.be.true;

        const remoteSub = await remotePlebbit.getSubplebbit({ address: subplebbit.address });
        await remoteSub.update();
        await resolveWhenConditionIsTrue({ toUpdate: remoteSub, predicate: async () => remoteSub.features?.noImageReplies === true });
        expect(remoteSub.features?.noImageReplies).to.be.true;
        await remoteSub.stop();
    });

    it(`Can publish a post with image link (noImageReplies only blocks replies)`, async () => {
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: {
                link: "https://example.com/image.png",
                content: "Just text"
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can't publish a reply with image link`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePlebbit, false, {
            link: "https://example.com/photo.jpg"
        });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REPLY_HAS_LINK_THAT_IS_IMAGE
        });
    });

    it(`Can publish a reply without image link`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePlebbit, false, {
            content: "Just text reply"
        });
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });

    it(`Can publish a reply with video link (noImageReplies doesn't block videos)`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePlebbit, false, {
            link: "https://example.com/video.mp4"
        });
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });
});
