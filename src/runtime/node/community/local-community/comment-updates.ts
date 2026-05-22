import { stringify as deterministicStringify } from "safe-stable-stringify";
import * as remeda from "remeda";
import pLimit from "p-limit";
import Logger from "../../../../logger.js";
import { timestamp, writeKuboFilesWithTimeout } from "../../../../util.js";
import env from "../../../../version.js";
import { calculateInlineRepliesBudget } from "../../util.js";
import { cleanUpBeforePublishing, signCommentUpdate, verifyCommentUpdate } from "../../../../signer/signatures.js";
import { PKCError } from "../../../../pkc-error.js";
import { getAuthorNameFromWire } from "../../../../publications/publication-author.js";
import { deriveDbReplies } from "../../util.js";
import type {
    CommentsTableRow,
    CommentUpdatesTableRowInsert,
    CommentUpdateType,
    DbRepliesSortEntry
} from "../../../../publications/comment/types.js";
import type { LocalCommunity } from "../local-community.js";
import type { CommentUpdateToWriteToDbAndPublishToIpfs } from "./defaults.js";
import { rmUnneededMfsPaths } from "./cleanup.js";

export function pubsubTopicWithfallback(community: LocalCommunity) {
    return community.pubsubTopic || community.address;
}

export function calculateLocalMfsPathForCommentUpdate(
    community: LocalCommunity,
    postDbComment: Pick<CommentsTableRow, "cid">,
    timestampRange: number
) {
    // TODO Can optimize the call below by only asking for timestamp field
    return ["/" + community.address, "postUpdates", timestampRange, postDbComment.cid, "update"].join("/");
}

export async function calculateNewCommentUpdate(
    community: LocalCommunity,
    comment: CommentsTableRow
): Promise<CommentUpdateToWriteToDbAndPublishToIpfs> {
    const log = Logger("pkc-js:local-community:_calculateNewCommentUpdate");

    // If we're here that means we're gonna calculate the new update and publish it
    log.trace(`Attempting to calculate new CommentUpdate for comment (${comment.cid}) on community`, community.address);

    // This comment will have the local new CommentUpdate, which we will publish to IPFS fiels
    // It includes new author.community as well as updated values in CommentUpdate (except for replies field)
    const storedCommentUpdate = community._dbHandler.queryCommentUpdateTimestampBucketReplies({ cid: comment.cid });
    const authorDomain = getAuthorNameFromWire(comment.author);
    const calculatedCommentUpdate = community._dbHandler.queryCalculatedCommentUpdate({ comment, authorDomain });
    log.trace(
        "Calculated comment update for comment",
        comment.cid,
        "on community",
        community.address,
        "with reply count",
        calculatedCommentUpdate.replyCount
    );

    const currentTimestamp = timestamp();

    const newUpdatedAt =
        typeof storedCommentUpdate?.updatedAt === "number" && storedCommentUpdate.updatedAt >= currentTimestamp
            ? storedCommentUpdate.updatedAt + 1
            : currentTimestamp;

    const commentUpdatePriorToSigning: Omit<CommentUpdateType, "signature"> = {
        ...cleanUpBeforePublishing({
            ...calculatedCommentUpdate,
            updatedAt: newUpdatedAt,
            protocolVersion: env.PROTOCOL_VERSION
        })
    };

    const preloadedRepliesPages = "best";
    const inlineRepliesBudget = calculateInlineRepliesBudget({
        comment,
        commentUpdateWithoutReplies: commentUpdatePriorToSigning
    });
    const adjustedPreloadedRepliesPageSizeBytes = Math.max(inlineRepliesBudget, 1);

    const generatedRepliesPages =
        comment.depth === 0
            ? await community._pageGenerator.generatePostPages(comment, preloadedRepliesPages, adjustedPreloadedRepliesPageSizeBytes)
            : await community._pageGenerator.generateReplyPages(comment, preloadedRepliesPages, adjustedPreloadedRepliesPageSizeBytes);

    // we have to make sure not clean up submissions of authors by calling cleanUpBeforePublishing
    if (generatedRepliesPages) {
        if ("singlePreloadedPage" in generatedRepliesPages)
            commentUpdatePriorToSigning.replies = { pages: generatedRepliesPages.singlePreloadedPage };
        else if (generatedRepliesPages.pageCids) {
            commentUpdatePriorToSigning.replies = {
                pageCids: generatedRepliesPages.pageCids,
                pages: remeda.pick(generatedRepliesPages.pages, [preloadedRepliesPages])
            };
        }
    }

    // Extract allPageCids from the generation result (not available for singlePreloadedPage case)
    const allPageCids =
        generatedRepliesPages && !("singlePreloadedPage" in generatedRepliesPages) ? generatedRepliesPages.allPageCids : undefined;

    // Unpin old page CIDs that are no longer in the new generation
    {
        const oldDbReplies = storedCommentUpdate?.replies as Record<string, DbRepliesSortEntry> | undefined;
        const oldCids = new Set(oldDbReplies ? Object.values(oldDbReplies).flatMap((sort) => sort?.allPageCids ?? []) : []);
        const newCids = new Set(allPageCids ? Object.values(allPageCids).flat() : []);
        for (const cid of oldCids) {
            if (!newCids.has(cid)) community._cidsToUnPin.add(cid);
        }
    }

    const newCommentUpdate: CommentUpdateType = {
        ...commentUpdatePriorToSigning,
        signature: await signCommentUpdate({ update: commentUpdatePriorToSigning, signer: community.signer })
    };

    await validateCommentUpdateSignature(community, newCommentUpdate, comment, log);

    const newPostUpdateBucket =
        comment.depth === 0 ? community._postUpdatesBuckets.find((bucket) => timestamp() - bucket <= comment.timestamp) : undefined;
    const newLocalMfsPath =
        typeof newPostUpdateBucket === "number"
            ? calculateLocalMfsPathForCommentUpdate(community, comment, newPostUpdateBucket)
            : undefined;

    if (
        storedCommentUpdate?.postUpdatesBucket &&
        newLocalMfsPath &&
        newPostUpdateBucket &&
        storedCommentUpdate.postUpdatesBucket !== newPostUpdateBucket
    ) {
        const oldPostUpdates = calculateLocalMfsPathForCommentUpdate(community, comment, storedCommentUpdate.postUpdatesBucket).replace(
            "/update",
            ""
        );
        community._mfsPathsToRemove.add(oldPostUpdates);
    }
    const newCommentUpdateDbRecord = <CommentUpdatesTableRowInsert>{
        ...newCommentUpdate,
        // Store CID refs instead of full inline page data — see deriveDbReplies()
        replies: deriveDbReplies({ replies: newCommentUpdate.replies, allPageCids }),
        postUpdatesBucket: newPostUpdateBucket,
        publishedToPostUpdatesMFS: false,

        insertedAt: timestamp()
    };
    return {
        newCommentUpdate,
        newCommentUpdateToWriteToDb: newCommentUpdateDbRecord,
        localMfsPath: newLocalMfsPath,
        pendingApproval: comment.pendingApproval
    };
}

