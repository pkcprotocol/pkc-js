import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { beforeEach, it } from "vitest";
import { PageGenerator } from "../../../../dist/node/runtime/node/community/page-generator.js";
import { calculateUnixFsDagSizeCidV0 } from "../../../../dist/node/util.js";
import { MAX_PAGE_SIZE_BYTES } from "../../../../dist/node/pages/page-size.js";
import { Buffer } from "buffer";
import { readFileSync } from "node:fs";

import type { PageIpfs } from "../../../../dist/node/pages/types.js";
import type { CommentIpfsType, CommentUpdateType } from "../../../../dist/node/publications/comment/types.js";

interface CommentEntry {
    comment: CommentIpfsType;
    commentUpdate: CommentUpdateType;
}

interface CommentOptions {
    contentLength?: number;
    label?: string;
    cid?: string;
    timestamp?: number;
    depth?: number;
    previousCid?: string;
    content?: string;
    parentCid?: string;
    postCid?: string;
    title?: string;
    protocolVersion?: string;
    upvoteCount?: number;
    downvoteCount?: number;
    replyCount?: number;
    childCount?: number;
    nestedReplyCount?: number;
    nestedReplyContentLength?: number;
    replies?: CommentEntry[];
}

interface ReplyEntryParams {
    parentCid: string;
    parentDepth: number;
    postCid: string;
    count: number;
    contentLength: number;
}

interface ShallowReplyParams {
    parentCid: string;
    parentDepth: number;
    postCid: string;
    label: string;
    contentLength: number;
}

const SAFETY_MARGIN_BYTES = 1024;
const NEXT_CID_PLACEHOLDER = "QmXsYKgNH7XoZXdLko5uDvtWSRNE2AXuQ4u8KxVpCacrZx";
const OBJECT_WRAPPER_WITH_CID_BYTES = Buffer.byteLength(JSON.stringify({ comments: [], nextCid: NEXT_CID_PLACEHOLDER }), "utf8") - 2;
const MAX_COMMENT_CONTENT_BYTES = 40 * 1024;
const BASE_COMMENT_IPFS: CommentIpfsType = loadFixture("../../../fixtures/signatures/comment/commentUpdate/valid_comment_ipfs.json");
const BASE_COMMENT_UPDATE: CommentUpdateType = loadFixture("../../../fixtures/signatures/comment/commentUpdate/valid_comment_update.json");
const BASE_COMMENT_SIGNATURE = BASE_COMMENT_UPDATE.signature;

