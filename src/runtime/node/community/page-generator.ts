import { calculateStringSizeSameAsIpfsAddCidV0, hideClassPrivateProps, retryKuboIpfsAddAndProvide, timestamp } from "../../../util.js";
import { LocalCommunity } from "./local-community.js";
import assert from "assert";
import type {
    AllPageCids,
    ModQueueCommentInPage,
    ModQueuePageIpfs,
    PageIpfs,
    PageSortExclusionOptionName,
    PostSortName,
    PostsPagesTypeIpfs,
    RepliesPagesTypeIpfs,
    ReplySortName
} from "../../../pages/types.js";
import type { CommentsTableRow, CommentUpdateType } from "../../../publications/comment/types.js";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import env from "../../../version.js";
import { PKCError } from "../../../pkc-error.js";
import type { ResolvedPageSort } from "./page-sorts/index.js";
import type { PageSortScope } from "../../../community/types.js";
import Logger from "../../../logger.js";
import type { CommunityIpfsType } from "../../../community/types.js";
import { cleanUpBeforePublishing, signCommentUpdateForChallengeVerification } from "../../../signer/signatures.js";
import { deriveCommentIpfsFromCommentTableRow } from "../util.js";
import { sha256 } from "js-sha256";

export type PageOptions = {
    excludeRemovedComments: boolean;
    excludeDeletedComments: boolean;
    excludeCommentPendingApproval: boolean; // Exclude comments waiting in mod queue for approval or disapproval
    excludeCommentWithApprovedFalse: boolean; // comment has only {approved: false}
    excludeCommentsWithDifferentCommunityAddress: boolean;
    commentUpdateFieldsToExclude?: (keyof CommentUpdateType)[];
    parentCid: string | null;
    preloadedPage?: PostSortName | ReplySortName; // informational; which sorts embed is decided by settings.pages (issue #73)
    baseTimestamp: number;
    firstPageSizeBytes: number;
};

type SinglePreloadedPageRes = Record<PostSortName | ReplySortName, PageIpfs>;

type PageCidUndefinedIfPreloadedPage = [undefined, ...string[]] | string[];

type AddedPageChunksToIpfsRes = Partial<Record<PostSortName | ReplySortName, { pages: PageIpfs[]; cids: PageCidUndefinedIfPreloadedPage }>>;

// Sorts whose file threw during this generation, keyed by sortName. They are skipped so the remaining sorts still
// publish; the publish paths turn each entry into an error event (ERR_PAGE_SORT_FAILED_TO_GENERATE).
export type FailedPageSorts = Record<string, PKCError>;

export type MultiPageGenerationResult<T extends PostsPagesTypeIpfs | RepliesPagesTypeIpfs> = T & {
    allPageCids: AllPageCids;
    failedSorts: FailedPageSorts;
};

export type PageGenerationResult<T extends PostsPagesTypeIpfs | RepliesPagesTypeIpfs> =
    | MultiPageGenerationResult<T>
    | { singlePreloadedPage: SinglePreloadedPageRes; failedSorts: FailedPageSorts } // every preloaded sort fit in one chunk, nothing else generated
    | undefined; // nothing to paginate

type SortedPageSort = { sort: ResolvedPageSort; comments: PageIpfs["comments"] };

// The wire shape (`{ pages, pageCids? }`) of either generation result. `pages` holds only the preloaded sorts'
// embedded first pages; a preloaded sort that overflowed into more chunks continues through pages[sort].nextCid,
// and a sort that is not embedded is reachable through pageCids only.
export function wirePagesFromGeneration<T extends PostsPagesTypeIpfs | RepliesPagesTypeIpfs>(
    generated: NonNullable<PageGenerationResult<T>>
): T {
    if ("singlePreloadedPage" in generated) return { pages: generated.singlePreloadedPage } as T;
    return { pages: generated.pages, ...(generated.pageCids ? { pageCids: generated.pageCids } : {}) } as T;
}

