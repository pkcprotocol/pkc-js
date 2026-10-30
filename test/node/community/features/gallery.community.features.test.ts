// comment.gallery (issue #436): community-side enforcement of features.maxPostGalleryItems /
// maxReplyGalleryItems, the per-item media checks, and the existing media features applied to every item.
// Structure-only validation is covered in test/node-and-browser/gallery/schema.test.ts.
import {
    mockPKC,
    createSubWithNoChallenge,
    generateMockPost,
    generateMockComment,
    publishWithExpectedResult,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    publishRandomPost
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined, CreateCommentOptions } from "../../../../dist/node/publications/comment/types.js";

type Gallery = NonNullable<CreateCommentOptions["gallery"]>;

const image = (name = "a"): Gallery[number] => ({ url: `https://example.com/${name}.png`, htmlTagName: "img" });
const gif = (): Gallery[number] => ({ url: "https://example.com/animated.gif", htmlTagName: "img" });
const video = (name = "a"): Gallery[number] => ({ url: `https://example.com/${name}.mp4`, htmlTagName: "video" });
const audio = (name = "a"): Gallery[number] => ({ url: `https://example.com/${name}.mp3`, htmlTagName: "audio" });

type TestCommunity = LocalCommunity | RpcLocalCommunity;

async function startCommunity(pkc: PKC, features?: TestCommunity["features"]): Promise<TestCommunity> {
    const community = await createSubWithNoChallenge({}, pkc);
    if (features) await community.edit({ features });
    await community.start();
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    return community;
}

// A post whose only payload is its gallery, no content or title.
const galleryOnlyPost = async ({ community, pkc, gallery }: { community: TestCommunity; pkc: PKC; gallery: Gallery }) =>
    pkc.createComment({ communityAddress: community.address, signer: await pkc.createSigner(), gallery });

const postWith = async ({ community, pkc, postProps }: { community: TestCommunity; pkc: PKC; postProps: Partial<CreateCommentOptions> }) =>
    generateMockPost({ communityAddress: community.address, pkc, postProps });

const replyWith = async ({ parent, pkc, props }: { parent: Comment; pkc: PKC; props: Partial<CreateCommentOptions> }) =>
    generateMockComment(parent as CommentIpfsWithCidDefined, pkc, false, props);

describe.concurrent(`comment.gallery: maxPostGalleryItems, maxReplyGalleryItems and item validation`, async () => {
    let pkc: PKC;
    let remotePKC: PKC;
    let community: TestCommunity;
    let publishedPost: Comment;

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        community = await startCommunity(pkc);
        publishedPost = await publishRandomPost({ communityAddress: community.address, pkc: remotePKC });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    // Galleries are off unless the owner sets a max: there is no default.
    it.sequential(`A gallery is rejected while the features are absent, then the features are updated in props`, async () => {
        expect(community.features?.maxPostGalleryItems).to.be.undefined;
        await publishWithExpectedResult({
            publication: await postWith({ community, pkc: remotePKC, postProps: { gallery: [image()] } }),
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_POST_GALLERY_NOT_ALLOWED
        });
        await publishWithExpectedResult({
            publication: await replyWith({ parent: publishedPost, pkc: remotePKC, props: { gallery: [video()] } }),
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REPLY_GALLERY_NOT_ALLOWED
        });

        await community.edit({
            features: { ...community.features, maxPostGalleryItems: 3, maxReplyGalleryItems: 2, noImageReplies: true }
        });
        expect(community.features?.maxPostGalleryItems).to.equal(3);
        expect(community.features?.maxReplyGalleryItems).to.equal(2);

        const remoteCommunity = await remotePKC.createCommunity({ address: community.address });
        await remoteCommunity.update();
        await resolveWhenConditionIsTrue({
            toUpdate: remoteCommunity,
            predicate: async () => remoteCommunity.features?.maxPostGalleryItems === 3
        });
        expect(remoteCommunity.features?.maxReplyGalleryItems).to.equal(2);
        await remoteCommunity.stop();
    });

    it(`Can publish a gallery-only post, and it loads with every item prop intact`, async () => {
        const gallery = [
            { ...image("cover"), width: 800, height: 600, alt: "a cat on a chair" },
            video("clip"),
            // A prop a later protocol version might add: items are loose, so it survives signing, storage and loading
            { ...audio("song"), caption: "added by a later version" } as Gallery[number]
        ];
        const post = await galleryOnlyPost({ community, pkc: remotePKC, gallery });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });

        const loaded = await remotePKC.createComment({ cid: post.cid! });
        await loaded.update();
        await resolveWhenConditionIsTrue({ toUpdate: loaded, predicate: async () => typeof loaded.timestamp === "number" });
        expect(loaded.gallery).to.deep.equal(gallery);
        expect(loaded.content).to.be.undefined;
        expect(loaded.title).to.be.undefined;
        await loaded.stop();
    });

    it(`Can publish a post with both link and gallery`, async () => {
        const post = await postWith({
            community,
            pkc: remotePKC,
            postProps: { link: "https://example.com/article", gallery: [image(), image("b")] }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can't publish a post with more items than maxPostGalleryItems`, async () => {
        const post = await postWith({
            community,
            pkc: remotePKC,
            postProps: { gallery: [image("1"), image("2"), image("3"), image("4")] }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_POST_GALLERY_EXCEEDS_MAX_ITEMS
        });
    });

    it(`Can publish a gallery-only reply`, async () => {
        const reply = await replyWith({
            parent: publishedPost,
            pkc: remotePKC,
            props: { content: undefined, gallery: [video("1"), video("2")] }
        });
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });

    it(`Can't publish a reply with more items than maxReplyGalleryItems`, async () => {
        const reply = await replyWith({ parent: publishedPost, pkc: remotePKC, props: { gallery: [video("1"), video("2"), video("3")] } });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REPLY_GALLERY_EXCEEDS_MAX_ITEMS
        });
    });

    it(`noImageReplies rejects a reply if any gallery item is an image`, async () => {
        const reply = await replyWith({ parent: publishedPost, pkc: remotePKC, props: { gallery: [video(), image()] } });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REPLY_HAS_LINK_THAT_IS_IMAGE
        });
    });

    for (const [description, url] of [
        ["an http url", "http://example.com/a.png"],
        ["an https url that is not media", "https://example.com/page.html"],
        ["an https url with no extension", "https://example.com/media/abc"],
        ["a url whose format is only in the query string", "https://pbs.twimg.com/media/abc?format=jpg"]
    ] as const) {
        it(`Can't publish a gallery item with ${description}`, async () => {
            const post = await postWith({ community, pkc: remotePKC, postProps: { gallery: [image(), { url, htmlTagName: "img" }] } });
            await publishWithExpectedResult({
                publication: post,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_GALLERY_ITEM_NOT_MEDIA
            });
        });
    }

    for (const item of [
        { url: "https://example.com/a.png", htmlTagName: "video" },
        { url: "https://example.com/a.mp4", htmlTagName: "img" },
        { url: "https://example.com/a.mp3", htmlTagName: "video" },
        { url: "https://example.com/animated.gif", htmlTagName: "video" }
    ] as const) {
        it(`Can't publish a gallery item ${item.url} with htmlTagName ${item.htmlTagName}`, async () => {
            const post = await postWith({ community, pkc: remotePKC, postProps: { gallery: [item] } });
            await publishWithExpectedResult({
                publication: post,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_GALLERY_ITEM_HTML_TAG_NAME_MISMATCH
            });
        });
    }
});

