import { existsSync, readdirSync, openSync, readSync, closeSync, rm as rmSync, watch as fsWatch, promises as fsPromises } from "node:fs";
import { default as nodeNativeFunctions } from "./native-functions.js";
import type { KuboRpcClient, NativeFunctions } from "../../types.js";
import path from "path";
import assert from "assert";
import scraper from "open-graph-scraper";
import { HttpProxyAgent, HttpsProxyAgent } from "hpagent";
import { PKCError } from "../../pkc-error.js";
import probe from "probe-image-size";
import { PKC } from "../../pkc/pkc.js";
import { STORAGE_KEYS } from "../../constants.js";
import { RemoteCommunity } from "../../community/remote-community.js";
import os from "os";
import type { OpenGraphScraperOptions } from "open-graph-scraper/types";
import { Agent as HttpAgent } from "http";
import { Agent as HttpsAgent } from "https";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { create as CreateKuboRpcClient } from "kubo-rpc-client";
import Logger from "../../logger.js";
import * as remeda from "remeda";
import type { CommunityIpfsType } from "../../community/types.js";
import type {
    CommentIpfsType,
    CommentPubsubMessagePublication,
    CommentPubsubMessagPublicationSignature,
    CommentsTableRow,
    CommentUpdateType,
    DbRepliesFormat,
    DbPostsFormat
} from "../../publications/comment/types.js";
import { DbHandler } from "./community/db-handler.js";
import Database from "better-sqlite3";
import { CommentIpfsSchema, CommentUpdateSchema } from "../../publications/comment/schema.js";
import type { PageIpfs } from "../../pages/types.js";
import { MAX_FILE_SIZE_BYTES_FOR_COMMENT_UPDATE } from "../../publications/comment/comment-client-manager.js";

export const getDefaultDataPath = () => path.join(process.cwd(), ".pkc");

export const getDefaultCommunityDbConfig = async (communityAddress: string, pkc: PKC): Promise<DbHandler["_dbConfig"]> => {
    let filename: string;
    if (pkc.noData) filename = ":memory:";
    else {
        assert(typeof pkc.dataPath === "string", "pkc.dataPath need to be defined to get default community db config");
        filename = path.join(pkc.dataPath, "communities", communityAddress);
        await fsPromises.mkdir(path.dirname(filename), { recursive: true });
    }

    return {
        filename,
        fileMustExist: true
    };
};

async function _getThumbnailUrlOfLink(url: string, agent?: { https: any; http: any }) {
    const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
    const lowerCaseLink = url.toLowerCase();
    if (imageExtensions.some((ext) => lowerCaseLink.endsWith(ext))) {
        return { thumbnailUrl: url };
    }

    const options: OpenGraphScraperOptions & { agent?: { https: any; http: any } } = {
        url,
        fetchOptions: {
            // not sure which prop is used here, but let's use both
            //@ts-expect-error
            downloadLimit: 2000000,
            size: 2000000
        }
    };

    if (agent) options["agent"] = agent;

    const res = await scraper(options);

    if (res.error) {
        throw res;
    }
    if (!res?.result?.ogImage) return undefined;

    return {
        thumbnailUrl: res.result.ogImage[0].url,
        thumbnailUrlWidth: Number(res.result.ogImage[0].width),
        thumbnailUrlHeight: Number(res.result.ogImage[0].height)
    };
}