describeSkipIfRpc("page-generator _chunkComments", () => {
    let pageGenerator: PageGenerator;

    beforeEach(() => {
        pageGenerator = new PageGenerator({
            address: "chunking-test",
            _clientsManager: {
                getDefaultKuboRpcClient: () => ({ _client: {} })
            }
        } as ConstructorParameters<typeof PageGenerator>[0]);
        resetCommentFactory();
    });

    it("returns one chunk when comments already fit into the first page budget", async () => {
        const comments = [createCommentEntry(50), createCommentEntry(50)];
        const totalSize = measurePageSize(comments, { includeNextCid: false });
        const chunks = await chunkComments(pageGenerator, comments, totalSize + 512);

        expect(chunks).to.have.length(1);
        expect(chunks[0]).to.equal(comments);
        expect(chunks[0]).to.deep.equal(comments);
    });

    it("splits when only the safety margin would be exceeded even if the first page size is not", async () => {
        const large = createCommentEntry(2500);
        const nearLimit = createCommentEntry(100);
        const remainingTail = [createCommentEntry(100), createCommentEntry(100), createCommentEntry(100)];
        const comments = [large, nearLimit, ...remainingTail];
        const combinedSinglePage = measurePageSize([large, nearLimit], { includeNextCid: true });
        const firstPageSizeBytes = combinedSinglePage + Math.floor(SAFETY_MARGIN_BYTES / 2);
        const totalWithoutCid = measurePageSize(comments, { includeNextCid: false });
        const threshold = firstPageSizeBytes - SAFETY_MARGIN_BYTES;

        expect(totalWithoutCid).to.be.greaterThan(firstPageSizeBytes);
        expect(combinedSinglePage).to.be.lessThan(firstPageSizeBytes);
        expect(combinedSinglePage).to.be.greaterThan(threshold);

        const chunks = await chunkComments(pageGenerator, comments, firstPageSizeBytes);

        expect(chunks).to.have.length(2);
        expect(chunks[0]).to.deep.equal([large]);
        expect(chunks[1]).to.deep.equal([nearLimit, ...remainingTail]);

        const firstChunkSize = measurePageSize(chunks[0], { includeNextCid: true });
        const expectedChunkSize = measurePageSize([large], { includeNextCid: true });

        expect(firstChunkSize).to.equal(expectedChunkSize);
        expect(firstChunkSize).to.be.lessThan(firstPageSizeBytes);
    });

    it("treats the comma delimiter as part of the size budget", async () => {
        const first = createCommentEntry(2498);
        const second = createCommentEntry(0);
        const rest = [createCommentEntry(500), createCommentEntry(500)];
        const firstSize = measureCommentSize(first);
        const secondSize = measureCommentSize(second);
        const current = OBJECT_WRAPPER_WITH_CID_BYTES + firstSize;
        const firstPageSizeBytes = current + secondSize + SAFETY_MARGIN_BYTES;
        const threshold = firstPageSizeBytes - SAFETY_MARGIN_BYTES;
        const combinedSinglePage = measurePageSize([first, second], { includeNextCid: true });
        const firstChunkSerialized = measurePageSize([first], { includeNextCid: true });
        const totalWithoutCid = measurePageSize([first, second, ...rest], { includeNextCid: false });
        const serializedWithoutComma = firstChunkSerialized + secondSize;

        expect(totalWithoutCid).to.be.greaterThan(firstPageSizeBytes);
        expect(current + secondSize).to.equal(threshold);
        expect(combinedSinglePage).to.equal(serializedWithoutComma + 1);

        const chunks = await chunkComments(pageGenerator, [first, second, ...rest], firstPageSizeBytes);

        expect(chunks).to.have.length(2);
        expect(chunks[0]).to.deep.equal([first]);
        expect(chunks[1]).to.deep.equal([second, ...rest]);
    });

    it("keeps single oversized comments instead of dropping them", async () => {
        const oversized = createCommentEntry(6000);
        const followUp = createCommentEntry(50);
        const firstPageSizeBytes = 4096;

        const chunks = await chunkComments(pageGenerator, [oversized, followUp], firstPageSizeBytes);

        expect(chunks).to.have.length(2);
        expect(chunks[0]).to.deep.equal([oversized]);
        expect(chunks[1]).to.deep.equal([followUp]);

        const firstChunkSize = measurePageSize(chunks[0], { includeNextCid: true });
        expect(firstChunkSize).to.be.greaterThan(firstPageSizeBytes);
    });

    it("handles firstPageSizeBytes values smaller than the safety margin", async () => {
        const comments = [createCommentEntry(10), createCommentEntry(10), createCommentEntry(10)];
        const chunks = await chunkComments(pageGenerator, comments, 512);

        expect(chunks).to.have.length(2);
        expect(chunks[0]).to.deep.equal([comments[0]]);
        expect(chunks[1]).to.deep.equal([comments[1], comments[2]]);

        const firstChunkSize = measurePageSize(chunks[0], { includeNextCid: true });
        const secondChunkSize = measurePageSize(chunks[1], { includeNextCid: false });
        const expectedFirstChunkSize = measurePageSize([comments[0]], { includeNextCid: true });
        const expectedSecondChunkSize = measurePageSize([comments[1], comments[2]], { includeNextCid: false });

        expect(firstChunkSize).to.equal(expectedFirstChunkSize);
        expect(secondChunkSize).to.equal(expectedSecondChunkSize);
    });

    it("allows later chunks to pack more comments as their budgets grow", async () => {
        const comments = Array.from({ length: 24 }, (_, index) =>
            createCommentEntry({
                contentLength: 2048,
                label: `bulk-${index}`,
                nestedReplyCount: 20,
                nestedReplyContentLength: 512
            })
        );
        const firstPageSizeBytes =
            measurePageSize([comments[0], comments[1]], { includeNextCid: true }) - Math.floor(SAFETY_MARGIN_BYTES / 2);
        const chunks = await chunkComments(pageGenerator, comments, firstPageSizeBytes);

        expect(chunks).to.have.length(3);
        expect(chunks[0]).to.have.length(1);
        expect(chunks[1].length).to.be.greaterThan(1);
        expect(chunks[2].length).to.be.greaterThan(0);
        expect(chunks.flat().length).to.equal(comments.length);

        const firstChunkSize = measurePageSize(chunks[0], { includeNextCid: true });
        const secondChunkSize = measurePageSize(chunks[1], { includeNextCid: true });
        expect(secondChunkSize).to.be.greaterThan(firstChunkSize);

        const secondChunkLimit = 1024 * 1024 - SAFETY_MARGIN_BYTES;
        expect(secondChunkSize).to.be.at.most(secondChunkLimit);

        const lastChunkSize = measurePageSize(chunks[2], { includeNextCid: false });
        expect(lastChunkSize).to.be.lessThan(2 * 1024 * 1024);
    });

    // Issue #504: the chunker summed each entry's DAG size as if it were its own file (11 to 14 bytes of leaf framing
    // per entry) while a page's real DAG overhead is one leaf framing per 256 KiB chunk plus the root's links, about
    // 7,950 bytes at 32 MiB. With a few hundred large entries per page the sum fell short of the real overhead by more
    // than the 1 KiB margin and the generated page came out over its limit (ERR_PAGE_GENERATED_IS_OVER_EXPECTED_SIZE).
    it("keeps a 32 MiB page of few large entries under its limit (issue #504)", async () => {
        // 437 posts with large inline reply pages, sized so that the per-entry sum lands within a few hundred bytes of
        // the budget: the shape of the page that came out 23 bytes over on a 1M-comment board
        const LIMIT = MAX_PAGE_SIZE_BYTES;
        const COUNT = 437;
        const budget = LIMIT - SAFETY_MARGIN_BYTES;
        const wrapperAsCounted = calculateUnixFsDagSizeCidV0(OBJECT_WRAPPER_WITH_CID_BYTES + 2) - 2;
        const entryFraming = calculateUnixFsDagSizeCidV0(70_000) - 70_000; // what one entry costs beyond its bytes, as its own file
        const entryBytes = Math.floor((budget - wrapperAsCounted - (COUNT - 1)) / COUNT) - entryFraming;
        const comments = Array.from({ length: COUNT + 1 }, () => createCommentEntry(10)) as unknown as PageIpfs["comments"];
        const chunks = pageGenerator._chunkComments({ comments, firstPageSizeBytes: LIMIT, sizeOf: () => entryBytes });
        expect(chunks.length).to.equal(2);
        const onPage = chunks[0].length; // the per-entry sum put all COUNT of them on the page, and the page came out over
        const dagSize = calculateUnixFsDagSizeCidV0(measurePageBytes(onPage, entryBytes, true));
        expect(dagSize, `the page of ${onPage} entries of ${entryBytes} bytes must be what the limit allows`).to.be.at.most(LIMIT);
        expect(
            calculateUnixFsDagSizeCidV0(measurePageBytes(onPage + 1, entryBytes, true)),
            "the page ended before it was full"
        ).to.be.greaterThan(LIMIT - SAFETY_MARGIN_BYTES);
    });

    it("fills every page up to its limit across the 1, 2, 4... 32 MiB steps", async () => {
        const ENTRY_BYTES = 76_000;
        const comments = Array.from({ length: 2_600 }, () => createCommentEntry(10)) as unknown as PageIpfs["comments"];
        const firstPageSizeBytes = 1024 * 1024;
        const chunks = pageGenerator._chunkComments({ comments, firstPageSizeBytes, sizeOf: () => ENTRY_BYTES });
        expect(chunks.length).to.be.greaterThan(6); // 1 + 1 + 2 + 4 + 8 + 16 + 32 MiB pages, then more 32 MiB pages
        const pageLimit = (index: number) =>
            index === 0 ? firstPageSizeBytes : Math.min(1024 * 1024 * 2 ** (index - 1), MAX_PAGE_SIZE_BYTES);
        for (let index = 0; index < chunks.length; index++) {
            const hasNextCid = index < chunks.length - 1;
            const dagSize = calculateUnixFsDagSizeCidV0(measurePageBytes(chunks[index].length, ENTRY_BYTES, hasNextCid));
            expect(dagSize, `page ${index} with ${chunks[index].length} entries must fit its ${pageLimit(index)} byte limit`).to.be.at.most(
                pageLimit(index)
            );
            // and not end early either: one more entry would not have fit under the limit
            if (hasNextCid)
                expect(
                    calculateUnixFsDagSizeCidV0(measurePageBytes(chunks[index].length + 1, ENTRY_BYTES, true)),
                    `page ${index} ended before it was full`
                ).to.be.greaterThan(pageLimit(index) - SAFETY_MARGIN_BYTES);
        }
    });

    it("returns a chunk for empty comment lists so callers can reuse the original array", async () => {
        const emptyComments: CommentEntry[] = [];
        const chunks = await chunkComments(pageGenerator, emptyComments, 2048);

        expect(chunks).to.have.length(1);
        expect(chunks[0]).to.equal(emptyComments);
        expect(chunks[0]).to.have.length(0);
    });
});

