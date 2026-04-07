import type {
    PageIpfs,
    PagesTypeIpfs,
    PagesTypeJson,
    PostSort,
    ReplySort,
    Timeframe,
    PageTypeJson,
    ModQueuePageTypeJson,
    ModQueuePageIpfs,
    ModQueueCommentInPage
} from "./types.js";
import { Comment } from "../publications/comment/comment.js";
import assert from "assert";
import { BasePages, PostsPages, RepliesPages } from "./pages.js";

import * as remeda from "remeda";
import type { CommentWithinModQueuePageJson, CommentWithinRepliesPostsPageJson, CommentUpdateType } from "../publications/comment/types.js";
import { shortifyAddress, shortifyCid } from "../util.js";
import { RemoteCommunity } from "../community/remote-community.js";
import { getAuthorDomainFromWire } from "../publications/publication-author.js";
import { getCommunityAddressFromRecord } from "../publications/publication-community.js";
import { sha256 } from "js-sha256";
import type { LRUCache } from "lru-cache";
import { BaseClientsManager } from "../clients/base-client-manager.js";
import { parseJsonWithPKCErrorIfFails, parsePageIpfsSchemaWithPKCErrorIfItFails } from "../schema/schema-util.js";
import type { CommunityIpfsType } from "../community/types.js";
import { buildRuntimeAuthor } from "../publications/publication-author.js";

export const TIMEFRAMES_TO_SECONDS: Record<Timeframe, number> = Object.freeze({
    HOUR: 3600, // 60 * 60
    DAY: 86400, // 60 * 60 * 24
    WEEK: 604800, // 60 * 60 * 24 * 7
    MONTH: 2629746, // Average seconds in a month (60 * 60 * 24 * 30.436875)
    YEAR: 31557600, // Seconds in a year including leap years (60 * 60 * 24 * 365.25)
    ALL: Infinity
});

export const POSTS_SORT_TYPES: PostSort = {
    hot: { score: (...args) => hotScore(...args) },
    new: { score: (...args) => newScore(...args) },
    active: {
        score: (...args) => {
            throw Error("Active sort has no scoring");
        }
    },
    topHour: { timeframe: "HOUR", score: (...args) => topScore(...args) },
    topDay: { timeframe: "DAY", score: (...args) => topScore(...args) },
    topWeek: { timeframe: "WEEK", score: (...args) => topScore(...args) },
    topMonth: { timeframe: "MONTH", score: (...args) => topScore(...args) },
    topYear: { timeframe: "YEAR", score: (...args) => topScore(...args) },
    topAll: { timeframe: "ALL", score: (...args) => topScore(...args) }
};

export const POST_REPLIES_SORT_TYPES: ReplySort = {
    ...remeda.pick(POSTS_SORT_TYPES, ["new"]),
    best: { score: (...args) => bestScore(...args) },
    old: { score: (...args) => oldScore(...args) },
    newFlat: { ...POSTS_SORT_TYPES["new"], flat: true },
    oldFlat: { score: (...args) => oldScore(...args), flat: true }
};

export const REPLY_REPLIES_SORT_TYPES: ReplySort = {
    ...remeda.pick(POSTS_SORT_TYPES, ["new"]),
    best: { score: (...args) => bestScore(...args) },
    old: { score: (...args) => oldScore(...args) }
};

type CommentToSort = PageIpfs["comments"][0];

export function hotScore(comment: CommentToSort) {
    assert(
        typeof comment.commentUpdate.downvoteCount === "number" &&
            typeof comment.commentUpdate.upvoteCount === "number" &&
            typeof comment.comment.timestamp === "number"
    );

    let score = comment.commentUpdate.upvoteCount - comment.commentUpdate.downvoteCount;
    score++; // reddit initial upvotes is 1, pkc is 0
    const order = Math.log10(Math.max(Math.abs(score), 1));
    const sign = score > 0 ? 1 : score < 0 ? -1 : 0;
    const seconds = comment.comment.timestamp - 1134028003;
    return remeda.round(sign * order + seconds / 45000, 7);
}

