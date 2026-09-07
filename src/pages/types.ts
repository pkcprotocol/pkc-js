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
// what the generator applies today per scope. pkc-js applies them to the comment set and to the `replies` list a
// file receives, so a sort file never decides what "removed" means (issue #73).
export type PageSortExclusionOptionName =
    | "excludeRemovedComments"
    | "excludeDeletedComments"
    | "excludeCommentPendingApproval"
    | "excludeCommentWithApprovedFalse"
    | "excludeCommentsWithDifferentCommunityAddress";

// What a page sort file with `requireReplies` receives per descendant (docs/protocol/page-sorts.md, "Writing a page
// sort file"): the subset of a page entry a sort can reasonably rank on, without the signature, the nested pages or
// the media metadata. A page entry is a superset, so a client passes its walked page entries as they are; the
// community selects exactly these columns, which is what keeps a reply set of a million rows affordable.
export interface PageSortReplyEntry {
    comment: Pick<
        CommentIpfsType,
        | "parentCid"
        | "postCid"
        | "depth"
        | "timestamp"
        | "content"
        | "title"
        | "link"
        | "author"
        | "communityPublicKey"
        | "communityName"
        | "nsfw"
        | "spoiler"
        | "flairs"
    >;
    commentUpdate: Pick<
        CommentUpdateType,
        | "cid"
        | "upvoteCount"
        | "downvoteCount"
        | "replyCount"
        | "childCount"
        | "updatedAt"
        | "lastReplyTimestamp"
        | "pinned"
        | "locked"
        | "removed"
        | "approved"
        | "nsfw"
        | "spoiler"
        | "flairs"
    > & { edit?: Pick<NonNullable<CommentUpdateType["edit"]>, "deleted">; pendingApproval?: boolean };
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