describe.concurrent(`comment.gallery: noImages, noVideoReplies and noAudioReplies check every item`, async () => {
    let pkc: PKC;
    let remotePKC: PKC;
    let community: TestCommunity;
    let publishedPost: Comment;

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        community = await startCommunity(pkc, {
            maxPostGalleryItems: 5,
            maxReplyGalleryItems: 5,
            noImages: true,
            noVideoReplies: true,
            noAudioReplies: true
        });
        publishedPost = await publishRandomPost({ communityAddress: community.address, pkc: remotePKC });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it(`noImages rejects a post if any gallery item is an image`, async () => {
        const post = await postWith({ community, pkc: remotePKC, postProps: { gallery: [video(), image()] } });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_HAS_LINK_THAT_IS_IMAGE
        });
    });

    it(`Can publish a post with video and audio items (the reply features don't apply to posts)`, async () => {
        const post = await postWith({ community, pkc: remotePKC, postProps: { gallery: [video(), audio()] } });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`noVideoReplies rejects a reply if any gallery item is a video`, async () => {
        const reply = await replyWith({ parent: publishedPost, pkc: remotePKC, props: { gallery: [video()] } });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REPLY_HAS_LINK_THAT_IS_VIDEO
        });
    });

    it(`noAudioReplies rejects a reply if any gallery item is audio`, async () => {
        const reply = await replyWith({ parent: publishedPost, pkc: remotePKC, props: { gallery: [audio()] } });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REPLY_HAS_LINK_THAT_IS_AUDIO
        });
    });
});

// The client convention for media-required boards: the first file goes in `link` (the cover, which gets
// the community thumbnail), the rest in `gallery`. A gallery alone does not satisfy requirePostLink.
describe.concurrent(`comment.gallery: media-required board with noVideos and noAudio`, async () => {
    let pkc: PKC;
    let remotePKC: PKC;
    let community: TestCommunity;
    let publishedPost: Comment;

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        community = await startCommunity(pkc, {
            maxPostGalleryItems: 5,
            maxReplyGalleryItems: 0,
            requirePostLink: true,
            requirePostLinkIsMedia: true,
            noVideos: true,
            noAudio: true
        });
        publishedPost = await publishRandomPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: { link: "https://example.com/op.png" }
        });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it(`A gallery-only post does not satisfy requirePostLink`, async () => {
        const post = await galleryOnlyPost({ community, pkc: remotePKC, gallery: [image("1"), image("2")] });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_HAS_INVALID_LINK_FIELD
        });
    });

    it(`Can publish a post with the first file in link and the rest in gallery`, async () => {
        const post = await postWith({
            community,
            pkc: remotePKC,
            postProps: { link: "https://example.com/cover.png", gallery: [image("2"), image("3")] }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`noVideos rejects a post if any gallery item is an animated image`, async () => {
        const post = await postWith({
            community,
            pkc: remotePKC,
            postProps: { link: "https://example.com/cover.png", gallery: [image(), gif()] }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_HAS_LINK_THAT_IS_VIDEO
        });
    });

    it(`noAudio rejects a post if any gallery item is audio`, async () => {
        const post = await postWith({
            community,
            pkc: remotePKC,
            postProps: { link: "https://example.com/cover.png", gallery: [image(), audio()] }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_HAS_LINK_THAT_IS_AUDIO
        });
    });

    it(`maxReplyGalleryItems: 0 rejects a reply with a gallery`, async () => {
        const reply = await replyWith({ parent: publishedPost, pkc: remotePKC, props: { gallery: [image()] } });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REPLY_GALLERY_NOT_ALLOWED
        });
    });
});