async function getSerializedCommentsSize(comments: PageIpfs["comments"], hasNextCid: boolean): Promise<number> {
    const payload: PageIpfs = hasNextCid ? { comments, nextCid: "QmXsYKgNH7XoZXdLko5uDvtWSRNE2AXuQ4u8KxVpCacrZx" } : { comments };
    const serializedPayload = JSON.stringify(payload);
    return await calculateStringSizeSameAsIpfsAddCidV0(serializedPayload);
}

export class PageGenerator {
    private _community: LocalCommunity;

    constructor(community: PageGenerator["_community"]) {
        this._community = community;
        hideClassPrivateProps(this);
    }

    private async addQueuedCommentChunksToIpfs(
        chunks: ModQueueCommentInPage[][],
        sortName = "pendingApproval"
    ): Promise<{ pages: ModQueuePageIpfs[]; cids: string[] }> {
        const ipfsClient = this._community._clientsManager.getDefaultKuboRpcClient();
        const listOfPage: ModQueuePageIpfs[] = new Array(chunks.length);
        const cids: string[] = new Array(chunks.length);
        let expectedSize = 1024 * 1024 * Math.pow(2, chunks.length - 1); // expected size of last page
        for (let i = chunks.length - 1; i >= 0; i--) {
            const modQueuePageIpfs: ModQueuePageIpfs = { nextCid: cids[i + 1], comments: chunks[i] };
            if (!modQueuePageIpfs.nextCid) delete modQueuePageIpfs.nextCid; // we don't to include undefined anywhere in the protocol
            const addRes = await retryKuboIpfsAddAndProvide({
                ipfsClient: ipfsClient._client,
                log: Logger("pkc-js:page-generator:addQueuedCommentChunksToIpfs"),
                content: deterministicStringify(modQueuePageIpfs),
                addOptions: { pin: true },
                provideOptions: { recursive: true },
                provideInBackground: true
            });
            if (addRes.size > expectedSize)
                throw new PKCError("ERR_PAGE_GENERATED_IS_OVER_EXPECTED_SIZE", {
                    addRes,
                    pageIpfs: modQueuePageIpfs,
                    expectedSize,
                    sortName,
                    pageNum: i
                });
            cids[i] = addRes.path;
            listOfPage[i] = modQueuePageIpfs;
            expectedSize = expectedSize / 2; // we're going backward now
        }
        return { pages: listOfPage, cids };
    }

    private async addCommentChunksToIpfs(
        chunks: PageIpfs["comments"][],
        sortName: PostSortName | ReplySortName
    ): Promise<AddedPageChunksToIpfsRes> {
        assert(chunks.length > 0);

        const ipfsClient = this._community._clientsManager.getDefaultKuboRpcClient();
        const listOfPage: PageIpfs[] = new Array(chunks.length);
        const cids: string[] = new Array(chunks.length);
        let curMaxPageSize = 1024 * 1024 * Math.pow(2, chunks.length - 1); // expected size of last page
        for (let pageNum = chunks.length - 1; pageNum >= 0; pageNum--) {
            const pageIpfs: PageIpfs = { nextCid: cids[pageNum + 1], comments: chunks[pageNum] };
            if (!pageIpfs.nextCid) delete pageIpfs.nextCid; // we don't to include undefined anywhere in the protocol

            const stringifiedPageIpfs = deterministicStringify(pageIpfs);

            const calculatedSizeOfStringifedPageIpfs = await calculateStringSizeSameAsIpfsAddCidV0(stringifiedPageIpfs);
            if (calculatedSizeOfStringifedPageIpfs > curMaxPageSize)
                throw new PKCError("ERR_PAGE_GENERATED_IS_OVER_EXPECTED_SIZE", {
                    calculatedSizeOfStringifedPageIpfs,
                    pageIpfs,
                    expectedSize: curMaxPageSize,
                    sortName,
                    pageNum
                });

            const addRes = await retryKuboIpfsAddAndProvide({
                ipfsClient: ipfsClient._client,
                log: Logger("pkc-js:page-generator:addCommentChunksToIpfs"),
                content: stringifiedPageIpfs,
                addOptions: { pin: true },
                provideOptions: { recursive: true },
                provideInBackground: true
            });
            if (addRes.size > curMaxPageSize)
                throw new PKCError("ERR_PAGE_GENERATED_IS_OVER_EXPECTED_SIZE", {
                    addRes,
                    pageIpfs,
                    expectedSize: curMaxPageSize,
                    sortName,
                    pageNum
                });
            cids[pageNum] = addRes.path;
            listOfPage[pageNum] = pageIpfs;
            curMaxPageSize = curMaxPageSize / 2; // we're going backward now
        }
        return { [sortName]: { pages: listOfPage, cids } };
    }

