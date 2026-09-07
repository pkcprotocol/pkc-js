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

// The exclusion settings every page sort receives as string options (settings.pages[].options), defaulting to
// what the generator applies today per scope. A sort file splices them into its own SQL through
// PageSortDb.exclusionClauses so pkc-js keeps the single definition of what "removed" means (issue #73).
export type PageSortExclusionOptionName =
    | "excludeRemovedComments"
    | "excludeDeletedComments"
    | "excludeCommentPendingApproval"
    | "excludeCommentWithApprovedFalse"
    | "excludeCommentsWithDifferentCommunityAddress";

// The read-only sqlite facade handed to page sort files. `prepare` returns better-sqlite3's own Statement so
// authors get the upstream API and docs; anything that would write is rejected at prepare time. Node only:
// page generation runs in the LocalCommunity process.
export interface PageSortDb {
    prepare(sql: string): import("better-sqlite3").Statement;
    exclusionClauses(
        options: Record<string, string | undefined>,
        aliases: { comment: string; update: string; paramPrefix?: string }
    ): { sql: string; params: Record<string, string> };
}

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