// Should be moved to community.ts
export async function getThumbnailPropsOfLink(
    url: string,
    community: RemoteCommunity,
    proxyHttpUrl?: string
): Promise<{ thumbnailUrl: string; thumbnailUrlWidth?: number; thumbnailUrlHeight?: number } | undefined> {
    const log = Logger(`pkc-js:community:getThumbnailUrlOfLink`);

    const agent = proxyHttpUrl
        ? {
              http: new HttpProxyAgent({ proxy: proxyHttpUrl }),
              https: new HttpsProxyAgent({ proxy: proxyHttpUrl })
          }
        : undefined;

    let thumbnailOg: Awaited<ReturnType<typeof _getThumbnailUrlOfLink>>;

    try {
        thumbnailOg = await _getThumbnailUrlOfLink(url, agent);
    } catch (e) {
        const pkcError = new PKCError("ERR_FAILED_TO_FETCH_THUMBNAIL_URL_OF_LINK", {
            error: e,
            url,
            proxyHttpUrl,
            communityAddress: community.address
        });
        //@ts-expect-error
        pkcError.stack = e.stack;
        log.error(pkcError);
        community.emit("error", pkcError);
        return undefined;
    }
    if (!thumbnailOg) return undefined;

    try {
        let thumbnailHeight = thumbnailOg.thumbnailUrlHeight;
        let thumbnailWidth = thumbnailOg.thumbnailUrlWidth;
        if (typeof thumbnailHeight !== "number" || thumbnailHeight === 0 || isNaN(thumbnailHeight)) {
            const probedDimensions = await fetchDimensionsOfImage(thumbnailOg.thumbnailUrl, agent);
            if (probedDimensions) {
                thumbnailHeight = probedDimensions.height;
                thumbnailWidth = probedDimensions.width;
            }
        }
        if (typeof thumbnailWidth !== "number" || typeof thumbnailHeight !== "number") return { thumbnailUrl: thumbnailOg.thumbnailUrl };
        return { thumbnailUrl: thumbnailOg.thumbnailUrl, thumbnailUrlHeight: thumbnailHeight, thumbnailUrlWidth: thumbnailWidth };
    } catch (e) {
        const pkcError = new PKCError("ERR_FAILED_TO_FETCH_THUMBNAIL_DIMENSION_OF_LINK", {
            url,
            proxyHttpUrl,
            error: e,
            communityAddress: community.address
        });
        //@ts-expect-error
        pkcError.stack = e.stack;
        log.error(pkcError);
        community.emit("error", pkcError);
        return undefined;
    }
}

async function fetchDimensionsOfImage(imageUrl: string, agent?: any): Promise<{ width: number; height: number } | undefined> {
    const result = await probe(imageUrl, { agent });
    if (typeof result?.width === "number") return { width: result.width, height: result.height };
}

export const nativeFunctions: NativeFunctions = nodeNativeFunctions;
export const setNativeFunctions = (newNativeFunctions: Partial<NativeFunctions>) => {
    if (!newNativeFunctions) throw Error(`User passed an undefined object to setNativeFunctions`);
    //@ts-expect-error
    for (const i in newNativeFunctions) nativeFunctions[i] = newNativeFunctions[i];
};

export const deleteOldCommunityInWindows = async (subPath: string, pkc: Pick<PKC, "_storage">) => {
    const log = Logger("pkc-js:community:deleteStaleCommunityInWindows");
    const communityAddress = path.basename(subPath);
    await new Promise((resolve) => setTimeout(resolve, 10000)); // give windows time to release the file
    try {
        await fsPromises.rm(subPath, { force: true });
        log(`Succeeded in deleting old community (${communityAddress})`);
    } catch (e) {
        // Assume it's because of EBUSY
        log.error(
            `Failed to delete old community (${communityAddress}). Restarting the node process or daemon should make this error disappear`,
            e
        );
        // Put communityAddress in storage
        const storageKey = STORAGE_KEYS[STORAGE_KEYS.PERSISTENT_DELETED_COMMUNITIES];
        const communitiesThatWeFailedToDelete: string[] = (await pkc._storage.getItem(storageKey)) || [];
        if (!communitiesThatWeFailedToDelete.includes(communityAddress)) communitiesThatWeFailedToDelete.push(communityAddress);
        await pkc._storage.setItem(storageKey, communitiesThatWeFailedToDelete);
        log(`Updated persistent deleted communities in storage`, communitiesThatWeFailedToDelete);
    }
};