export async function validateCommentUpdateSignature(
    community: LocalCommunity,
    newCommentUpdate: CommentUpdateType,
    comment: CommentsTableRow,
    log: Logger
) {
    // This function should be deleted at some point, once the protocol ossifies
    const verificationOpts = {
        update: newCommentUpdate,
        resolveAuthorNames: false,
        clientsManager: community._clientsManager,
        community,
        comment,
        validatePages: community._pkc.validatePages,
        validateUpdateSignature: true
    };
    const validation = await verifyCommentUpdate(verificationOpts);
    if (!validation.valid) {
        log.error(`CommentUpdate (${comment.cid}) signature is invalid due to (${validation.reason}). This is a critical error`);
        throw new PKCError("ERR_COMMENT_UPDATE_SIGNATURE_IS_INVALID", { validation, verificationOpts });
    }
}

export async function updateCommentsThatNeedToBeUpdated(community: LocalCommunity): Promise<CommentUpdateToWriteToDbAndPublishToIpfs[]> {
    const log = Logger(`pkc-js:local-community:_updateCommentsThatNeedToBeUpdated`);

    // Get all comments that need to be updated
    const commentsToUpdate = community._dbHandler.queryCommentsToBeUpdated();

    if (commentsToUpdate.length === 0) return [];

    community._communityUpdateTrigger = true;
    log(`Will update ${commentsToUpdate.length} comments in this update loop for community (${community.address})`);

    // Group by postCid
    const commentsByPostCid = remeda.groupBy.strict(commentsToUpdate, (x) => x.postCid);
    const allCommentUpdateRows: CommentUpdateToWriteToDbAndPublishToIpfs[] = [];

    // Process different post trees in parallel
    const postLimit = pLimit(10); // Process up to 10 post trees concurrently

    const postProcessingPromises = Object.entries(commentsByPostCid).map(([postCid, commentsForPost]) =>
        postLimit(async () => {
            try {
                // Group by depth
                const commentsByDepth = remeda.groupBy.strict(commentsForPost, (x) => x.depth);
                const depthsKeySorted = remeda.keys.strict(commentsByDepth).sort((a, b) => Number(b) - Number(a)); // Sort depths from highest to lowest

                const postUpdateRows: CommentUpdateToWriteToDbAndPublishToIpfs[] = [];

                // Process each depth level in sequence within this post tree
                for (const depthKey of depthsKeySorted) {
                    const commentsAtDepth = commentsByDepth[depthKey];

                    // Process all comments at this depth in parallel
                    const depthLimit = pLimit(50);

                    // Calculate updates for all comments at this depth in parallel
                    const depthUpdatePromises = commentsAtDepth.map((comment) =>
                        depthLimit(async () => await calculateNewCommentUpdate(community, comment))
                    );

                    // Wait for all comments at this depth to be calculated
                    const depthResults = await Promise.all(depthUpdatePromises);

                    // Batch write all updates for this depth to the database
                    community._dbHandler.upsertCommentUpdates(depthResults.map((r) => r.newCommentUpdateToWriteToDb));

                    // Add to our results
                    postUpdateRows.push(...depthResults);
                }

                return postUpdateRows;
            } catch (error) {
                log.error(`Failed to process post tree ${postCid}:`, error);
                throw error;
            }
        })
    );

    // Wait for all post trees to be processed
    const postResults = await Promise.all(postProcessingPromises);

    // Collect all results
    for (const result of postResults) {
        allCommentUpdateRows.push(...result);
    }

    return allCommentUpdateRows;
}

