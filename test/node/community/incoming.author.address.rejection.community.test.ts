import { beforeAll, afterAll, it, expect } from "vitest";
import Logger from "@pkcprotocol/pkc-logger";
import signers from "../../fixtures/signers.js";
import {
    createSubWithNoChallenge,
    disableValidationOfSignatureBeforePublishing,
    ensurePublicationIsSigned,
    mockPKC,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    setExtraPropOnCommentAndSign,
    setExtraPropOnCommentEditAndSign,
    setExtraPropOnCommentModerationAndSign,
    setExtraPropOnVoteAndSign
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { messages } from "../../../dist/node/errors.js";
import { _signJson, cleanUpBeforePublishing } from "../../../dist/node/signer/signatures.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type Publication from "../../../dist/node/publications/publication.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type Vote from "../../../dist/node/publications/vote/vote.js";
import type { CommentEdit } from "../../../dist/node/publications/comment-edit/comment-edit.js";
import type { CommentModeration } from "../../../dist/node/publications/comment-moderation/comment-moderation.js";
import type CommunityEdit from "../../../dist/node/publications/community-edit/community-edit.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { SignerType } from "../../../dist/node/signer/types.js";

type PublicationKey = "comment" | "vote" | "commentEdit" | "commentModeration" | "communityEdit";

type PublicationWithSigner = Publication & {
    signer?: SignerType;
};

describeSkipIfRpc.sequential("LocalCommunity rejects incoming signed wire author.address", async () => {
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

        targetPost = await publishRandomPost({
            communityAddress: community.address,
            pkc
        });

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

    async function injectSignedAuthorAddressIntoCommunityEdit(communityEdit: CommunityEdit, authorAddress: string) {
        if (!communityEdit.signer) throw Error("Expected communityEdit.signer to be defined");
        await ensurePublicationIsSigned(communityEdit, community);

        const publication = communityEdit.raw.pubsubMessageToPublish!;
        const modifiedPublication = {
            ...publication,
            author: { ...(publication.author || {}), address: authorAddress }
        };
        const signedPropertyNames = publication.signature.signedPropertyNames.includes("author")
            ? publication.signature.signedPropertyNames
            : [...publication.signature.signedPropertyNames, "author"];
        const log = Logger("pkc-js:test:injectSignedAuthorAddressIntoCommunityEdit");

        modifiedPublication.signature = await _signJson(
            signedPropertyNames,
            cleanUpBeforePublishing(modifiedPublication),
            communityEdit.signer,
            log
        );

        communityEdit.raw.pubsubMessageToPublish = modifiedPublication;
        communityEdit.signature = modifiedPublication.signature;
        disableValidationOfSignatureBeforePublishing(communityEdit);
    }

    it("rejects a live incoming comment with signed wire author.address", async () => {
        const comment = await pkc.createComment({
            communityAddress: community.address,
            title: `Reserved author.address comment ${Date.now()}`,
            content: `Reserved author.address comment content ${Date.now()}`,
            signer: await pkc.createSigner()
        });

        await assertPublicationRejectsWireAuthorAddress({
            publication: comment,
            publicationKey: "comment",
            injectAuthorAddress: async (authorAddress) => {
                await ensurePublicationIsSigned(comment, community);
                await setExtraPropOnCommentAndSign(comment, { author: { address: authorAddress } }, true);
            }
        });
    });

    it("rejects a live incoming vote with signed wire author.address", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        const vote = await pkc.createVote({
            commentCid: targetPost.cid,
            vote: 1,
            communityAddress: community.address,
            signer: await pkc.createSigner()
        });

        await assertPublicationRejectsWireAuthorAddress({
            publication: vote,
            publicationKey: "vote",
            injectAuthorAddress: async (authorAddress) => {
                await ensurePublicationIsSigned(vote, community);
                await setExtraPropOnVoteAndSign(vote as Vote, { author: { address: authorAddress } }, true);
            }
        });
    });

    it("rejects a live incoming commentEdit with signed wire author.address", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        if (!targetPost.signer) throw Error("Expected target post instance to retain its signer");
        const commentEdit = await pkc.createCommentEdit({
            commentCid: targetPost.cid,
            content: `Reserved author.address edit ${Date.now()}`,
            communityAddress: community.address,
            signer: targetPost.signer
        });

        await assertPublicationRejectsWireAuthorAddress({
            publication: commentEdit,
            publicationKey: "commentEdit",
            injectAuthorAddress: async (authorAddress) => {
                await ensurePublicationIsSigned(commentEdit, community);
                await setExtraPropOnCommentEditAndSign(commentEdit as CommentEdit, { author: { address: authorAddress } }, true);
            }
        });
    });

    it("rejects a live incoming commentModeration with signed wire author.address", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        const commentModeration = await pkc.createCommentModeration({
            communityAddress: community.address,
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
                await ensurePublicationIsSigned(commentModeration, community);
                await setExtraPropOnCommentModerationAndSign(
                    commentModeration as CommentModeration,
                    { author: { address: authorAddress } },
                    true
                );
            }
        });
    });

    it("rejects a live incoming communityEdit with signed wire author.address", async () => {
        if (!community.signer || !("privateKey" in community.signer) || typeof community.signer.privateKey !== "string")
            throw Error("Expected local community to expose its owner signer with a private key");
        const communityEdit = await pkc.createCommunityEdit({
            communityAddress: community.address,
            communityEdit: {
                description: `Reserved author.address sub edit ${Date.now()}`
            },
            signer: community.signer as SignerType
        });

        await assertPublicationRejectsWireAuthorAddress({
            publication: communityEdit,
            publicationKey: "communityEdit",
            injectAuthorAddress: async (authorAddress) => {
                await injectSignedAuthorAddressIntoCommunityEdit(communityEdit, authorAddress);
            }
        });
    });
});