export async function tryToDeleteCommunitiesThatFailedToBeDeletedBefore(pkc: PKC, log: Logger) {
    const deletedPersistentCommunities = <string[] | undefined>(
        await pkc._storage.getItem(STORAGE_KEYS[STORAGE_KEYS.PERSISTENT_DELETED_COMMUNITIES])
    );

    if (Array.isArray(deletedPersistentCommunities)) {
        if (deletedPersistentCommunities.length === 0) {
            await pkc._storage.removeItem(STORAGE_KEYS[STORAGE_KEYS.PERSISTENT_DELETED_COMMUNITIES]);
            log("Removed persistent deleted communities from storage because there are none left");
            return undefined;
        }
        // Attempt to delete them
        const communitiesThatWereDeletedSuccessfully: string[] = [];
        for (const communityAddress of deletedPersistentCommunities) {
            const communityPath = path.join(<string>pkc.dataPath, "communities", communityAddress);
            try {
                await fsPromises.rm(communityPath, { force: true });
                log(`Succeeded in deleting old db path (${communityAddress})`);
                communitiesThatWereDeletedSuccessfully.push(communityAddress);
            } catch (e) {
                log.error(
                    `Failed to delete stale db (${communityAddress}). This error should go away after restarting the daemon or process`,
                    e
                );
            }
        }
        const newPersistentDeletedCommunities = remeda.difference(deletedPersistentCommunities, communitiesThatWereDeletedSuccessfully);
        if (newPersistentDeletedCommunities.length === 0) {
            await pkc._storage.removeItem(STORAGE_KEYS[STORAGE_KEYS.PERSISTENT_DELETED_COMMUNITIES]);
            log("Removed persistent deleted communities from storage because there are none left");
            return undefined;
        } else {
            await pkc._storage.setItem(STORAGE_KEYS[STORAGE_KEYS.PERSISTENT_DELETED_COMMUNITIES], newPersistentDeletedCommunities);
            log(`Updated persistent deleted communities in storage`, newPersistentDeletedCommunities);
            return newPersistentDeletedCommunities;
        }
    }
}

export function listCommunitiesSync(pkc: PKC) {
    const log = Logger("pkc-js:listCommunitiesSync");
    if (typeof pkc.dataPath !== "string") throw Error("pkc.dataPath needs to be defined to listCommunities");
    const communitiesPath = path.join(pkc.dataPath, "communities");

    // We'll skip the deleted persistent subs handling for now since it's async
    // and would need separate handling

    // Get files synchronously
    const files = readdirSync(communitiesPath, { recursive: false, withFileTypes: false })
        .map((file) => file.toString()) // Ensure all entries are strings
        .filter((file) => !file.includes(".lock") && !file.endsWith("-journal") && !file.endsWith("-shm") && !file.endsWith("-wal"));

    const communityFilesWeDontNeedToCheck = pkc.communities ? files.filter((address) => pkc.communities.includes(address)) : [];

    // For the remaining files, check if they're SQLite files synchronously
    const filesToCheckIfSqlite = files.filter((address) => !communityFilesWeDontNeedToCheck.includes(address));
    const sqliteFiles = filesToCheckIfSqlite.filter((address) => {
        try {
            // Simple synchronous check for SQLite files
            // Look for the SQLite file header "SQLite format 3\0"
            const filePath = path.join(communitiesPath, address);
            if (!existsSync(filePath)) return false;

            const fd = openSync(filePath, "r");
            const buffer = Buffer.alloc(16);
            readSync(fd, buffer, 0, 16, 0);
            closeSync(fd);

            // Check for SQLite header
            return buffer.toString().startsWith("SQLite format 3");
        } catch (e) {
            return false;
        }
    });

    // Combine and sort the results
    const filtered_results = [...communityFilesWeDontNeedToCheck, ...sqliteFiles].sort();
    return filtered_results;
}

export async function importSignerIntoKuboNode(
    ipnsKeyName: string,
    ipfsKey: Uint8Array,
    kuboRpcClientOptions: KuboRpcClient["_clientOptions"]
) {
    const log = Logger("pkc-js:local-community:importSignerIntoKuboNode");
    const data = new FormData();
    if (typeof ipnsKeyName !== "string") throw Error("ipnsKeyName needs to be defined before importing key into IPFS node");
    if (!ipfsKey || ipfsKey.constructor?.name !== "Uint8Array" || ipfsKey.byteLength <= 0)
        throw Error("ipfsKey needs to be defined before importing key into IPFS node");

    const normalizedKey = Uint8Array.from(ipfsKey);
    data.append("file", new Blob([normalizedKey.buffer]));
    const kuboRpcUrl = kuboRpcClientOptions.url;
    if (!kuboRpcUrl) throw Error(`Can't figure out ipfs node URL from ipfsNode (${JSON.stringify(kuboRpcClientOptions)}`);
    const url = `${kuboRpcUrl}/key/import?arg=${ipnsKeyName}&ipns-base=b58mh`;
    const res = await fetch(url, {
        method: "POST",
        body: data,
        headers: kuboRpcClientOptions.headers
    });

    if (res.status === 500) return; // key already imported

    if (res.status !== 200)
        throw new PKCError("ERR_FAILED_TO_IMPORT_IPFS_KEY", { url, status: res.status, statusText: res.statusText, ipnsKeyName });
    const resJson = (await res.json()) as { Id: string; Name: string };

    log("Imported IPNS' signer into kubo node", resJson, " Onto kubo rpc URL", kuboRpcUrl);
    return { id: resJson.Id, name: resJson.Name };
}

