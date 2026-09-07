import { calculateUnixFsDagSizeCidV0, hideClassPrivateProps, retryKuboIpfsAddAndProvide, timestamp } from "../../../util.js";
import v8 from "node:v8";
import { Buffer } from "buffer";
import { LocalCommunity } from "./local-community.js";
import assert from "assert";
import type {
    AllPageCids,
    ModQueueCommentInPage,
    ModQueuePageIpfs,
    PageIpfs,
    PageSortReplyEntry,
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
import {
    applyPageSortExclusions,
    createDescendantsLookup,
    orderPageCommentsByScore,
    partitionPageCommentsForSort,
    scorePageCommentsWithFile,
    stripRepliesFromPageComment
} from "../../../pages/page-sort-client.js";
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

// One sort's added pages: every chunk's CID (the embedded first page of a preloaded sort has none) and, for a
// preloaded sort, the first page as an object, the only page object a generation builds (issue #351).
type AddedPageChunksToIpfsRes = Partial<
    Record<PostSortName | ReplySortName, { firstPage?: PageIpfs; cids: PageCidUndefinedIfPreloadedPage }>
>;

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

type PageComment = PageIpfs["comments"][number];

type SortedPageSort = { sort: ResolvedPageSort; chunks: PageComment[][] };

// The wire shape (`{ pages, pageCids? }`) of either generation result. `pages` holds only the preloaded sorts'
// embedded first pages; a preloaded sort that overflowed into more chunks continues through pages[sort].nextCid,
// and a sort that is not embedded is reachable through pageCids only.
export function wirePagesFromGeneration<T extends PostsPagesTypeIpfs | RepliesPagesTypeIpfs>(
    generated: NonNullable<PageGenerationResult<T>>
): T {
    if ("singlePreloadedPage" in generated) return { pages: generated.singlePreloadedPage } as T;
    return { pages: generated.pages, ...(generated.pageCids ? { pageCids: generated.pageCids } : {}) } as T;
}

const MB = 1024 * 1024;
const NON_PRELOADED_FIRST_PAGE_SIZE = MB; // pageCids first pages are always capped at 1mib, regardless of the preload budget
const SAFETY_MARGIN = 1024; // 1KiB under every page limit when chunking
const NEXT_CID_PLACEHOLDER = "QmXsYKgNH7XoZXdLko5uDvtWSRNE2AXuQ4u8KxVpCacrZx"; // any CIDv0: what a nextCid costs

// A page is its entries' canonical JSON joined inside this wrapper: keys sorted, and "comments" sorts before
// "nextCid", so the join is byte-identical to safe-stable-stringify of the page object (issue #351).
const PAGE_OPEN = '{"comments":[';
const PAGE_CLOSE = "]}";
const pageCloseWithNextCid = (nextCid: string): string => `],"nextCid":${JSON.stringify(nextCid)}}`;
const PAGE_OPEN_BYTES = Buffer.byteLength(PAGE_OPEN);
const PAGE_CLOSE_BYTES = Buffer.byteLength(PAGE_CLOSE);
const PAGE_CLOSE_WITH_CID_BYTES = Buffer.byteLength(pageCloseWithNextCid(NEXT_CID_PLACEHOLDER));

// The UTF-8 size of a page holding entries of the given sizes
function pageBytes(entrySizes: number[], hasNextCid: boolean): number {
    let bytes = PAGE_OPEN_BYTES + (hasNextCid ? PAGE_CLOSE_WITH_CID_BYTES : PAGE_CLOSE_BYTES) + Math.max(entrySizes.length - 1, 0);
    for (const size of entrySizes) bytes += size;
    return bytes;
}

// What `ipfs add` reports for a page of these entries
const pageDagSize = (entrySizes: number[], hasNextCid: boolean): number => calculateUnixFsDagSizeCidV0(pageBytes(entrySizes, hasNextCid));

const SERIALIZE_BATCH = 256; // entries resolved and serialized per database round trip

// How many bytes of serialized entries a community keeps between generations: an eighth of the heap limit (so
// --max-old-space-size scales it), never under 32 MiB or over 512 MiB. Past it, pages re-serialize what they need.
function serializedEntryCacheBudgetBytes(): number {
    const heapLimit = v8.getHeapStatistics().heap_size_limit;
    return Math.min(Math.max(Math.floor(heapLimit / 8), 32 * MB), 512 * MB);
}

// Where a generation's page entries come from once the comment set is loaded: the JSON a page holds for each entry
// (nested reply pages resolved from the database), and the wire object of each (for an embedded page). Both are
// called per bounded batch, so the reply rows a board holds are streamed through, never held at once (issue #351).
export type PageEntrySource = {
    serialize: (entries: PageComment[]) => string[];
    resolve: (entries: PageComment[]) => PageComment[];
};

// Serialized entries kept across generations, by cid, valid while the CommentUpdate's updatedAt is unchanged: a
// CommentUpdate is recalculated (new updatedAt) whenever anything under the comment changes, so the same
// (cid, updatedAt) serializes to the same bytes. Bounded by a byte budget; a changed entry replaces its old bytes,
// a new entry is kept only while the budget allows, and entries a generation did not see are dropped after it, so
// a steady board costs a serialization per changed post and the budget's worth of memory (issue #351).
class EntryJsonCache {
    private _byCid = new Map<string, { updatedAt: number; json: string; bytes: number }>();
    private _bytes = 0;

    constructor(private readonly _budgetBytes: number) {}

    get(entry: PageComment): { json: string; bytes: number } | undefined {
        const cached = this._byCid.get(entry.commentUpdate.cid);
        return cached && cached.updatedAt === entry.commentUpdate.updatedAt ? cached : undefined;
    }

    offer(entry: PageComment, json: string, bytes: number): void {
        const cid = entry.commentUpdate.cid;
        const previous = this._byCid.get(cid);
        const budgetAfter = this._bytes - (previous?.bytes ?? 0) + bytes;
        if (budgetAfter > this._budgetBytes) {
            if (previous) this._drop(cid);
            return;
        }
        this._byCid.set(cid, { updatedAt: entry.commentUpdate.updatedAt, json, bytes });
        this._bytes = budgetAfter;
    }

    // Keep only the cids a generation listed (a purged or excluded post frees its bytes)
    retainOnly(cids: Set<string>): void {
        for (const cid of [...this._byCid.keys()]) if (!cids.has(cid)) this._drop(cid);
    }

    private _drop(cid: string): void {
        const cached = this._byCid.get(cid);
        if (!cached) return;
        this._byCid.delete(cid);
        this._bytes -= cached.bytes;
    }
}

// Admission by bytes for the pages being built at once: sorts add their pages in parallel, but a page's string (its
// entries fetched plus the join) lives in memory until its add returns, and the doubling page sizes make late pages
// of a large board hundreds of MiB. A page waits until the bytes in flight fit the budget; one that exceeds the
// budget alone runs when nothing else is in flight, so generation always makes progress (issue #351).
class PageBytesBudget {
    private _inFlight = 0;
    private _waiting: { bytes: number; resume: () => void }[] = [];

    constructor(private readonly _budgetBytes: number) {}

    private _fits(bytes: number): boolean {
        return this._inFlight === 0 || this._inFlight + bytes <= this._budgetBytes;
    }

    async acquire(bytes: number): Promise<() => void> {
        if (this._fits(bytes)) this._inFlight += bytes;
        else await new Promise<void>((resume) => this._waiting.push({ bytes, resume })); // counted by the release that admits it
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this._inFlight -= bytes;
            // Admit waiters in arrival order while they fit, counting each before it resumes so a caller that
            // releases and acquires again in the same tick cannot slip in ahead of it
            for (let i = 0; i < this._waiting.length; ) {
                if (!this._fits(this._waiting[i].bytes)) {
                    i++;
                    continue;
                }
                const [next] = this._waiting.splice(i, 1);
                this._inFlight += next.bytes;
                next.resume();
            }
        };
    }
}

