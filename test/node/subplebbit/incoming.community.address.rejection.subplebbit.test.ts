import { beforeAll, afterAll, it } from "vitest";
import Logger from "@pkc/pkc-logger";
import {
    createSubWithNoChallenge,
    describeSkipIfRpc,
    disableValidationOfSignatureBeforePublishing,
    ensurePublicationIsSigned,
    mockPlebbit,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { messages } from "../../../dist/node/errors.js";
import { _signJson, cleanUpBeforePublishing } from "../../../dist/node/signer/signatures.js";
import type { Plebbit } from "../../../dist/node/plebbit/plebbit.js";
import type Publication from "../../../dist/node/publications/publication.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { SignerType } from "../../../dist/node/signer/types.js";

type PublicationWithSigner = Publication & { signer?: SignerType };

describeSkipIfRpc.sequential("LocalSubplebbit rejects publications with wrong community address", async () => {
    let plebbit: Plebbit;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let targetPost: Comment;
    let moderatorSigner: SignerType;

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        subplebbit = await createSubWithNoChallenge({}, plebbit);

        await subplebbit.start();
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () => typeof subplebbit.updatedAt === "number"
        });

        targetPost = await publishRandomPost({ communityAddress: subplebbit.address, plebbit });

        moderatorSigner = await plebbit.createSigner();
        const ownerSigner = subplebbit.signer;
        if (!ownerSigner?.address || !("privateKey" in ownerSigner) || typeof ownerSigner.privateKey !== "string")
            throw Error("Expected local subplebbit to have an owner signer with a private key");

        await subplebbit.edit({
            roles: {
                ...(subplebbit.roles || {}),
                [moderatorSigner.address]: { role: "moderator" },
                [ownerSigner.address]: { role: "owner" }
            }
        });
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () =>
                subplebbit.roles?.[moderatorSigner.address]?.role === "moderator" &&
                subplebbit.roles?.[ownerSigner.address]?.role === "owner"
        });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
    });

    // --- helpers ---

    async function injectWrongSubplebbitAddress(publication: PublicationWithSigner) {
        const log = Logger("plebbit-js:test:injectWrongSubplebbitAddress");
        if (!publication.signer) throw Error("Expected publication to have a signer");
        await ensurePublicationIsSigned(publication, subplebbit);

        const orig = publication.raw.pubsubMessageToPublish!;
        const modified = { ...orig } as Record<string, unknown>;
        delete modified.communityPublicKey;
        delete modified.communityName;
        modified.subplebbitAddress = "QmSomeWrongSubplebbitAddress";

        const newSignedProps = [
            ...orig.signature.signedPropertyNames.filter((k) => k !== "communityPublicKey" && k !== "communityName"),
            "subplebbitAddress"
        ];
        modified.signature = await _signJson(newSignedProps, cleanUpBeforePublishing(modified), publication.signer, log);
        publication.raw.pubsubMessageToPublish = modified as typeof orig;
        publication.signature = modified.signature as typeof publication.signature;
        disableValidationOfSignatureBeforePublishing(publication);
    }

    async function injectWrongCommunityPublicKey(publication: PublicationWithSigner) {
        const log = Logger("plebbit-js:test:injectWrongCommunityPublicKey");
        if (!publication.signer) throw Error("Expected publication to have a signer");
        await ensurePublicationIsSigned(publication, subplebbit);

        const orig = publication.raw.pubsubMessageToPublish!;
        const modified = { ...orig, communityPublicKey: "QmFakeWrongCommunityPublicKey" } as Record<string, unknown>;
        const signedProps = orig.signature.signedPropertyNames;
        modified.signature = await _signJson(signedProps, cleanUpBeforePublishing(modified), publication.signer, log);
        publication.raw.pubsubMessageToPublish = modified as typeof orig;
        publication.signature = modified.signature as typeof publication.signature;
        disableValidationOfSignatureBeforePublishing(publication);
    }

    // --- comment ---

    it("rejects a comment with deprecated subplebbitAddress field", async () => {
        const comment = await plebbit.createComment({
            communityAddress: subplebbit.address,
            title: `Deprecated subplebbitAddress comment ${Date.now()}`,
            content: `Content ${Date.now()}`,
            signer: await plebbit.createSigner()
        });
        await injectWrongSubplebbitAddress(comment);
        await publishWithExpectedResult({
            publication: comment,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_USES_DEPRECATED_SUBPLEBBIT_ADDRESS
        });
    });

    it("rejects a comment with wrong communityPublicKey", async () => {
        const comment = await plebbit.createComment({
            communityAddress: subplebbit.address,
            title: `Wrong communityPublicKey comment ${Date.now()}`,
            content: `Content ${Date.now()}`,
            signer: await plebbit.createSigner()
        });
        await injectWrongCommunityPublicKey(comment);
        await publishWithExpectedResult({
            publication: comment,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_INVALID_COMMUNITY_PUBLIC_KEY
        });
    });

    // --- vote ---

    it("rejects a vote with deprecated subplebbitAddress field", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        const vote = await plebbit.createVote({
            commentCid: targetPost.cid,
            vote: 1,
            communityAddress: subplebbit.address,
            signer: await plebbit.createSigner()
        });
        await injectWrongSubplebbitAddress(vote);
        await publishWithExpectedResult({
            publication: vote,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_USES_DEPRECATED_SUBPLEBBIT_ADDRESS
        });
    });

    it("rejects a vote with wrong communityPublicKey", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        const vote = await plebbit.createVote({
            commentCid: targetPost.cid,
            vote: 1,
            communityAddress: subplebbit.address,
            signer: await plebbit.createSigner()
        });
        await injectWrongCommunityPublicKey(vote);
        await publishWithExpectedResult({
            publication: vote,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_INVALID_COMMUNITY_PUBLIC_KEY
        });
    });

    // --- commentEdit ---

    it("rejects a commentEdit with deprecated subplebbitAddress field", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        if (!targetPost.signer) throw Error("Expected target post instance to retain its signer");
        const commentEdit = await plebbit.createCommentEdit({
            commentCid: targetPost.cid,
            content: `Deprecated subplebbitAddress edit ${Date.now()}`,
            communityAddress: subplebbit.address,
            signer: targetPost.signer
        });
        await injectWrongSubplebbitAddress(commentEdit);
        await publishWithExpectedResult({
            publication: commentEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_USES_DEPRECATED_SUBPLEBBIT_ADDRESS
        });
    });

    it("rejects a commentEdit with wrong communityPublicKey", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        if (!targetPost.signer) throw Error("Expected target post instance to retain its signer");
        const commentEdit = await plebbit.createCommentEdit({
            commentCid: targetPost.cid,
            content: `Wrong communityPublicKey edit ${Date.now()}`,
            communityAddress: subplebbit.address,
            signer: targetPost.signer
        });
        await injectWrongCommunityPublicKey(commentEdit);
        await publishWithExpectedResult({
            publication: commentEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_INVALID_COMMUNITY_PUBLIC_KEY
        });
    });

    // --- commentModeration ---

    it("rejects a commentModeration with deprecated subplebbitAddress field", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        const commentModeration = await plebbit.createCommentModeration({
            communityAddress: subplebbit.address,
            commentCid: targetPost.cid,
            commentModeration: { reason: `Deprecated subplebbitAddress mod ${Date.now()}`, spoiler: true },
            signer: moderatorSigner
        });
        await injectWrongSubplebbitAddress(commentModeration);
        await publishWithExpectedResult({
            publication: commentModeration,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_USES_DEPRECATED_SUBPLEBBIT_ADDRESS
        });
    });

    it("rejects a commentModeration with wrong communityPublicKey", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        const commentModeration = await plebbit.createCommentModeration({
            communityAddress: subplebbit.address,
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

    // --- subplebbitEdit ---

    it("rejects a subplebbitEdit with deprecated subplebbitAddress field", async () => {
        if (!subplebbit.signer || !("privateKey" in subplebbit.signer) || typeof subplebbit.signer.privateKey !== "string")
            throw Error("Expected local subplebbit to expose its owner signer with a private key");
        const subplebbitEdit = await plebbit.createSubplebbitEdit({
            communityAddress: subplebbit.address,
            subplebbitEdit: { description: `Deprecated subplebbitAddress sub edit ${Date.now()}` },
            signer: subplebbit.signer as SignerType
        });
        await injectWrongSubplebbitAddress(subplebbitEdit);
        await publishWithExpectedResult({
            publication: subplebbitEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_USES_DEPRECATED_SUBPLEBBIT_ADDRESS
        });
    });

    it("rejects a subplebbitEdit with wrong communityPublicKey", async () => {
        if (!subplebbit.signer || !("privateKey" in subplebbit.signer) || typeof subplebbit.signer.privateKey !== "string")
            throw Error("Expected local subplebbit to expose its owner signer with a private key");
        const subplebbitEdit = await plebbit.createSubplebbitEdit({
            communityAddress: subplebbit.address,
            subplebbitEdit: { description: `Wrong communityPublicKey sub edit ${Date.now()}` },
            signer: subplebbit.signer as SignerType
        });
        await injectWrongCommunityPublicKey(subplebbitEdit);
        await publishWithExpectedResult({
            publication: subplebbitEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_INVALID_COMMUNITY_PUBLIC_KEY
        });
    });
});