export function bestScore(comment: CommentToSort) {
    assert(typeof comment.commentUpdate.downvoteCount === "number" && typeof comment.commentUpdate.upvoteCount === "number");

    const originalUpvoteCount = comment.commentUpdate.upvoteCount; // can be 0
    const upvoteCount = comment.commentUpdate.upvoteCount + 1; // reddit initial upvotes is 1, pkc is 0
    const downvoteCount = comment.commentUpdate.downvoteCount;

    // n is the total number of ratings
    const n = originalUpvoteCount + downvoteCount;
    if (n === 0) {
        return 0;
    }

    // zα/2 is the (1-α/2) quantile of the standard normal distribution
    const z = 1.281551565545;

    // p is the observed fraction of positive ratings
    const p = upvoteCount / n;

    const left = p + (1 / (2 * n)) * z * z;
    const right = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    const under = 1 + (1 / n) * z * z;
    return (left - right) / under;
}

export function controversialScore(comment: CommentToSort) {
    assert(typeof comment.commentUpdate.downvoteCount === "number" && typeof comment.commentUpdate.upvoteCount === "number");

    const upvoteCount = comment.commentUpdate.upvoteCount + 1; // reddit initial upvotes is 1, pkc is 0
    if (comment.commentUpdate.downvoteCount <= 0 || upvoteCount <= 0) return 0;
    const magnitude = upvoteCount + comment.commentUpdate.downvoteCount;
    const balance =
        upvoteCount > comment.commentUpdate.downvoteCount
            ? comment.commentUpdate.downvoteCount / upvoteCount
            : upvoteCount / comment.commentUpdate.downvoteCount;
    return Math.pow(magnitude, balance);
}

export function topScore(comment: CommentToSort) {
    assert(typeof comment.commentUpdate.downvoteCount === "number" && typeof comment.commentUpdate.upvoteCount === "number");

    return comment.commentUpdate.upvoteCount - comment.commentUpdate.downvoteCount;
}

export function newScore(comment: CommentToSort) {
    assert(typeof comment.comment.timestamp === "number");
    return comment.comment.timestamp;
}

export function oldScore(comment: CommentToSort) {
    assert(typeof comment.comment.timestamp === "number");

    return -comment.comment.timestamp;
}

export function mapModqueuePageIpfsCommentToModQueuePageJsonComment(
    pageComment: ModQueuePageIpfs["comments"][number]
): CommentWithinModQueuePageJson {
    const postCid = pageComment.comment.postCid ?? (pageComment.comment.depth === 0 ? pageComment.commentUpdate.cid : undefined);
    if (!postCid) throw Error("Failed to infer postCid from pageIpfs.comments.comment");
    const runtimeAuthor = buildRuntimeAuthor({
        author: { ...(pageComment.comment.author || {}), ...(pageComment.commentUpdate.author || {}) },
        signaturePublicKey: pageComment.comment.signature.publicKey
    });

    const communityAddr = getCommunityAddressFromRecord(pageComment.comment as unknown as Record<string, unknown>)!;
    return {
        ...pageComment.comment,
        ...pageComment.commentUpdate,
        signature: pageComment.comment.signature,
        author: {
            ...runtimeAuthor,
            ...(pageComment.commentUpdate.author || {}),
            shortAddress: shortifyAddress(runtimeAuthor.address),
            flairs: pageComment.commentUpdate?.author?.community?.flairs || runtimeAuthor.flairs
        },
        communityAddress: communityAddr,
        shortCid: shortifyCid(pageComment.commentUpdate.cid),
        shortCommunityAddress: shortifyAddress(communityAddr),
        postCid,
        raw: {
            comment: pageComment.comment,
            commentUpdate: pageComment.commentUpdate
        }
    };
}