// The serialized form of one generation's entries: each entry's canonical page JSON and that JSON's UTF-8 size.
// Sizes are kept for every entry, since every sort's chunking needs them; the strings live in the cache, so a
// board's resolved reply trees are never all in memory. Sizing streams: entries the cache does not hold are
// resolved and serialized a batch at a time; a page fetches what the cache does not hold in one batch when it is
// built (issue #351).
class SerializedEntries {
    private _sizes = new Map<PageComment, number>();

    constructor(
        private readonly _source: PageEntrySource,
        private readonly _cache: EntryJsonCache
    ) {}

    sizeAll(entries: PageComment[]): void {
        const pending: PageComment[] = [];
        for (const entry of entries) {
            if (this._sizes.has(entry)) continue;
            const cached = this._cache.get(entry);
            if (cached) this._sizes.set(entry, cached.bytes);
            else pending.push(entry);
        }
        for (let start = 0; start < pending.length; start += SERIALIZE_BATCH) {
            const batch = pending.slice(start, start + SERIALIZE_BATCH);
            const strings = this._source.serialize(batch);
            for (let i = 0; i < batch.length; i++) {
                const bytes = Buffer.byteLength(strings[i]);
                this._sizes.set(batch[i], bytes);
                this._cache.offer(batch[i], strings[i], bytes);
            }
        }
    }

