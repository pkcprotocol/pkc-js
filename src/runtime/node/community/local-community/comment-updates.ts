import { stringify as deterministicStringify } from "safe-stable-stringify";
import { groupBy, keys } from "remeda";
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
    CommentUpdatesRow,
    CommentUpdatesTableRowInsert,
    CommentUpdateType,
    DbRepliesSortEntry
} from "../../../../publications/comment/types.js";
import type { LocalCommunity } from "../local-community.js";
import type { CalculatedCommentUpdate, CommunityAuthorMemo } from "../db-handler.js";
import type { CommentUpdateToWriteToDbAndPublishToIpfs } from "./defaults.js";
import { rmUnneededMfsPaths } from "./cleanup.js";
import { wirePagesFromGeneration } from "../page-generator.js";
import { reportFailedPageSorts } from "../page-sorts/index.js";

// A cycle that recalculated any comment must have recalculated at least one post: a reply's update
// dirties its whole ancestry, and only a post has a postUpdates file. A cycle that ends with no post
// file to write is a bug in the flagging query, not an empty cycle.
export const NO_POST_UPDATES_TO_PUBLISH_ERROR = "No comment updates of posts to publish to postUpdates directory. This is a critical bug";

// The topic this community uses for the challenge exchange, ignoring whether the exchange is
// currently enabled. There is no fallback to community.address anymore (issue #229): absence of
// pubsubTopic on the wire means the exchange is disabled, so the address must never stand in for a
// missing topic. community.signer.address is what the init backfill writes, so a community that
// toggles the exchange back on has a topic without needing a DB write first.
export function communityChallengePubsubTopic(community: LocalCommunity): string | undefined {
    return community.pubsubTopic || community.signer?.address;
}

// The topic to actually subscribe/publish on, undefined when settings.disablePubsubChallengeExchange
// turns the community read-only over the network.
export function challengeExchangePubsubTopic(community: LocalCommunity): string | undefined {
    if (community.settings?.disablePubsubChallengeExchange) return undefined;
    return communityChallengePubsubTopic(community);
}

export function calculateLocalMfsPathForCommentUpdate(
    community: LocalCommunity,
    postDbComment: Pick<CommentsTableRow, "cid">,
    timestampRange: number
) {
    // TODO Can optimize the call below by only asking for timestamp field
    return ["/" + community.address, "postUpdates", timestampRange, postDbComment.cid, "update"].join("/");
}