export function mapPageIpfsCommentToPageJsonComment(pageComment: PageIpfs["comments"][0]): CommentWithinRepliesPostsPageJson {
    const parsedPages = pageComment.commentUpdate.replies ? parsePagesIpfs(pageComment.commentUpdate.replies) : undefined;
    const postCid = pageComment.comment.postCid ?? (pageComment.comment.depth === 0 ? pageComment.commentUpdate.cid : undefined);
    if (!postCid) throw Error("Failed to infer postCid from pageIpfs.comments.comment");
    const runtimeAuthor = buildRuntimeAuthor({
        author: { ...(pageComment.comment.author || {}), ...(pageComment.commentUpdate.author || {}) },
        signaturePublicKey: pageComment.comment.signature.publicKey
    });

    const spoiler =
        typeof pageComment.commentUpdate.spoiler === "boolean"
            ? pageComment.commentUpdate.spoiler
            : typeof pageComment.commentUpdate.edit?.spoiler === "boolean"
              ? pageComment.commentUpdate.edit?.spoiler
              : pageComment.comment.spoiler;

    const nsfw =
        typeof pageComment.commentUpdate.nsfw === "boolean"
            ? pageComment.commentUpdate.nsfw
            : typeof pageComment.commentUpdate.edit?.nsfw === "boolean"
              ? pageComment.commentUpdate.edit?.nsfw
              : pageComment.comment.nsfw;

    const communityAddr = getCommunityAddressFromRecord(pageComment.comment as unknown as Record<string, unknown>)!;
    return {
        ...pageComment.comment,
        ...pageComment.commentUpdate,
        signature: pageComment.comment.signature,
        author: {
            ...runtimeAuthor,
            ...(pageComment.commentUpdate.author || {}),
            shortAddress: shortifyAddress(runtimeAuthor.address),
            flairs:
                pageComment.commentUpdate?.author?.community?.flairs ||
                pageComment.commentUpdate?.edit?.author?.flairs ||
                runtimeAuthor.flairs
        },
        communityAddress: communityAddr,
        shortCid: shortifyCid(pageComment.commentUpdate.cid),
        shortCommunityAddress: shortifyAddress(communityAddr),
        deleted: pageComment.commentUpdate.edit?.deleted,
        replies: parsedPages,
        content: pageComment.commentUpdate.edit?.content || pageComment.comment.content,
        reason: pageComment.commentUpdate.reason,
        spoiler,
        nsfw,
        // TODO flairs merging strategy will likely change — currently: mod flairs > author edit flairs > original comment flairs
        flairs: pageComment.commentUpdate.flairs || pageComment.commentUpdate.edit?.flairs || pageComment.comment.flairs,
        postCid,
        raw: {
            comment: pageComment.comment,
            commentUpdate: pageComment.commentUpdate
        }
    };
}

export function parsePageIpfs(pageIpfs: PageIpfs): PageTypeJson {
    const finalComments = pageIpfs.comments.map(mapPageIpfsCommentToPageJsonComment);

    return { comments: finalComments, ...remeda.omit(pageIpfs, ["comments"]) };
}

export function parseModQueuePageIpfs(modqueuePageIpfs: ModQueuePageIpfs): ModQueuePageTypeJson {
    const finalComments = modqueuePageIpfs.comments.map(mapModqueuePageIpfsCommentToModQueuePageJsonComment);
    return { comments: finalComments, ...remeda.omit(modqueuePageIpfs, ["comments"]) };
}

export function parsePagesIpfs(pagesRaw: PagesTypeIpfs): Omit<PagesTypeJson, "clients"> {
    const keys = remeda.keys.strict(pagesRaw.pages);
    const parsedPages = Object.values(pagesRaw.pages).map((pageIpfs) => parsePageIpfs(pageIpfs));
    const pagesType = remeda.fromEntries.strict(keys.map((key, i) => [key, parsedPages[i]]));
    return { pages: pagesType, pageCids: pagesRaw.pageCids || {} };
}

export function processAllCommentsRecursively(comments: PageIpfs["comments"], processor: (comment: PageIpfs["comments"][0]) => void): void {
    if (!comments || comments.length === 0) return;

    comments.forEach((comment) => processor(comment));

    for (const comment of comments)
        if (comment.commentUpdate.replies?.pages?.best?.comments)
            processAllCommentsRecursively(comment.commentUpdate.replies.pages.best.comments, processor);
}

// To use for both community.posts and comment.replies