async function chunkComments(
    pageGenerator: PageGenerator,
    comments: PageIpfs["comments"],
    firstPageSizeBytes: number
): Promise<PageIpfs["comments"][]> {
    return pageGenerator._chunkComments({ comments, firstPageSizeBytes });
}

// The UTF-8 size of a page of `count` entries of `entryBytes` each: the page generator's wrapper, the entries and
// the commas between them
function measurePageBytes(count: number, entryBytes: number, hasNextCid: boolean): number {
    const wrapper = hasNextCid ? OBJECT_WRAPPER_WITH_CID_BYTES + 2 : Buffer.byteLength(JSON.stringify({ comments: [] }), "utf8");
    return wrapper + count * entryBytes + Math.max(count - 1, 0);
}

let commentCounter = 0;

function resetCommentFactory(): void {
    commentCounter = 0;
}

function createCommentEntry(contentLengthOrOptions: number | CommentOptions = 0): CommentEntry {
    const options = normalizeCommentOptions(contentLengthOrOptions);
    commentCounter += 1;
    const label = options.label ?? `entry-${commentCounter}`;
    const cid = options.cid ?? `${BASE_COMMENT_UPDATE.cid}-${commentCounter}`;
    const timestamp = options.timestamp ?? BASE_COMMENT_IPFS.timestamp + commentCounter;
    const depth = options.depth ?? BASE_COMMENT_IPFS.depth ?? 0;
    const previousCid = options.previousCid ?? `${BASE_COMMENT_IPFS.previousCid}-${commentCounter}`;
    const safeContentLength = Math.min(Math.max(options.contentLength ?? 0, 0), MAX_COMMENT_CONTENT_BYTES - 64);
    const content = options.content ?? buildContentString(label, safeContentLength);

    const comment = structuredClone(BASE_COMMENT_IPFS);
    comment.depth = depth;
    comment.timestamp = timestamp;
    comment.previousCid = previousCid;
    comment.author = createCommentAuthor(label);
    comment.content = content;
    if (options.parentCid) comment.parentCid = options.parentCid;
    if (options.postCid) comment.postCid = options.postCid;
    if (options.title) comment.title = options.title;

    const commentUpdate = structuredClone(BASE_COMMENT_UPDATE);
    commentUpdate.cid = cid;
    commentUpdate.protocolVersion = options.protocolVersion ?? commentUpdate.protocolVersion ?? "1.0.0";
    commentUpdate.author = createCommentUpdateAuthor(label);
    commentUpdate.upvoteCount = options.upvoteCount ?? 0;
    commentUpdate.downvoteCount = options.downvoteCount ?? 0;

    const replies =
        options.replies ??
        createReplyEntries({
            parentCid: cid,
            parentDepth: depth,
            postCid: options.postCid ?? cid,
            count: options.nestedReplyCount ?? 0,
            contentLength: options.nestedReplyContentLength ?? 256
        });

    if (replies.length > 0) {
        commentUpdate.replyCount = replies.length;
        commentUpdate.childCount = replies.length;
        commentUpdate.replies = {
            pages: { best: { comments: replies } },
            pageCids: {}
        };
    } else {
        commentUpdate.replyCount = options.replyCount ?? 0;
        commentUpdate.childCount = options.childCount ?? 0;
        delete commentUpdate.replies;
    }

    commentUpdate.signature = {
        ...structuredClone(BASE_COMMENT_SIGNATURE),
        publicKey: `${BASE_COMMENT_SIGNATURE.publicKey}-${commentCounter}`,
        signature: `${BASE_COMMENT_SIGNATURE.signature}-${commentCounter}`
    };

    return { comment, commentUpdate };
}

