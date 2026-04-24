import { z } from "zod";
import {
    GetPageParamSchema,
    PageIpfsSchema,
    PostSortNameSchema,
    PostsPagesIpfsSchema,
    RepliesPagesIpfsSchema,
    ReplySortNameSchema
} from "./schema.js";
import type {
    CommentIpfsType,
    CommentUpdateForChallengeVerification,
    CommentUpdateType,
    CommentWithinModQueuePageJson,
    CommentWithinRepliesPostsPageJson
} from "../publications/comment/types.js";
import { JsonOfClass } from "../types.js";
import { PostsPages, RepliesPages } from "./pages.js";

export type PageIpfs = z.infer<typeof PageIpfsSchema>;

export type RepliesPagesTypeIpfs = z.infer<typeof RepliesPagesIpfsSchema>;

export type PostsPagesTypeIpfs = z.infer<typeof PostsPagesIpfsSchema>;

export type PagesTypeIpfs = RepliesPagesTypeIpfs | PostsPagesTypeIpfs;

export type PostSortName = z.infer<typeof PostSortNameSchema>;
export type ReplySortName = z.infer<typeof ReplySortNameSchema>;

export type AllPageCids = Record<ReplySortName | PostSortName, NonNullable<PageIpfs["nextCid"]>[]>;

export type ModQueueSortName = "pendingApproval";

export type Timeframe = "HOUR" | "DAY" | "WEEK" | "MONTH" | "YEAR" | "ALL";

export type SortProps = {
    score: (comment: { comment: CommentIpfsType; commentUpdate: CommentUpdateType }) => number;
    timeframe?: Timeframe;
    flat?: boolean;
};

export type PostSort = Record<PostSortName, SortProps>;

export type ReplySort = Record<ReplySortName, SortProps>;

// JSON types

export interface PageTypeJson extends Omit<PageIpfs, "comments"> {
    comments: CommentWithinRepliesPostsPageJson[];
}

export type PostsPagesTypeJson = JsonOfClass<PostsPages>;
export type RepliesPagesTypeJson = JsonOfClass<RepliesPages>;

export type PagesTypeJson = PostsPagesTypeJson | RepliesPagesTypeJson;

export type ModQueueCommentInPage = {
    comment: CommentIpfsType;
    commentUpdate: CommentUpdateForChallengeVerification & { pendingApproval: true };
};

export type ModQueuePageIpfs = {
    comments: ModQueueCommentInPage[];
    nextCid?: string;
};

export type ModQueuePageTypeJson = {
    comments: CommentWithinModQueuePageJson[];
    nextCid?: string;
};

// GetPage param

export type GetPageParam = z.infer<typeof GetPageParamSchema> & { abortSignal?: AbortSignal };