    private async addPreloadedCommentChunksToIpfs(
        chunks: PageIpfs["comments"][],
        sortName: PostSortName | ReplySortName
    ): Promise<AddedPageChunksToIpfsRes> {
        const listOfPage: PageIpfs[] = new Array(chunks.length);
        const cids: PageCidUndefinedIfPreloadedPage = [undefined]; // pageCids will never have the cid of preloaded page
        const ipfsClient = this._community._clientsManager.getDefaultKuboRpcClient();
        for (let pageNum = chunks.length - 1; pageNum >= 1; pageNum--) {
            const pageIpfs: PageIpfs = { nextCid: cids[pageNum + 1], comments: chunks[pageNum] };
            if (!pageIpfs.nextCid) delete pageIpfs.nextCid; // we don't to include undefined anywhere in the protocol

            const maximumPageSize = 1024 * 1024 * Math.pow(2, Math.max(pageNum - 1, 0));
            const stringifiedPageIpfs = deterministicStringify(pageIpfs);

            const calculatedSizeOfStringifedPageIpfs = await calculateStringSizeSameAsIpfsAddCidV0(stringifiedPageIpfs);
            if (calculatedSizeOfStringifedPageIpfs > maximumPageSize)
                throw new PKCError("ERR_PAGE_GENERATED_IS_OVER_EXPECTED_SIZE", {
                    calculatedSizeOfStringifedPageIpfs,
                    pageIpfs,
                    maximumPageSize,
                    sortName,
                    pageNum
                });

            const addRes = await retryKuboIpfsAddAndProvide({
                ipfsClient: ipfsClient._client,
                log: Logger("pkc-js:page-generator:addPreloadedCommentChunksToIpfs"),
                content: stringifiedPageIpfs,
                addOptions: { pin: true },
                provideOptions: { recursive: true },
                provideInBackground: true
            });
            if (addRes.size > maximumPageSize)
                throw new PKCError("ERR_PAGE_GENERATED_IS_OVER_EXPECTED_SIZE", {
                    addRes,
                    pageIpfs,
                    maximumPageSize,
                    sortName,
                    pageNum
                });
            cids[pageNum] = addRes.path;
            listOfPage[pageNum] = pageIpfs;
        }
        const firstPage = <PageIpfs>{ comments: chunks[0], nextCid: cids[1] };
        if (!firstPage.nextCid) delete firstPage.nextCid; // every comment fit in the embedded page, nothing to continue to
        listOfPage[0] = firstPage;
        return { [sortName]: { pages: listOfPage, cids } };
    }