export async function moveCommunityDbToDeletedDirectory(communityAddress: string, pkc: PKC) {
    if (typeof pkc.dataPath !== "string") throw Error("pkc.dataPath is not defined");

    const oldPath = path.join(pkc.dataPath, "communities", communityAddress);
    const newPath = path.join(pkc.dataPath, "communities", "deleted", communityAddress);

    // Create the deleted directory if it doesn't exist
    await fsPromises.mkdir(path.join(pkc.dataPath, "communities", "deleted"), { recursive: true });

    // Check if the source file exists
    if (!existsSync(oldPath)) {
        throw Error(`Source database ${oldPath} does not exist`);
    }

    // Use better-sqlite3 backup instead of file copy
    try {
        const sourceDb = new Database(oldPath, { fileMustExist: true });

        // Perform backup
        await sourceDb.backup(newPath);

        // Close the connection
        sourceDb.close();

        // Delete the original file
        if (os.type() === "Windows_NT") {
            await deleteOldCommunityInWindows(oldPath, pkc);
        } else
            rmSync(oldPath, (err) => {
                if (err) throw err;
            });
    } catch (error: any) {
        error.details = { ...error.details, oldPath, newPath };
        throw error;
    }
}

export function createKuboRpcClient(kuboRpcClientOptions: KuboRpcClient["_clientOptions"]): KuboRpcClient["_client"] {
    const log = Logger("pkc-js:pkc:createKuboRpcClient");
    log.trace("Creating a new kubo client on node with options", kuboRpcClientOptions);
    const isHttpsAgent =
        (typeof kuboRpcClientOptions.url === "string" && kuboRpcClientOptions.url.startsWith("https")) ||
        kuboRpcClientOptions?.protocol === "https" ||
        (kuboRpcClientOptions.url instanceof URL && kuboRpcClientOptions?.url?.protocol === "https:") ||
        kuboRpcClientOptions.url?.toString()?.includes("https");
    const Agent = isHttpsAgent ? HttpsAgent : HttpAgent;

    const onehourMs = 1000 * 60 * 60;

    const kuboRpcClient = CreateKuboRpcClient({
        ...kuboRpcClientOptions,
        agent: kuboRpcClientOptions.agent || new Agent({ keepAlive: true, maxSockets: Infinity, timeout: onehourMs }),
        timeout: onehourMs
    });

    return kuboRpcClient;
}

export async function monitorCommunitiesDirectory(pkc: PKC) {
    const watchAbortController = new AbortController();
    const communitiesPath = path.join(pkc.dataPath!, "communities");

    // Create directory synchronously if it doesn't exist
    await fsPromises.mkdir(communitiesPath, { recursive: true });

    const extensionsToIgnore = [".lock", "-journal", "-shm", "-wal"];
    let isProcessingChange = false;

    // Initial check
    const initialCommunities = listCommunitiesSync(pkc);
    if (deterministicStringify(initialCommunities) !== deterministicStringify(pkc.communities)) {
        pkc.emit("communitieschange", initialCommunities);
    }

    // Set up watcher with synchronous check
    fsWatch(communitiesPath, { signal: watchAbortController.signal, persistent: false }, (eventType, filename) => {
        // Skip ignored files
        if (typeof filename === "string" && extensionsToIgnore.some((ext) => filename.endsWith(ext))) return;

        // Prevent overlapping processing
        if (isProcessingChange) return;

        isProcessingChange = true;
        try {
            const currentCommunities = listCommunitiesSync(pkc);
            if (deterministicStringify(currentCommunities) !== deterministicStringify(pkc.communities)) {
                pkc.emit("communitieschange", currentCommunities);
            }
        } catch (error) {
            // Handle any errors
        } finally {
            isProcessingChange = false;
        }
    });

    return watchAbortController;
}

