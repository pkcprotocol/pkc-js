import Logger from "../../../../logger.js";
import path from "node:path";
import { promises as fsPromises, existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { v4 as uuidV4 } from "uuid";
import { STORAGE_KEYS } from "../../../../constants.js";
import { PKCError } from "../../../../pkc-error.js";
import { backupCommunityDb, BackupAbortError } from "../../util.js";
import type { LocalCommunity } from "../local-community.js";
import type { CommunityExportRecord, ExportCommunityUserOptions } from "../../../../community/types.js";

// Internal handle for an in-flight export, held in LocalCommunity._activeExports.
// `controller` is internal — user-supplied signals are wired to abort it via the listener stored
// here so we can detach the listener on terminal transitions and avoid leaks.
export interface InternalExportHandle {
    exportId: string;
    controller: AbortController;
    detachUserSignal?: () => void;
    donePromise: Promise<void>;
}

const EXPORTS_KEY = STORAGE_KEYS[STORAGE_KEYS.EXPORTS];

function defaultExportPathFor(community: LocalCommunity, exportId: string): string {
    if (typeof community._pkc.dataPath !== "string")
        throw new PKCError("ERR_DATA_PATH_IS_NOT_DEFINED", { communityAddress: community.address });
    return path.join(community._pkc.dataPath, "exports", `${exportId}.sqlite`);
}

function sourceDbPathFor(community: LocalCommunity): string {
    if (typeof community._pkc.dataPath !== "string")
        throw new PKCError("ERR_DATA_PATH_IS_NOT_DEFINED", { communityAddress: community.address });
    return path.join(community._pkc.dataPath, "communities", community.address);
}

async function persistExports(community: LocalCommunity): Promise<void> {
    if (!community._dbHandler) return;
    try {
        await community._dbHandler.keyvSet(EXPORTS_KEY, community._exports);
    } catch (e) {
        Logger("pkc-js:local-community:export").error("Failed to persist exports to keyv", e);
    }
}

export function cloneExportRecord(record: CommunityExportRecord): CommunityExportRecord {
    return {
        ...record,
        ...(record.error ? { error: { ...record.error } } : {})
    };
}

function snapshotExports(community: LocalCommunity): CommunityExportRecord[] {
    return community._exports.map(cloneExportRecord);
}

function emitExportsChange(community: LocalCommunity): void {
    community.emit("exportschange", snapshotExports(community));
}

async function updateRecord(community: LocalCommunity, exportId: string, patch: Partial<CommunityExportRecord>): Promise<void> {
    const idx = community._exports.findIndex((r) => r.exportId === exportId);
    if (idx === -1) return;
    community._exports[idx] = { ...community._exports[idx], ...patch };
    await persistExports(community);
    emitExportsChange(community);
}

async function runExportTask(
    community: LocalCommunity,
    exportId: string,
    opts: { destPath: string; includePrivateKey: boolean; signal: AbortSignal }
) {
    const log = Logger("pkc-js:local-community:export:run");
    const sourcePath = sourceDbPathFor(community);

    try {
        if (opts.signal.aborted) throw new BackupAbortError();

        let lastEmittedProgress = 0;
        const { size, sha256 } = await backupCommunityDb({
            sourcePath,
            destPath: opts.destPath,
            includePrivateKey: opts.includePrivateKey,
            signal: opts.signal,
            onProgress: (progress) => {
                // Throttle emissions so we don't churn keyv/listeners on every step
                if (progress - lastEmittedProgress < 0.05 && progress < 0.99) return;
                lastEmittedProgress = progress;
                void updateRecord(community, exportId, { progress });
            }
        });

        await updateRecord(community, exportId, {
            progress: 1,
            size,
            sha256,
            url: pathToFileURL(opts.destPath).href
        });
        log.trace("Export complete for community", community.address, "exportId", exportId);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof BackupAbortError || opts.signal.aborted) {
            await updateRecord(community, exportId, {
                error: { code: "ERR_EXPORT_CANCELLED", message: message || "Export was cancelled" }
            });
        } else {
            log.error("Backup failed for community", community.address, "exportId", exportId, err);
            await updateRecord(community, exportId, {
                error: { code: "ERR_EXPORT_BACKUP_FAILED", message }
            });
        }
    } finally {
        community._activeExports.delete(exportId);
    }
}

