import {
    generateMockPost,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    createSubWithNoChallenge,
    mockPKC,
    describeSkipIfRpc
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { timestamp } from "../../../../dist/node/util.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { SignerWithPublicKeyAddress } from "../../../../dist/node/signer/index.js";
import { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";

describe("Ban then purge", () => {
    let pkc: PKC;
    let community: LocalCommunity | RpcLocalCommunity;
    let authorSigner: SignerWithPublicKeyAddress;
    let moderatorSigner: SignerWithPublicKeyAddress;
    let commentToBeBanned: Comment;
    let authorBanExpiresAt: number;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity | RpcLocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.updatedAt === "number"
        });

        authorSigner = await pkc.createSigner();
        moderatorSigner = await pkc.createSigner();

        await community.edit({ roles: { [moderatorSigner.address]: { role: "moderator" } } });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.roles?.[moderatorSigner.address]?.role === "moderator"
        });

        commentToBeBanned = await publishRandomPost({
            communityAddress: community.address,
            pkc: pkc,
            postProps: { signer: authorSigner }
        });
        await commentToBeBanned.update();
        await resolveWhenConditionIsTrue({
            toUpdate: commentToBeBanned,
            predicate: async () => typeof commentToBeBanned.updatedAt === "number"
        });
        authorBanExpiresAt = timestamp() + 300; // Ban stays for 5 minutes
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it.sequential(`Mod can ban the author`, async () => {
        const banMod = await pkc.createCommentModeration({
            communityAddress: community.address,
            commentCid: commentToBeBanned.cid,
            commentModeration: {
                author: { banExpiresAt: authorBanExpiresAt },
                reason: "Ban before purge test " + Date.now()
            },
            signer: moderatorSigner
        });
        await publishWithExpectedResult({ publication: banMod, expectedChallengeSuccess: true });
    });

    it.sequential(`Banned author can't publish`, async () => {
        const newCommentByBannedAuthor = await generateMockPost({
            communityAddress: community.address,
            pkc: pkc,
            postProps: {
                signer: authorSigner
            }
        });
        await publishWithExpectedResult({
            publication: newCommentByBannedAuthor,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_IS_BANNED
        });
    });

    it.sequential(`Mod purges the banned comment`, async () => {
        const purgeEdit = await pkc.createCommentModeration({
            communityAddress: community.address,
            commentCid: commentToBeBanned.cid,
            commentModeration: { reason: "Purge after ban test " + Date.now(), purged: true },
            signer: moderatorSigner
        });
        await publishWithExpectedResult({ publication: purgeEdit, expectedChallengeSuccess: true });
    });

    it.sequential(`Author ban persists after purging the comment`, async () => {
        // The ban should persist even after the comment is purged because the
        // targetAuthorSignerAddress column in commentModerations stores the banned
        // author's address directly, allowing lookup without going through comments table.
        const newCommentByBannedAuthor = await generateMockPost({
            communityAddress: community.address,
            pkc: pkc,
            postProps: {
                signer: authorSigner
            }
        });
        await publishWithExpectedResult({
            publication: newCommentByBannedAuthor,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_IS_BANNED
        });
    });
});

describeSkipIfRpc("Ban then purge with per-post pseudonymity mode", () => {
    let pkc: PKC;
    let community: LocalCommunity;
    let authorSigner: SignerWithPublicKeyAddress;
    let moderatorSigner: SignerWithPublicKeyAddress;
    let commentToBeBanned: Comment;
    let authorBanExpiresAt: number;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.edit({ features: { pseudonymityMode: "per-post" } });
        await community.start();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.updatedAt === "number"
        });

        authorSigner = await pkc.createSigner();
        moderatorSigner = await pkc.createSigner();

        await community.edit({ roles: { [moderatorSigner.address]: { role: "moderator" } } });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.roles?.[moderatorSigner.address]?.role === "moderator"
        });

        commentToBeBanned = await publishRandomPost({
            communityAddress: community.address,
            pkc: pkc,
            postProps: { signer: authorSigner }
        });
        await commentToBeBanned.update();
        await resolveWhenConditionIsTrue({
            toUpdate: commentToBeBanned,
            predicate: async () => typeof commentToBeBanned.updatedAt === "number"
        });
        authorBanExpiresAt = timestamp() + 300;
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it.sequential(`Mod can ban the author via anonymized comment`, async () => {
        // Verify the comment was anonymized
        const aliasRow = community._dbHandler.queryPseudonymityAliasByCommentCid(commentToBeBanned.cid);
        expect(aliasRow).to.exist;
        expect(aliasRow?.originalAuthorSignerPublicKey).to.equal(authorSigner.publicKey);

        const banMod = await pkc.createCommentModeration({
            communityAddress: community.address,
            commentCid: commentToBeBanned.cid,
            commentModeration: {
                author: { banExpiresAt: authorBanExpiresAt },
                reason: "Ban pseudonymous author before purge test " + Date.now()
            },
            signer: moderatorSigner
        });
        await publishWithExpectedResult({ publication: banMod, expectedChallengeSuccess: true });
    });

    it.sequential(`Banned author can't publish (using original signer)`, async () => {
        const newCommentByBannedAuthor = await generateMockPost({
            communityAddress: community.address,
            pkc: pkc,
            postProps: {
                signer: authorSigner
            }
        });
        await publishWithExpectedResult({
            publication: newCommentByBannedAuthor,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_IS_BANNED
        });
    });

    it.sequential(`Mod purges the banned anonymized comment`, async () => {
        const purgeEdit = await pkc.createCommentModeration({
            communityAddress: community.address,
            commentCid: commentToBeBanned.cid,
            commentModeration: { reason: "Purge pseudonymous after ban test " + Date.now(), purged: true },
            signer: moderatorSigner
        });
        await publishWithExpectedResult({ publication: purgeEdit, expectedChallengeSuccess: true });
    });

    it.sequential(`Author ban persists after purging the anonymized comment`, async () => {
        // The ban should persist because targetAuthorSignerAddress stores the original
        // author's address (resolved from pseudonymityAliases.originalAuthorSignerPublicKey)
        const newCommentByBannedAuthor = await generateMockPost({
            communityAddress: community.address,
            pkc: pkc,
            postProps: {
                signer: authorSigner
            }
        });
        await publishWithExpectedResult({
            publication: newCommentByBannedAuthor,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_IS_BANNED
        });
    });
});