    sizeOf = (entry: PageComment): number => {
        const size = this._sizes.get(entry);
        assert(size !== undefined, "entry was not serialized before chunking");
        return size;
    };

    // The JSON of each entry, in the given order
    stringsOf(entries: PageComment[]): string[] {
        const strings: string[] = new Array(entries.length);
        const missing: number[] = [];
        for (let i = 0; i < entries.length; i++) {
            const cached = this._cache.get(entries[i]);
            if (cached) strings[i] = cached.json;
            else missing.push(i);
        }
        for (let start = 0; start < missing.length; start += SERIALIZE_BATCH) {
            const indexes = missing.slice(start, start + SERIALIZE_BATCH);
            const serialized = this._source.serialize(indexes.map((i) => entries[i]));
            for (let k = 0; k < indexes.length; k++) strings[indexes[k]] = serialized[k];
        }
        return strings;
    }
}

export class PageGenerator {
    private _community: LocalCommunity;
    private _postEntryCache: EntryJsonCache | undefined; // post page entries across generations, see EntryJsonCache

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
        let expectedSize = MB * Math.pow(2, chunks.length - 1); // expected size of last page
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

    // Add one sort's chunks, last page first so each page knows its nextCid. Every page is the join of its entries'
    // serialized JSON, sized exactly before the add; a preloaded sort's first chunk is not added but returned as the
    // page object the record embeds (its entries materialized from the database, nested replies resolved).
    private async _addChunksToIpfs({
        chunks,
        sortName,
        serialized,
        embedFirst,
        source,
        budget
    }: {
        chunks: PageComment[][];
        sortName: PostSortName | ReplySortName;
        serialized: SerializedEntries;
        embedFirst: boolean;
        source: PageEntrySource;
        budget: PageBytesBudget;
    }): Promise<AddedPageChunksToIpfsRes> {
        assert(chunks.length > 0);
        const cids: (string | undefined)[] = new Array(chunks.length);
        for (let pageNum = chunks.length - 1; pageNum >= (embedFirst ? 1 : 0); pageNum--) {
            const nextCid = cids[pageNum + 1];
            // pageCids pages may grow 1, 2, 4... MiB; the pages after an embedded first page start at 1 MiB
            const maximumPageSize = MB * Math.pow(2, embedFirst ? Math.max(pageNum - 1, 0) : pageNum);
            const entries = chunks[pageNum];
            const entrySizes = entries.map(serialized.sizeOf);
            const calculatedSize = pageDagSize(entrySizes, nextCid !== undefined);
            if (calculatedSize > maximumPageSize)
                throw new PKCError("ERR_PAGE_GENERATED_IS_OVER_EXPECTED_SIZE", {
                    calculatedSizeOfStringifedPageIpfs: calculatedSize,
                    expectedSize: maximumPageSize,
                    commentCount: entries.length,
                    sortName,
                    pageNum
                });
            // the entries' strings plus their join are both held until the add returns
            const release = await budget.acquire(2 * pageBytes(entrySizes, nextCid !== undefined));
            try {
                cids[pageNum] = await this._buildAndAddPage({ entries, nextCid, serialized, maximumPageSize, sortName, pageNum });
            } finally {
                release();
            }
        }
        if (!embedFirst) return { [sortName]: { cids: cids as string[] } };
        const firstPage: PageIpfs = { comments: source.resolve(chunks[0]) };
        if (cids[1]) firstPage.nextCid = cids[1]; // else every comment fit in the embedded page, nothing to continue to
        return { [sortName]: { firstPage, cids: cids as PageCidUndefinedIfPreloadedPage } };
    }