    async _chunkComments<T extends PageIpfs["comments"] | ModQueuePageIpfs["comments"]>({
        comments,
        firstPageSizeBytes
    }: {
        comments: T;
        firstPageSizeBytes: number;
    }): Promise<T[]> {
        const FIRST_PAGE_SIZE = firstPageSizeBytes; // dynamic page size for preloaded sorts, 1MB for others
        const SAFETY_MARGIN = 1024; // Use 1KiB margin

        // Calculate overhead with and without nextCid
        const OBJECT_WRAPPER_WITH_CID =
            (await calculateStringSizeSameAsIpfsAddCidV0(
                JSON.stringify(<PageIpfs>{
                    comments: [],
                    nextCid: "QmXsYKgNH7XoZXdLko5uDvtWSRNE2AXuQ4u8KxVpCacrZx" // random cid as a place holder
                })
            )) - 2; // Subtract 2 for empty array "[]"

        const OBJECT_WRAPPER_WITHOUT_CID =
            (await calculateStringSizeSameAsIpfsAddCidV0(
                JSON.stringify(<PageIpfs>{
                    comments: []
                })
            )) - 2; // Subtract 2 for empty array "[]"

        // Quick check for small arrays - if everything fits in one page, no nextCid needed
        const totalSizeWithoutCid = await calculateStringSizeSameAsIpfsAddCidV0(JSON.stringify(<PageIpfs>{ comments }));
        if (totalSizeWithoutCid <= FIRST_PAGE_SIZE) {
            return [comments]; // Single page, no chunking needed
        }

        const chunks: T[] = [];

        let currentChunk = [] as unknown as T;
        let chunkIndex = 0;
        let accumulatedSize = OBJECT_WRAPPER_WITH_CID;

        // Pre-calculate sizes to avoid repeated stringification
        const commentSizes = new Map<number, number>();

        async function getCommentSize(index: number): Promise<number> {
            if (!commentSizes.has(index)) {
                const size = await calculateStringSizeSameAsIpfsAddCidV0(JSON.stringify(comments[index]));
                commentSizes.set(index, size);
            }
            return commentSizes.get(index)!;
        }

        function getCurrentMaxSize(index: number): number {
            if (index === 0) {
                return FIRST_PAGE_SIZE; // First page is dynamic for preloaded
            } else {
                const MB = 1024 * 1024;
                // For preloaded: dynamic page size, 1MB, 2MB, 4MB, etc.
                // For non-preloaded: 1MB, 2MB, 4MB, 8MB, etc.
                return MB * Math.pow(2, index - 1); // index-1 because we want to start with 1MB
            }
        }

        for (let i = 0; i < comments.length; i++) {
            const commentSize = await getCommentSize(i);
            const maxSize = getCurrentMaxSize(chunkIndex);
            const isLastItem = i === comments.length - 1;

            // Add comma if needed
            const commaSize = currentChunk.length > 0 ? 1 : 0;

            // Check if adding this comment would exceed the limit MINUS the safety margin
            if (accumulatedSize + commaSize + commentSize > maxSize - SAFETY_MARGIN) {
                if (currentChunk.length > 0) {
                    chunks.push(currentChunk);
                    currentChunk = [] as unknown as T;
                    chunkIndex++;

                    if (isLastItem) {
                        accumulatedSize = OBJECT_WRAPPER_WITHOUT_CID;
                    } else {
                        accumulatedSize = OBJECT_WRAPPER_WITH_CID;
                    }
                } else if (commentSize > maxSize - SAFETY_MARGIN) {
                    const log = Logger("pkc-js:page-generator:_chunkComments");
                    log.trace(
                        `Single comment at index ${i} (size ${commentSize}) is large relative to page size limit (${maxSize}) for page ${chunkIndex}`
                    );
                    accumulatedSize = isLastItem ? OBJECT_WRAPPER_WITHOUT_CID : OBJECT_WRAPPER_WITH_CID;
                }
            }

            currentChunk.push(comments[i] as any);
            accumulatedSize += commaSize + commentSize;
        }

        if (currentChunk.length > 0) {
            chunks.push(currentChunk);
        }

        return chunks;
    }