export function parseRawPages(
    pages: PagesTypeIpfs | Omit<PagesTypeJson, "clients"> | RepliesPages | PostsPages | undefined
): Pick<RepliesPages | PostsPages, "pages"> {
    if (!pages)
        return {
            pages: {}
        };

    const isIpfs = typeof Object.values(pages.pages)[0]?.comments[0]?.["commentUpdate"]?.["cid"] === "string";

    if (isIpfs) {
        const pagesIpfs = <PagesTypeIpfs>pages;
        // pages is a PagesTypeIpfs
        const parsedPages = parsePagesIpfs(pagesIpfs);
        return { pages: parsedPages.pages };
    } else if (pages instanceof BasePages)
        return { pages: pages.pages }; // already parsed
    else {
        pages = pages as PagesTypeJson;
        // Backward compat: old serialized flat pages may have subplebbitAddress but not communityAddress
        for (const page of Object.values(pages.pages)) {
            if (!page) continue;
            for (const comment of page.comments) {
                if (!comment.communityAddress) {
                    const addr = getCommunityAddressFromRecord(comment as unknown as Record<string, unknown>);
                    if (addr) {
                        comment.communityAddress = addr;
                        comment.shortCommunityAddress = shortifyAddress(addr);
                    }
                }
            }
        }
        return {
            pages: pages.pages
        };
    }
}

// finding comments within pages

export function findCommentInPageInstance(
    pageInstance: RemoteCommunity["posts"] | Comment["replies"],
    targetCommentCid: string
): PageIpfs["comments"][0] | undefined {
    if (!pageInstance) throw Error("should define page ipfs");
    if (!targetCommentCid) throw Error("should define target comment cid");

    for (const page of Object.values(pageInstance.pages))
        if (page) for (const pageComment of page.comments) if (pageComment.cid === targetCommentCid) return pageComment.raw;

    return undefined;
}

export function findCommentInParsedPages(pageJson: PageTypeJson, targetCommentCid: string): PageTypeJson["comments"][0] | undefined {
    if (!pageJson) throw Error("should define page json");
    if (!targetCommentCid) throw Error("should define target comment cid");

    return remeda.find(pageJson.comments, (comment) => comment.cid === targetCommentCid);
}

export function findCommentInHierarchicalPageIpfsRecursively(page: PageIpfs, targetCid: string): PageIpfs["comments"][0] | undefined {
    if (!page) throw Error("should define page ipfs");
    if (!targetCid) throw Error("should define target comment cid");

    for (const pageComment of page.comments) {
        if (pageComment.commentUpdate.cid === targetCid) return pageComment;
        if (pageComment.commentUpdate.replies?.pages) {
            for (const preloadedPage of Object.values(pageComment.commentUpdate.replies.pages)) {
                const result = findCommentInHierarchicalPageIpfsRecursively(preloadedPage, targetCid);
                if (result) return result;
            }
        }
    }
    return undefined;
}

// Runtime fields types — derived from Comment so tsc catches changes
export type CommentRuntimeFields = {
    author?: Partial<Pick<Comment["author"], "nameResolved">>;
};

export type PageRuntimeFields = {
    comments?: CommentRuntimeFields[];
};

function _buildCommentRuntimeFields(
    comment: PageIpfs["comments"][0] | ModQueuePageIpfs["comments"][0],
    cache: LRUCache<string, boolean>
): CommentRuntimeFields {
    const domain = getAuthorDomainFromWire(comment.comment.author);
    if (!domain) return {};
    const key = sha256(domain + comment.comment.signature.publicKey);
    const cached = cache.get(key);
    if (typeof cached !== "boolean") return {};
    return { author: { nameResolved: cached } };
}

export function buildPageRuntimeFields(page: PageIpfs | ModQueuePageIpfs, cache: LRUCache<string, boolean>): PageRuntimeFields {
    return {
        comments: (page.comments as PageIpfs["comments"]).map((c) => {
            const rf: CommentRuntimeFields & { replies?: { pages?: Record<string, PageRuntimeFields> } } = _buildCommentRuntimeFields(
                c,
                cache
            );
            // Recurse into nested preloaded replies
            // Use `replies.pages` path (matches parsed PageTypeJson structure) not `commentUpdate.replies.pages` (raw PageIpfs structure)
            if ("commentUpdate" in c && c.commentUpdate?.replies?.pages) {
                const nestedPages: Record<string, PageRuntimeFields> = {};
                for (const [sortName, nestedPage] of Object.entries(c.commentUpdate.replies.pages)) {
                    nestedPages[sortName] = buildPageRuntimeFields(nestedPage, cache);
                }
                rf.replies = { pages: nestedPages };
            }
            return rf;
        })
    };
}