export function calculateExpectedSignatureSize(
    newIpns: Omit<CommunityIpfsType, "signature" | "posts"> | Omit<CommentUpdateType, "signature" | "posts">
) {
    // Get all non-undefined properties as they'll be in signedPropertyNames
    const signedProps = Object.entries(newIpns)
        .filter(([_, value]) => value !== undefined)
        .map(([key]) => key);

    const mockSignature = {
        signature: "A".repeat(88), // ed25519 sig is 64 bytes -> 88 bytes in base64
        publicKey: "A".repeat(44), // ed25519 pubkey is 32 bytes -> 44 bytes in base64
        type: "ed25519",
        signedPropertyNames: signedProps
    };

    return Buffer.byteLength(JSON.stringify(mockSignature), "utf8");
}

export function deriveCommentIpfsFromCommentTableRow(commentTableRow: CommentsTableRow): CommentIpfsType {
    const commentIpfs = remeda.pick(commentTableRow, remeda.keys.strict(CommentIpfsSchema.shape)) as CommentIpfsType;
    const commentPubsub = remeda.pick(
        commentTableRow,
        (commentTableRow.signature as CommentPubsubMessagPublicationSignature).signedPropertyNames
    ) as CommentPubsubMessagePublication;
    const finalCommentIpfsJson = <CommentIpfsType>{
        ...commentPubsub,
        ...commentIpfs,
        ...commentTableRow.extraProps
    };
    if (commentTableRow.depth === 0) delete finalCommentIpfsJson.postCid;

    // For old migrated rows (pre-wire-format-change), extraProps contains subplebbitAddress.
    // The original CommentIpfs on IPFS did NOT have communityPublicKey/communityName,
    // so we must remove them to preserve CID reproducibility.
    if (commentTableRow.extraProps && "subplebbitAddress" in commentTableRow.extraProps) {
        delete (finalCommentIpfsJson as Record<string, unknown>).communityPublicKey;
        delete (finalCommentIpfsJson as Record<string, unknown>).communityName;
    }

    return finalCommentIpfsJson;
}

type InlineRepliesBudgetOptions = {
    comment: CommentsTableRow;
    commentUpdateWithoutReplies: Omit<CommentUpdateType, "signature">;
    maxCommentUpdateBytes?: number;
    maxPageBytes?: number;
    minInlineRepliesBytes?: number;
    hardInlineRepliesLimitBytes?: number;
    depthBufferBaseBytes?: number;
    depthBufferPerDepthBytes?: number;
    commentUpdateHeadroomBytes?: number;
    pageSafetyMarginBytes?: number;
    inlineMetadataBytes?: number;
};

export function calculateInlineRepliesBudget({
    comment,
    commentUpdateWithoutReplies,
    maxCommentUpdateBytes = MAX_FILE_SIZE_BYTES_FOR_COMMENT_UPDATE,
    maxPageBytes = 512 * 1024,
    minInlineRepliesBytes = 96 * 1024,
    hardInlineRepliesLimitBytes = 256 * 1024,
    depthBufferBaseBytes = 8 * 1024,
    depthBufferPerDepthBytes = 8 * 1024,
    commentUpdateHeadroomBytes = 4 * 1024,
    pageSafetyMarginBytes = 1024,
    inlineMetadataBytes = 2 * 1024
}: InlineRepliesBudgetOptions): number {
    const commentUpdateSize = Buffer.byteLength(JSON.stringify(commentUpdateWithoutReplies), "utf8");
    const repliesAvailableSize =
        maxCommentUpdateBytes -
        commentUpdateSize -
        calculateExpectedSignatureSize(commentUpdateWithoutReplies) -
        commentUpdateHeadroomBytes;

    const depthBufferBytes = depthBufferBaseBytes + comment.depth * depthBufferPerDepthBytes;
    const desiredPreloadedPageBudget = repliesAvailableSize - depthBufferBytes;
    const clampedPreloadedPageBudget = Math.min(Math.max(desiredPreloadedPageBudget, minInlineRepliesBytes), hardInlineRepliesLimitBytes);
    const inlineBudgetFromComment = Math.max(0, Math.min(clampedPreloadedPageBudget, repliesAvailableSize));

    const commentEntryWithoutReplies = {
        comment: deriveCommentIpfsFromCommentTableRow(comment),
        commentUpdate: commentUpdateWithoutReplies
    };
    const entryWithoutRepliesSize = Buffer.byteLength(JSON.stringify({ comments: [commentEntryWithoutReplies] }), "utf8");
    const inlineBudgetFromPage = Math.max(0, maxPageBytes - pageSafetyMarginBytes - inlineMetadataBytes - entryWithoutRepliesSize);

    return Math.max(0, Math.min(inlineBudgetFromComment, inlineBudgetFromPage));
}