    // Apply one sort to a loaded comment set: the file's filter, pinned placement, the maxAge window, then the file's
    // whole-set scorer. Pinned comments sort first and bypass both filters when pinnedFirst is on (the default), so a
    // sticky never ages out of a windowed index; with pinnedFirst off they are ordinary comments.
    sortComments(comments: PageIpfs["comments"], sort: ResolvedPageSort, baseTimestamp: number): PageIpfs["comments"] {
        const db = this._community._dbHandler.createPageSortDb();
        const { options } = sort;
        const pinned = sort.pinnedFirst ? comments.filter((entry) => entry.commentUpdate.pinned === true) : [];
        let unpinned = sort.pinnedFirst ? comments.filter((entry) => entry.commentUpdate.pinned !== true) : comments;
        if (sort.file.filter) {
            const filter = sort.file.filter;
            unpinned = unpinned.filter((entry) =>
                filter({ comment: entry.comment, commentUpdate: entry.commentUpdate, options, baseTimestamp })
            );
        }
        if (typeof sort.maxAgeSeconds === "number") {
            const timestampLower = baseTimestamp - sort.maxAgeSeconds;
            unpinned = unpinned.filter((entry) => entry.comment.timestamp >= timestampLower);
        }
        const survivors = pinned.concat(unpinned);
        if (survivors.length === 0) return [];
        const scores = sort.file.scoreAll({ comments: survivors, db, options, baseTimestamp });
        const scoreOf = (entry: PageIpfs["comments"][number]): number => {
            const score = scores.get(entry.commentUpdate.cid);
            if (typeof score !== "number" || Number.isNaN(score))
                throw Error(`Page sort ${sort.sortName} returned no numeric score for comment ${entry.commentUpdate.cid}`);
            return score;
        };
        const byScoreDesc = (a: PageIpfs["comments"][number], b: PageIpfs["comments"][number]) => scoreOf(b) - scoreOf(a);
        return pinned.sort(byScoreDesc).concat(unpinned.sort(byScoreDesc));
    }

    async sortAndChunkComments(
        unsortedComments: PageIpfs["comments"],
        sort: ResolvedPageSort,
        options: Pick<PageOptions, "baseTimestamp" | "firstPageSizeBytes" | "parentCid">
    ): Promise<PageIpfs["comments"][]> {
        if (unsortedComments.length === 0) throw Error("Should not provide empty array of comments to sort");
        const commentsSorted = this.sortComments(unsortedComments, sort, options.baseTimestamp);
        if (commentsSorted.length === 0) return [];
        return this._chunkComments({ comments: commentsSorted, firstPageSizeBytes: options.firstPageSizeBytes });
    }

    // Resolves to sortedComments
    // this is for non preloaded sorts
    async sortChunkAddIpfsNonPreloaded(
        comments: PageIpfs["comments"],
        sort: ResolvedPageSort,
        options: Pick<PageOptions, "baseTimestamp" | "firstPageSizeBytes" | "parentCid">
    ): Promise<AddedPageChunksToIpfsRes | undefined> {
        const commentsChunks = await this.sortAndChunkComments(comments, sort, options);
        if (commentsChunks.length === 0) return undefined;
        return this.addCommentChunksToIpfs(commentsChunks, sort.sortName);
    }

    // Load the comment set each sort runs over. Sorts that share the same exclusion options (all of them, unless an
    // owner set an exclude* option on one entry) share one query; flat sorts have their own query shape.
    private _createCommentLoader(
        load: (exclusions: Record<PageSortExclusionOptionName, boolean>, flat: boolean) => PageIpfs["comments"]
    ): (sort: ResolvedPageSort) => PageIpfs["comments"] {
        const cache = new Map<string, PageIpfs["comments"]>();
        return (sort) => {
            const exclusions = sort.exclusions;
            const key = `${sort.flat}:${JSON.stringify(exclusions)}`;
            if (!cache.has(key)) cache.set(key, load(exclusions, sort.flat));
            return cache.get(key)!;
        };
    }

