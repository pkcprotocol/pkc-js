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

// GC once the repo is within this fraction of Datastore.StorageMax. Kubo's own --enable-gc makes the
// same decision from Datastore.StorageGCWatermark (default 90), so we mirror it instead of inventing
// a second policy — a node that later switches to the daemon flag behaves identically.
const GC_HIGH_WATERMARK = 0.9;

// Floor between two GC runs on one daemon. Once a repo is above the watermark it tends to STAY above
// it (GC only reclaims unpinned blocks), so without a floor every sync of every community would
// trigger a fresh GC.
const MIN_MS_BETWEEN_GC = 60 * 60 * 1000;

// repo.gc and repo.stat are whole-daemon operations, but cleanUpIpfsRepoIfDue runs once per community
// sync — a node hosting dozens of communities calls it dozens of times per interval against a single
// shared daemon. Both pieces of state are therefore keyed by Kubo RPC URL, not by community: the
// timestamp so the interval floor is per-daemon, and the in-flight promise so concurrent callers join
// one GC run instead of each starting their own.
const lastGcFinishedAtByKuboUrl = new Map<string, number>();
const inFlightGcByKuboUrl = new Map<string, Promise<void>>();

// Exported for tests: module state outlives a single community, so a suite that asserts on the
// interval floor has to be able to clear it between cases.
export function _resetRepoGcSchedulingState() {
    lastGcFinishedAtByKuboUrl.clear();
    inFlightGcByKuboUrl.clear();
}

export async function cleanUpIpfsRepoIfDue(community: LocalCommunity, force = false): Promise<void> {
    const log = Logger("pkc-js:local-community:syncIpnsWithDb:_cleanUpIpfsRepoIfDue");
    const kuboRpc = community._clientsManager.getDefaultKuboRpcClient();
    const kuboUrl = String(kuboRpc.url);

    const inFlight = inFlightGcByKuboUrl.get(kuboUrl);
    if (inFlight) return inFlight; // another community's sync is already GCing this daemon

    // No await between the get() above and the set() below, so no second caller can interleave here.
    const gcRun = _runRepoGcIfDue({ community, kuboUrl, force, log }).finally(() => inFlightGcByKuboUrl.delete(kuboUrl));
    inFlightGcByKuboUrl.set(kuboUrl, gcRun);
    return gcRun;
}

async function _runRepoGcIfDue({
    community,
    kuboUrl,
    force,
    log
}: {
    community: LocalCommunity;
    kuboUrl: string;
    force: boolean;
    log: Logger;
}): Promise<void> {
    const kuboRpc = community._clientsManager.getDefaultKuboRpcClient();

    let repoSizeBefore: bigint | undefined;

    if (!force) {
        const lastGcFinishedAt = lastGcFinishedAtByKuboUrl.get(kuboUrl);
        if (typeof lastGcFinishedAt === "number" && Date.now() - lastGcFinishedAt < MIN_MS_BETWEEN_GC) return;

        let repoStat: Awaited<ReturnType<typeof kuboRpc._client.repo.stat>>;
        try {
            // size-only: the default repo/stat also counts every object, which walks the whole
            // flatfs blockstore — on the repos this feature exists for that is millions of files.
            repoStat = await kuboRpc._client.repo.stat({ searchParams: new URLSearchParams({ "size-only": "true" }) });
        } catch (e) {
            log.error("Skipping repo.gc: failed to read repo.stat from the kubo node", kuboUrl, e);
            return;
        }

        repoSizeBefore = repoStat.repoSize;

        // storageMax comes from Datastore.StorageMax. If the daemon reports no ceiling there is
        // nothing to compare against, so fall back to GCing on the interval alone rather than
        // never GCing at all.
        if (repoStat.storageMax > 0n) {
            const gcThreshold = (repoStat.storageMax * BigInt(Math.round(GC_HIGH_WATERMARK * 100))) / 100n;
            if (repoStat.repoSize < gcThreshold) {
                log.trace(
                    "Skipping repo.gc on",
                    kuboUrl,
                    "- repo size",
                    repoStat.repoSize,
                    "is below the",
                    `${GC_HIGH_WATERMARK * 100}%`,
                    "watermark",
                    gcThreshold,
                    "of StorageMax",
                    repoStat.storageMax
                );
                return;
            }
        }
    }

    let gcCids = 0;
    try {
        for await (const res of kuboRpc._client.repo.gc({ quiet: true })) {
            if (res.cid) gcCids++;
            else log.error("Failed to GC ipfs repo due to error", res.err);
        }
    } catch (e) {
        log.error("Failed to GC ipfs repo due to error", e);
        return;
    } finally {
        // Stamped on failure too: a daemon that can't GC is a daemon we should back off from, not
        // one to retry against every 20s sync for the rest of its life.
        lastGcFinishedAtByKuboUrl.set(kuboUrl, Date.now());
    }

    // How much a GC actually reclaims is the open question on pkc-js#225: the affected node had
    // >11k recursive pins, and GC never touches pinned data. Log it rather than assume.
    let repoSizeAfter: bigint | undefined;
    try {
        repoSizeAfter = (await kuboRpc._client.repo.stat({ searchParams: new URLSearchParams({ "size-only": "true" }) })).repoSize;
    } catch (e) {
        log.trace("repo.gc finished but the follow-up repo.stat failed", e);
    }

    log(
        "GC cleaned",
        gcCids,
        "cids out of the IPFS node",
        kuboUrl,
        "- repo size",
        repoSizeBefore ?? "unknown",
        "->",
        repoSizeAfter ?? "unknown"
    );
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
