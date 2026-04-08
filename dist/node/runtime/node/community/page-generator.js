import { calculateStringSizeSameAsIpfsAddCidV0, hideClassPrivateProps, retryKuboIpfsAddAndProvide, timestamp } from "../../../util.js";
import assert from "assert";
import * as remeda from "remeda";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import env from "../../../version.js";
import { POSTS_SORT_TYPES, POST_REPLIES_SORT_TYPES, TIMEFRAMES_TO_SECONDS, REPLY_REPLIES_SORT_TYPES } from "../../../pages/util.js";
import { PKCError } from "../../../pkc-error.js";
import Logger from "../../../logger.js";
import { cleanUpBeforePublishing, signCommentUpdateForChallengeVerification } from "../../../signer/signatures.js";
import { deriveCommentIpfsFromCommentTableRow } from "../util.js";
import { sha256 } from "js-sha256";
async function getSerializedCommentsSize(comments, hasNextCid) {
    const payload = hasNextCid ? { comments, nextCid: "QmXsYKgNH7XoZXdLko5uDvtWSRNE2AXuQ4u8KxVpCacrZx" } : { comments };
    const serializedPayload = JSON.stringify(payload);
    return await calculateStringSizeSameAsIpfsAddCidV0(serializedPayload);
}
export class PageGenerator {
    constructor(community) {
        this._community = community;
        hideClassPrivateProps(this);
    }
    async addQueuedCommentChunksToIpfs(chunks, sortName = "pendingApproval") {
        const ipfsClient = this._community._clientsManager.getDefaultKuboRpcClient();
        const listOfPage = new Array(chunks.length);
        const cids = new Array(chunks.length);
        let expectedSize = 1024 * 1024 * Math.pow(2, chunks.length - 1); // expected size of last page
        for (let i = chunks.length - 1; i >= 0; i--) {
            const modQueuePageIpfs = { nextCid: cids[i + 1], comments: chunks[i] };
            if (!modQueuePageIpfs.nextCid)
                delete modQueuePageIpfs.nextCid; // we don't to include undefined anywhere in the protocol
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
    async addCommentChunksToIpfs(chunks, sortName) {
        assert(chunks.length > 0);
        const ipfsClient = this._community._clientsManager.getDefaultKuboRpcClient();
        const listOfPage = new Array(chunks.length);
        const cids = new Array(chunks.length);
        let curMaxPageSize = 1024 * 1024 * Math.pow(2, chunks.length - 1); // expected size of last page
        for (let pageNum = chunks.length - 1; pageNum >= 0; pageNum--) {
            const pageIpfs = { nextCid: cids[pageNum + 1], comments: chunks[pageNum] };
            if (!pageIpfs.nextCid)
                delete pageIpfs.nextCid; // we don't to include undefined anywhere in the protocol
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
    async addPreloadedCommentChunksToIpfs(chunks, sortName) {
        const listOfPage = new Array(chunks.length);
        const cids = [undefined]; // pageCids will never have the cid of preloaded page
        const ipfsClient = this._community._clientsManager.getDefaultKuboRpcClient();
        for (let pageNum = chunks.length - 1; pageNum >= 1; pageNum--) {
            const pageIpfs = { nextCid: cids[pageNum + 1], comments: chunks[pageNum] };
            if (!pageIpfs.nextCid)
                delete pageIpfs.nextCid; // we don't to include undefined anywhere in the protocol
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
        const firstPage = { comments: chunks[0], nextCid: cids[1] };
        if (!firstPage.nextCid)
            throw Error("First page should have nextCid");
        listOfPage[0] = firstPage;
        return { [sortName]: { pages: listOfPage } };
    }
    async _chunkComments({ comments, firstPageSizeBytes }) {
        const FIRST_PAGE_SIZE = firstPageSizeBytes; // dynamic page size for preloaded sorts, 1MB for others
        const SAFETY_MARGIN = 1024; // Use 1KiB margin
        // Calculate overhead with and without nextCid
        const OBJECT_WRAPPER_WITH_CID = (await calculateStringSizeSameAsIpfsAddCidV0(JSON.stringify({
            comments: [],
            nextCid: "QmXsYKgNH7XoZXdLko5uDvtWSRNE2AXuQ4u8KxVpCacrZx" // random cid as a place holder
        }))) - 2; // Subtract 2 for empty array "[]"
        const OBJECT_WRAPPER_WITHOUT_CID = (await calculateStringSizeSameAsIpfsAddCidV0(JSON.stringify({
            comments: []
        }))) - 2; // Subtract 2 for empty array "[]"
        // Quick check for small arrays - if everything fits in one page, no nextCid needed
        const totalSizeWithoutCid = await calculateStringSizeSameAsIpfsAddCidV0(JSON.stringify({ comments }));
        if (totalSizeWithoutCid <= FIRST_PAGE_SIZE) {
            return [comments]; // Single page, no chunking needed
        }
        const chunks = [];
        let currentChunk = [];
        let chunkIndex = 0;
        let accumulatedSize = OBJECT_WRAPPER_WITH_CID;
        // Pre-calculate sizes to avoid repeated stringification
        const commentSizes = new Map();
        async function getCommentSize(index) {
            if (!commentSizes.has(index)) {
                const size = await calculateStringSizeSameAsIpfsAddCidV0(JSON.stringify(comments[index]));
                commentSizes.set(index, size);
            }
            return commentSizes.get(index);
        }
        function getCurrentMaxSize(index) {
            if (index === 0) {
                return FIRST_PAGE_SIZE; // First page is dynamic for preloaded
            }
            else {
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
                    currentChunk = [];
                    chunkIndex++;
                    if (isLastItem) {
                        accumulatedSize = OBJECT_WRAPPER_WITHOUT_CID;
                    }
                    else {
                        accumulatedSize = OBJECT_WRAPPER_WITH_CID;
                    }
                }
                else if (commentSize > maxSize - SAFETY_MARGIN) {
                    const log = Logger("pkc-js:page-generator:_chunkComments");
                    log.trace(`Single comment at index ${i} (size ${commentSize}) is large relative to page size limit (${maxSize}) for page ${chunkIndex}`);
                    accumulatedSize = isLastItem ? OBJECT_WRAPPER_WITHOUT_CID : OBJECT_WRAPPER_WITH_CID;
                }
            }
            currentChunk.push(comments[i]);
            accumulatedSize += commaSize + commentSize;
        }
        if (currentChunk.length > 0) {
            chunks.push(currentChunk);
        }
        return chunks;
    }
    async sortAndChunkComments(unsortedComments, sortName, options) {
        if (unsortedComments.length === 0)
            throw Error("Should not provide empty array of comments to sort");
        const sortProps = options.parentCid
            ? POST_REPLIES_SORT_TYPES[sortName]
            : POSTS_SORT_TYPES[sortName];
        if (typeof sortProps.score !== "function")
            throw Error(`SortProps[${sortName}] score function is not defined`);
        const scoreSort = (obj1, obj2) => {
            // calculated from DB
            if (sortName === "active") {
                if (typeof obj1.activeScore !== "number")
                    throw Error("Active score is not defined");
                if (typeof obj2.activeScore !== "number")
                    throw Error("Active score is not defined");
                return obj2.activeScore - obj1.activeScore;
            }
            else {
                const score1 = sortProps.score(obj1);
                const score2 = sortProps.score(obj2);
                return score2 - score1;
            }
        };
        const pinnedComments = unsortedComments.filter((obj) => obj.commentUpdate.pinned === true).sort(scoreSort);
        let unpinnedComments = unsortedComments.filter((obj) => !obj.commentUpdate.pinned).sort(scoreSort);
        if (sortProps.timeframe) {
            const timestampLower = options.baseTimestamp - TIMEFRAMES_TO_SECONDS[sortProps.timeframe];
            unpinnedComments = unpinnedComments.filter((obj) => obj.comment.timestamp >= timestampLower);
        }
        const commentsSorted = pinnedComments.concat(unpinnedComments).map((comment) => remeda.omit(comment, ["activeScore"]));
        if (commentsSorted.length === 0)
            return [];
        const commentsChunks = await this._chunkComments({
            comments: commentsSorted,
            firstPageSizeBytes: options.firstPageSizeBytes
        });
        return commentsChunks;
    }
    // Resolves to sortedComments
    // this is for non preloaded sorts
    async sortChunkAddIpfsNonPreloaded(comments, sortName, options) {
        const commentsChunks = await this.sortAndChunkComments(comments, sortName, options);
        if (commentsChunks.length === 0)
            return undefined;
        const res = await this.addCommentChunksToIpfs(commentsChunks, sortName);
        return res;
    }
    _generationResToPages(res) {
        const filteredGeneratedPages = res.filter(Boolean); // Take out undefined values
        if (filteredGeneratedPages.length === 0)
            return undefined;
        const mergedObject = Object.assign({}, ...filteredGeneratedPages);
        return {
            pages: Object.assign({}, ...Object.entries(mergedObject).map(([sortName, pages]) => ({ [sortName]: pages.pages[0] }))),
            pageCids: Object.assign({}, ...Object.entries(mergedObject).map(([sortName, pages]) => (pages.cids ? { [sortName]: pages.cids[0] } : undefined)))
        };
    }
    async generateCommunityPosts(preloadedPageSortName, preloadedPageSizeBytes) {
        const pageOptions = {
            excludeCommentsWithDifferentCommunityAddress: true,
            excludeDeletedComments: true,
            excludeRemovedComments: true,
            excludeCommentPendingApproval: true,
            excludeCommentWithApprovedFalse: true,
            parentCid: null,
            preloadedPage: preloadedPageSortName,
            baseTimestamp: timestamp(),
            firstPageSizeBytes: preloadedPageSizeBytes
        };
        // Sorting posts on a community level
        const rawPosts = this._community._dbHandler.queryPostsWithActiveScore(pageOptions);
        if (rawPosts.length === 0)
            return undefined;
        const preloadedChunk = await this.sortAndChunkComments(rawPosts, preloadedPageSortName, pageOptions);
        const firstChunkSize = await getSerializedCommentsSize(preloadedChunk[0], preloadedChunk.length > 1);
        if (firstChunkSize > preloadedPageSizeBytes)
            throw new PKCError("ERR_PAGE_GENERATED_IS_OVER_EXPECTED_SIZE", {
                firstChunkSize,
                preloadedPageSizeBytes,
                sortName: preloadedPageSortName
            });
        if (preloadedChunk.length === 1)
            return { singlePreloadedPage: { [preloadedPageSortName]: { comments: preloadedChunk[0] } } }; // all comments fit in one preloaded page
        // we're gonna have pages for each sort type, they don't fit in a single preloaded chunk
        const sortResults = [];
        sortResults.push(await this.addPreloadedCommentChunksToIpfs(preloadedChunk, preloadedPageSortName));
        const nonPreloadedSorts = remeda.keys.strict(POSTS_SORT_TYPES).filter((sortName) => sortName !== preloadedPageSortName);
        await Promise.all(nonPreloadedSorts.map(async (sortName) => {
            sortResults.push(await this.sortChunkAddIpfsNonPreloaded(rawPosts, sortName, {
                ...pageOptions,
                firstPageSizeBytes: 1024 * 1024
            }));
        }));
        const generatedPages = this._generationResToPages(sortResults);
        if (!generatedPages)
            return undefined;
        return generatedPages;
    }
    async _bundleLatestCommentUpdateWithQueuedComments(queuedComment) {
        const communityAuthor = this._community._dbHandler.queryCommunityAuthor(queuedComment.authorSignerAddress);
        const commentUpdateOfVerificationNoSignature = cleanUpBeforePublishing({
            author: { community: communityAuthor },
            cid: queuedComment.cid,
            protocolVersion: env.PROTOCOL_VERSION,
            pendingApproval: true
        });
        const commentUpdate = {
            ...commentUpdateOfVerificationNoSignature,
            signature: await signCommentUpdateForChallengeVerification({
                update: commentUpdateOfVerificationNoSignature,
                signer: this._community.signer
            })
        };
        const commentIpfs = deriveCommentIpfsFromCommentTableRow(queuedComment);
        return { comment: commentIpfs, commentUpdate };
    }
    async generateModQueuePages() {
        const firstPageSizeBytes = 1024 * 1024;
        const commentsPendingApproval = this._community._dbHandler.queryCommentsPendingApproval();
        if (commentsPendingApproval.length === 0)
            return undefined;
        const queuedComments = await Promise.all(commentsPendingApproval.map((comment) => this._bundleLatestCommentUpdateWithQueuedComments(comment)));
        const combinedHashOfCids = sha256(queuedComments.map((comment) => comment.commentUpdate.cid).join(""));
        const chunkedQueuedComments = await this._chunkComments({ comments: queuedComments, firstPageSizeBytes });
        const pages = await this.addQueuedCommentChunksToIpfs(chunkedQueuedComments, "pendingApproval");
        return { pageCids: { pendingApproval: pages.cids[0] }, combinedHashOfCids };
    }
    async generatePostPages(comment, preloadedReplyPageSortName, preloadedPageSizeBytes) {
        const pageOptions = {
            excludeCommentsWithDifferentCommunityAddress: true,
            excludeDeletedComments: false,
            excludeRemovedComments: false,
            excludeCommentWithApprovedFalse: false,
            excludeCommentPendingApproval: true,
            parentCid: comment.cid,
            preloadedPage: preloadedReplyPageSortName,
            baseTimestamp: timestamp()
        };
        const hierarchalReplies = this._community._dbHandler.queryPageComments(pageOptions);
        if (hierarchalReplies.length === 0)
            return undefined;
        const preloadedChunk = await this.sortAndChunkComments(hierarchalReplies, preloadedReplyPageSortName, {
            ...pageOptions,
            firstPageSizeBytes: preloadedPageSizeBytes
        });
        const firstChunkSize = await getSerializedCommentsSize(preloadedChunk[0], preloadedChunk.length > 1);
        const disablePreload = firstChunkSize > preloadedPageSizeBytes;
        if (!disablePreload && preloadedChunk.length === 1)
            return { singlePreloadedPage: { [preloadedReplyPageSortName]: { comments: preloadedChunk[0] } } }; // all comments fit in one page
        const sortResults = [];
        if (disablePreload) {
            sortResults.push(await this.sortChunkAddIpfsNonPreloaded(hierarchalReplies, preloadedReplyPageSortName, {
                ...pageOptions,
                firstPageSizeBytes: 1024 * 1024
            }));
        }
        else {
            sortResults.push(await this.addPreloadedCommentChunksToIpfs(preloadedChunk, preloadedReplyPageSortName));
        }
        const nonPreloadedSorts = remeda.keys.strict(POST_REPLIES_SORT_TYPES).filter((sortName) => sortName !== preloadedReplyPageSortName);
        const flattenedReplies = this._community._dbHandler.queryFlattenedPageReplies({
            ...pageOptions,
            commentUpdateFieldsToExclude: ["replies"]
        });
        await Promise.all(nonPreloadedSorts.map(async (sortName) => {
            const replies = POST_REPLIES_SORT_TYPES[sortName].flat ? flattenedReplies : hierarchalReplies;
            sortResults.push(await this.sortChunkAddIpfsNonPreloaded(replies, sortName, { ...pageOptions, firstPageSizeBytes: 1024 * 1024 }));
        }));
        const generatedPages = this._generationResToPages(sortResults);
        if (!generatedPages)
            return undefined;
        if (disablePreload)
            return { pageCids: generatedPages.pageCids, pages: {} };
        else
            return generatedPages;
    }
    async generateReplyPages(comment, preloadedReplyPageSortName, preloadedPageSizeBytes) {
        const pageOptions = {
            excludeCommentsWithDifferentCommunityAddress: true,
            excludeDeletedComments: false,
            excludeRemovedComments: false,
            excludeCommentPendingApproval: true,
            parentCid: comment.cid,
            preloadedPage: preloadedReplyPageSortName,
            baseTimestamp: timestamp(),
            excludeCommentWithApprovedFalse: false
        };
        const hierarchalReplies = this._community._dbHandler.queryPageComments(pageOptions);
        if (hierarchalReplies.length === 0)
            return undefined;
        const preloadedChunk = await this.sortAndChunkComments(hierarchalReplies, preloadedReplyPageSortName, {
            ...pageOptions,
            firstPageSizeBytes: preloadedPageSizeBytes
        });
        const firstChunkSize = await getSerializedCommentsSize(preloadedChunk[0], preloadedChunk.length > 1);
        const disablePreload = firstChunkSize > preloadedPageSizeBytes;
        if (!disablePreload && preloadedChunk.length === 1)
            return { singlePreloadedPage: { [preloadedReplyPageSortName]: { comments: preloadedChunk[0] } } }; // all comments fit in one page
        const nonPreloadedSorts = remeda.keys
            .strict(REPLY_REPLIES_SORT_TYPES)
            .filter((sortName) => sortName !== preloadedReplyPageSortName);
        const sortResults = [];
        if (disablePreload) {
            sortResults.push(await this.sortChunkAddIpfsNonPreloaded(hierarchalReplies, preloadedReplyPageSortName, {
                ...pageOptions,
                firstPageSizeBytes: 1024 * 1024
            }));
        }
        else {
            sortResults.push(await this.addPreloadedCommentChunksToIpfs(preloadedChunk, preloadedReplyPageSortName));
        }
        await Promise.all(nonPreloadedSorts.map(async (hierarchalSortName) => {
            sortResults.push(await this.sortChunkAddIpfsNonPreloaded(hierarchalReplies, hierarchalSortName, {
                ...pageOptions,
                firstPageSizeBytes: 1024 * 1024 // pageCids will always have first pages with limit of 1mib, regardless of preloadedPageSizeBytes
            }));
        }));
        const generatedPages = this._generationResToPages(sortResults);
        if (!generatedPages)
            return undefined;
        if (disablePreload)
            return { pageCids: generatedPages.pageCids, pages: {} };
        else
            return generatedPages;
    }
    toJSON() {
        return undefined;
    }
}
//# sourceMappingURL=page-generator.js.map