export function buildPagesRuntimeFields(
    pages: Record<string, PageIpfs | ModQueuePageIpfs>,
    cache: LRUCache<string, boolean>
): Record<string, PageRuntimeFields> {
    const result: Record<string, PageRuntimeFields> = {};
    for (const [sort, page] of Object.entries(pages)) {
        result[sort] = buildPageRuntimeFields(page, cache);
    }
    return result;
}

function extractCommentRuntimeFieldsFromParsedComment(
    comment: PageTypeJson["comments"][number] | ModQueuePageTypeJson["comments"][number]
): CommentRuntimeFields & { replies?: { pages?: Record<string, PageRuntimeFields> } } {
    const runtimeFields: CommentRuntimeFields & { replies?: { pages?: Record<string, PageRuntimeFields> } } = {};
    if (typeof comment.author?.nameResolved === "boolean") runtimeFields.author = { nameResolved: comment.author.nameResolved };

    const repliesPages = "replies" in comment ? comment.replies?.pages : undefined;
    if (repliesPages) {
        const replyRuntimeFields = extractParsedPagesRuntimeFields(repliesPages);
        if (Object.keys(replyRuntimeFields).length > 0) runtimeFields.replies = { pages: replyRuntimeFields };
    }

    return runtimeFields;
}

function extractParsedPageRuntimeFields(page: PageTypeJson | ModQueuePageTypeJson): PageRuntimeFields {
    const comments = page.comments.map(extractCommentRuntimeFieldsFromParsedComment);
    return comments.some((commentRuntimeFields) => Object.keys(commentRuntimeFields).length > 0) ? { comments } : {};
}

export function extractParsedPagesRuntimeFields(
    pages: Record<string, PageTypeJson | ModQueuePageTypeJson | undefined>
): Record<string, PageRuntimeFields> {
    const result: Record<string, PageRuntimeFields> = {};
    for (const [sort, page] of Object.entries(pages)) {
        if (!page) continue;
        const pageRuntimeFields = extractParsedPageRuntimeFields(page);
        if (Object.keys(pageRuntimeFields).length > 0) result[sort] = pageRuntimeFields;
    }
    return result;
}

export function extractCommunityRuntimeFieldsFromParsedPages({
    postsPages,
    modQueuePages
}: {
    postsPages?: Record<string, PageTypeJson | undefined>;
    modQueuePages?: Record<string, ModQueuePageTypeJson | undefined>;
}) {
    const runtimeFields: {
        posts?: { pages: Record<string, PageRuntimeFields> };
        modQueue?: { pages: Record<string, PageRuntimeFields> };
    } = {};

    if (postsPages) {
        const postsRuntimeFields = extractParsedPagesRuntimeFields(postsPages);
        if (Object.keys(postsRuntimeFields).length > 0) runtimeFields.posts = { pages: postsRuntimeFields };
    }

    if (modQueuePages) {
        const modQueueRuntimeFields = extractParsedPagesRuntimeFields(modQueuePages);
        if (Object.keys(modQueueRuntimeFields).length > 0) runtimeFields.modQueue = { pages: modQueueRuntimeFields };
    }

    return Object.keys(runtimeFields).length > 0 ? runtimeFields : undefined;
}

export function findCommentInPageInstanceRecursively(
    pageInstance: RemoteCommunity["posts"] | Comment["replies"],
    targetCid: string
): PageIpfs["comments"][0] | undefined {
    if (!pageInstance) throw Error("should define page instance");
    if (!targetCid) throw Error("should define target comment cid");

    for (const preloadedPage of Object.values(pageInstance.pages)) {
        if (!preloadedPage) continue;

        const pageIpfs = <PageIpfs>{
            comments: preloadedPage.comments.map((parsedPageComment) => parsedPageComment.raw),
            nextCid: preloadedPage.nextCid
        };
        const foundComment = findCommentInHierarchicalPageIpfsRecursively(pageIpfs, targetCid);
        if (foundComment) return foundComment;
    }

    return undefined;
}