    // Generic generation for one scope (community posts, or one comment's replies) from its configured sorts.
    //
    // 1. Every sort is applied to its comment set; a sort whose file throws is recorded in failedSorts and skipped.
    // 2. Preloaded sorts split preloadedPageSizeBytes equally. One whose first chunk does not fit its share drops to
    //    pageCids (it is generated like a non-preloaded sort) while the others still embed.
    // 3. If every surviving preloaded sort fits in a single chunk, the single-page shortcut applies: only those pages
    //    are returned and nothing else is generated (docs/protocol/pages.md, "single-chunk shortcut"). With no
    //    preloaded sort at all there is no shortcut and every sort goes to pageCids.
    // 4. Otherwise preloaded sorts embed their first chunk and add the rest to IPFS; the others add every chunk.
    // Results keep the configured order so `pages` keys tell a client which preloaded sort is the default.
    private async _generatePagesForSorts<T extends PostsPagesTypeIpfs | RepliesPagesTypeIpfs>({
        scope,
        sorts,
        loadComments,
        preloadedPageSizeBytes,
        baseTimestamp,
        parentCid
    }: {
        scope: PageSortScope;
        sorts: ResolvedPageSort[];
        loadComments: (sort: ResolvedPageSort) => PageIpfs["comments"];
        preloadedPageSizeBytes: number;
        baseTimestamp: number;
        parentCid: string | null;
    }): Promise<PageGenerationResult<T>> {
        if (sorts.length === 0) return undefined;
        const failedSorts: FailedPageSorts = {};
        const fail = (sort: ResolvedPageSort, error: unknown) => {
            failedSorts[sort.sortName] = new PKCError("ERR_PAGE_SORT_FAILED_TO_GENERATE", {
                sortName: sort.sortName,
                scope,
                pageSortName: sort.settings.name ?? sort.settings.path,
                error
            });
        };
        const NON_PRELOADED_FIRST_PAGE_SIZE = 1024 * 1024; // pageCids first pages are always capped at 1mib, regardless of the preload budget

        // Load first so the preload budget is split only among preloaded sorts that have something to embed
        const loaded: { sort: ResolvedPageSort; comments: PageIpfs["comments"] }[] = [];
        for (const sort of sorts) {
            try {
                const comments = loadComments(sort);
                if (comments.length > 0) loaded.push({ sort, comments });
            } catch (e) {
                fail(sort, e);
            }
        }
        if (loaded.length === 0) return undefined;

        const preloadedCount = loaded.filter(({ sort }) => sort.preloaded).length;
        const share = preloadedCount > 0 ? Math.floor(preloadedPageSizeBytes / preloadedCount) : 0;
        const preloaded: (SortedPageSort & { chunks: PageIpfs["comments"][] })[] = [];
        const nonPreloaded: (SortedPageSort & { chunks: PageIpfs["comments"][] })[] = [];
        for (const { sort, comments } of loaded) {
            let chunks: PageIpfs["comments"][];
            try {
                chunks = await this.sortAndChunkComments(comments, sort, {
                    baseTimestamp,
                    parentCid,
                    firstPageSizeBytes: sort.preloaded ? share : NON_PRELOADED_FIRST_PAGE_SIZE
                });
            } catch (e) {
                fail(sort, e);
                continue;
            }
            if (chunks.length === 0) continue; // every comment filtered out
            const sortedComments = chunks.flat();
            if (!sort.preloaded) {
                nonPreloaded.push({ sort, comments: sortedComments, chunks });
                continue;
            }
            const firstChunkSize = await getSerializedCommentsSize(chunks[0], chunks.length > 1);
            if (firstChunkSize > share) {
                // Its share of the budget is not enough even for its first chunk: degrade this sort to pageCids
                const rechunked = await this._chunkComments({
                    comments: sortedComments,
                    firstPageSizeBytes: NON_PRELOADED_FIRST_PAGE_SIZE
                });
                nonPreloaded.push({ sort, comments: sortedComments, chunks: rechunked });
            } else preloaded.push({ sort, comments: sortedComments, chunks });
        }
        if (preloaded.length === 0 && nonPreloaded.length === 0) return undefined;

        if (preloaded.length > 0 && preloaded.every(({ chunks }) => chunks.length === 1)) {
            const singlePreloadedPage: SinglePreloadedPageRes = {};
            for (const { sort, chunks } of preloaded) singlePreloadedPage[sort.sortName] = { comments: chunks[0] };
            return { singlePreloadedPage, failedSorts };
        }

        // Full generation. Preloaded first, then the others, each in configured order; IPFS adds run in parallel.
        const results = await Promise.all([
            ...preloaded.map(({ sort, chunks }) => this.addPreloadedCommentChunksToIpfs(chunks, sort.sortName)),
            ...nonPreloaded.map(({ sort, chunks }) => this.addCommentChunksToIpfs(chunks, sort.sortName))
        ]);
        const generatedPages = this._generationResToPages(results) as (T & { allPageCids: AllPageCids }) | undefined;
        if (!generatedPages) return undefined;
        return { ...generatedPages, failedSorts };
    }