function normalizeCommentOptions(contentLengthOrOptions: number | CommentOptions): CommentOptions {
    if (typeof contentLengthOrOptions === "number") {
        return { contentLength: contentLengthOrOptions };
    }
    if (typeof contentLengthOrOptions === "object" && contentLengthOrOptions !== null) {
        return contentLengthOrOptions;
    }
    return {};
}

function createCommentAuthor(label: string): CommentIpfsType["author"] {
    const author = structuredClone(BASE_COMMENT_IPFS.author);
    author.displayName = `${author.displayName?.split(" - ")[0] ?? "Author"} - ${label}`;
    return author;
}

function createCommentUpdateAuthor(label: string): CommentUpdateType["author"] {
    const author = structuredClone(BASE_COMMENT_UPDATE.author);
    if (author?.community) {
        author.community = { ...author.community, lastCommentCid: `${author.community.lastCommentCid}-${label}` };
    }
    return author;
}

function buildContentString(label: string, targetBytes: number): string {
    const safeBytes = Math.min(Math.max(0, targetBytes), MAX_COMMENT_CONTENT_BYTES);
    if (safeBytes === 0) {
        return `${label}-content`;
    }
    const unit = `${label}-segment-`;
    const unitBytes = Buffer.byteLength(unit, "utf8");
    const repeat = Math.max(1, Math.floor(safeBytes / unitBytes));
    let result = unit.repeat(repeat);
    while (Buffer.byteLength(result, "utf8") < safeBytes) {
        result += "-";
    }
    return result;
}