export async function calculateNewCommentUpdate(opts: {
    community: LocalCommunity;
    comment: CommentsTableRow;
    // Captured BEFORE the batch's queryCommentsToBeUpdated() DB read and used as the row's
    // insertedAt (issue #209). queryCommentsToBeUpdated flags a comment when a publication row
    // satisfies pub.insertedAt >= cu.insertedAt (second granularity), so the stamp must not
    // postdate any publication inserted while this calculation is running — stamping at
    // row-build time (after async page generation + signing) let a publication inserted after
    // the aggregate read compare as "older" forever, wedging it out of the update pipeline.
    // Worst case of the earlier stamp is one redundant recalculation next cycle.
    batchStartTimestamp: number;
    // The update cycle reads these for a whole depth batch at once (issue #352); a caller updating one comment
    // leaves them out and they are read here
    precomputed?: {
        calculated: CalculatedCommentUpdate;
        storedCommentUpdate: Pick<CommentUpdatesRow, "updatedAt" | "postUpdatesBucket" | "replies"> | undefined;
    };
}): Promise<CommentUpdateToWriteToDbAndPublishToIpfs> {
    const { community, comment, batchStartTimestamp, precomputed } = opts;
    const log = Logger("pkc-js:local-community:_calculateNewCommentUpdate");

    // If we're here that means we're gonna calculate the new update and publish it
    log.trace(`Attempting to calculate new CommentUpdate for comment (${comment.cid}) on community`, community.address);

    // This comment will have the local new CommentUpdate, which we will publish to IPFS fiels
    // It includes new author.community as well as updated values in CommentUpdate (except for replies field)
    const storedCommentUpdate = precomputed
        ? precomputed.storedCommentUpdate
        : community._dbHandler.queryCommentUpdateTimestampBucketReplies({ cid: comment.cid });
    const calculatedCommentUpdate =
        precomputed?.calculated ??
        community._dbHandler.queryCalculatedCommentUpdate({ comment, authorDomain: getAuthorNameFromWire(comment.author) });
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

    const inlineRepliesBudget = calculateInlineRepliesBudget({
        comment,
        commentUpdateWithoutReplies: commentUpdatePriorToSigning
    });
    const adjustedPreloadedRepliesPageSizeBytes = Math.max(inlineRepliesBudget, 1);

    // Which reply sorts are generated and which embed is settings.pages' call (issue #73)
    const generatedRepliesPages =
        comment.depth === 0
            ? await community._pageGenerator.generatePostPages(comment, adjustedPreloadedRepliesPageSizeBytes)
            : await community._pageGenerator.generateReplyPages(comment, adjustedPreloadedRepliesPageSizeBytes);
    if (generatedRepliesPages) reportFailedPageSorts(community, generatedRepliesPages.failedSorts, log);

    // we have to make sure not clean up submissions of authors by calling cleanUpBeforePublishing
    if (generatedRepliesPages) commentUpdatePriorToSigning.replies = wirePagesFromGeneration(generatedRepliesPages);

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

        insertedAt: batchStartTimestamp
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

// How many comments of a depth are calculated, signed and upserted before the next slice starts.
const COMMENT_UPDATE_SLICE_SIZE = 2000;

export async function updateCommentsThatNeedToBeUpdated(community: LocalCommunity): Promise<CommentUpdateToWriteToDbAndPublishToIpfs[]>;
export async function updateCommentsThatNeedToBeUpdated(
    community: LocalCommunity,
    onCommentUpdatesWritten: (rows: CommentUpdateToWriteToDbAndPublishToIpfs[]) => void | Promise<void>
): Promise<void>;
export async function updateCommentsThatNeedToBeUpdated(
    community: LocalCommunity,
    // Called with each slice of rows as soon as they are written to the DB, deepest depth first. A caller
    // that passes it decides what to keep and nothing is accumulated here, which is how the publish cycle
    // avoids holding every comment's whole CommentUpdate (the inline reply pages are the bulk of a row)
    // from the first slice until the record is published: it writes the slice's posts to MFS and keeps
    // their cids. A caller that wants every row, such as a test walking a small board, omits it.
    onCommentUpdatesWritten?: (rows: CommentUpdateToWriteToDbAndPublishToIpfs[]) => void | Promise<void>
): Promise<CommentUpdateToWriteToDbAndPublishToIpfs[] | void> {
    const log = Logger(`pkc-js:local-community:_updateCommentsThatNeedToBeUpdated`);

    // Must be captured before the flag query below reads the DB — see the batchStartTimestamp
    // param of calculateNewCommentUpdate (issue #209).
    const batchStartTimestamp = timestamp();

    // Get all comments that need to be updated
    const commentsToUpdate = community._dbHandler.queryCommentsToBeUpdated();

    if (commentsToUpdate.length === 0) return onCommentUpdatesWritten ? undefined : [];

    community._communityUpdateTrigger = true;
    log(`Will update ${commentsToUpdate.length} comments in this update loop for community (${community.address})`);

    // Deepest depth first across the whole board: a comment's counts, last reply and reply pages read its children's
    // CommentUpdates, so every child is calculated and written before any parent. Within a depth the fields of every
    // comment are read in one batched pass (issue #352) and the author aggregates are memoised for the cycle, then
    // the reply pages, signing and the depth's single upsert follow.
    const commentsByDepth = groupBy(commentsToUpdate, (comment) => comment.depth);
    const depthsDeepestFirst = keys(commentsByDepth).sort((a, b) => Number(b) - Number(a));
    const authorMemo: CommunityAuthorMemo = new Map();
    const allCommentUpdateRows: CommentUpdateToWriteToDbAndPublishToIpfs[] | undefined = onCommentUpdatesWritten ? undefined : [];
    const limit = pLimit(50);
    for (const depthKey of depthsDeepestFirst) {
        const commentsAtDepth = commentsByDepth[depthKey];
        // A depth is calculated in slices so a consumer can take each one and let it go: a board's posts
        // are one depth, and holding all of their CommentUpdates at once is what made the cycle's memory
        // grow with the board (issue #355). The slice is large enough that the per-depth batched reads of
        // issue #352 still pay for themselves — at 500 the phase cost 28% more, at 2000 it is unchanged.
        for (let index = 0; index < commentsAtDepth.length; index += COMMENT_UPDATE_SLICE_SIZE) {
            const slice = commentsAtDepth.slice(index, index + COMMENT_UPDATE_SLICE_SIZE);
            const calculated = community._dbHandler.queryCalculatedCommentUpdates({ comments: slice, authorMemo });
            const stored = community._dbHandler.queryCommentUpdateTimestampBucketRepliesByCids(slice.map((comment) => comment.cid));
            const sliceResults = await Promise.all(
                slice.map((comment) =>
                    limit(() =>
                        calculateNewCommentUpdate({
                            community,
                            comment,
                            batchStartTimestamp,
                            precomputed: { calculated: calculated.get(comment.cid)!, storedCommentUpdate: stored.get(comment.cid) }
                        })
                    )
                )
            );
            community._dbHandler.upsertCommentUpdates(sliceResults.map((result) => result.newCommentUpdateToWriteToDb));
            if (onCommentUpdatesWritten) await onCommentUpdatesWritten(sliceResults);
            else allCommentUpdateRows!.push(...sliceResults);
        }
    }
    return allCommentUpdateRows;
}

// Writes one slice of a cycle's post CommentUpdates into the postUpdates MFS directory: the purge
// filter, the writes, the directory flush and the post-write purge re-check. Split out of
// syncPostUpdatesWithIpfs so the publish cycle can hand each slice over as it is calculated and then
// drop it, instead of holding every post's CommentUpdate (its inline reply page is the bulk of a row)
// until the whole board has been recalculated (issue #355). Marking the comments as published stays
// with the caller: it happens once, for the posts and the replies together, when the cycle's writes
// are done. Returns how many files were written.
export async function writePostUpdatesToMfs(
    community: LocalCommunity,
    postCommentUpdateRows: (CommentUpdateToWriteToDbAndPublishToIpfs & { localMfsPath: string })[]
): Promise<number> {
    const log = Logger("pkc-js:local-community:sync:_syncPostUpdatesFilesystemWithIpfs");

    const postUpdatesDirectory = `/${community.address}`;

    // Drop post updates whose comment was purged after this sync cycle captured it. A concurrent
    // purge (storeCommentModeration) deletes the comment from the DB and removes its postUpdates MFS
    // entry; writing the captured update back here would resurrect the purged post in postUpdates, and
    // since it is gone from the DB nothing would ever clean it up again. See pkc-js issue #142.
    const liveCommentUpdates = postCommentUpdateRows.filter((row) => community._dbHandler.commentExistsInDb(row.newCommentUpdate.cid));
    const purgedMidSyncCount = postCommentUpdateRows.length - liveCommentUpdates.length;
    if (purgedMidSyncCount > 0)
        log(`Skipping ${purgedMidSyncCount} post CommentUpdate(s) for community ${community.address} whose comment was purged mid-sync`);

    const kuboRpc = community._clientsManager.getDefaultKuboRpcClient();
    const removedMfsPaths: string[] = await rmUnneededMfsPaths(community);
    let postUpdatesDirectoryCid: Awaited<ReturnType<typeof kuboRpc._client.files.flush>> | undefined;

    // 50 is measured, not arbitrary. Benchmarked against kubo 0.43.0 (6 communities syncing
    // concurrently, 600 writes each, flush:true, warm repo): 50 and 100 are within noise of each
    // other (~3650 vs ~3710 writes/s) and 200/400 are 9-12% SLOWER. Above ~200, concurrent
    // files.write with parents:true also starts failing outright with "file already exists" as the
    // implicit parent mkdir races itself. Raising this buys nothing.
    const BATCH_SIZE = 50;
    for (let index = 0; index < liveCommentUpdates.length; index += BATCH_SIZE) {
        const batch = liveCommentUpdates.slice(index, index + BATCH_SIZE);

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

    // The filter above still leaves a window: a purge landing between it and the writes has already
    // run its own MFS cleanup, so the write resurrects the purged post's update file with nothing
    // left to remove it (the comment is gone from the DB and _mfsPathsToRemove is drained). A purge
    // always deletes from the DB before removing MFS paths, so any purge whose rm preceded one of
    // the writes is visible to this re-check. If the rm here fails the paths stay queued in
    // _mfsPathsToRemove and the rmUnneededMfsPaths call above retries them next sync. See issue #304.
    const rowsPurgedDuringWrites = liveCommentUpdates.filter((row) => !community._dbHandler.commentExistsInDb(row.newCommentUpdate.cid));
    if (rowsPurgedDuringWrites.length > 0) {
        log(
            `${rowsPurgedDuringWrites.length} post CommentUpdate(s) of community ${community.address} were purged during the MFS writes. Removing their MFS entries`
        );
        for (const row of rowsPurgedDuringWrites) community._mfsPathsToRemove.add(row.localMfsPath);
        await rmUnneededMfsPaths(community);
        postUpdatesDirectoryCid = await kuboRpc._client.files.flush(postUpdatesDirectory);
    }

    log(
        "Community",
        community.address,
        "Synced",
        liveCommentUpdates.length,
        "post CommentUpdates",
        "with MFS postUpdates directory",
        postUpdatesDirectoryCid?.toString()
    );
    return liveCommentUpdates.length;
}

// One cycle's worth of post CommentUpdates in one call: what the publish cycle did before it started
// streaming them (issue #355), and what a caller holding a whole cycle's rows still wants.
export async function syncPostUpdatesWithIpfs(
    community: LocalCommunity,
    commentUpdateRowsToPublishToIpfs: CommentUpdateToWriteToDbAndPublishToIpfs[],
    // The cid of every comment this cycle updated, posts and replies alike: all of them are marked as
    // published once the posts' files are in MFS, and only the posts have a file to write. Defaults to
    // the given rows' own cids.
    cidsUpdatedInThisCycle: string[] = commentUpdateRowsToPublishToIpfs.map((row) => row.newCommentUpdate.cid)
) {
    const postCommentUpdateRows = commentUpdateRowsToPublishToIpfs.filter(
        (row): row is CommentUpdateToWriteToDbAndPublishToIpfs & { localMfsPath: string } => typeof row.localMfsPath === "string"
    );

    if (postCommentUpdateRows.length === 0) throw Error(NO_POST_UPDATES_TO_PUBLISH_ERROR);

    await writePostUpdatesToMfs(community, postCommentUpdateRows);
    community._dbHandler.markCommentsAsPublishedToPostUpdates(cidsUpdatedInThisCycle);
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