const FIRST_PAGE_MAX_FILE_SIZE_BYTES = 1024 * 1024;

type PendingPageCid = { cid: string; maxSize: number };
type PagesSource =
    | NonNullable<CommunityIpfsType["posts"]>
    | NonNullable<CommentUpdateType["replies"] | NonNullable<CommunityIpfsType["modQueue"]>>;

export async function iterateOverPageCidsToFindAllCids(opts: { pages: PagesSource; clientManager: BaseClientsManager }): Promise<string[]> {
    if (!opts?.pages) throw Error("expected pages to be defined when iterating over page cids");
    const { pages, clientManager } = opts;

    const timeoutMs = clientManager._pkc._timeouts["page-ipfs"];
    const visited = new Set<string>();
    const queued = new Map<string, PendingPageCid>();
    const queue: PendingPageCid[] = [];
    const collectedCids: string[] = [];
    const collectedSet = new Set<string>();

    const addCidToResult = (cid: string) => {
        if (collectedSet.has(cid)) return;
        collectedSet.add(cid);
        collectedCids.push(cid);
    };

    const enqueue = (cid: string | undefined, maxSize: number, addToResultFlag = true) => {
        if (typeof cid !== "string" || cid.length === 0 || visited.has(cid)) return;
        if (addToResultFlag) addCidToResult(cid);
        const existingEntry = queued.get(cid);
        if (existingEntry) {
            if (existingEntry.maxSize >= maxSize) return;
            existingEntry.maxSize = maxSize;
            return;
        }
        const entry: PendingPageCid = { cid, maxSize };
        queued.set(cid, entry);
        queue.push(entry);
    };

    const initialPageCids = Array.from(
        new Set(Object.values(pages.pageCids ?? {}).filter((cid): cid is string => typeof cid === "string" && cid.length > 0))
    );
    initialPageCids.forEach((cid) => enqueue(cid, FIRST_PAGE_MAX_FILE_SIZE_BYTES));

    const preloadedPages = "pages" in pages ? Object.values(pages.pages ?? {}) : [];
    for (const preloadedPage of preloadedPages)
        if (typeof preloadedPage?.nextCid === "string" && preloadedPage.nextCid.length > 0)
            enqueue(preloadedPage.nextCid, FIRST_PAGE_MAX_FILE_SIZE_BYTES * 2);

    const fetchPage = async (cid: string, maxSizeBytes: number): Promise<PageIpfs> => {
        const rawPage = await clientManager._fetchCidP2P(cid, { maxFileSizeBytes: maxSizeBytes, timeoutMs });
        const parsedPage = parseJsonWithPKCErrorIfFails(rawPage);
        const pageIpfs = parsePageIpfsSchemaWithPKCErrorIfItFails(parsedPage);
        return pageIpfs;
    };

    while (queue.length) {
        const batch = queue.splice(0);

        // Fetch the current batch concurrently to reduce latency across sorts.
        const batchResults = await Promise.all(
            batch.map(async ({ cid, maxSize }) => {
                if (visited.has(cid)) return { status: "skipped" as const };
                try {
                    const page = await fetchPage(cid, maxSize);
                    return { status: "success" as const, cid, page, maxSize };
                } catch (error) {
                    return { status: "error" as const, cid, error };
                }
            })
        );

        for (const result of batchResults) {
            if (result.status === "skipped") continue;
            if (result.status === "error") {
                visited.add(result.cid);
                queued.delete(result.cid);
                continue;
            }

            const { cid, page, maxSize } = result;
            if (visited.has(cid)) continue;

            visited.add(cid);
            queued.delete(cid);

            if (!page.nextCid || visited.has(page.nextCid)) continue;

            const expectedNextPageSize = Math.max(maxSize * 2, FIRST_PAGE_MAX_FILE_SIZE_BYTES);
            enqueue(page.nextCid, expectedNextPageSize);
        }
    }

    return collectedCids;
}
