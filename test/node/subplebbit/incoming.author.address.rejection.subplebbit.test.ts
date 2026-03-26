import { beforeAll, afterAll, it, expect } from "vitest";
import Logger from "@plebbit/plebbit-logger";
import {
    createSubWithNoChallenge,
    describeSkipIfRpc,
    disableValidationOfSignatureBeforePublishing,
    ensurePublicationIsSigned,
    mockPlebbit,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    setExtraPropOnCommentAndSign,
    setExtraPropOnCommentEditAndSign,
    setExtraPropOnCommentModerationAndSign,
    setExtraPropOnVoteAndSign
} from "../../../dist/node/test/test-util.js";
import { messages } from "../../../dist/node/errors.js";
import { _signJson, cleanUpBeforePublishing } from "../../../dist/node/signer/signatures.js";
import type { Plebbit } from "../../../dist/node/plebbit/plebbit.js";
import type Publication from "../../../dist/node/publications/publication.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type Vote from "../../../dist/node/publications/vote/vote.js";
import type { CommentEdit } from "../../../dist/node/publications/comment-edit/comment-edit.js";
import type { CommentModeration } from "../../../dist/node/publications/comment-moderation/comment-moderation.js";
import type SubplebbitEdit from "../../../dist/node/publications/subplebbit-edit/subplebbit-edit.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { SignerType } from "../../../dist/node/signer/types.js";

type PublicationKey = "comment" | "vote" | "commentEdit" | "commentModeration" | "subplebbitEdit";

type PublicationWithSigner = Publication & {
    signer?: SignerType;
};

describeSkipIfRpc.sequential("LocalSubplebbit rejects incoming signed wire author.address", async () => {
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

        targetPost = await publishRandomPost({
            communityAddress: subplebbit.address,
            plebbit
        });

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

    async function assertPublicationRejectsWireAuthorAddress({
        publication,
        publicationKey,
        injectAuthorAddress
    }: {
        publication: PublicationWithSigner;
        publicationKey: PublicationKey;
        injectAuthorAddress: (authorAddress: string) => Promise<void>;
    }) {
        if (!publication.signer?.address) throw Error(`Expected ${publicationKey} publication to have a signer with an address`);
        const forbiddenAuthorAddress = publication.signer.address;

        await injectAuthorAddress(forbiddenAuthorAddress);
        const requestToEncrypt = publication.toJSONPubsubRequestToEncrypt() as Record<
            PublicationKey,
            { author?: { address?: string } } | undefined
        >;
        expect(requestToEncrypt[publicationKey]?.author?.address).to.equal(forbiddenAuthorAddress);

        await publishWithExpectedResult({
            publication,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_AUTHOR_HAS_RESERVED_FIELD
        });
    }

    async function injectSignedAuthorAddressIntoSubplebbitEdit(subplebbitEdit: SubplebbitEdit, authorAddress: string) {
        if (!subplebbitEdit.signer) throw Error("Expected subplebbitEdit.signer to be defined");
        await ensurePublicationIsSigned(subplebbitEdit, subplebbit);

        const publication = subplebbitEdit.raw.pubsubMessageToPublish!;
        const modifiedPublication = {
            ...publication,
            author: { ...(publication.author || {}), address: authorAddress }
        };
        const signedPropertyNames = publication.signature.signedPropertyNames.includes("author")
            ? publication.signature.signedPropertyNames
            : [...publication.signature.signedPropertyNames, "author"];
        const log = Logger("plebbit-js:test:injectSignedAuthorAddressIntoSubplebbitEdit");

        modifiedPublication.signature = await _signJson(
            signedPropertyNames,
            cleanUpBeforePublishing(modifiedPublication),
            subplebbitEdit.signer,
            log
        );

        subplebbitEdit.raw.pubsubMessageToPublish = modifiedPublication;
        subplebbitEdit.signature = modifiedPublication.signature;
        disableValidationOfSignatureBeforePublishing(subplebbitEdit);
    }

    it("rejects a live incoming comment with signed wire author.address", async () => {
        const comment = await plebbit.createComment({
            communityAddress: subplebbit.address,
            title: `Reserved author.address comment ${Date.now()}`,
            content: `Reserved author.address comment content ${Date.now()}`,
            signer: await plebbit.createSigner()
        });

        await assertPublicationRejectsWireAuthorAddress({
            publication: comment,
            publicationKey: "comment",
            injectAuthorAddress: async (authorAddress) => {
                await ensurePublicationIsSigned(comment, subplebbit);
                await setExtraPropOnCommentAndSign(comment, { author: { address: authorAddress } }, true);
            }
        });
    });

    it("rejects a live incoming vote with signed wire author.address", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        const vote = await plebbit.createVote({
            commentCid: targetPost.cid,
            vote: 1,
            communityAddress: subplebbit.address,
            signer: await plebbit.createSigner()
        });

        await assertPublicationRejectsWireAuthorAddress({
            publication: vote,
            publicationKey: "vote",
            injectAuthorAddress: async (authorAddress) => {
                await ensurePublicationIsSigned(vote, subplebbit);
                await setExtraPropOnVoteAndSign(vote as Vote, { author: { address: authorAddress } }, true);
            }
        });
    });

    it("rejects a live incoming commentEdit with signed wire author.address", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        if (!targetPost.signer) throw Error("Expected target post instance to retain its signer");
        const commentEdit = await plebbit.createCommentEdit({
            commentCid: targetPost.cid,
            content: `Reserved author.address edit ${Date.now()}`,
            communityAddress: subplebbit.address,
            signer: targetPost.signer
        });

        await assertPublicationRejectsWireAuthorAddress({
            publication: commentEdit,
            publicationKey: "commentEdit",
            injectAuthorAddress: async (authorAddress) => {
                await ensurePublicationIsSigned(commentEdit, subplebbit);
                await setExtraPropOnCommentEditAndSign(commentEdit as CommentEdit, { author: { address: authorAddress } }, true);
            }
        });
    });

    it("rejects a live incoming commentModeration with signed wire author.address", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        const commentModeration = await plebbit.createCommentModeration({
            communityAddress: subplebbit.address,
            commentCid: targetPost.cid,
            commentModeration: {
                reason: `Reserved author.address moderation ${Date.now()}`,
                spoiler: true
            },
            signer: moderatorSigner
        });

        await assertPublicationRejectsWireAuthorAddress({
            publication: commentModeration,
            publicationKey: "commentModeration",
            injectAuthorAddress: async (authorAddress) => {
                await ensurePublicationIsSigned(commentModeration, subplebbit);
                await setExtraPropOnCommentModerationAndSign(
                    commentModeration as CommentModeration,
                    { author: { address: authorAddress } },
                    true
                );
            }
        });
    });

    it("rejects a live incoming subplebbitEdit with signed wire author.address", async () => {
        if (!subplebbit.signer || !("privateKey" in subplebbit.signer) || typeof subplebbit.signer.privateKey !== "string")
            throw Error("Expected local subplebbit to expose its owner signer with a private key");
        const subplebbitEdit = await plebbit.createSubplebbitEdit({
            communityAddress: subplebbit.address,
            subplebbitEdit: {
                description: `Reserved author.address sub edit ${Date.now()}`
            },
            signer: subplebbit.signer as SignerType
        });

        await assertPublicationRejectsWireAuthorAddress({
            publication: subplebbitEdit,
            publicationKey: "subplebbitEdit",
            injectAuthorAddress: async (authorAddress) => {
                await injectSignedAuthorAddressIntoSubplebbitEdit(subplebbitEdit, authorAddress);
            }
        });
    });
});
