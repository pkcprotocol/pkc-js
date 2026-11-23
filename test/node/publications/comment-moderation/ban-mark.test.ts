import {
    generateMockPost,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    createSubWithNoChallenge,
    mockPKC
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { timestamp } from "../../../../dist/node/util.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { SignerWithPublicKeyAddress } from "../../../../dist/node/signer/index.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";

// commentUpdate.authorBanExpiresAt (issue #363): which comment a mod banned the author from, through a real community
// from the moderation publication to the CommentUpdate a client loads. The precedence rules are covered one by one
// in test/node/community/authorBanExpiresAt.db.community.test.ts.
describe("commentUpdate.authorBanExpiresAt marks the comment a ban was published on", () => {
    let pkc: PKC;
    let community: LocalCommunity | RpcLocalCommunity;
    let authorSigner: SignerWithPublicKeyAddress;
    let moderatorSigner: SignerWithPublicKeyAddress;
    let bannedPost: Comment;
    let otherPost: Comment;
    let banExpiresAt: number;

    // `reason` only tells two moderations with the same value apart: published within the same second, identical content
    // signs into the same moderation, which the community answers as the duplicate it is without storing it again
    const moderateAuthor = async (commentCid: string, authorBanExpiresAt: number, reason?: string) => {
        const moderation = await pkc.createCommentModeration({
            communityAddress: community.address,
            commentCid,
            commentModeration: { author: { banExpiresAt: authorBanExpiresAt }, ...(reason ? { reason } : {}) },
            signer: moderatorSigner
        });
        await publishWithExpectedResult({ publication: moderation, expectedChallengeSuccess: true });
    };

    const authorPublishes = async (expected: { banned: boolean }) => {
        const post = await generateMockPost({ communityAddress: community.address, pkc, postProps: { signer: authorSigner } });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: !expected.banned,
            expectedReason: expected.banned ? messages.ERR_AUTHOR_IS_BANNED : undefined
        });
    };

    beforeAll(async () => {
        pkc = await mockPKC();
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity | RpcLocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        authorSigner = await pkc.createSigner();
        moderatorSigner = await pkc.createSigner();
        await community.edit({ roles: { [moderatorSigner.address]: { role: "moderator" } } });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.roles?.[moderatorSigner.address]?.role === "moderator"
        });

        bannedPost = await publishRandomPost({ communityAddress: community.address, pkc, postProps: { signer: authorSigner } });
        otherPost = await publishRandomPost({ communityAddress: community.address, pkc, postProps: { signer: authorSigner } });
        for (const post of [bannedPost, otherPost]) {
            await post.update();
            await resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => typeof post.updatedAt === "number" });
        }
        banExpiresAt = timestamp() + 300;
    });

    afterAll(async () => {
        await bannedPost?.stop();
        await otherPost?.stop();
        await community.delete();
        await pkc.destroy();
    });

    it.sequential("a ban marks the comment it was published on, and the author's other comment only carries the aggregate", async () => {
        expect(bannedPost.authorBanExpiresAt).to.be.undefined;
        await moderateAuthor(bannedPost.cid!, banExpiresAt);

        await resolveWhenConditionIsTrue({ toUpdate: bannedPost, predicate: async () => bannedPost.authorBanExpiresAt === banExpiresAt });
        await resolveWhenConditionIsTrue({
            toUpdate: otherPost,
            predicate: async () => otherPost.author.community?.banExpiresAt === banExpiresAt
        });
        expect(bannedPost.author.community?.banExpiresAt).to.equal(banExpiresAt);
        expect(bannedPost.raw.commentUpdate?.authorBanExpiresAt).to.equal(banExpiresAt);
        expect(bannedPost.raw.commentUpdate?.signature.signedPropertyNames).to.include("authorBanExpiresAt");
        expect(otherPost.authorBanExpiresAt).to.be.undefined;
        expect(otherPost.raw.commentUpdate).to.not.have.property("authorBanExpiresAt");
        await authorPublishes({ banned: true });
    });

    it.sequential("an unban on the marked comment lifts the ban and keeps the mark", async () => {
        const unbanTimestamp = timestamp() - 10;
        await moderateAuthor(bannedPost.cid!, unbanTimestamp);

        await resolveWhenConditionIsTrue({ toUpdate: bannedPost, predicate: async () => bannedPost.authorBanExpiresAt === unbanTimestamp });
        expect(bannedPost.author.community?.banExpiresAt).to.equal(unbanTimestamp);
        expect(otherPost.authorBanExpiresAt).to.be.undefined;
        await authorPublishes({ banned: false });
    });

    it.sequential("0 on the marked comment removes the mark and leaves the author banned", async () => {
        // A different expiry than the first ban, so it cannot sign into the same moderation
        const secondBanExpiresAt = banExpiresAt + 100;
        await moderateAuthor(bannedPost.cid!, secondBanExpiresAt);
        await resolveWhenConditionIsTrue({
            toUpdate: bannedPost,
            predicate: async () => bannedPost.authorBanExpiresAt === secondBanExpiresAt
        });
        await authorPublishes({ banned: true });

        await moderateAuthor(bannedPost.cid!, 0);
        await resolveWhenConditionIsTrue({ toUpdate: bannedPost, predicate: async () => bannedPost.authorBanExpiresAt === undefined });
        expect(bannedPost.raw.commentUpdate).to.not.have.property("authorBanExpiresAt");
        expect(bannedPost.author.community?.banExpiresAt, "0 never touches the ban").to.equal(secondBanExpiresAt);
        expect(otherPost.author.community?.banExpiresAt).to.equal(secondBanExpiresAt);
        expect(otherPost.authorBanExpiresAt).to.be.undefined;
        await authorPublishes({ banned: true });
    });

    it.sequential("an unban then 0 on the same comment undoes the ban: the author can publish and no mark is left", async () => {
        const unbanTimestamp = timestamp() - 20;
        await moderateAuthor(bannedPost.cid!, unbanTimestamp);
        await resolveWhenConditionIsTrue({ toUpdate: bannedPost, predicate: async () => bannedPost.authorBanExpiresAt === unbanTimestamp });
        await authorPublishes({ banned: false });

        await moderateAuthor(bannedPost.cid!, 0, "clearing the mark the unban left");
        await resolveWhenConditionIsTrue({ toUpdate: bannedPost, predicate: async () => bannedPost.authorBanExpiresAt === undefined });
        expect(bannedPost.raw.commentUpdate).to.not.have.property("authorBanExpiresAt");
        expect(bannedPost.author.community?.banExpiresAt, "the lifted ban's past timestamp stays").to.equal(unbanTimestamp);
        await authorPublishes({ banned: false });
    });
});