export async function syncPostUpdatesWithIpfs(
    community: LocalCommunity,
    commentUpdateRowsToPublishToIpfs: CommentUpdateToWriteToDbAndPublishToIpfs[]
) {
    const log = Logger("pkc-js:local-community:sync:_syncPostUpdatesFilesystemWithIpfs");

    const postUpdatesDirectory = `/${community.address}`;
    const commentUpdatesWithLocalPath = commentUpdateRowsToPublishToIpfs.filter(
        (row): row is CommentUpdateToWriteToDbAndPublishToIpfs & { localMfsPath: string } => typeof row.localMfsPath === "string"
    );

    if (commentUpdatesWithLocalPath.length === 0)
        throw Error("No comment updates of posts to publish to postUpdates directory. This is a critical bug");

    const kuboRpc = community._clientsManager.getDefaultKuboRpcClient();
    const removedMfsPaths: string[] = await rmUnneededMfsPaths(community);
    let postUpdatesDirectoryCid: Awaited<ReturnType<typeof kuboRpc._client.files.flush>> | undefined;

    const BATCH_SIZE = 50;
    for (let index = 0; index < commentUpdatesWithLocalPath.length; index += BATCH_SIZE) {
        const batch = commentUpdatesWithLocalPath.slice(index, index + BATCH_SIZE);

        await Promise.all(
            batch.map(async (row) => {
                const { localMfsPath, newCommentUpdate } = row;
                const content = deterministicStringify(newCommentUpdate);

                await writeKuboFilesWithTimeout({
                    ipfsClient: kuboRpc._client,
                    log,
                    path: localMfsPath,
                    content,
                    options: {
                        create: true,
                        truncate: true,
                        parents: true,
                        // flush: true to avoid Kubo's global Internal.MFSNoFlushLimit (default 256).
                        // Costs some throughput (each write self-flushes instead of batching) but
                        // is safe under multi-community concurrency, which the global counter is not.
                        flush: true
                    }
                });

                removedMfsPaths.push(localMfsPath);
            })
        );

        postUpdatesDirectoryCid = await kuboRpc._client.files.flush(postUpdatesDirectory);
    }

    const postUpdatesDirectoryCidString = postUpdatesDirectoryCid?.toString();
    log(
        "Community",
        community.address,
        "Synced",
        commentUpdatesWithLocalPath.length,
        "post CommentUpdates",
        "with MFS postUpdates directory",
        postUpdatesDirectoryCidString
    );
    community._dbHandler.markCommentsAsPublishedToPostUpdates(commentUpdateRowsToPublishToIpfs.map((row) => row.newCommentUpdate.cid));
}

export async function adjustPostUpdatesBucketsIfNeeded(community: LocalCommunity) {
    if (!community.postUpdates) return;
    // Look for posts whose buckets should be changed

    const log = Logger("pkc-js:local-community:start:_adjustPostUpdatesBucketsIfNeeded");
    const postsWithOutdatedPostUpdateBucket = community._dbHandler.queryPostsWithOutdatedBuckets(community._postUpdatesBuckets);
    if (postsWithOutdatedPostUpdateBucket.length === 0) return;

    community._dbHandler.forceUpdateOnAllCommentsWithCid(postsWithOutdatedPostUpdateBucket.map((post) => post.cid));

    log(`Found ${postsWithOutdatedPostUpdateBucket.length} posts with outdated buckets and forced their updates`);
}
