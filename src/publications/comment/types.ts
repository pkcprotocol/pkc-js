import { z } from "zod";
import {
    CommentChallengeRequestToEncryptSchema,
    CommentIpfsSchema,
    CommentPubsubMessagePublicationSchema,
    CommentSignedPropertyNames,
    CommentsTableRowSchema,
    CommentUpdateForChallengeVerificationSchema,
    CommentUpdateForChallengeVerificationSignedPropertyNames,
    CommentUpdateForDisapprovedPendingComment,
    CommentUpdateSchema,
    CommentUpdateSignedPropertyNames,
    CommentUpdateTableRowSchema,
    CreateCommentOptionsSchema
} from "./schema.js";
import { CommunityAuthorSchema } from "../../schema/schema.js";
import { RpcCommentEventResultSchema, RpcCommentUpdateResultSchema } from "../../clients/rpc-client/schema.js";
import type { JsonOfClass, RuntimeAuthorWithCommentUpdateType } from "../../types.js";
import { Comment } from "./comment.js";
import type { RepliesPagesTypeJson } from "../../pages/types.js";
import type { PublicationRpcErrorToTransmit, PublicationState } from "../types.js";
import type { JsonSignature, SignerType } from "../../signer/types.js";
import Publication from "../publication.js";

export type CommunityAuthor = z.infer<typeof CommunityAuthorSchema>;

export type CreateCommentOptions = z.infer<typeof CreateCommentOptionsSchema>;

export type CommentPubsubMessagePublication = z.infer<typeof CommentPubsubMessagePublicationSchema>;

export interface CommentOptionsToSign extends Omit<CommentPubsubMessagePublication, "signature"> {
    signer: SignerType;
    communityAddress: string; // instance-only field from CreateCommentOptions, omitted from wire/signing
}

export type CommentUpdateType = z.infer<typeof CommentUpdateSchema>;

export type CommentUpdateForDisapprovedPendingComment = z.infer<typeof CommentUpdateForDisapprovedPendingComment>;

export type CommentUpdateForChallengeVerification = z.infer<typeof CommentUpdateForChallengeVerificationSchema>;

export type CommentIpfsType = z.infer<typeof CommentIpfsSchema>;

export type CommentChallengeRequestToEncryptType = z.infer<typeof CommentChallengeRequestToEncryptSchema>;

export type RpcCommentUpdateResultType = z.infer<typeof RpcCommentUpdateResultSchema>;
export type RpcCommentResultType = z.infer<typeof RpcCommentEventResultSchema>;

export interface CommentRawField extends Omit<Required<Publication["raw"]>, "pubsubMessageToPublish" | "unsignedPublicationOptions"> {
    comment?: CommentIpfsType;
    commentUpdate?: CommentUpdateType;
    pubsubMessageToPublish?: CommentPubsubMessagePublication;
    commentUpdateFromChallengeVerification?: CommentUpdateForChallengeVerification;
    runtimeFieldsFromRpc?: Record<string, any>;
}

// JSON types

export type CommentJson = JsonOfClass<Comment>;

type AuthorWithShortCommunityAddress = RuntimeAuthorWithCommentUpdateType & { shortAddress: string };

export interface CommentIpfsWithCidDefined extends CommentIpfsType {
    cid: string;
}

export interface CommentIpfsWithCidPostCidDefined extends CommentIpfsWithCidDefined {
    postCid: string;
}

// community.posts.pages.hot.comments[0] will have this shape
export interface CommentWithinRepliesPostsPageJson extends CommentIpfsWithCidPostCidDefined, Omit<CommentUpdateType, "replies"> {
    communityAddress: string;
    communityPublicKey?: string;
    communityName?: string;
    shortCid: string;
    shortCommunityAddress: string;
    author: AuthorWithShortCommunityAddress;
    deleted?: boolean;
    replies?: Omit<RepliesPagesTypeJson, "clients">;
    raw: { comment: CommentIpfsType; commentUpdate: CommentUpdateType };
}

export interface CommentWithinModQueuePageJson extends CommentIpfsWithCidPostCidDefined, CommentUpdateForChallengeVerification {
    communityAddress: string;
    communityPublicKey?: string;
    communityName?: string;
    shortCid: string;
    shortCommunityAddress: string;
    author: AuthorWithShortCommunityAddress;
    raw: { comment: CommentIpfsType; commentUpdate: CommentUpdateForChallengeVerification & { pendingApproval: boolean } };
    pendingApproval: boolean;
}

// Comment states

export type CommentState = PublicationState | "updating";

export type CommentUpdatingState =
    | "stopped"
    | "resolving-author-name"
    | "fetching-ipfs"
    | "fetching-update-ipfs"
    | "resolving-community-name"
    | "fetching-community-ipns"
    | "fetching-community-ipfs"
    | "failed"
    | "succeeded"
    | "waiting-retry";

// Native types here

export interface CommentPubsubMessageWithCommunityAuthor extends CommentPubsubMessagePublication {
    author: RuntimeAuthorWithCommentUpdateType;
}

export interface PostPubsubMessageWithCommunityAuthor extends CommentPubsubMessageWithCommunityAuthor {
    parentCid: undefined;
}

export interface ReplyPubsubMessageWithCommunityAuthor extends CommentPubsubMessageWithCommunityAuthor {
    parentCid: string;
}

// Signatures here

export interface CommentPubsubMessagPublicationSignature extends JsonSignature {
    signedPropertyNames: typeof CommentSignedPropertyNames;
}

export interface CommentUpdateForChallengeVerificationSignature extends JsonSignature {
    signedPropertyNames: typeof CommentUpdateForChallengeVerificationSignedPropertyNames;
}

export interface CommentUpdateSignature extends JsonSignature {
    signedPropertyNames: typeof CommentUpdateSignedPropertyNames;
}

export type MinimumCommentFieldsToFetchPages = Pick<CommentIpfsWithCidDefined, "cid" | "depth" | "postCid"> & { communityAddress: string };

export type CommentRpcErrorToTransmit = PublicationRpcErrorToTransmit & {
    details?: PublicationRpcErrorToTransmit["details"] & {
        newUpdatingState?: Comment["updatingState"];
    };
};

// DB Table

export type CommentsTableRow = z.infer<typeof CommentsTableRowSchema>;

export interface CommentsTableRowInsert extends Omit<CommentsTableRow, "rowid"> {}

// CommentUpdates table

export type CommentUpdatesRow = z.infer<typeof CommentUpdateTableRowSchema>;
export type CommentUpdatesTableRowInsert = CommentUpdatesRow;