export async function exportCommunityEmbedded(
    community: LocalCommunity,
    options: ExportCommunityUserOptions = {}
): Promise<{ exportId: string }> {
    // Sync validation
    if (options.signal?.aborted) {
        const reason = (options.signal as AbortSignal).reason;
        throw reason ?? new DOMException("The operation was aborted.", "AbortError");
    }

    const exportId = uuidV4();
    const destPath = options.exportPath ? path.resolve(options.exportPath) : defaultExportPathFor(community, exportId);
    const includePrivateKey = options.includePrivateKey === true;

    if (path.resolve(destPath) === path.resolve(sourceDbPathFor(community)))
        throw new PKCError("ERR_EXPORT_PATH_TARGETS_LIVE_DB", { communityAddress: community.address, exportPath: destPath });

    if (!community.publicKey) throw new PKCError("ERR_LOCAL_COMMUNITY_HAS_NO_SIGNER_IN_INTERNAL_STATE", { address: community.address });

    const record: CommunityExportRecord = {
        exportId,
        ...(community.name ? { name: community.name } : {}),
        publicKey: community.publicKey,
        includePrivateKey,
        progress: 0
    };
    community._exports.push(record);
    await persistExports(community);
    emitExportsChange(community);

    const controller = new AbortController();
    let detachUserSignal: (() => void) | undefined;
    if (options.signal) {
        const userSignal = options.signal;
        const onAbort = () => controller.abort(userSignal.reason);
        userSignal.addEventListener("abort", onAbort, { once: true });
        detachUserSignal = () => userSignal.removeEventListener("abort", onAbort);
    }

    // Serialize per-community: each export waits for the prior queue entry before running.
    // Using a chained Promise guarantees ordering even under high concurrency.
    const previousQueue = community._exportQueue;
    let resolveDone!: () => void;
    const donePromise = new Promise<void>((res) => {
        resolveDone = res;
    });
    community._activeExports.set(exportId, { exportId, controller, detachUserSignal, donePromise });

    community._exportQueue = previousQueue
        .then(async () => {
            // Skip the actual work if the record was already cancelled while queued
            const current = community._exports.find((r) => r.exportId === exportId);
            if (!current || current.error) return;
            if (controller.signal.aborted) {
                await updateRecord(community, exportId, {
                    error: { code: "ERR_EXPORT_CANCELLED", message: "Export was cancelled before it could start" }
                });
                return;
            }
            await runExportTask(community, exportId, { destPath, includePrivateKey, signal: controller.signal });
        })
        .catch(() => {
            // runExportTask already records errors on the record; swallow so the queue stays alive
        })
        .finally(() => {
            detachUserSignal?.();
            resolveDone();
        });

    return { exportId };
}

export async function cancelExportEmbedded(community: LocalCommunity, exportId: string): Promise<void> {
    const handle = community._activeExports.get(exportId);
    if (!handle) return;
    handle.controller.abort();
    try {
        await handle.donePromise;
    } catch {
        // already recorded
    }
}

// Removes an export record from `community._exports`, deletes its backing file (if it lives
// under a file:// URL), persists to KeyV, and emits `exportschange`. Used by the RPC HTTP
// download endpoint to clean up after a successful download.
export async function deleteExportRecord(community: LocalCommunity, exportId: string): Promise<void> {
    const idx = community._exports.findIndex((r) => r.exportId === exportId);
    if (idx === -1) return;
    const record = community._exports[idx];

    if (record.url) {
        try {
            const parsed = new URL(record.url);
            if (parsed.protocol === "file:") await fsPromises.unlink(fileURLToPath(parsed)).catch(() => {});
        } catch {
            // Malformed URL — ignore; we still drop the record.
        }
    }

    community._exports.splice(idx, 1);
    await persistExports(community);
    emitExportsChange(community);
}

// Called on community load to:
//   (a) hydrate community._exports from KeyV, and
//   (b) prune records whose backing file no longer exists on disk (e.g. user deleted it).
export async function loadAndPruneExportsFromKeyv(community: LocalCommunity): Promise<void> {
    if (!community._dbHandler) return;
    let stored: CommunityExportRecord[] | undefined;
    try {
        stored = community._dbHandler.keyvHas(EXPORTS_KEY) ? community._dbHandler.keyvGet<CommunityExportRecord[]>(EXPORTS_KEY) ?? [] : [];
    } catch (e) {
        Logger("pkc-js:local-community:export").error("Failed to load exports from keyv", e);
        return;
    }
    const pruned: CommunityExportRecord[] = [];
    let didPrune = false;
    for (const record of stored) {
        // Drop records that never reached completion (in-flight crashes) or whose file is missing
        if (record.progress === 1 && record.url) {
            try {
                const parsed = new URL(record.url);
                if (parsed.protocol === "file:" && !existsSync(fileURLToPath(parsed))) {
                    didPrune = true;
                    continue;
                }
            } catch {
                didPrune = true;
                continue;
            }
            pruned.push(record);
        } else if (record.error) {
            // Terminal failure record — keep so the user can inspect it
            pruned.push(record);
        } else {
            // Was in-flight when the process exited; we can't resume, so drop
            didPrune = true;
        }
    }
    community._exports = pruned;
    if (didPrune) await persistExports(community);
}