    // Build one page's string and add it. Its own function on purpose: a suspended async function keeps its
    // registers, so a page string built inside the loop of _addChunksToIpfs would stay alive while the loop waits for
    // the next page's budget; here it dies with this frame as soon as the add returns (issue #351).
    private async _buildAndAddPage({
        entries,
        nextCid,
        serialized,
        maximumPageSize,
        sortName,
        pageNum
    }: {
        entries: PageComment[];
        nextCid: string | undefined;
        serialized: SerializedEntries;
        maximumPageSize: number;
        sortName: PostSortName | ReplySortName;
        pageNum: number;
    }): Promise<string> {
        const content = PAGE_OPEN + serialized.stringsOf(entries).join(",") + (nextCid ? pageCloseWithNextCid(nextCid) : PAGE_CLOSE);
        const addRes = await retryKuboIpfsAddAndProvide({
            ipfsClient: this._community._clientsManager.getDefaultKuboRpcClient()._client,
            log: Logger("pkc-js:page-generator:addChunksToIpfs"),
            content,
            addOptions: { pin: true },
            provideOptions: { recursive: true },
            provideInBackground: true
        });
        if (addRes.size > maximumPageSize)
            throw new PKCError("ERR_PAGE_GENERATED_IS_OVER_EXPECTED_SIZE", {
                addRes,
                expectedSize: maximumPageSize,
                commentCount: entries.length,
                sortName,
                pageNum
            });
        return addRes.path;
    }

    // Split comments into pages: the first under firstPageSizeBytes, then 1, 2, 4... MiB, each 1 KiB under its limit.
    // A comment counts as what `ipfs add` would report for its JSON alone, so the sum overestimates the page by a few
    // bytes per comment; `sizeOf` gives an entry's UTF-8 JSON size when the caller already serialized it (the page
    // generator does, once per entry for every sort), else each comment is stringified here.
    _chunkComments<T extends PageIpfs["comments"] | ModQueuePageIpfs["comments"]>({
        comments,
        firstPageSizeBytes,
        sizeOf
    }: {
        comments: T;
        firstPageSizeBytes: number;
        sizeOf?: (entry: T[number]) => number;
    }): T[] {
        const FIRST_PAGE_SIZE = firstPageSizeBytes; // dynamic page size for preloaded sorts, 1MB for others
        const bytesOf = sizeOf ?? ((entry: T[number]) => Buffer.byteLength(JSON.stringify(entry)));
        const entryBytes: number[] = new Array(comments.length);
        for (let i = 0; i < comments.length; i++) entryBytes[i] = bytesOf(comments[i]);

        // Quick check for small arrays - if everything fits in one page, no nextCid needed
        if (pageDagSize(entryBytes, false) <= FIRST_PAGE_SIZE) return [comments]; // Single page, no chunking needed

        // The wrapper's cost with and without nextCid, minus the 2 bytes of the empty array
        const OBJECT_WRAPPER_WITH_CID = pageDagSize([], true) - 2;
        const OBJECT_WRAPPER_WITHOUT_CID = pageDagSize([], false) - 2;

        const chunks: T[] = [];
        let currentChunk = [] as unknown as T;
        let chunkIndex = 0;
        let accumulatedSize = OBJECT_WRAPPER_WITH_CID;

        // The first page is dynamic; the pages after it 1MB, 2MB, 4MB...
        const getCurrentMaxSize = (index: number): number => (index === 0 ? FIRST_PAGE_SIZE : MB * Math.pow(2, index - 1));

        for (let i = 0; i < comments.length; i++) {
            const commentSize = calculateUnixFsDagSizeCidV0(entryBytes[i]);
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
                    accumulatedSize = isLastItem ? OBJECT_WRAPPER_WITHOUT_CID : OBJECT_WRAPPER_WITH_CID;
                } else if (commentSize > maxSize - SAFETY_MARGIN) {
                    const log = Logger("pkc-js:page-generator:_chunkComments");
                    log.trace(
                        `Single comment at index ${i} (size ${commentSize}) is large relative to page size limit (${maxSize}) for page ${chunkIndex}`
                    );
                    accumulatedSize = isLastItem ? OBJECT_WRAPPER_WITHOUT_CID : OBJECT_WRAPPER_WITH_CID;
                }
            }

