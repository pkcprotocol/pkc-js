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
    CreateCommentOptionsSchema,
    OriginalCommentFieldsBeforeCommentUpdateSchema
} from "./schema.js";
import { SubplebbitAuthorSchema } from "../../schema/schema.js";
import { RpcCommentEventResultSchema, RpcCommentUpdateResultSchema } from "../../clients/rpc-client/schema.js";
import type { AuthorTypeWithCommentUpdate, JsonOfClass } from "../../types.js";
import { Comment } from "./comment.js";
import type { RepliesPagesTypeJson } from "../../pages/types.js";
import type { PublicationRpcErrorToTransmit, PublicationState } from "../types.js";
import type { JsonSignature, SignerType } from "../../signer/types.js";
import Publication from "../publication.js";

export type SubplebbitAuthor = z.infer<typeof SubplebbitAuthorSchema>;

export type CreateCommentOptions = z.infer<typeof CreateCommentOptionsSchema>;

export type CommentPubsubMessagePublication = z.infer<typeof CommentPubsubMessagePublicationSchema>;

export interface CommentOptionsToSign extends Omit<CommentPubsubMessagePublication, "signature"> {
    signer: SignerType;
}

export type CommentUpdateType = z.infer<typeof CommentUpdateSchema>;

export type CommentUpdateForDisapprovedPendingComment = z.infer<typeof CommentUpdateForDisapprovedPendingComment>;

export type CommentUpdateForChallengeVerification = z.infer<typeof CommentUpdateForChallengeVerificationSchema>;

export type CommentIpfsType = z.infer<typeof CommentIpfsSchema>;

export type CommentChallengeRequestToEncryptType = z.infer<typeof CommentChallengeRequestToEncryptSchema>;

export type RpcCommentUpdateResultType = z.infer<typeof RpcCommentUpdateResultSchema>;
export type RpcCommentResultType = z.infer<typeof RpcCommentEventResultSchema>;

type CommentOriginalField = z.infer<typeof OriginalCommentFieldsBeforeCommentUpdateSchema>;

export interface CommentRawField extends Omit<Required<Publication["raw"]>, "pubsubMessageToPublish"> {
    comment?: CommentIpfsType;
    commentUpdate?: CommentUpdateType;
    pubsubMessageToPublish?: CommentPubsubMessagePublication;
    commentUpdateFromChallengeVerification?: CommentUpdateForChallengeVerification;
}

// JSON types

export type CommentJson = JsonOfClass<Comment>;

type AuthorWithShortSubplebbitAddress = AuthorTypeWithCommentUpdate & { shortAddress: string };

export interface CommentIpfsWithCidDefined extends CommentIpfsType {
    cid: string;
}

export interface CommentIpfsWithCidPostCidDefined extends CommentIpfsWithCidDefined {
    postCid: string;
}

// subplebbit.posts.pages.hot.comments[0] will have this shape
export interface CommentWithinRepliesPostsPageJson extends CommentIpfsWithCidPostCidDefined, Omit<CommentUpdateType, "replies"> {
    original: CommentOriginalField;
    shortCid: string;
    shortSubplebbitAddress: string;
    author: AuthorWithShortSubplebbitAddress;
    deleted?: boolean;
    replies?: Omit<RepliesPagesTypeJson, "clients">;
    raw: { comment: CommentIpfsType; commentUpdate: CommentUpdateType };
}

export interface CommentWithinModQueuePageJson extends CommentIpfsWithCidPostCidDefined, CommentUpdateForChallengeVerification {
    original: CommentOriginalField;
    shortCid: string;
    shortSubplebbitAddress: string;
    author: AuthorWithShortSubplebbitAddress;
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
    | "fetching-subplebbit-ipns"
    | "fetching-subplebbit-ipfs"
    | "failed"
    | "succeeded"
    | "waiting-retry";

// Native types here

export interface CommentPubsubMessageWithSubplebbitAuthor extends CommentPubsubMessagePublication {
    author: AuthorTypeWithCommentUpdate;
}

export interface PostPubsubMessageWithSubplebbitAuthor extends CommentPubsubMessageWithSubplebbitAuthor {
    parentCid: undefined;
}

export interface ReplyPubsubMessageWithSubplebbitAuthor extends CommentPubsubMessageWithSubplebbitAuthor {
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

export type MinimumCommentFieldsToFetchPages = Pick<CommentIpfsWithCidDefined, "cid" | "subplebbitAddress" | "depth" | "postCid">;

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
