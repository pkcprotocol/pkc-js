import type { PageIpfs, PagesTypeIpfs, PagesTypeJson, PostSort, ReplySort, Timeframe, PageTypeJson, ModQueuePageTypeJson, ModQueuePageIpfs } from "./types.js";
import { Comment } from "../publications/comment/comment.js";
import { PostsPages, RepliesPages } from "./pages.js";
import type { CommentWithinModQueuePageJson, CommentWithinRepliesPostsPageJson, CommentUpdateType } from "../publications/comment/types.js";
import { RemoteCommunity } from "../community/remote-community.js";
import type { LRUCache } from "lru-cache";
import { BaseClientsManager } from "../clients/base-client-manager.js";
import type { CommunityIpfsType } from "../community/types.js";
export declare const TIMEFRAMES_TO_SECONDS: Record<Timeframe, number>;
export declare const POSTS_SORT_TYPES: PostSort;
export declare const POST_REPLIES_SORT_TYPES: ReplySort;
export declare const REPLY_REPLIES_SORT_TYPES: ReplySort;
type CommentToSort = PageIpfs["comments"][0];
export declare function hotScore(comment: CommentToSort): number;
export declare function bestScore(comment: CommentToSort): number;
export declare function controversialScore(comment: CommentToSort): number;
export declare function topScore(comment: CommentToSort): number;
export declare function newScore(comment: CommentToSort): number;
export declare function oldScore(comment: CommentToSort): number;
export declare function mapModqueuePageIpfsCommentToModQueuePageJsonComment(pageComment: ModQueuePageIpfs["comments"][number]): CommentWithinModQueuePageJson;
export declare function mapPageIpfsCommentToPageJsonComment(pageComment: PageIpfs["comments"][0]): CommentWithinRepliesPostsPageJson;
export declare function parsePageIpfs(pageIpfs: PageIpfs): PageTypeJson;
export declare function parseModQueuePageIpfs(modqueuePageIpfs: ModQueuePageIpfs): ModQueuePageTypeJson;
export declare function parsePagesIpfs(pagesRaw: PagesTypeIpfs): Omit<PagesTypeJson, "clients">;
export declare function processAllCommentsRecursively(comments: PageIpfs["comments"], processor: (comment: PageIpfs["comments"][0]) => void): void;
export declare function parseRawPages(pages: PagesTypeIpfs | Omit<PagesTypeJson, "clients"> | RepliesPages | PostsPages | undefined): Pick<RepliesPages | PostsPages, "pages">;
export declare function findCommentInPageInstance(pageInstance: RemoteCommunity["posts"] | Comment["replies"], targetCommentCid: string): PageIpfs["comments"][0] | undefined;
export declare function findCommentInParsedPages(pageJson: PageTypeJson, targetCommentCid: string): PageTypeJson["comments"][0] | undefined;
export declare function findCommentInHierarchicalPageIpfsRecursively(page: PageIpfs, targetCid: string): PageIpfs["comments"][0] | undefined;
export type CommentRuntimeFields = {
    author?: Partial<Pick<Comment["author"], "nameResolved">>;
};
export type PageRuntimeFields = {
    comments?: CommentRuntimeFields[];
};
export declare function buildPageRuntimeFields(page: PageIpfs | ModQueuePageIpfs, cache: LRUCache<string, boolean>): PageRuntimeFields;
export declare function buildPagesRuntimeFields(pages: Record<string, PageIpfs | ModQueuePageIpfs>, cache: LRUCache<string, boolean>): Record<string, PageRuntimeFields>;
export declare function extractParsedPagesRuntimeFields(pages: Record<string, PageTypeJson | ModQueuePageTypeJson | undefined>): Record<string, PageRuntimeFields>;
export declare function extractCommunityRuntimeFieldsFromParsedPages({ postsPages, modQueuePages }: {
    postsPages?: Record<string, PageTypeJson | undefined>;
    modQueuePages?: Record<string, ModQueuePageTypeJson | undefined>;
}): {
    posts?: {
        pages: Record<string, PageRuntimeFields>;
    };
    modQueue?: {
        pages: Record<string, PageRuntimeFields>;
    };
} | undefined;
export declare function findCommentInPageInstanceRecursively(pageInstance: RemoteCommunity["posts"] | Comment["replies"], targetCid: string): PageIpfs["comments"][0] | undefined;
type PagesSource = NonNullable<CommunityIpfsType["posts"]> | NonNullable<CommentUpdateType["replies"] | NonNullable<CommunityIpfsType["modQueue"]>>;
export declare function iterateOverPageCidsToFindAllCids(opts: {
    pages: PagesSource;
    clientManager: BaseClientsManager;
}): Promise<string[]>;
export {};