function loadFixture<T>(relativePath: string): T {
    const fileUrl = new URL(relativePath, import.meta.url);
    return JSON.parse(readFileSync(fileUrl, "utf8")) as T;
}

function createReplyEntries({ parentCid, parentDepth, postCid, count, contentLength }: ReplyEntryParams): CommentEntry[] {
    if (!count || count <= 0) return [];
    return Array.from({ length: count }, (_, index) =>
        createShallowReplyEntry({
            parentCid,
            parentDepth,
            postCid,
            label: `reply-${parentCid}-${index}`,
            contentLength
        })
    );
}

function createShallowReplyEntry({ parentCid, parentDepth, postCid, label, contentLength }: ShallowReplyParams): CommentEntry {
    const entry = createCommentEntry({
        contentLength,
        label,
        depth: parentDepth + 1,
        parentCid,
        postCid,
        nestedReplyCount: 0
    });
    return entry;
}

function measureCommentSize(entry: CommentEntry): number {
    return Buffer.byteLength(JSON.stringify(entry), "utf8");
}

function measurePageSize(comments: CommentEntry[], { includeNextCid }: { includeNextCid: boolean } = { includeNextCid: false }): number {
    const payload = includeNextCid ? { comments, nextCid: NEXT_CID_PLACEHOLDER } : { comments };
    return Buffer.byteLength(JSON.stringify(payload), "utf8");
}
