import pLimit from "p-limit";
import Logger from "../../../../logger.js";
import { genToArray, removeMfsFilesSafely, statMfsPathSafely } from "../../../../util.js";
import type { DbRepliesSortEntry } from "../../../../publications/comment/types.js";
import type { PurgedCommentTableRows } from "../db-handler-types.js";
import type { LocalCommunity } from "../local-community.js";
import { calculateLocalMfsPathForCommentUpdate } from "./comment-updates.js";

export async function repinCommentsIPFSIfNeeded(community: LocalCommunity) {
    const log = Logger("pkc-js:local-community:start:_repinCommentsIPFSIfNeeded");
    const latestCommentCid = community._dbHandler.queryLatestCommentCid(); // latest comment ordered by id
    if (!latestCommentCid) return;
    const kuboRpcOrHelia = community._clientsManager.getDefaultKuboRpcClient();
    try {
        await genToArray(kuboRpcOrHelia._client.pin.ls({ paths: latestCommentCid.cid }));
        return; // the comment is already pinned, we assume the rest of the comments are so too
    } catch (e) {
        if (!(<Error>e).message.includes("is not pinned")) throw e;
    }

    log("The latest comment is not pinned in the ipfs node, pkc-js will repin all existing comment ipfs for community", community.address);

    // latestCommentCid should be the last in unpinnedCommentsFromDb array, in case we throw an error on a comment before it, it does not get pinned
    const unpinnedCommentsFromDb = community._dbHandler.queryAllCommentsOrderedByIdAsc(); // we assume all comments are unpinned if latest comment is not pinned

    // In the _repinCommentIpfs method:
    const limit = pLimit(50);
    const pinningPromises = unpinnedCommentsFromDb.map((unpinnedCommentRow) =>
        limit(async () => {
            if (unpinnedCommentRow.pendingApproval) return; // we don't pin comments waiting to get approved
            await community._addCommentRowToIPFS(
                unpinnedCommentRow,
                Logger("pkc-js:local-community:start:_repinCommentsIPFSIfNeeded:_addCommentRowToIPFS")
            );
        })
    );

    await Promise.all(pinningPromises);

    community._dbHandler.forceUpdateOnAllComments(); // force pkc-js to republish all comment updates

    log(`${unpinnedCommentsFromDb.length} comments' IPFS have been repinned`);
}

export async function unpinStaleCids(community: LocalCommunity) {
    const log = Logger("pkc-js:local-community:sync:unpinStaleCids");

    if (community._cidsToUnPin.size > 0) {
        const sizeBefore = community._cidsToUnPin.size;

        // Create a concurrency limiter with a limit of 50
        const limit = pLimit(50);

        const kuboRpc = community._clientsManager.getDefaultKuboRpcClient();
        // Process all unpinning in parallel with concurrency limit
        await Promise.all(
            Array.from(community._cidsToUnPin.values()).map((cid) =>
                limit(async () => {
                    try {
                        await kuboRpc._client.pin.rm(cid, { recursive: true });
                        community._cidsToUnPin.delete(cid);
                    } catch (e) {
                        const error = <Error>e;
                        if (error.message.startsWith("not pinned")) {
                            community._cidsToUnPin.delete(cid);
                        } else {
                            log.trace("Failed to unpin cid", cid, "on community", community.address, "due to error", error);
                        }
                    }
                })
            )
        );

        log.trace(`unpinned ${sizeBefore - community._cidsToUnPin.size} stale cids from ipfs node for community (${community.address})`);
    }
}

export async function rmUnneededMfsPaths(community: LocalCommunity): Promise<string[]> {
    const log = Logger("pkc-js:local-community:sync:_rmUnneededMfsPaths");

    if (community._mfsPathsToRemove.size > 0) {
        const toDeleteMfsPaths = Array.from(community._mfsPathsToRemove.values());
        const kuboRpc = community._clientsManager.getDefaultKuboRpcClient();
        try {
            await removeMfsFilesSafely({
                kuboRpcClient: kuboRpc,
                paths: toDeleteMfsPaths,
                log
            });
            toDeleteMfsPaths.forEach((path) => community._mfsPathsToRemove.delete(path));
            return toDeleteMfsPaths;
        } catch (e) {
            const error = <Error>e;
            if (error.message.includes("file does not exist"))
                return toDeleteMfsPaths; // file does not exist, we can return the paths that were not deleted
            else {
                log.error("Failed to remove paths from MFS", toDeleteMfsPaths, e);
                throw error;
            }
        }
    } else return [];
}