            (currentChunk as unknown[]).push(comments[i]);
            accumulatedSize += commaSize + commentSize;
        }

        if (currentChunk.length > 0) chunks.push(currentChunk);

        return chunks;
    }

    // Apply one sort to a loaded comment set: pinned placement, the maxAge window (both shared with the client-side
    // sorter so a client reproduces the same set), then the file's `score` per comment, which drops what it declines.
    // The exclusions were already applied by the SQL that loaded the set, and to `replies` (the scope's descendants,
    // loaded once per generation and only for a file that declares requireReplies).
    sortComments(
        comments: PageIpfs["comments"],
        sort: ResolvedPageSort,
        baseTimestamp: number,
        replies?: PageSortReplyEntry[],
        stripEntry?: (entry: PageComment) => PageComment,
        streamReplies?: (ordered: PageComment[]) => (cid: string) => PageSortReplyEntry[]
    ): PageIpfs["comments"] {
        const { options } = sort;
        const { pinned, unpinned } = partitionPageCommentsForSort({ comments, reserved: sort, baseTimestamp });
        if (pinned.length + unpinned.length === 0) return [];
        // a requireReplies post sort scores pinned then unpinned in this order, and the provider streams subtrees along it
        const descendantsOf = streamReplies && sort.file.requireReplies ? streamReplies([...pinned, ...unpinned]) : undefined;
        return orderPageCommentsByScore({
            pinned,
            unpinned,
            sortName: sort.sortName,
            scoreOf: scorePageCommentsWithFile({ file: sort.file, options, baseTimestamp, replies, stripEntry, descendantsOf })
        });
    }

    async sortAndChunkComments(
        unsortedComments: PageIpfs["comments"],
        sort: ResolvedPageSort,
        options: Pick<PageOptions, "baseTimestamp" | "firstPageSizeBytes" | "parentCid"> & {
            replies?: PageSortReplyEntry[];
            sizeOf?: (entry: PageComment) => number;
            stripEntry?: (entry: PageComment) => PageComment;
            streamReplies?: (ordered: PageComment[]) => (cid: string) => PageSortReplyEntry[];
        }
    ): Promise<PageIpfs["comments"][]> {
        if (unsortedComments.length === 0) throw Error("Should not provide empty array of comments to sort");
        const commentsSorted = this.sortComments(
            unsortedComments,
            sort,
            options.baseTimestamp,
            options.replies,
            options.stripEntry,
            options.streamReplies
        );
        if (commentsSorted.length === 0) return [];
        return this._chunkComments({ comments: commentsSorted, firstPageSizeBytes: options.firstPageSizeBytes, sizeOf: options.sizeOf });
    }

    // The reply set requireReplies sorts score over: one unfiltered query per generation, shared by every such sort,
    // each filtering it with its own exclusion options in JS (the same filter a client applies before sortPageComments
    // scores). Nothing runs unless a sort asks.
    private _createRepliesLoader(load: () => PageSortReplyEntry[]): (sort: ResolvedPageSort) => PageSortReplyEntry[] {
        let all: PageSortReplyEntry[] | undefined;
        const filtered = new Map<string, PageSortReplyEntry[]>();
        return (sort) => {
            all ??= load();
            const key = JSON.stringify(sort.exclusions);
            if (!filtered.has(key))
                filtered.set(
                    key,
                    applyPageSortExclusions({ comments: all, exclusions: sort.exclusions, communityAddress: this._community.address })
                );
            return filtered.get(key)!;
        };
    }

    // The reply set a requireReplies post sort scores over, streamed: the provider walks the posts in the order the
    // scorer asks for them and loads one batch of posts' subtrees at a time (lean entries, the sort's exclusions
    // applied), so a board's replies are never in memory at once; the file still receives each post's whole subtree
    // (issue #351). A post asked out of order (never, in practice) just loads its own batch.
    private _createStreamingRepliesProvider(sort: ResolvedPageSort): (ordered: PageComment[]) => (cid: string) => PageSortReplyEntry[] {
        const db = this._community._dbHandler;
        const communityAddress = this._community.address;
        return (ordered) => {
            const indexOf = new Map(ordered.map((entry, index) => [entry.commentUpdate.cid, index]));
            let batchStart = -1;
            let batchEnd = -1;
            let descendantsOf: ((cid: string) => PageSortReplyEntry[]) | undefined;
            return (cid) => {
                const index = indexOf.get(cid);
                if (index === undefined) return [];
                if (index < batchStart || index >= batchEnd || !descendantsOf) {
                    batchStart = index;
                    batchEnd = Math.min(index + SERIALIZE_BATCH, ordered.length);
                    const replies = db.queryAllRepliesForPageSort({
                        postCids: ordered.slice(batchStart, batchEnd).map((entry) => entry.commentUpdate.cid)
                    });
                    descendantsOf = createDescendantsLookup(
                        applyPageSortExclusions({ comments: replies, exclusions: sort.exclusions, communityAddress })
                    );
                }
                return descendantsOf(cid);
            };
        };
    }

    // Load the comment set each sort runs over. Sorts that share the same exclusion options (all of them, unless an
    // owner set an exclude* option on one entry) share one query; flat sorts have their own query shape.
    private _createCommentLoader(
        load: (exclusions: Record<PageSortExclusionOptionName, boolean>, flat: boolean) => PageIpfs["comments"]
    ): ((sort: ResolvedPageSort) => PageIpfs["comments"]) & { loaded: () => PageIpfs["comments"] } {
        const cache = new Map<string, PageIpfs["comments"]>();
        const loader = (sort: ResolvedPageSort) => {
            const exclusions = sort.exclusions;
            const key = `${sort.flat}:${JSON.stringify(exclusions)}`;
            if (!cache.has(key)) cache.set(key, load(exclusions, sort.flat));
            return cache.get(key)!;
        };
        loader.loaded = () => [...cache.values()].flat(); // every entry any sort of this generation loaded
        return loader;
    }

    // Generic generation for one scope (community posts, or one comment's replies) from its configured sorts.
    //
    // 1. Every sort is applied to its comment set; a sort whose file throws is recorded in failedSorts and skipped.
    //    Loading the comment set is pkc-js's own code, so an error there (a busy sqlite, a malformed row) propagates
    //    and aborts the cycle, leaving the last good record published; the sync loop retries next cycle.
    // 2. Preloaded sorts split preloadedPageSizeBytes equally. One whose first chunk does not fit its share drops to
    //    pageCids (it is generated like a non-preloaded sort) while the others still embed.
    // 3. If every preloaded sort fits in a single chunk, the single-page shortcut applies: only those pages are returned
    //    and nothing else is generated (docs/protocol/pages.md, "single-chunk shortcut"). Skipping the other sorts is
    //    only sound when a client holding the embedded pages can build them locally, so when any sort would be
    //    skipped (a non-preloaded or demoted one) every embedded page must hold the whole comment set: a windowed or
    //    filtered preloaded sort next to other sorts takes the full path instead. With no preloaded sort at all there
    //    is no shortcut and every sort goes to pageCids.
    // 4. Otherwise preloaded sorts embed their first chunk and add the rest to IPFS; the others add every chunk.
    // Results keep the configured order so `pages` keys tell a client which preloaded sort is the default.
    //
    // The comment sets are lean: an entry carries its DB-format reply refs, which `score` never sees since `replies`
    // is stripped. What a page holds for an entry comes from `source`, which resolves a batch's nested reply pages
    // from rows; entries are sized through SerializedEntries (serialized a batch at a time, strings kept in the
    // entry cache while its budget allows) and fetched per page when built, so a sort costs an ordered list of
    // references, and a board's reply trees stream through instead of being held at once (issue #351).
    private async _generatePagesForSorts<T extends PostsPagesTypeIpfs | RepliesPagesTypeIpfs>({
        scope,
        sorts,
        loadComments,
        loadReplies,
        streamReplies,
        source,
        entryCache,
        preloadedPageSizeBytes,
        baseTimestamp,
        parentCid
    }: {
        scope: PageSortScope;
        sorts: ResolvedPageSort[];
        loadComments: (sort: ResolvedPageSort) => PageIpfs["comments"];
        loadReplies?: (sort: ResolvedPageSort) => PageSortReplyEntry[]; // the scope's descendants at once (reply scope), for a requireReplies file
        streamReplies?: (sort: ResolvedPageSort) => (ordered: PageComment[]) => (cid: string) => PageSortReplyEntry[]; // or streamed (post scope)
        source: PageEntrySource;
        entryCache: EntryJsonCache;
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

        // Load first so the preload budget is split only among preloaded sorts that have something to embed. Not
        // inside the per-sort net: only the sort file's own code may fail a single sort (see 1. above).
        const loaded: { sort: ResolvedPageSort; comments: PageIpfs["comments"]; replies?: PageSortReplyEntry[] }[] = [];
        for (const sort of sorts) {
            const comments = loadComments(sort);
            if (comments.length > 0)
                loaded.push({ sort, comments, ...(sort.file.requireReplies && loadReplies ? { replies: loadReplies(sort) } : {}) });
        }
        if (loaded.length === 0) return undefined;

        const serialized = new SerializedEntries(source, entryCache);
        for (const { comments } of loaded) serialized.sizeAll(comments); // one serialization per entry, shared by every sort
        const strippedEntries = new Map<PageComment, PageComment>(); // what `score` receives, built once per entry
        const stripEntry = (entry: PageComment): PageComment => {
            let stripped = strippedEntries.get(entry);
            if (!stripped) strippedEntries.set(entry, (stripped = stripRepliesFromPageComment(entry)));
            return stripped;
        };

        const preloadedCount = loaded.filter(({ sort }) => sort.preloaded).length;
        const share = preloadedCount > 0 ? Math.floor(preloadedPageSizeBytes / preloadedCount) : 0;
        const preloaded: (SortedPageSort & { holdsWholeSet: boolean })[] = [];
        const nonPreloaded: SortedPageSort[] = [];
        for (const { sort, comments, replies } of loaded) {
            let chunks: PageIpfs["comments"][];
            try {
                chunks = await this.sortAndChunkComments(comments, sort, {
                    baseTimestamp,
                    parentCid,
                    firstPageSizeBytes: sort.preloaded ? share : NON_PRELOADED_FIRST_PAGE_SIZE,
                    replies,
                    sizeOf: serialized.sizeOf,
                    stripEntry,
                    streamReplies: streamReplies?.(sort)
                });
            } catch (e) {
                fail(sort, e);
                continue;
            }
            if (chunks.length === 0) continue; // every comment filtered out
            if (!sort.preloaded) {
                nonPreloaded.push({ sort, chunks });
                continue;
            }
            const firstChunkSize = pageDagSize(chunks[0].map(serialized.sizeOf), chunks.length > 1);
            if (firstChunkSize > share) {
                // Its share of the budget is not enough even for its first chunk: degrade this sort to pageCids
                const rechunked = this._chunkComments({
                    comments: chunks.flat(),
                    firstPageSizeBytes: NON_PRELOADED_FIRST_PAGE_SIZE,
                    sizeOf: serialized.sizeOf
                });
                nonPreloaded.push({ sort, chunks: rechunked });
            } else
                preloaded.push({
                    sort,
                    chunks,
                    holdsWholeSet: chunks.length === 1 && chunks[0].length === comments.length
                });
        }
        if (preloaded.length === 0 && nonPreloaded.length === 0) return undefined;

        const everyPreloadedIsSingleChunk = preloaded.length > 0 && preloaded.every(({ chunks }) => chunks.length === 1);
        const skippingOtherSortsIsSound = nonPreloaded.length === 0 || preloaded.every(({ holdsWholeSet }) => holdsWholeSet);
        if (everyPreloadedIsSingleChunk && skippingOtherSortsIsSound) {
            const singlePreloadedPage: SinglePreloadedPageRes = {};
            for (const { sort, chunks } of preloaded) singlePreloadedPage[sort.sortName] = { comments: source.resolve(chunks[0]) };
            return { singlePreloadedPage, failedSorts };
        }

        // Full generation. Preloaded first, then the others, each in configured order; IPFS adds run in parallel
        // under one byte budget for the pages in flight.
        const budget = new PageBytesBudget(serializedEntryCacheBudgetBytes());
        const results = await Promise.all([
            ...preloaded.map(({ sort, chunks }) =>
                this._addChunksToIpfs({ chunks, sortName: sort.sortName, serialized, embedFirst: true, source, budget })
            ),
            ...nonPreloaded.map(({ sort, chunks }) =>
                this._addChunksToIpfs({ chunks, sortName: sort.sortName, serialized, embedFirst: false, source, budget })
            )
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
            else {
                assert(data.firstPage, `preloaded sort ${sortName} has no embedded first page`);
                pages[sortName] = data.firstPage;
            }
            const cids: (string | undefined)[] = data.cids;
            allPageCids[sortName] = cids.filter((c): c is string => typeof c === "string");
        }
        return { pages, ...(Object.keys(pageCids).length > 0 ? { pageCids } : {}), allPageCids };
    }

    private async _pageSortsFor(scope: PageSortScope): Promise<ResolvedPageSort[]> {
        return (await this._community._ensurePageSortsLoaded())[scope];
    }

    // Page entries out of the community database: each batch's nested reply pages resolved from rows. Plain
    // JSON.stringify is canonical here: the row mapper builds every object with sorted keys
    // (createPositionalCommentRowMapper), so this is byte-identical to safe-stable-stringify at native speed.
    private _dbPageEntrySource(): PageEntrySource {
        const db = this._community._dbHandler;
        const resolve = (entries: PageComment[]) => db.resolveRepliesCidRefsForEntries(entries);
        return { resolve, serialize: (entries) => resolve(entries).map((entry) => JSON.stringify(entry)) };
    }

    async generateCommunityPosts({
        preloadedPageSizeBytes
    }: {
        preloadedPageSizeBytes: number;
    }): Promise<PageGenerationResult<PostsPagesTypeIpfs>> {
        const baseTimestamp = timestamp();
        const sorts = await this._pageSortsFor("posts");
        // Posts are loaded lean, their reply pages still as CID refs; the page entry source resolves them per batch
        // (issue #351)
        const loadComments = this._createCommentLoader((exclusions) =>
            this._community._dbHandler.queryPosts({ ...exclusions, parentCid: null })
        );
        this._postEntryCache ??= new EntryJsonCache(serializedEntryCacheBudgetBytes());
        const generated = await this._generatePagesForSorts<PostsPagesTypeIpfs>({
            scope: "posts",
            sorts,
            loadComments,
            streamReplies: (sort) => this._createStreamingRepliesProvider(sort), // a requireReplies post sort streams each post's subtree
            source: this._dbPageEntrySource(),
            entryCache: this._postEntryCache,
            preloadedPageSizeBytes,
            baseTimestamp,
            parentCid: null
        });
        this._postEntryCache.retainOnly(new Set(loadComments.loaded().map((entry) => entry.commentUpdate.cid)));
        return generated;
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

        const chunkedQueuedComments = this._chunkComments({ comments: queuedComments, firstPageSizeBytes });

        const pages = await this.addQueuedCommentChunksToIpfs(chunkedQueuedComments, "pendingApproval");

        return { pageCids: { pendingApproval: pages.cids[0] }, combinedHashOfCids };
    }

    // Reply pages of one comment. Flat sorts (flattened descendant subtree) are generated for post replies only:
    // depth-1+ comments have never had them and one settings.pages.replies list applies at every depth.
    private async _generateRepliesPages(
        comment: Pick<CommentsTableRow, "cid"> & Partial<Pick<CommentsTableRow, "postCid">>,
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
        // Every reply under the comment's post, for a requireReplies reply sort; each reply's own subtree is sliced from it
        const loadReplies = this._createRepliesLoader(() => {
            const postCid = comment.postCid ?? this._community._dbHandler.queryComment(comment.cid)?.postCid ?? comment.cid;
            return this._community._dbHandler.queryAllRepliesForPageSort({ postCid });
        });
        return this._generatePagesForSorts<RepliesPagesTypeIpfs>({
            scope: "replies",
            sorts,
            loadComments,
            loadReplies,
            source: this._dbPageEntrySource(),
            entryCache: new EntryJsonCache(serializedEntryCacheBudgetBytes()), // one comment's replies, dropped with the generation
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