// RPC skipped because these tests require direct community interaction with crafted wire payloads
describeSkipIfRpc.sequential("LocalCommunity rejects incoming non-domain author.name", async () => {
    let pkc: PKC;
    let community: LocalCommunity | RpcLocalCommunity;
    let targetPost: Comment;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = await createSubWithNoChallenge({}, pkc);

        await community.start();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.updatedAt === "number"
        });

        targetPost = await publishRandomPost({
            communityAddress: community.address,
            pkc
        });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("rejects a comment with author.name set to another user's B58 address", async () => {
        const signer = await pkc.createSigner();
        const comment = await pkc.createComment({
            communityAddress: community.address,
            title: `Spoofed B58 author.name ${Date.now()}`,
            content: `Content ${Date.now()}`,
            signer
        });

        // Inject author.name as a different signer's B58 address (spoofing attempt)
        await ensurePublicationIsSigned(comment, community);
        const currentAuthor = comment.raw.pubsubMessageToPublish!.author || {};
        await setExtraPropOnCommentAndSign(comment, { author: { ...currentAuthor, name: signers[2].address } }, true);

        await publishWithExpectedResult({
            publication: comment,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_NAME_MUST_BE_A_DOMAIN
        });
    });

    it("rejects a comment with author.name set to gibberish (not a domain or B58)", async () => {
        const signer = await pkc.createSigner();
        const comment = await pkc.createComment({
            communityAddress: community.address,
            title: `Gibberish author.name ${Date.now()}`,
            content: `Content ${Date.now()}`,
            signer
        });

        await ensurePublicationIsSigned(comment, community);
        const currentAuthor = comment.raw.pubsubMessageToPublish!.author || {};
        await setExtraPropOnCommentAndSign(comment, { author: { ...currentAuthor, name: "not-a-valid-address" } }, true);

        await publishWithExpectedResult({
            publication: comment,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_NAME_MUST_BE_A_DOMAIN
        });
    });

    it("rejects a vote with author.name set to another user's B58 address", async () => {
        if (!targetPost.cid) throw Error("Expected target post to have a CID");
        const signer = await pkc.createSigner();
        const vote = await pkc.createVote({
            commentCid: targetPost.cid,
            vote: 1,
            communityAddress: community.address,
            signer
        });

        await ensurePublicationIsSigned(vote, community);
        const currentAuthor = vote.raw.pubsubMessageToPublish!.author || {};
        await setExtraPropOnVoteAndSign(vote as Vote, { author: { ...currentAuthor, name: signers[3].address } }, true);

        await publishWithExpectedResult({
            publication: vote,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_NAME_MUST_BE_A_DOMAIN
        });
    });
});