    private _generationResToPages(
        res: (AddedPageChunksToIpfsRes | undefined)[]
    ): (PostsPagesTypeIpfs & { allPageCids: AllPageCids }) | undefined {
        const filteredGeneratedPages = res.filter(Boolean); // Take out undefined values
        if (filteredGeneratedPages.length === 0) return undefined;
        const mergedObject: AddedPageChunksToIpfsRes = Object.assign({}, ...filteredGeneratedPages);
        const pages: Record<string, PageIpfs> = {};
        const pageCids: Record<string, string> = {};
        const allPageCids: AllPageCids = {};
        for (const [sortName, data] of Object.entries(mergedObject)) {
            if (!data) continue;
            const firstCid = data.cids[0];
            if (firstCid)
                pageCids[sortName] = firstCid; // pageCids never carries a preloaded sort's first page
            else pages[sortName] = data.pages[0];
            const cids: (string | undefined)[] = data.cids;
            allPageCids[sortName] = cids.filter((c): c is string => typeof c === "string");
        }
        return { pages, ...(Object.keys(pageCids).length > 0 ? { pageCids } : {}), allPageCids };
    }

    private async _pageSortsFor(scope: PageSortScope): Promise<ResolvedPageSort[]> {
        return (await this._community._ensurePageSortsLoaded())[scope];
    }

    async generateCommunityPosts({
        preloadedPageSizeBytes
    }: {
        preloadedPageSizeBytes: number;
    }): Promise<PageGenerationResult<PostsPagesTypeIpfs>> {
        const baseTimestamp = timestamp();
        const sorts = await this._pageSortsFor("posts");
        const loadComments = this._createCommentLoader((exclusions) => {
            const rawPostsUnresolved = this._community._dbHandler.queryPosts({ ...exclusions, parentCid: null });
            if (rawPostsUnresolved.length === 0) return [];
            // Resolve CID-ref replies for each post so pages have full nested reply trees
            return this._community._dbHandler.resolveRepliesCidRefsForEntries(rawPostsUnresolved);
        });
        return this._generatePagesForSorts<PostsPagesTypeIpfs>({
            scope: "posts",
            sorts,
            loadComments,
            preloadedPageSizeBytes,
            baseTimestamp,
            parentCid: null
        });
    }