describeSkipIfRpc("Ban then purge with per-author pseudonymity mode", () => {
    let pkc: PKC;
    let community: LocalCommunity;
    let authorSigner: SignerWithPublicKeyAddress;
    let moderatorSigner: SignerWithPublicKeyAddress;
    let commentToBeBanned: Comment;
    let authorBanExpiresAt: number;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.edit({ features: { pseudonymityMode: "per-author" } });
        await community.start();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.updatedAt === "number"
        });

        authorSigner = await pkc.createSigner();
        moderatorSigner = await pkc.createSigner();

        await community.edit({ roles: { [moderatorSigner.address]: { role: "moderator" } } });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.roles?.[moderatorSigner.address]?.role === "moderator"
        });

        commentToBeBanned = await publishRandomPost({
            communityAddress: community.address,
            pkc: pkc,
            postProps: { signer: authorSigner }
        });
        await commentToBeBanned.update();
        await resolveWhenConditionIsTrue({
            toUpdate: commentToBeBanned,
            predicate: async () => typeof commentToBeBanned.updatedAt === "number"
        });
        authorBanExpiresAt = timestamp() + 300;
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it.sequential(`Mod can ban the author via per-author anonymized comment`, async () => {
        // Verify the comment was anonymized with per-author mode
        const aliasRow = community._dbHandler.queryPseudonymityAliasByCommentCid(commentToBeBanned.cid);
        expect(aliasRow).to.exist;
        expect(aliasRow?.mode).to.equal("per-author");
        expect(aliasRow?.originalAuthorSignerPublicKey).to.equal(authorSigner.publicKey);

        const banMod = await pkc.createCommentModeration({
            communityAddress: community.address,
            commentCid: commentToBeBanned.cid,
            commentModeration: {
                author: { banExpiresAt: authorBanExpiresAt },
                reason: "Ban per-author pseudonymous author before purge test " + Date.now()
            },
            signer: moderatorSigner
        });
        await publishWithExpectedResult({ publication: banMod, expectedChallengeSuccess: true });
    });

    it.sequential(`Banned author can't publish (using original signer)`, async () => {
        const newCommentByBannedAuthor = await generateMockPost({
            communityAddress: community.address,
            pkc: pkc,
            postProps: {
                signer: authorSigner
            }
        });
        await publishWithExpectedResult({
            publication: newCommentByBannedAuthor,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_IS_BANNED
        });
    });

    it.sequential(`Mod purges the banned per-author anonymized comment`, async () => {
        const purgeEdit = await pkc.createCommentModeration({
            communityAddress: community.address,
            commentCid: commentToBeBanned.cid,
            commentModeration: { reason: "Purge per-author after ban test " + Date.now(), purged: true },
            signer: moderatorSigner
        });
        await publishWithExpectedResult({ publication: purgeEdit, expectedChallengeSuccess: true });
    });

    it.sequential(`Author ban persists after purging the per-author anonymized comment`, async () => {
        const newCommentByBannedAuthor = await generateMockPost({
            communityAddress: community.address,
            pkc: pkc,
            postProps: {
                signer: authorSigner
            }
        });
        await publishWithExpectedResult({
            publication: newCommentByBannedAuthor,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_IS_BANNED
        });
    });
});
