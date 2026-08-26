import pLimit from "p-limit";
import retry from "retry";
import Logger from "../../../../logger.js";
import { genToArray, removeMfsFilesSafely, statMfsPathSafely } from "../../../../util.js";
import type { DbRepliesSortEntry } from "../../../../publications/comment/types.js";
import type { PurgedCommentTableRows } from "../db-handler-types.js";
import type { LocalCommunity } from "../local-community.js";
import { calculateLocalMfsPathForCommentUpdate } from "./comment-updates.js";

// pin.ls probe that retries transient Kubo RPC connection errors (`fetch failed`, ECONNRESET,
// ETIMEDOUT...). "is not pinned" is the expected "needs a repin" signal and is never retried.
async function _pinLsWithRetries({
    kuboRpcClient,
    cid,
    log,
    inputNumOfRetries
}: {
    kuboRpcClient: ReturnType<LocalCommunity["_clientsManager"]["getDefaultKuboRpcClient"]>;
    cid: string;
    log: Logger;
    inputNumOfRetries?: number;
}): Promise<void> {
    const numOfRetries = inputNumOfRetries ?? 3;
    return new Promise<void>((resolve, reject) => {
        const operation = retry.operation({ retries: numOfRetries, factor: 2, minTimeout: 1000 });
        operation.attempt(async (currentAttempt) => {
            try {
                await genToArray(kuboRpcClient._client.pin.ls({ paths: cid }));
                resolve();
            } catch (error) {
                if ((error as Error).message?.includes("is not pinned")) {
                    reject(error);
                    return;
                }
                log.error(`Failed attempt ${currentAttempt}/${numOfRetries + 1} to check whether ${cid} is pinned:`, error);
                if (operation.retry(error as Error)) return;
                reject(operation.mainError() || error);
            }
        });
    });
}

export async function repinCommentsIPFSIfNeeded(community: LocalCommunity) {
    const log = Logger("pkc-js:local-community:start:_repinCommentsIPFSIfNeeded");
    const latestCommentCid = community._dbHandler.queryLatestCommentCid(); // latest comment ordered by id
    if (!latestCommentCid) return;
    const kuboRpcOrHelia = community._clientsManager.getDefaultKuboRpcClient();
    try {
        // Retries on transient Kubo connection errors so a daemon blip doesn't fail community.start(),
        // same as the files.stat probe in repinCommentUpdateIfNeeded.
        await _pinLsWithRetries({ kuboRpcClient: kuboRpcOrHelia, cid: latestCommentCid.cid, log });
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

// Floor between two GC runs on one daemon, and the whole of the GC policy: once an hour we sweep,
// unconditionally.
//
// repo.gc over the RPC is not conditional. Kubo consults Datastore.StorageGCWatermark only from the
// daemon's own `--enable-gc` loop; /api/v0/repo/gc always runs a full sweep. pkc-js never spawns the
// daemon (the operator hands us a kubo RPC URL that may not even be local), so we cannot delegate to
// that loop and the schedule has to live here.
//
// The floor is what makes it a schedule. This runs at the end of every community sync on a default
// 20s publishInterval, and the in-flight promise below only merges callers that actually overlap —
// the moment a run settles the next sync tick is free to start another. Without the floor a node
// hosting dozens of communities GCs back to back forever, and since kubo 0.43.0 GC and in-flight MFS
// writes hold each other off, so that steady state would stall every postUpdates write on the node.
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

type KuboRpcClient = ReturnType<LocalCommunity["_clientsManager"]["getDefaultKuboRpcClient"]>;

// size-only: a default repo/stat also counts every object, which walks the whole flatfs blockstore —
// on the repos this feature exists for that is millions of files. Nothing branches on the result, it
// only feeds the log line, so a failing daemon costs us the number and not the GC.
async function _readRepoSizeSafely({
    kuboRpc,
    kuboUrl,
    log
}: {
    kuboRpc: KuboRpcClient;
    kuboUrl: string;
    log: Logger;
}): Promise<bigint | undefined> {
    try {
        return (await kuboRpc._client.repo.stat({ searchParams: new URLSearchParams({ "size-only": "true" }) })).repoSize;
    } catch (e) {
        log.trace("Failed to read repo size from the kubo node", kuboUrl, e);
        return undefined;
    }
}

// Bytes arrive as bigint. Repo sizes are nowhere near Number.MAX_SAFE_INTEGER (9PB), so converting
// once for the human-readable scaling is exact in every case we can actually hit.
function _formatBytes(bytes: bigint): string {
    const asNumber = Number(bytes);
    const units = ["B", "KB", "MB", "GB", "TB"];
    const magnitude = Math.abs(asNumber);
    const unitIndex = magnitude < 1 ? 0 : Math.min(Math.floor(Math.log(magnitude) / Math.log(1024)), units.length - 1);
    const scaled = asNumber / 1024 ** unitIndex;
    return unitIndex === 0 ? `${asNumber}B` : `${scaled.toFixed(2)}${units[unitIndex]}`;
}

// Exported for tests. The repo can legitimately end a sweep BIGGER than it started: GC and the
// community syncs writing new blocks run against the same daemon, and nothing pauses publishing for
// the duration. Report that case as what it is instead of logging a negative reclaim.
export function _describeReclaimedSpace({ before, after }: { before: bigint | undefined; after: bigint | undefined }): string {
    if (typeof before !== "bigint" || typeof after !== "bigint") return "reclaimed an unknown amount, repo.stat was unavailable";

    const sizes = `(${_formatBytes(before)} -> ${_formatBytes(after)})`;
    if (after > before) return `reclaimed no space, the repo grew ${_formatBytes(after - before)} during the sweep ${sizes}`;
    return `reclaimed ${_formatBytes(before - after)} ${sizes}`;
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

    if (!force) {
        const lastGcFinishedAt = lastGcFinishedAtByKuboUrl.get(kuboUrl);
        if (typeof lastGcFinishedAt === "number" && Date.now() - lastGcFinishedAt < MIN_MS_BETWEEN_GC) return;
    }

    // Read purely for the before/after line at the end, so a failure here must not skip the sweep.
    const repoSizeBefore = await _readRepoSizeSafely({ kuboRpc, kuboUrl, log });

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
    const repoSizeAfter = await _readRepoSizeSafely({ kuboRpc, kuboUrl, log });

    log(
        "GC cleaned",
        gcCids,
        "cids out of the IPFS node",
        kuboUrl,
        "and",
        _describeReclaimedSpace({ before: repoSizeBefore, after: repoSizeAfter })
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