    async _bundleLatestCommentUpdateWithQueuedComments(queuedComment: CommentsTableRow): Promise<ModQueueCommentInPage> {
        const communityAuthor = this._community._dbHandler.queryCommunityAuthor(queuedComment.authorSignerAddress);
        // Spread the challenge-supplied commentUpdate fields (e.g. `reason`) persisted at storage time
        // so the mod-queue page matches the live challengeverification sent to the publisher. Base
        // fields are spread last so they win. signCommentUpdateForChallengeVerification derives
        // signedPropertyNames from the actual keys, so extras like `reason` are signed automatically.
        const commentUpdateOfVerificationNoSignature = <Omit<ModQueueCommentInPage["commentUpdate"], "signature">>cleanUpBeforePublishing({
            ...(queuedComment.challengeCommentUpdate ?? {}),
            author: { community: communityAuthor },
            cid: queuedComment.cid,
            protocolVersion: env.PROTOCOL_VERSION,
            pendingApproval: true
        });
        const commentUpdate = <ModQueueCommentInPage["commentUpdate"]>{
            ...commentUpdateOfVerificationNoSignature,
            signature: await signCommentUpdateForChallengeVerification({
                update: commentUpdateOfVerificationNoSignature,
                signer: this._community.signer
            })
        };
        const commentIpfs = deriveCommentIpfsFromCommentTableRow(queuedComment);
        return { comment: commentIpfs, commentUpdate };
    }

    async generateModQueuePages(): Promise<(CommunityIpfsType["modQueue"] & { combinedHashOfCids: string }) | undefined> {
        const firstPageSizeBytes = 1024 * 1024;
        const commentsPendingApproval = this._community._dbHandler.queryCommentsPendingApproval();
        if (commentsPendingApproval.length === 0) return undefined;

        const queuedComments: ModQueueCommentInPage[] = await Promise.all(
            commentsPendingApproval.map((comment) => this._bundleLatestCommentUpdateWithQueuedComments(comment))
        );

        const combinedHashOfCids = sha256(queuedComments.map((comment) => comment.commentUpdate.cid).join(""));

        const chunkedQueuedComments = await this._chunkComments({ comments: queuedComments, firstPageSizeBytes });

        const pages = await this.addQueuedCommentChunksToIpfs(chunkedQueuedComments, "pendingApproval");

        return { pageCids: { pendingApproval: pages.cids[0] }, combinedHashOfCids };
    }

    // Reply pages of one comment. Flat sorts (flattened descendant subtree) are generated for post replies only:
    // depth-1+ comments have never had them and one settings.pages.replies list applies at every depth.
    private async _generateRepliesPages(
        comment: Pick<CommentsTableRow, "cid">,
        preloadedPageSizeBytes: number,
        includeFlatSorts: boolean
    ): Promise<PageGenerationResult<RepliesPagesTypeIpfs>> {
        const baseTimestamp = timestamp();
        const sorts = (await this._pageSortsFor("replies")).filter((sort) => includeFlatSorts || !sort.flat);
        const loadComments = this._createCommentLoader((exclusions, flat) => {
            const pageOptions = { ...exclusions, parentCid: comment.cid, baseTimestamp };
            return flat
                ? this._community._dbHandler.queryFlattenedPageReplies({ ...pageOptions, commentUpdateFieldsToExclude: ["replies"] })
                : this._community._dbHandler.queryPageCommentsWithResolvedReplies(pageOptions); // recursive query following CID-ref lists in DB replies to build nested trees
        });
        return this._generatePagesForSorts<RepliesPagesTypeIpfs>({
            scope: "replies",
            sorts,
            loadComments,
            preloadedPageSizeBytes,
            baseTimestamp,
            parentCid: comment.cid
        });
    }

    async generatePostPages(
        comment: Pick<CommentsTableRow, "cid">,
        preloadedPageSizeBytes: number
    ): Promise<PageGenerationResult<RepliesPagesTypeIpfs>> {
        return this._generateRepliesPages(comment, preloadedPageSizeBytes, true);
    }

    async generateReplyPages(
        comment: Pick<CommentsTableRow, "cid" | "depth">,
        preloadedPageSizeBytes: number
    ): Promise<PageGenerationResult<RepliesPagesTypeIpfs>> {
        return this._generateRepliesPages(comment, preloadedPageSizeBytes, false);
    }

    toJSON() {
        return undefined;
    }
}
