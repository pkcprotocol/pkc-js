import { beforeAll, afterAll, it } from "vitest";
import Logger from "@pkc/pkc-logger";
import {
    createSubWithNoChallenge,
    describeSkipIfRpc,
    disableValidationOfSignatureBeforePublishing,
    ensurePublicationIsSigned,
    mockPKC,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { messages } from "../../../dist/node/errors.js";
import { _signJson, cleanUpBeforePublishing } from "../../../dist/node/signer/signatures.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type Publication from "../../../dist/node/publications/publication.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { SignerType } from "../../../dist/node/signer/types.js";

type PublicationWithSigner = Publication & { signer?: SignerType };

describeSkipIfRpc.sequential("LocalCommunity rejects publications with wrong community address", async () => {
    let pkc: PKC;
    let community: LocalCommunity | RpcLocalCommunity;
    let targetPost: Comment;
    let moderatorSigner: SignerType;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = await createSubWithNoChallenge({}, pkc);

        await community.start();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.updatedAt === "number"
        });

        targetPost = await publishRandomPost({ communityAddress: community.address, pkc });

        moderatorSigner = await pkc.createSigner();
        const ownerSigner = community.signer;
        if (!ownerSigner?.address || !("privateKey" in ownerSigner) || typeof ownerSigner.privateKey !== "string")
            throw Error("Expected local community to have an owner signer with a private key");

        await community.edit({
            roles: {
                ...(community.roles || {}),
                [moderatorSigner.address]: { role: "moderator" },
                [ownerSigner.address]: { role: "owner" }
            }
        });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () =>
                community.roles?.[moderatorSigner.address]?.role === "moderator" && community.roles?.[ownerSigner.address]?.role === "owner"
        });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    // --- helpers ---

    async function injectWrongCommunityAddress(publication: PublicationWithSigner) {
        const log = Logger("pkc-js:test:injectWrongCommunityAddress");
        if (!publication.signer) throw Error("Expected publication to have a signer");
        await ensurePublicationIsSigned(publication, community);

        const orig = publication.raw.pubsubMessageToPublish!;
        const modified = { ...orig } as Record<string, unknown>;
        delete modified.communityPublicKey;
        delete modified.communityName;
        modified.communityAddress = "QmSomeWrongCommunityAddress";

        const newSignedProps = [
            ...orig.signature.signedPropertyNames.filter((k) => k !== "communityPublicKey" && k !== "communityName"),
            "communityAddress"
        ];
        modified.signature = await _signJson(newSignedProps, cleanUpBeforePublishing(modified), publication.signer, log);
        publication.raw.pubsubMessageToPublish = modified as typeof orig;
        publication.signature = modified.signature as typeof publication.signature;
        disableValidationOfSignatureBeforePublishing(publication);
    }

    async function injectWrongCommunityPublicKey(publication: PublicationWithSigner) {
        const log = Logger("pkc-js:test:injectWrongCommunityPublicKey");
        if (!publication.signer) throw Error("Expected publication to have a signer");
        await ensurePublicationIsSigned(publication, community);

        const orig = publication.raw.pubsubMessageToPublish!;
        const modified = { ...orig, communityPublicKey: "QmFakeWrongCommunityPublicKey" } as Record<string, unknown>;
        const signedProps = orig.signature.signedPropertyNames;
        modified.signature = await _signJson(signedProps, cleanUpBeforePublishing(modified), publication.signer, log);
        publication.raw.pubsubMessageToPublish = modified as typeof orig;
        publication.signature = modified.signature as typeof publication.signature;
        disableValidationOfSignatureBeforePublishing(publication);
    }

    async function injectSubplebbitAddress(publication: PublicationWithSigner) {
        const log = Logger("pkc-js:test:injectSubplebbitAddress");
        if (!publication.signer) throw Error("Expected publication to have a signer");
        await ensurePublicationIsSigned(publication, community);

        const orig = publication.raw.pubsubMessageToPublish!;
        const modified = { ...orig } as Record<string, unknown>;
        delete modified.communityPublicKey;
        delete modified.communityName;
        // Use the community's correct IPNS key to prove rejection is field-name-based, not value-based
        modified.subplebbitAddress = community.signer!.address;

        const newSignedProps = [
            ...orig.signature.signedPropertyNames.filter((k) => k !== "communityPublicKey" && k !== "communityName"),
            "subplebbitAddress"
        ];
        modified.signature = await _signJson(newSignedProps, cleanUpBeforePublishing(modified), publication.signer, log);
        publication.raw.pubsubMessageToPublish = modified as typeof orig;
        publication.signature = modified.signature as typeof publication.signature;
        disableValidationOfSignatureBeforePublishing(publication);
    }

    // --- comment ---

    it("rejects a comment with deprecated communityAddress field", async () => {
        const comment = await pkc.createComment({
            communityAddress: community.address,
            title: `Deprecated communityAddress comment ${Date.now()}`,
            content: `Content ${Date.now()}`,
            signer: await pkc.createSigner()
        });
        await injectWrongCommunityAddress(comment);
        await publishWithExpectedResult({
            publication: comment,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_USES_DEPRECATED_COMMUNITY_ADDRESS
        });
    });

    it("rejects a comment with wrong communityPublicKey", async () => {
        const comment = await pkc.createComment({
            communityAddress: community.address,
            title: `Wrong communityPublicKey comment ${Date.now()}`,
            content: `Content ${Date.now()}`,
            signer: await pkc.createSigner()
        });
        await injectWrongCommunityPublicKey(comment);
        await publishWithExpectedResult({
            publication: comment,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_INVALID_COMMUNITY_PUBLIC_KEY
        });
    });

    it("rejects a comment with wrong communityName", async () => {
        const comment = await pkc.createComment({
            communityAddress: "wrong-community.eth",
            communityPublicKey: community.address,
            title: `Wrong communityName comment ${Date.now()}`,
            content: `Content ${Date.now()}`,
            signer: await pkc.createSigner()
        });
        await publishWithExpectedResult({
            publication: comment,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_INVALID_COMMUNITY_NAME
        });
    });

    it("rejects a comment with deprecated subplebbitAddress field", async () => {
        const comment = await pkc.createComment({
            communityAddress: community.address,
            title: `Deprecated subplebbitAddress comment ${Date.now()}`,
            content: `Content ${Date.now()}`,
            signer: await pkc.createSigner()
        });
        await injectSubplebbitAddress(comment);
        await publishWithExpectedResult({
            publication: comment,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_USES_DEPRECATED_SUBPLEBBIT_ADDRESS
        });
    });

    // --- vote ---

    it("rejects a vote with deprecated communityAddress field", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        const vote = await pkc.createVote({
            commentCid: targetPost.cid,
            vote: 1,
            communityAddress: community.address,
            signer: await pkc.createSigner()
        });
        await injectWrongCommunityAddress(vote);
        await publishWithExpectedResult({
            publication: vote,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_USES_DEPRECATED_COMMUNITY_ADDRESS
        });
    });

    it("rejects a vote with wrong communityPublicKey", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        const vote = await pkc.createVote({
            commentCid: targetPost.cid,
            vote: 1,
            communityAddress: community.address,
            signer: await pkc.createSigner()
        });
        await injectWrongCommunityPublicKey(vote);
        await publishWithExpectedResult({
            publication: vote,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_INVALID_COMMUNITY_PUBLIC_KEY
        });
    });

    it("rejects a vote with wrong communityName", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        const vote = await pkc.createVote({
            commentCid: targetPost.cid,
            vote: 1,
            communityAddress: "wrong-community.eth",
            communityPublicKey: community.address,
            signer: await pkc.createSigner()
        });
        await publishWithExpectedResult({
            publication: vote,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_INVALID_COMMUNITY_NAME
        });
    });

    it("rejects a vote with deprecated subplebbitAddress field", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        const vote = await pkc.createVote({
            commentCid: targetPost.cid,
            vote: 1,
            communityAddress: community.address,
            signer: await pkc.createSigner()
        });
        await injectSubplebbitAddress(vote);
        await publishWithExpectedResult({
            publication: vote,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_USES_DEPRECATED_SUBPLEBBIT_ADDRESS
        });
    });

    // --- commentEdit ---

    it("rejects a commentEdit with deprecated communityAddress field", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        if (!targetPost.signer) throw Error("Expected target post instance to retain its signer");
        const commentEdit = await pkc.createCommentEdit({
            commentCid: targetPost.cid,
            content: `Deprecated communityAddress edit ${Date.now()}`,
            communityAddress: community.address,
            signer: targetPost.signer
        });
        await injectWrongCommunityAddress(commentEdit);
        await publishWithExpectedResult({
            publication: commentEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_USES_DEPRECATED_COMMUNITY_ADDRESS
        });
    });

    it("rejects a commentEdit with wrong communityPublicKey", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        if (!targetPost.signer) throw Error("Expected target post instance to retain its signer");
        const commentEdit = await pkc.createCommentEdit({
            commentCid: targetPost.cid,
            content: `Wrong communityPublicKey edit ${Date.now()}`,
            communityAddress: community.address,
            signer: targetPost.signer
        });
        await injectWrongCommunityPublicKey(commentEdit);
        await publishWithExpectedResult({
            publication: commentEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_INVALID_COMMUNITY_PUBLIC_KEY
        });
    });

    it("rejects a commentEdit with wrong communityName", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        if (!targetPost.signer) throw Error("Expected target post instance to retain its signer");
        const commentEdit = await pkc.createCommentEdit({
            commentCid: targetPost.cid,
            content: `Wrong communityName edit ${Date.now()}`,
            communityAddress: "wrong-community.eth",
            communityPublicKey: community.address,
            signer: targetPost.signer
        });
        await publishWithExpectedResult({
            publication: commentEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_INVALID_COMMUNITY_NAME
        });
    });

    it("rejects a commentEdit with deprecated subplebbitAddress field", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        if (!targetPost.signer) throw Error("Expected target post instance to retain its signer");
        const commentEdit = await pkc.createCommentEdit({
            commentCid: targetPost.cid,
            content: `Deprecated subplebbitAddress edit ${Date.now()}`,
            communityAddress: community.address,
            signer: targetPost.signer
        });
        await injectSubplebbitAddress(commentEdit);
        await publishWithExpectedResult({
            publication: commentEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_USES_DEPRECATED_SUBPLEBBIT_ADDRESS
        });
    });

    // --- commentModeration ---

    it("rejects a commentModeration with deprecated communityAddress field", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        const commentModeration = await pkc.createCommentModeration({
            communityAddress: community.address,
            commentCid: targetPost.cid,
            commentModeration: { reason: `Deprecated communityAddress mod ${Date.now()}`, spoiler: true },
            signer: moderatorSigner
        });
        await injectWrongCommunityAddress(commentModeration);
        await publishWithExpectedResult({
            publication: commentModeration,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_USES_DEPRECATED_COMMUNITY_ADDRESS
        });
    });

    it("rejects a commentModeration with wrong communityPublicKey", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        const commentModeration = await pkc.createCommentModeration({
            communityAddress: community.address,
            commentCid: targetPost.cid,
            commentModeration: { reason: `Wrong communityPublicKey mod ${Date.now()}`, spoiler: true },
            signer: moderatorSigner
        });
        await injectWrongCommunityPublicKey(commentModeration);
        await publishWithExpectedResult({
            publication: commentModeration,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_INVALID_COMMUNITY_PUBLIC_KEY
        });
    });

    it("rejects a commentModeration with wrong communityName", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        const commentModeration = await pkc.createCommentModeration({
            communityAddress: "wrong-community.eth",
            communityPublicKey: community.address,
            commentCid: targetPost.cid,
            commentModeration: { reason: `Wrong communityName mod ${Date.now()}`, spoiler: true },
            signer: moderatorSigner
        });
        await publishWithExpectedResult({
            publication: commentModeration,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_INVALID_COMMUNITY_NAME
        });
    });

    it("rejects a commentModeration with deprecated subplebbitAddress field", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        const commentModeration = await pkc.createCommentModeration({
            communityAddress: community.address,
            commentCid: targetPost.cid,
            commentModeration: { reason: `Deprecated subplebbitAddress mod ${Date.now()}`, spoiler: true },
            signer: moderatorSigner
        });
        await injectSubplebbitAddress(commentModeration);
        await publishWithExpectedResult({
            publication: commentModeration,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_USES_DEPRECATED_SUBPLEBBIT_ADDRESS
        });
    });

    // --- communityEdit ---

    it("rejects a communityEdit with deprecated communityAddress field", async () => {
        if (!community.signer || !("privateKey" in community.signer) || typeof community.signer.privateKey !== "string")
            throw Error("Expected local community to expose its owner signer with a private key");
        const communityEdit = await pkc.createCommunityEdit({
            communityAddress: community.address,
            communityEdit: { description: `Deprecated communityAddress sub edit ${Date.now()}` },
            signer: community.signer as SignerType
        });
        await injectWrongCommunityAddress(communityEdit);
        await publishWithExpectedResult({
            publication: communityEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_USES_DEPRECATED_COMMUNITY_ADDRESS
        });
    });

    it("rejects a communityEdit with wrong communityPublicKey", async () => {
        if (!community.signer || !("privateKey" in community.signer) || typeof community.signer.privateKey !== "string")
            throw Error("Expected local community to expose its owner signer with a private key");
        const communityEdit = await pkc.createCommunityEdit({
            communityAddress: community.address,
            communityEdit: { description: `Wrong communityPublicKey sub edit ${Date.now()}` },
            signer: community.signer as SignerType
        });
        await injectWrongCommunityPublicKey(communityEdit);
        await publishWithExpectedResult({
            publication: communityEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_INVALID_COMMUNITY_PUBLIC_KEY
        });
    });

    it("rejects a communityEdit with wrong communityName", async () => {
        if (!community.signer || !("privateKey" in community.signer) || typeof community.signer.privateKey !== "string")
            throw Error("Expected local community to expose its owner signer with a private key");
        const communityEdit = await pkc.createCommunityEdit({
            communityAddress: "wrong-community.eth",
            communityPublicKey: community.address,
            communityEdit: { description: `Wrong communityName sub edit ${Date.now()}` },
            signer: community.signer as SignerType
        });
        await publishWithExpectedResult({
            publication: communityEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_INVALID_COMMUNITY_NAME
        });
    });

    it("rejects a communityEdit with deprecated subplebbitAddress field", async () => {
        if (!community.signer || !("privateKey" in community.signer) || typeof community.signer.privateKey !== "string")
            throw Error("Expected local community to expose its owner signer with a private key");
        const communityEdit = await pkc.createCommunityEdit({
            communityAddress: community.address,
            communityEdit: { description: `Deprecated subplebbitAddress sub edit ${Date.now()}` },
            signer: community.signer as SignerType
        });
        await injectSubplebbitAddress(communityEdit);
        await publishWithExpectedResult({
            publication: communityEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_USES_DEPRECATED_SUBPLEBBIT_ADDRESS
        });
    });
});
