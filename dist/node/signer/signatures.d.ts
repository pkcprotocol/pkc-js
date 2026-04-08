import { PKC } from "../pkc/pkc.js";
import type { ChallengeAnswerMessageSignature, ChallengeAnswerMessageType, ChallengeMessageSignature, ChallengeMessageType, ChallengeRequestMessageSignature, ChallengeRequestMessageType, ChallengeVerificationMessageSignature, ChallengeVerificationMessageType, DecryptedChallengeVerification } from "../pubsub-messages/types.js";
import Logger from "../logger.js";
import { messages } from "../errors.js";
import { BaseClientsManager } from "../clients/base-client-manager.js";
import type { CommunityIpfsType, CommunitySignature } from "../community/types.js";
import type { JsonSignature, PubsubMsgToSign, PubsubSignature, SignerType } from "./types.js";
import type { CommentEditOptionsToSign, CommentEditPubsubMessagePublication, CommentEditSignature } from "../publications/comment-edit/types.js";
import type { VoteOptionsToSign, VotePubsubMessagePublication, VoteSignature } from "../publications/vote/types.js";
import type { CommentIpfsType, CommentIpfsWithCidDefined, CommentIpfsWithCidPostCidDefined, CommentOptionsToSign, CommentPubsubMessagePublication, CommentPubsubMessagPublicationSignature, CommentUpdateForChallengeVerification, CommentUpdateForChallengeVerificationSignature, CommentUpdateSignature, CommentUpdateType } from "../publications/comment/types.js";
import type { ModQueuePageIpfs, PageIpfs } from "../pages/types.js";
import type { CommentModerationOptionsToSign, CommentModerationPubsubMessagePublication, CommentModerationSignature } from "../publications/comment-moderation/types.js";
import type { CommunityEditPublicationOptionsToSign, CommunityEditPublicationSignature, CommunityEditPubsubMessagePublication } from "../publications/community-edit/types.js";
export type ValidationResult = {
    valid: true;
} | {
    valid: false;
    reason: string;
};
export declare const signBufferEd25519: (bufferToSign: Uint8Array, privateKeyBase64: string) => Promise<Uint8Array<ArrayBufferLike>>;
export declare const verifyBufferEd25519: (bufferToSign: Uint8Array, bufferSignature: Uint8Array, publicKeyBase64: string) => Promise<boolean>;
export declare function _signJson(signedPropertyNames: JsonSignature["signedPropertyNames"], cleanedPublication: Object, // should call cleanUpBeforePublish before calling _signJson
signer: SignerType, log: Logger): Promise<JsonSignature>;
export declare function _signPubsubMsg({ signedPropertyNames, msg, // should call cleanUpBeforePublish before calling _signPubsubMsg
signer, log }: {
    signedPropertyNames: PubsubSignature["signedPropertyNames"];
    msg: PubsubMsgToSign;
    signer: SignerType;
    log: Logger;
}): Promise<PubsubSignature>;
export declare function cleanUpBeforePublishing<T>(msg: T): T;
export declare function signComment({ comment, pkc }: {
    comment: CommentOptionsToSign;
    pkc: PKC;
}): Promise<CommentPubsubMessagPublicationSignature>;
export declare function signCommentUpdate({ update, signer }: {
    update: Omit<CommentUpdateType, "signature">;
    signer: SignerType;
}): Promise<CommentUpdateSignature>;
export declare function signCommentUpdateForChallengeVerification({ update, signer }: {
    update: Omit<DecryptedChallengeVerification["commentUpdate"], "signature">;
    signer: SignerType;
}): Promise<CommentUpdateForChallengeVerificationSignature>;
export declare function signVote({ vote, pkc }: {
    vote: VoteOptionsToSign;
    pkc: PKC;
}): Promise<VoteSignature>;
export declare function signCommunityEdit({ communityEdit, pkc }: {
    communityEdit: CommunityEditPublicationOptionsToSign;
    pkc: PKC;
}): Promise<CommunityEditPublicationSignature>;
export declare function signCommentEdit({ edit, pkc }: {
    edit: CommentEditOptionsToSign;
    pkc: PKC;
}): Promise<CommentEditSignature>;
export declare function signCommentModeration({ commentMod, pkc }: {
    commentMod: CommentModerationOptionsToSign;
    pkc: PKC;
}): Promise<CommentModerationSignature>;
export declare function signCommunity({ community, signer }: {
    community: Omit<CommunityIpfsType, "signature">;
    signer: SignerType;
}): Promise<CommunitySignature>;
export declare function signChallengeRequest({ request, signer }: {
    request: Omit<ChallengeRequestMessageType, "signature">;
    signer: SignerType;
}): Promise<ChallengeRequestMessageSignature>;
export declare function signChallengeMessage({ challengeMessage, signer }: {
    challengeMessage: Omit<ChallengeMessageType, "signature">;
    signer: SignerType;
}): Promise<ChallengeMessageSignature>;
export declare function signChallengeAnswer({ challengeAnswer, signer }: {
    challengeAnswer: Omit<ChallengeAnswerMessageType, "signature">;
    signer: SignerType;
}): Promise<ChallengeAnswerMessageSignature>;
export declare function signChallengeVerification({ challengeVerification, signer }: {
    challengeVerification: Omit<ChallengeVerificationMessageType, "signature">;
    signer: SignerType;
}): Promise<ChallengeVerificationMessageSignature>;
export declare function verifyVote({ vote, resolveAuthorNames, clientsManager }: {
    vote: VotePubsubMessagePublication;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
}): Promise<ValidationResult>;
export declare function verifyCommunityEdit({ communityEdit, resolveAuthorNames, clientsManager }: {
    communityEdit: CommunityEditPubsubMessagePublication;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
}): Promise<ValidationResult>;
export declare function verifyCommentEdit({ edit, resolveAuthorNames, clientsManager }: {
    edit: CommentEditPubsubMessagePublication;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
}): Promise<ValidationResult>;
export declare function verifyCommentModeration({ moderation, resolveAuthorNames, clientsManager }: {
    moderation: CommentModerationPubsubMessagePublication;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
}): Promise<ValidationResult>;
export declare function verifyCommentPubsubMessage({ comment, resolveAuthorNames, clientsManager, abortSignal }: {
    comment: CommentPubsubMessagePublication;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    abortSignal?: AbortSignal;
}): Promise<{
    valid: true;
} | {
    valid: false;
    reason: string;
} | {
    valid: boolean;
    reason: messages;
}>;
export declare function verifyCommentIpfs(opts: {
    comment: CommentIpfsType;
    calculatedCommentCid: string;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    communityAddressFromInstance?: string;
    abortSignal?: AbortSignal;
}): ReturnType<typeof verifyCommentPubsubMessage>;
export declare function verifyCommunity({ community, communityIpnsName, resolveAuthorNames, clientsManager, validatePages, cacheIfValid, abortSignal }: {
    community: CommunityIpfsType;
    communityIpnsName: string;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    validatePages: boolean;
    cacheIfValid?: boolean;
    abortSignal?: AbortSignal;
}): Promise<ValidationResult>;
export declare function verifyCommentUpdate({ update, resolveAuthorNames, clientsManager, community, comment, validatePages, validateUpdateSignature, abortSignal }: {
    update: CommentUpdateType | CommentUpdateForChallengeVerification | ModQueuePageIpfs["comments"][0]["commentUpdate"];
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    community: CommunityForVerifyingPages;
    comment: Pick<CommentIpfsWithCidPostCidDefined, "signature" | "cid" | "depth" | "postCid">;
    validatePages: boolean;
    validateUpdateSignature: boolean;
    abortSignal?: AbortSignal;
}): Promise<ValidationResult>;
export declare function verifyChallengeRequest({ request, validateTimestampRange }: {
    request: ChallengeRequestMessageType;
    validateTimestampRange: boolean;
}): Promise<ValidationResult>;
export declare function verifyChallengeMessage({ challenge, pubsubTopic, validateTimestampRange }: {
    challenge: ChallengeMessageType;
    pubsubTopic: string;
    validateTimestampRange: boolean;
}): Promise<ValidationResult>;
export declare function verifyChallengeAnswer({ answer, validateTimestampRange }: {
    answer: ChallengeAnswerMessageType;
    validateTimestampRange: boolean;
}): Promise<ValidationResult>;
export declare function verifyChallengeVerification({ verification, pubsubTopic, validateTimestampRange }: {
    verification: ChallengeVerificationMessageType;
    pubsubTopic: string;
    validateTimestampRange: boolean;
}): Promise<ValidationResult>;
type ParentCommentForVerifyingPages = Pick<CommentIpfsWithCidPostCidDefined, "cid" | "depth" | "postCid"> | Pick<CommentIpfsWithCidDefined, "postCid"> | {
    cid: undefined;
    depth: -1;
    postCid: undefined;
};
type CommunityForVerifyingPages = {
    address: string;
    signature?: CommunityIpfsType["signature"];
};
export declare function verifyPageComment({ pageComment, community, parentComment, resolveAuthorNames, clientsManager, validatePages, validateUpdateSignature, abortSignal }: {
    pageComment: (PageIpfs | ModQueuePageIpfs)["comments"][0];
    community: CommunityForVerifyingPages;
    parentComment: ParentCommentForVerifyingPages | undefined;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    validatePages: boolean;
    validateUpdateSignature: boolean;
    abortSignal?: AbortSignal;
}): Promise<ValidationResult>;
export declare function verifyPage({ pageCid, pageSortName, page, resolveAuthorNames, clientsManager, community, parentComment, validatePages, validateUpdateSignature, abortSignal }: {
    pageCid: string | undefined;
    pageSortName: string | undefined;
    page: PageIpfs;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    community: CommunityForVerifyingPages;
    parentComment: ParentCommentForVerifyingPages;
    validatePages: boolean;
    validateUpdateSignature: boolean;
    abortSignal?: AbortSignal;
}): Promise<ValidationResult>;
export declare function verifyModQueuePage({ pageCid, page, resolveAuthorNames, clientsManager, community, validatePages, validateUpdateSignature, abortSignal }: {
    pageCid: string | undefined;
    page: ModQueuePageIpfs;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    community: CommunityForVerifyingPages;
    validatePages: boolean;
    validateUpdateSignature: boolean;
    abortSignal?: AbortSignal;
}): Promise<ValidationResult>;
export {};