export async function repinCommentUpdateIfNeeded(community: LocalCommunity) {
    const log = Logger("pkc-js:start:_repinCommentUpdateIfNeeded");

    // iterating on all comment updates is not efficient, we should figure out a better way
    // Most of the time we run this function, the comment updates are already written to ipfs rpeo
    const kuboRpc = community._clientsManager.getDefaultKuboRpcClient();
    try {
        // Retries on transient Kubo connection errors so a daemon blip doesn't fail community.start().
        await statMfsPathSafely({ kuboRpcClient: kuboRpc, path: `/${community.address}`, statOptions: { hash: true }, log });
        return; // if the directory of this community exists, we assume all the comment updates are there
    } catch (e) {
        if (!(<Error>e).message.includes("file does not exist")) throw e;
    }

    // community has no comment updates, we can return
    if (!community.lastCommentCid) return;

    log(`CommentUpdate directory`, community.address, "will republish all comment updates");

    community._dbHandler.forceUpdateOnAllComments(); // pkc-js will recalculate and publish all comment updates
}

export async function cleanUpIpfsRepoRarely(community: LocalCommunity, force = false) {
    const log = Logger("pkc-js:local-community:syncIpnsWithDb:_cleanUpIpfsRepoRarely");
    if (Math.random() < 0.00001 || force) {
        let gcCids = 0;
        const kuboRpc = community._clientsManager.getDefaultKuboRpcClient();

        try {
            for await (const res of kuboRpc._client.repo.gc({ quiet: true })) {
                if (res.cid) gcCids++;
                else log.error("Failed to GC ipfs repo due to error", res.err);
            }
        } catch (e) {
            log.error("Failed to GC ipfs repo due to error", e);
        }

        log("GC cleaned", gcCids, "cids out of the IPFS node");
    }
}

export async function addAllCidsUnderPurgedCommentToBeRemoved(
    community: LocalCommunity,
    purgedCommentAndCommentUpdate: PurgedCommentTableRows
) {
    community._cidsToUnPin.add(purgedCommentAndCommentUpdate.commentTableRow.cid);
    community._blocksToRm.push(purgedCommentAndCommentUpdate.commentTableRow.cid);
    if (typeof purgedCommentAndCommentUpdate.commentUpdateTableRow?.postUpdatesBucket === "number") {
        const localCommentUpdatePath = calculateLocalMfsPathForCommentUpdate(
            community,
            purgedCommentAndCommentUpdate.commentTableRow,
            purgedCommentAndCommentUpdate.commentUpdateTableRow?.postUpdatesBucket
        );
        community._mfsPathsToRemove.add(localCommentUpdatePath);
    }
    if (purgedCommentAndCommentUpdate?.commentUpdateTableRow?.replies) {
        // replies is DbRepliesFormat — flat per-sort with allPageCids
        const dbReplies = purgedCommentAndCommentUpdate.commentUpdateTableRow.replies as Record<string, DbRepliesSortEntry>;
        for (const sortEntry of Object.values(dbReplies)) {
            if (sortEntry?.allPageCids) {
                for (const cid of sortEntry.allPageCids) {
                    community._cidsToUnPin.add(cid);
                    community._blocksToRm.push(cid);
                }
            }
        }
    }
}

export async function purgeDisapprovedCommentsOlderThan(community: LocalCommunity) {
    if (typeof community.settings?.purgeDisapprovedCommentsOlderThan !== "number") return;

    const log = Logger("pkc-js:local-community:_purgeDisapprovedCommentsOlderThan");
    const purgedComments = community._dbHandler.purgeDisapprovedCommentsOlderThan(community.settings.purgeDisapprovedCommentsOlderThan);

    if (!purgedComments || purgedComments.length === 0) return;

    log("Purged disapproved comments", purgedComments, "because retention time has passed and it's time to purge them from DB and pages");

    // need to clear out any commentUpdate.postUpdatesBucket
    // need to clear out any comment.cid
    // need to clear out any commentUpdate.replies

    for (const purgedComment of purgedComments)
        for (const purgedCommentAndCommentUpdate of purgedComment.purgedTableRows)
            await addAllCidsUnderPurgedCommentToBeRemoved(community, purgedCommentAndCommentUpdate);

    if (community._mfsPathsToRemove.size > 0) await rmUnneededMfsPaths(community);
    if (community.updateCid) {
        community._blocksToRm.push(community.updateCid); // we need to remove current updateCid which references purged comments
        community._cidsToUnPin.add(community.updateCid);
    }
}