export function deriveDbReplies(opts: {
    replies: CommentUpdateType["replies"];
    allPageCids?: Record<string, string[]>;
}): DbRepliesFormat | undefined {
    const { replies, allPageCids } = opts;
    if (!replies) return undefined;
    const result: DbRepliesFormat = {};

    // Preloaded sort(s): store commentCids + allPageCids
    if (replies.pages) {
        for (const [sortName, page] of Object.entries(replies.pages)) {
            result[sortName] = {
                commentCids: page.comments.map((c) => c.commentUpdate.cid),
                ...(allPageCids?.[sortName]?.length ? { allPageCids: allPageCids[sortName] } : {})
            };
        }
    }

    // Non-preloaded sorts: store only allPageCids
    if (allPageCids) {
        for (const [sortName, cids] of Object.entries(allPageCids)) {
            if (!result[sortName] && cids.length > 0) {
                result[sortName] = { allPageCids: cids };
            }
        }
    }

    return Object.keys(result).length > 0 ? result : undefined;
}

export function deriveDbPosts(opts: {
    posts: CommunityIpfsType["posts"];
    allPageCids?: Record<string, string[]>;
}): DbPostsFormat | undefined {
    const { posts, allPageCids } = opts;
    if (!posts) return undefined;
    const result: DbPostsFormat = {};

    // Preloaded sort(s): store commentCids + allPageCids
    if (posts.pages) {
        for (const [sortName, page] of Object.entries(posts.pages)) {
            result[sortName] = {
                commentCids: page.comments.map((c) => c.commentUpdate.cid),
                ...(allPageCids?.[sortName]?.length ? { allPageCids: allPageCids[sortName] } : {})
            };
        }
    }

    // Non-preloaded sorts: store only allPageCids
    if (allPageCids) {
        for (const [sortName, cids] of Object.entries(allPageCids)) {
            if (!result[sortName] && cids.length > 0) {
                result[sortName] = { allPageCids: cids };
            }
        }
    }

    // pageCids without allPageCids (e.g. restoring from old wire format with only pageCids)
    if (posts.pageCids) {
        for (const [sortName, cid] of Object.entries(posts.pageCids)) {
            if (!result[sortName] && cid) {
                result[sortName] = { allPageCids: [cid] };
            }
        }
    }

    return Object.keys(result).length > 0 ? result : undefined;
}

export function resolveDbPostsCidRefs(opts: { dbPosts: DbPostsFormat; dbHandler: DbHandler }): CommunityIpfsType["posts"] {
    // Resolve CID-ref format posts back to wire format for in-memory state on startup.
    // For preloaded sorts (with commentCids): query those posts from DB and resolve their nested replies.
    // For non-preloaded sorts (allPageCids only): reconstruct pageCids.
    const { dbPosts, dbHandler } = opts;
    const commentUpdateCols = remeda.keys.strict(CommentUpdateSchema.shape);
    const commentIpfsCols = [...remeda.keys.strict(CommentIpfsSchema.shape), "extraProps"];

    const pages: Record<string, PageIpfs> = {};
    const pageCids: Record<string, string> = {};

    for (const [sortName, sortEntry] of Object.entries(dbPosts)) {
        if (sortEntry?.commentCids?.length) {
            // Query posts by their CIDs and resolve nested replies
            const entries = dbHandler.queryCommentAndCommentUpdateByCids(sortEntry.commentCids, {
                commentUpdateCols,
                commentIpfsCols
            });

            // Preserve commentCids order
            const byCid = new Map<string, PageIpfs["comments"][0]>(entries.map((e) => [e.commentUpdate.cid, e]));
            const orderedEntries = sortEntry.commentCids.map((cid) => byCid.get(cid)).filter((e): e is PageIpfs["comments"][0] => !!e);

            const resolved = dbHandler.resolveRepliesCidRefsForEntries(orderedEntries);
            pages[sortName] = { comments: resolved };
        }
        if (sortEntry?.allPageCids?.[0]) {
            pageCids[sortName] = sortEntry.allPageCids[0];
        }
    }

    return {
        pages,
        ...(Object.keys(pageCids).length > 0 ? { pageCids } : {})
    };
}
