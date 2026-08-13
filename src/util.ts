import { messages } from "./errors.js";
import { PKCError } from "./pkc-error.js";
import type { CommunityIpfsType } from "./community/types.js";
//@ts-expect-error
import extName from "ext-name";
import { CID } from "multiformats/cid"; // re-sourced from kubo-rpc-client (identical class) to keep kubo off the eager import path
import type { Multiaddr } from "@multiformats/multiaddr";
import * as Digest from "multiformats/hashes/digest";
import { Buffer } from "buffer";
import { base58btc } from "multiformats/bases/base58";
import { isEmpty, isNonNullish, isPlainObject, keys, mapKeys, omitBy, pickBy } from "remeda";
import type { KuboRpcClient } from "./types.js";
import type {
    AddOptions,
    AddResult,
    BlockPutOptions,
    BlockRmOptions,
    FilesRmOptions,
    FilesStatOptions,
    FilesStatResult,
    FilesWriteOptions,
    RoutingProvideOptions
} from "kubo-rpc-client";
import type {
    DecryptedChallengeRequestMessageType,
    DecryptedChallengeRequestMessageTypeWithCommunityAuthor,
    DecryptedChallengeRequestMessageWithPostCommunityAuthor,
    DecryptedChallengeRequestMessageWithReplyCommunityAuthor,
    DecryptedChallengeRequestPublication,
    PublicationFromDecryptedChallengeRequest,
    PublicationWithCommunityAuthorFromDecryptedChallengeRequest
} from "./pubsub-messages/types.js";
import { DecryptedChallengeRequestPublicationSchema } from "./pubsub-messages/schema.js";
import EventEmitter from "events";
import { RemoteCommunity } from "./community/remote-community.js";
import pTimeout from "p-timeout";
import { of as calculateIpfsCidV0Lib } from "typestub-ipfs-only-hash";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import { sha256 } from "js-sha256";
import { base32 } from "multiformats/bases/base32";
import { PKC } from "./pkc/pkc.js";
import Logger from "./logger.js";
import retry from "retry";
import { peerIdFromString } from "@libp2p/peer-id";
// ipns / ipns/validator / blockstore-core / ipfs-unixfs-importer are dynamic-imported inside the async
// functions that use them (IPNS-record read/validate + CID-size helpers) so these externals stay off
// the eager import path — an RPC-only consumer never resolves them at import time.
import type { IPNSRecord } from "ipns";
import { findUpdatingCommunity } from "./pkc/tracked-instance-registry-util.js";

export function timestamp() {
    return Math.round(Date.now() / 1000);
}

export function createAbortError(message = "The operation was aborted") {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
}

export function isAbortError(error: unknown): error is Error {
    return error instanceof Error && error.name === "AbortError";
}

export function throwIfAbortSignalAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) {
        // Avoid assigning to `.name` when it's already set — the default DOMException reason
        // from `AbortController.abort()` (no arg) has `name` as a read-only getter.
        if (!signal.reason.name) signal.reason.name = "AbortError";
        throw signal.reason;
    }
    if (typeof signal.reason === "string" && signal.reason.length > 0) throw createAbortError(signal.reason);
    throw createAbortError();
}

// Sleep for `ms`, resolving early if `signal` aborts. The abort listener is detached on BOTH
// outcomes (timer elapsed or aborted), so it never leaks on a long-lived signal — `{ once: true }`
// alone only removes it when abort fires, which leaks one listener per call on the normal
// timer-elapsed path (see issues #145, #146). Used by the community update loops' inter-iteration
// sleep and the comment parallel-connect timer.
export function sleepUntilTimeoutOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        const onAbortOrTimeout = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbortOrTimeout);
            resolve();
        };
        const timer = setTimeout(onAbortOrTimeout, ms);
        signal?.addEventListener("abort", onAbortOrTimeout, { once: true });
    });
}

// Race `promise` against `signal` aborting, rejecting with an AbortError if the signal fires first.
// The abort listener is detached once the race settles regardless of who wins, so it never leaks on
// a long-lived signal — `{ once: true }` alone only removes it when abort fires, which leaks one
// listener per call in the common case (the promise wins; see issue #144). Mirrors the onParentAbort
// cleanup pattern in fetchFromMultipleGateways.
export async function raceAgainstAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    let onAbort: (() => void) | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                if (signal.aborted) {
                    reject(createAbortError());
                    return;
                }
                onAbort = () => reject(createAbortError());
                signal.addEventListener("abort", onAbort, { once: true });
            })
        ]);
    } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
    }
}

export function replaceXWithY(obj: Record<string, any>, x: any, y: any): any {
    // obj is a JS object
    if (!isPlainObject(obj)) return obj;
    const newObj: Record<string, any> = {};
    Object.entries(obj).forEach(([key, value]) => {
        if (obj[key] === x) newObj[key] = y;
        // `typeof`` gives browser transpiling error "Uncaught ReferenceError: exports is not defined"
        // don't know why but it can be fixed by replacing with `instanceof`
        // else if (typeof value === "object" && value !== null) newObj[key] = replaceXWithY(value, x, y);
        else if (isPlainObject(value)) newObj[key] = replaceXWithY(value, x, y);
        else if (Array.isArray(value)) newObj[key] = value.map((iterValue) => replaceXWithY(iterValue, x, y));
        else newObj[key] = value;
    });
    return newObj;
}

export function removeNullUndefinedValues<T extends Object>(obj: T): T {
    // remeda v2 types pickBy's result as EnumeratedPartialNarrowed<T, ...>, which no longer
    // overlaps T for a direct cast; go through unknown. Runtime: same object minus null/undefined.
    return pickBy(obj, isNonNullish) as unknown as T;
}

function removeUndefinedValues<T extends Object>(obj: T) {
    return pickBy(obj, isNonNullish);
}

function removeNullUndefinedEmptyObjectValues<T extends Object>(obj: T) {
    const firstStep = removeNullUndefinedValues(obj); // remove undefined and null values
    const secondStep = omitBy(firstStep, (value) => isPlainObject(value) && isEmpty(value)); // remove empty {} values
    return secondStep;
}

// A safe function that you can use that will not modify a JSON by removing null or empty objects
export function removeUndefinedValuesRecursively<T>(obj: T): T {
    if (Array.isArray(obj)) return <T>obj.map(removeUndefinedValuesRecursively);
    if (!isPlainObject(obj)) return obj;
    const cleanedObj: any = removeUndefinedValues(obj);
    for (const [key, value] of Object.entries(cleanedObj))
        if (isPlainObject(value) || Array.isArray(value)) cleanedObj[key] = removeUndefinedValuesRecursively(value);
    return cleanedObj;
}

export function removeNullUndefinedEmptyObjectsValuesRecursively<T>(obj: T): T {
    if (Array.isArray(obj)) return <T>obj.map(removeNullUndefinedEmptyObjectsValuesRecursively);
    if (!isPlainObject(obj)) return obj;
    const cleanedObj: any = removeNullUndefinedEmptyObjectValues(obj);
    for (const key of Object.keys(cleanedObj)) {
        if (isPlainObject(cleanedObj[key]) || Array.isArray(cleanedObj[key]))
            cleanedObj[key] = removeNullUndefinedEmptyObjectsValuesRecursively(cleanedObj[key]);
        if (isPlainObject(cleanedObj[key]) && isEmpty(cleanedObj[key])) delete cleanedObj[key];
    }

    return cleanedObj;
}

const parseIfJsonString = (jsonString: any) => {
    if (typeof jsonString !== "string" || (!jsonString.startsWith("{") && !jsonString.startsWith("["))) return undefined;
    try {
        return JSON.parse(jsonString);
    } catch {
        return undefined;
    }
};

// Only for DB
export const parseDbResponses = (obj: any): any => {
    // This function is gonna be called for every query on db, it should be optimized
    if (obj === "[object Object]") throw Error(`Object shouldn't be [object Object]`);
    if (Array.isArray(obj)) return obj.map((o) => parseDbResponses(o));
    const parsedJsonString = parseIfJsonString(obj);
    if (!isPlainObject(obj) && !parsedJsonString) return obj;

    const newObj = removeNullUndefinedValues(parsedJsonString || obj); // we may need clone here, not sure
    const booleanFields = [
        "deleted",
        "spoiler",
        "pinned",
        "locked",
        "archived",
        "removed",
        "nsfw",
        "commentIpfs_deleted",
        "commentIpfs_nsfw",
        "commentIpfs_spoiler",
        "commentIpfs_pinned",
        "commentIpfs_locked",
        "commentIpfs_archived",
        "commentIpfs_removed",
        "commentUpdate_deleted",
        "commentUpdate_spoiler",
        "commentUpdate_pinned",
        "commentUpdate_locked",
        "commentUpdate_archived",
        "commentUpdate_removed",
        "commentUpdate_nsfw",
        "isAuthorEdit",
        "publishedToPostUpdatesIpfs"
    ]; // TODO use zod here
    for (const [key, value] of Object.entries(newObj)) {
        if (value === "[object Object]") throw Error(`key (${key}) shouldn't be [object Object]`);

        if (booleanFields.includes(key) && (value === 1 || value === 0)) newObj[key] = Boolean(value);
        else newObj[key] = parseIfJsonString(value) || value;
    }
    if (newObj.extraProps) return { ...newObj, ...newObj.extraProps };
    else if (newObj["commentIpfs_extraProps"]) {
        // needed when creating pages
        const mappedExtraPropsOnCommentIpfs = mapKeys(newObj["commentIpfs_extraProps"], (key) => `commentIpfs_${String(key)}`);
        return { ...newObj, ...mappedExtraPropsOnCommentIpfs };
    }

    return <any>newObj;
};

export function shortifyAddress(address: string): string {
    if (address.includes(".")) return address; // If a domain then no need to shortify
    // Remove prefix (12D3KooW)
    const removedPrefix = address.slice(8);
    // Return first 12 characters
    const shortAddress = removedPrefix.slice(0, 12);
    return shortAddress;
}

export function shortifyCid(cid: string): string {
    // Remove prefix (Qm)
    // Return first 12 characters
    return cid.slice(2).slice(0, 12);
}

export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function firstResolve<T>(promises: Promise<T>[]) {
    return new Promise<T>((resolve) => promises.forEach((promise) => promise.then(resolve)));
}

export function getErrorCodeFromMessage(message: string): keyof typeof messages {
    const codes = keys(messages);
    for (const code of codes) if (messages[code] === message) return code;
    throw Error(`No error code was found for message (${message})`);
}

export function doesDomainAddressHaveCapitalLetter(domainAddress: string) {
    if (!domainAddress.includes(".")) return false;
    return /[A-Z]/.test(domainAddress); // Regex test for capital letters in English only
}

export function getPostUpdateTimestampRange(postUpdates: CommunityIpfsType["postUpdates"], postTimestamp: number) {
    if (!postUpdates) throw Error("community has no post updates");
    if (!postTimestamp) throw Error("post has no timestamp");
    return (
        keys(postUpdates)
            // sort from smallest to biggest
            .sort((a, b) => Number(a) - Number(b))
            // find the smallest timestamp range where comment.timestamp is newer
            .filter((timestampRange) => timestamp() - Number(timestampRange) <= postTimestamp)
    );
}

export function isLinkValid(link: string): boolean {
    try {
        const url = new URL(link);
        if (url.protocol !== "https:") throw Error("Not a valid https url");
        return true;
    } catch (e) {
        return false;
    }
}

export function isLinkOfMedia(link: string): boolean {
    if (!link) return false;
    let mime: string | undefined;
    try {
        mime = extName(new URL(link).pathname.toLowerCase().replace("/", ""))[0]?.mime;
    } catch (e) {
        return false;
    }
    if (mime?.startsWith("image") || mime?.startsWith("video") || mime?.startsWith("audio")) return true;
    return false;
}

function getMimeFromUrl(url: string): string | undefined {
    try {
        return extName(new URL(url).pathname.toLowerCase().replace("/", ""))[0]?.mime;
    } catch {
        return undefined;
    }
}

function isUrlOfImage(url: string): boolean {
    const mime = getMimeFromUrl(url);
    return mime?.startsWith("image") ?? false;
}

function isUrlOfVideo(url: string): boolean {
    const mime = getMimeFromUrl(url);
    return mime?.startsWith("video") ?? false;
}

export function isLinkOfImage(link: string): boolean {
    if (!link) return false;
    return isUrlOfImage(link);
}

export function isLinkOfVideo(link: string): boolean {
    if (!link) return false;
    return isUrlOfVideo(link);
}

// Known animated image MIME types
const ANIMATED_IMAGE_MIMES = new Set(["image/gif", "image/apng"]);

function isUrlOfAnimatedImage(url: string): boolean {
    const mime = getMimeFromUrl(url);
    return mime !== undefined && ANIMATED_IMAGE_MIMES.has(mime);
}

export function isLinkOfAnimatedImage(link: string): boolean {
    if (!link) return false;
    return isUrlOfAnimatedImage(link);
}

function isUrlOfAudio(url: string): boolean {
    const mime = getMimeFromUrl(url);
    return mime?.startsWith("audio") ?? false;
}

export function isLinkOfAudio(link: string): boolean {
    if (!link) return false;
    return isUrlOfAudio(link);
}

export function contentContainsMarkdownImages(content: string): boolean {
    if (!content) return false;

    // Check for HTML img tags
    const htmlImgTagRegex = /<img\s+[^>]*src\s*=\s*["']([^"']+)["'][^>]*\/?>/gi;
    if (htmlImgTagRegex.test(content)) return true;

    // Check for markdown image syntax: ![alt](url)
    // Negative lookbehind (?<!\\) ensures it's not escaped
    const markdownImageRegex = /(?<!\\)!\[[^\]]*\]\(([^)]+)\)/g;
    const matches = content.matchAll(markdownImageRegex);
    for (const match of matches) {
        const url = match[1];
        // If URL has image extension OR no extension (could be an image), flag it
        if (isUrlOfImage(url)) return true;
        // Also flag URLs without extensions (e.g., imgur direct links)
        const mime = getMimeFromUrl(url);
        if (mime === undefined) {
            // URL has no recognizable extension, still flag markdown images
            return true;
        }
    }

    return false;
}

export function contentContainsMarkdownAudio(content: string): boolean {
    if (!content) return false;

    // Check for HTML audio tags
    const htmlAudioTagRegex = /<audio[\s>]/gi;
    if (htmlAudioTagRegex.test(content)) return true;

    // Check for markdown image syntax with audio URLs: ![alt](url)
    const markdownImageRegex = /(?<!\\)!\[[^\]]*\]\(([^)]+)\)/g;
    const matches = content.matchAll(markdownImageRegex);
    for (const match of matches) {
        const url = match[1];
        if (isUrlOfAudio(url)) return true;
    }

    return false;
}

export function contentContainsMarkdownVideos(content: string): boolean {
    if (!content) return false;

    // Check for HTML video tags
    const htmlVideoTagRegex = /<video[\s>]/gi;
    if (htmlVideoTagRegex.test(content)) return true;

    // Check for HTML iframe tags (YouTube/Vimeo embeds)
    const htmlIframeTagRegex = /<iframe[\s>]/gi;
    if (htmlIframeTagRegex.test(content)) return true;

    // Check for markdown image syntax with video URLs: ![alt](url)
    const markdownImageRegex = /(?<!\\)!\[[^\]]*\]\(([^)]+)\)/g;
    const matches = content.matchAll(markdownImageRegex);
    for (const match of matches) {
        const url = match[1];
        if (isUrlOfVideo(url) || isUrlOfAnimatedImage(url)) return true;
    }

    return false;
}

export async function genToArray<T>(gen: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const x of gen) {
        out.push(x);
    }
    return out;
}

export function isStringDomain(x: string | undefined) {
    return typeof x === "string" && x.includes(".");
}

export function isEthAliasDomain(address: string): boolean {
    const lower = address.toLowerCase();
    return lower.endsWith(".eth") || lower.endsWith(".bso");
}

export function normalizeEthAliasDomain(address: string): string {
    return address.endsWith(".bso") ? address.slice(0, -4) + ".eth" : address;
}

export function areEquivalentCommunityAddresses(addressA: string, addressB: string): boolean {
    if (addressA === addressB) return true;
    const lowerA = addressA.toLowerCase();
    const lowerB = addressB.toLowerCase();
    if (!isEthAliasDomain(lowerA) || !isEthAliasDomain(lowerB)) return false;
    return normalizeEthAliasDomain(lowerA) === normalizeEthAliasDomain(lowerB);
}

export function getEquivalentCommunityAddresses(address: string): string[] {
    const lower = address.toLowerCase();
    if (lower.endsWith(".bso")) return [address, address.slice(0, -4) + ".eth"];
    if (lower.endsWith(".eth")) return [address, address.slice(0, -4) + ".bso"];
    return [address];
}

export function isIpns(x: string) {
    // This function will test if a string is of IPNS address (12D)
    try {
        Digest.decode(base58btc.decode(`z${x}`));
        return true;
    } catch {
        return false;
    }
}

export function isIpfsCid(x: string) {
    try {
        return Boolean(CID.parse(x));
    } catch {
        return false;
    }
}

export function isIpfsPath(x: string): boolean {
    return x.startsWith("/ipfs/");
}

export function isIpnsPath(x: string): boolean {
    // Require a non-empty name segment after the prefix so a malformed bare "/ipns/" is rejected
    // (it would otherwise flow into split("/")[2] next-hop parsing as an empty name).
    const parts = x.split("/");
    return parts.length >= 3 && parts[1] === "ipns" && parts[2].length > 0;
}

export type KuboRpcClientCreateOption = string | URL | Multiaddr | (Record<string, unknown> & { url?: string | URL | Multiaddr });

function isMultiaddrLike(value: unknown): value is Multiaddr {
    if (typeof value !== "object" || value === null) return false;
    if (!("bytes" in value)) return false;
    const candidate = value as { bytes?: unknown };
    return candidate.bytes instanceof Uint8Array;
}

export function parseIpfsRawOptionToIpfsOptions(kuboRpcRawOption: KuboRpcClientCreateOption): KuboRpcClient["_clientOptions"] {
    if (!kuboRpcRawOption) throw Error("Need to define the ipfs options");
    if (typeof kuboRpcRawOption === "string" || kuboRpcRawOption instanceof URL) {
        const url = new URL(kuboRpcRawOption);
        const authorization =
            url.username && url.password ? "Basic " + Buffer.from(`${url.username}:${url.password}`).toString("base64") : undefined;
        return {
            url: authorization ? url.origin + url.pathname : kuboRpcRawOption.toString(),
            ...(authorization ? { headers: { authorization, origin: "http://localhost" } } : undefined)
        };
    } else if (isMultiaddrLike(kuboRpcRawOption)) return { url: kuboRpcRawOption };
    else return kuboRpcRawOption as KuboRpcClient["_clientOptions"];
}

// Deep merge runtimeFields from RPC server into parsed data.
// Handles nested objects (recursive), arrays (element-by-element), and primitives (overwrite).
// For getter-only properties (e.g. updatingState), sets the backing _field directly.
export function deepMergeRuntimeFields(target: any, source: any): void {
    if (!source || typeof source !== "object") return;
    if (!target || typeof target !== "object") return;
    for (const key of Object.keys(source)) {
        if (Array.isArray(source[key]) && Array.isArray(target?.[key])) {
            for (let i = 0; i < source[key].length; i++) {
                if (i < target[key].length) deepMergeRuntimeFields(target[key][i], source[key][i]);
            }
        } else if (source[key] && typeof source[key] === "object" && target?.[key] && typeof target[key] === "object") {
            deepMergeRuntimeFields(target[key], source[key]);
        } else if (source[key] !== undefined) {
            // Don't create new complex (object/array) properties on the target from runtimeFields.
            // RuntimeFields should only merge into existing structures, not create new pages/comments/etc.
            if ((typeof source[key] === "object" || Array.isArray(source[key])) && !(key in target)) {
                continue;
            }
            // Check if the property is getter-only (no setter)
            let descriptor: PropertyDescriptor | undefined;
            let proto = target;
            while (proto && !descriptor) {
                descriptor = Object.getOwnPropertyDescriptor(proto, key);
                proto = Object.getPrototypeOf(proto);
            }
            if (descriptor?.get && !descriptor.set) {
                // Set the backing _field directly (e.g. _updatingState for updatingState)
                target[`_${key}`] = source[key];
            } else {
                target[key] = source[key];
            }
        }
    }
}

export function hideClassPrivateProps(_this: any) {
    // make props that start with _ not enumerable

    for (const propertyName in _this) {
        if (propertyName.startsWith("_")) Object.defineProperty(_this, propertyName, { enumerable: false });
    }
}

export function derivePublicationFromChallengeRequest<
    T extends Pick<
        | DecryptedChallengeRequestMessageType
        | DecryptedChallengeRequestMessageTypeWithCommunityAuthor
        | DecryptedChallengeRequestMessageType,
        keyof DecryptedChallengeRequestPublication
    >
>(
    request: T
): T extends DecryptedChallengeRequestMessageTypeWithCommunityAuthor
    ? PublicationWithCommunityAuthorFromDecryptedChallengeRequest
    : PublicationFromDecryptedChallengeRequest {
    const publicationFieldNames = keys(DecryptedChallengeRequestPublicationSchema.shape) as (keyof T)[];
    for (const pubName of publicationFieldNames) {
        const publication = request[pubName];
        if (publication)
            return publication as T extends DecryptedChallengeRequestMessageTypeWithCommunityAuthor
                ? PublicationWithCommunityAuthorFromDecryptedChallengeRequest
                : PublicationFromDecryptedChallengeRequest;
    }

    throw Error("Failed to find publication on ChallengeRequest");
}

export function isRequestPubsubPublicationOfReply(
    request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor
): request is DecryptedChallengeRequestMessageWithReplyCommunityAuthor {
    return Boolean(request.comment && request.comment.parentCid);
}

export function isRequestPubsubPublicationOfPost(
    request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor
): request is DecryptedChallengeRequestMessageWithPostCommunityAuthor {
    return Boolean(request.comment && !request.comment.parentCid);
}

export async function resolveWhenPredicateIsTrue(options: {
    toUpdate: EventEmitter;
    predicate: () => Promise<boolean> | boolean;
    eventName?: string;
}) {
    const { toUpdate, predicate, eventName = "update" } = options;
    await new Promise<void>((resolve, reject) => {
        const listener = async () => {
            try {
                const conditionStatus = await predicate();
                if (conditionStatus) {
                    toUpdate.removeListener(eventName, listener);
                    resolve();
                }
            } catch (error) {
                toUpdate.removeListener(eventName, listener);
                reject(error);
            }
        };
        toUpdate.on(eventName, listener);
        listener(); // initial check — no await, errors flow through reject()
    });
}

export async function waitForUpdateInCommunityInstanceWithErrorAndTimeout(community: RemoteCommunity, timeoutMs: number) {
    const wasUpdating = community.state === "updating";
    const updatingStates: RemoteCommunity["updatingState"][] = [];
    const updatingStateChangeListener = (state: RemoteCommunity["updatingState"]) => updatingStates.push(state);
    community.on("updatingstatechange", updatingStateChangeListener);
    // Wait specifically for communityIpfs to be defined — intermediate "update" events
    // (e.g. resetInstance, toJSONInternalRpcBeforeFirstUpdate) may fire without it
    let updateListener: (() => void) | undefined;
    const updatePromise = new Promise<void>((resolve) => {
        updateListener = () => {
            if (community.raw.communityIpfs) {
                community.removeListener("update", updateListener!);
                resolve();
            }
        };
        community.on("update", updateListener);
    });
    // Track all errors for debugging context, but only throw immediately on non-retriable errors.
    // Retriable errors (details.retriableError === true) are handled by the retry loop —
    // throwing on them would abort the retry before it can succeed.
    const errors: (PKCError | Error)[] = [];
    let criticalError: PKCError | Error | undefined;
    let nonRetriableErrorResolve: (() => void) | undefined;
    const nonRetriableErrorPromise = new Promise<void>((resolve) => {
        nonRetriableErrorResolve = resolve;
    });
    const errorListener = (err: PKCError | Error) => {
        errors.push(err);
        const isRetriable = "details" in err && (err as any).details?.retriableError === true;
        if (!isRetriable) {
            criticalError = err;
            nonRetriableErrorResolve?.();
        }
    };
    community.on("error", errorListener);
    try {
        if (community.state !== "started") await community.update();
        if (criticalError) throw criticalError; // Non-retriable error may have fired synchronously during update (e.g. RPC emitAllPendingMessages replay)
        await pTimeout(Promise.race([updatePromise, nonRetriableErrorPromise]), {
            milliseconds: timeoutMs,
            message:
                criticalError ||
                errors.at(-1) ||
                new PKCError("ERR_GET_COMMUNITY_TIMED_OUT", {
                    communityAddress: community.address,
                    timeoutMs,
                    errors,
                    updatingStates,
                    community
                })
        });
        if (criticalError) throw criticalError;
    } catch (e) {
        if (criticalError) throw criticalError;
        if (errors.length > 0) throw errors.at(-1);
        const updatingCommunity = findUpdatingCommunity(community._pkc, { publicKey: community.publicKey, name: community.name });
        if (updatingCommunity?._clientsManager._ipnsLoadingOperation?.mainError())
            throw updatingCommunity._clientsManager._ipnsLoadingOperation.mainError();
        throw e;
    } finally {
        if (updateListener) community.removeListener("update", updateListener);
        community.removeListener("error", errorListener);
        community.removeListener("updatingstatechange", updatingStateChangeListener);
        if (!wasUpdating && community.state !== "started") await community.stop();
    }
}

export function calculateIpfsCidV0(content: string) {
    return calculateIpfsCidV0Lib(content);
}

/**
 * converts a binary record key to a pubsub topic key
 */
export function binaryKeyToPubsubTopic(key: Uint8Array) {
    const b64url = uint8ArrayToString(key, "base64url");

    return `/record/${b64url}`;
}

export function ipnsNameToIpnsOverPubsubTopic(ipnsName: string) {
    // for ipns over pubsub, the topic is '/record/' + Base64Url(Uint8Array('/ipns/') + Uint8Array('12D...'))
    // https://github.com/ipfs/helia/blob/1561e4a106074b94e421a77b0b8776b065e48bc5/packages/ipns/src/routing/pubsub.ts#L169
    const ipnsNamespaceBytes = new TextEncoder().encode("/ipns/");
    const ipnsNameBytes = peerIdFromString(ipnsName).toMultihash().bytes; // accepts base58 (12D...) and base36 (k51...)
    const ipnsNameBytesWithNamespace = new Uint8Array(ipnsNamespaceBytes.length + ipnsNameBytes.length);
    ipnsNameBytesWithNamespace.set(ipnsNamespaceBytes, 0);
    ipnsNameBytesWithNamespace.set(ipnsNameBytes, ipnsNamespaceBytes.length);
    const pubsubTopic = "/record/" + uint8ArrayToString(ipnsNameBytesWithNamespace, "base64url");
    return pubsubTopic;
}

export const pubsubTopicToDhtKey = (pubsubTopic: string): string => {
    return pubsubTopicToDhtKeyCid(pubsubTopic).toString(base32);
};

export const pubsubTopicToDhtKeyCid = (pubsubTopic: string): CID => {
    const stringToHash = `floodsub:${pubsubTopic}`;
    const bytes = new TextEncoder().encode(stringToHash);

    // Use synchronous sha256 from js-sha256
    const hashBytes = sha256.array(bytes);

    // Create a multiformats digest from the raw hash bytes
    // 0x12 is the multicodec for SHA-256
    const digest = Digest.create(0x12, new Uint8Array(hashBytes));

    // Create CID with the digest
    const cid = CID.create(1, 0x55, digest);
    return cid;
};

export async function retryKuboBlockPutPinAndProvidePubsubTopic({
    ipfsClient: kuboRpcClient,
    log,
    pubsubTopic,
    inputNumOfRetries,
    blockPutOptions,
    provideOptions
}: {
    ipfsClient: Pick<PKC["clients"]["kuboRpcClients"][string]["_client"], "block" | "routing">;
    log: Logger;
    pubsubTopic: string;
    inputNumOfRetries?: number;
    blockPutOptions?: BlockPutOptions;
    provideOptions?: RoutingProvideOptions;
}): Promise<CID> {
    const numOfRetries = inputNumOfRetries ?? 3;
    const bytes = new TextEncoder().encode(`floodsub:${pubsubTopic}`);
    const expectedCid = pubsubTopicToDhtKeyCid(pubsubTopic);

    return new Promise((resolve, reject) => {
        const operation = retry.operation({
            retries: numOfRetries,
            factor: 2,
            minTimeout: 2000
        });

        operation.attempt(async (currentAttempt) => {
            try {
                // pin in the same call rather than with a following pin.add: a repo gc that lands
                // between the two deletes the still-unpinned block, and pin.add on a block the node
                // no longer has waits on bitswap forever instead of failing, which hangs
                // community.start() until its caller times out.
                const cid = (await kuboRpcClient.block.put(bytes, {
                    ...blockPutOptions,
                    format: "raw",
                    mhtype: "sha2-256",
                    version: 1,
                    pin: true
                })) as CID;

                if (!cid.equals(expectedCid)) {
                    throw new Error(
                        `block.put CID mismatch for pubsub topic ${pubsubTopic}: expected ${String(expectedCid)} got ${String(cid)}`
                    );
                }

                try {
                    const provideEvents = kuboRpcClient.routing.provide(cid, provideOptions);
                    for await (const event of provideEvents) {
                        log.trace(`Provide event for ${String(cid)}:`, event);
                    }
                } catch (e) {
                    log.trace("Minor Error, not a big deal: Failed to provide after block.put", e);
                }

                resolve(cid);
            } catch (error) {
                log.error(`Failed attempt ${currentAttempt}/${numOfRetries + 1} to store and provide pubsub topic block:`, error);

                if (operation.retry(error as Error)) return;

                reject(operation.mainError() || error);
            }
        });
    });
}

export async function retryKuboIpfsAddAndProvide({
    ipfsClient: kuboRpcClient,
    log,
    content,
    inputNumOfRetries,
    addOptions,
    provideOptions,
    provideInBackground
}: {
    ipfsClient: Pick<PKC["clients"]["kuboRpcClients"][string]["_client"], "add" | "routing">;
    log: Logger;
    content: string;
    inputNumOfRetries?: number;
    addOptions?: AddOptions;
    provideOptions?: RoutingProvideOptions;
    provideInBackground: boolean;
}): Promise<AddResult> {
    const numOfRetries = inputNumOfRetries ?? 3;

    return new Promise((resolve, reject) => {
        const operation = retry.operation({
            retries: numOfRetries,
            factor: 2,
            minTimeout: 2000
        });

        operation.attempt(async (currentAttempt) => {
            try {
                const addRes = await kuboRpcClient.add(content, addOptions);
                // I think it's not needed to provide now that the re-providing bug has been fixed

                const runProvide = async () => {
                    try {
                        const provideEvents = kuboRpcClient.routing.provide(addRes.cid, provideOptions);
                        for await (const event of provideEvents) {
                            log.trace(`Provide event for ${addRes.cid}:`, event);
                        }
                    } catch (e) {
                        log.trace("Minor Error, not a big deal: Failed to provide after add", e);
                    }
                };

                if (provideInBackground) {
                    void runProvide();
                } else {
                    await runProvide();
                }
                resolve(addRes);
            } catch (error) {
                log.error(`Failed attempt ${currentAttempt}/${numOfRetries + 1} to add and provide content to IPFS:`, error);

                if (operation.retry(error as Error)) return;

                reject(operation.mainError() || error);
            }
        });
    });
}

export async function retryKuboIpfsAdd({
    ipfsClient: kuboRpcClient,
    log,
    content,
    inputNumOfRetries,
    options
}: {
    ipfsClient: Pick<PKC["clients"]["kuboRpcClients"][string]["_client"], "add">;
    log: Logger;
    content: string;
    inputNumOfRetries?: number;
    options?: AddOptions;
}): Promise<AddResult> {
    const numOfRetries = inputNumOfRetries ?? 3;

    return new Promise((resolve, reject) => {
        const operation = retry.operation({
            retries: numOfRetries,
            factor: 2,
            minTimeout: 2000
        });

        operation.attempt(async (currentAttempt) => {
            try {
                const addRes = await kuboRpcClient.add(content, options);
                resolve(addRes);
            } catch (error) {
                log.error(`Failed attempt ${currentAttempt}/${numOfRetries + 1} to add content to IPFS:`, error);

                if (operation.retry(error as Error)) return;

                reject(operation.mainError() || error);
            }
        });
    });
}

type KuboFilesWriteParameters = Parameters<PKC["clients"]["kuboRpcClients"][string]["_client"]["files"]["write"]>;

export async function writeKuboFilesWithTimeout({
    ipfsClient: kuboRpcClient,
    log,
    path,
    content,
    inputNumOfRetries,
    options,
    timeoutMs
}: {
    ipfsClient: Pick<PKC["clients"]["kuboRpcClients"][string]["_client"], "files">;
    log: Logger;
    path: KuboFilesWriteParameters[0];
    content: KuboFilesWriteParameters[1];
    inputNumOfRetries?: number;
    options?: FilesWriteOptions;
    timeoutMs?: number;
}): Promise<void> {
    const numOfRetries = inputNumOfRetries ?? 3;
    // 60s, not the 15s this used to be. Since kubo 0.43.0 a repo GC and in-flight MFS writes hold
    // each other off, so a write can legitimately pause for the length of a GC and then succeed —
    // the changelog calls this out explicitly. A 15s budget turns that ordinary contention into a
    // failed sync.
    const timeoutMilliseconds = timeoutMs ?? 60_000;

    // kubo 0.43.0 honors `timeout` on files.write, so hand the daemon the same budget: it aborts the
    // op server-side and releases the MFS lock, where a bare client-side abort would leave the write
    // running under the lock. pTimeout stays as the backstop for a daemon that never answers at all,
    // with enough slack that the server's own (more informative) error normally wins the race.
    const writeOptions: FilesWriteOptions = { timeout: timeoutMilliseconds, ...options };

    return new Promise((resolve, reject) => {
        const operation = retry.operation({
            retries: numOfRetries,
            factor: 2,
            minTimeout: 2000
        });

        operation.attempt(async (currentAttempt) => {
            try {
                await pTimeout(kuboRpcClient.files.write(path, content, writeOptions), {
                    milliseconds: timeoutMilliseconds + 5_000,
                    message: `Timed out writing to MFS path ${path} after ${timeoutMilliseconds + 5_000}ms`
                });
                resolve();
            } catch (error) {
                log.error(`Failed attempt ${currentAttempt}/${numOfRetries + 1} to write content to MFS path ${path}:`, error);

                if (operation.retry(error as Error)) return;

                reject(operation.mainError() || error);
            }
        });
    });
}

export async function removeBlocksFromKuboNode({
    ipfsClient: kuboRpcClient,
    log,
    cids,
    inputNumOfRetries,
    options
}: {
    ipfsClient: Pick<PKC["clients"]["kuboRpcClients"][string]["_client"], "block">;
    log: Logger;
    cids: string[];
    inputNumOfRetries?: number;
    options?: BlockRmOptions;
}): Promise<string[]> {
    const cidsToRemove = cids.map((cid) => CID.parse(cid));
    const numOfRetries = inputNumOfRetries ?? 3;

    const removedCids: string[] = [];
    return new Promise((resolve, reject) => {
        const operation = retry.operation({
            retries: numOfRetries,
            factor: 2,
            minTimeout: 1000
        });

        operation.attempt(async (currentAttempt) => {
            try {
                for await (const cid of kuboRpcClient.block.rm(cidsToRemove, options)) {
                    removedCids.push(cid.cid.toV0().toString());
                }
                resolve(removedCids);
            } catch (error) {
                log.error(`Failed attempt ${currentAttempt}/${numOfRetries + 1} to remove blocks from kubo node:`, error);

                if (operation.retry(error as Error)) return;

                reject(operation.mainError() || error);
            }
        });
    });
}

export async function removeMfsFilesSafely({
    kuboRpcClient,
    paths,
    log,
    inputNumOfRetries,
    rmOptions
}: {
    kuboRpcClient: PKC["clients"]["kuboRpcClients"][string];
    paths: string[];
    log?: Logger;
    inputNumOfRetries?: number;
    rmOptions?: FilesRmOptions;
}) {
    const logger = log ?? Logger("pkc-js:util:removeMfsFilesSafely");
    const numOfRetries = inputNumOfRetries ?? 3;

    return new Promise<void>((resolve, reject) => {
        const operation = retry.operation({
            retries: numOfRetries,
            factor: 2,
            minTimeout: 1000
        });

        operation.attempt(async (currentAttempt) => {
            try {
                await pTimeout(
                    kuboRpcClient._client.files.rm(paths, {
                        recursive: true,
                        //@ts-expect-error
                        force: true,
                        ...rmOptions
                    }),
                    {
                        milliseconds: 120000,
                        message: new PKCError("ERR_TIMED_OUT_RM_MFS_FILE", {
                            toDeleteMfsPaths: paths,
                            kuboRpcUrl: kuboRpcClient.url
                        })
                    }
                );

                resolve();
            } catch (error) {
                logger.error(`Failed attempt ${currentAttempt}/${numOfRetries + 1} to remove MFS paths ${paths.join(", ")}:`, error);

                if (operation.retry(error as Error)) return;

                reject(operation.mainError() || error);
            }
        });
    });
}

// Wrap an MFS `files.stat` call with retry on transient Kubo RPC connection failures
// (e.g. `fetch failed` / ETIMEDOUT / ECONNREFUSED while the daemon is briefly restarting).
// Without this, a momentary blip during community.start() throws straight out and fails the start.
// A `"file does not exist"` rejection is the legitimate "MFS path absent" signal, so it is rethrown
// immediately without retrying — callers branch on it.
export async function statMfsPathSafely({
    kuboRpcClient,
    path,
    statOptions,
    log,
    inputNumOfRetries
}: {
    kuboRpcClient: PKC["clients"]["kuboRpcClients"][string];
    path: string;
    statOptions?: FilesStatOptions;
    log?: Logger;
    inputNumOfRetries?: number;
}): Promise<FilesStatResult> {
    const logger = log ?? Logger("pkc-js:util:statMfsPathSafely");
    const numOfRetries = inputNumOfRetries ?? 3;

    return new Promise<FilesStatResult>((resolve, reject) => {
        const operation = retry.operation({
            retries: numOfRetries,
            factor: 2,
            minTimeout: 1000
        });

        operation.attempt(async (currentAttempt) => {
            try {
                resolve(await kuboRpcClient._client.files.stat(path, statOptions));
            } catch (error) {
                // "file does not exist" is the expected "MFS path absent" signal — don't retry it.
                if ((error as Error).message?.includes("file does not exist")) {
                    reject(error);
                    return;
                }
                logger.error(`Failed attempt ${currentAttempt}/${numOfRetries + 1} to stat MFS path ${path}:`, error);
                if (operation.retry(error as Error)) return;
                reject(operation.mainError() || error);
            }
        });
    });
}

// IPNS records MUST NOT exceed 10 KiB per the IPNS spec (https://specs.ipfs.tech/ipns/ipns-record);
// the `ipns` package's validator enforces the same limit as its own MAX_RECORD_SIZE. We cap the read
// BEFORE buffering the body so an untrusted gateway cannot exhaust memory by streaming a huge response
// that the validator would only reject after the fact (the validator's check runs on the already-buffered
// bytes). See docs/protocol/delegated-ipns.md.
export const MAX_IPNS_RECORD_SIZE = 10 * 1024;

// Joins streamed body chunks into a single Uint8Array. `total` MUST equal the summed chunk lengths.
function concatBodyChunks(chunks: Uint8Array[], total: number): Uint8Array {
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

// Reads a fetch Response body into a Uint8Array, refusing to buffer more than MAX_IPNS_RECORD_SIZE. Checks
// Content-Length up front, then streams the body — WHATWG `getReader` (browser / undici) or the node-fetch
// async-iterable Node stream — enforcing the hard ceiling per chunk, so a missing or dishonest Content-Length
// still cannot make us buffer an oversized record. Only an exotic body that is neither stream type falls back
// to buffer-then-check. The caller supplies onOverSizeLimit so the error carries its own domain code/context
// (gateway chain vs local kubo node).
async function readRawIpnsRecordBody(
    res: Response,
    onOverSizeLimit: (info: { maxBytes: number; observedBytes: number; viaContentLength: boolean }) => PKCError
): Promise<Uint8Array> {
    const maxBytes = MAX_IPNS_RECORD_SIZE;
    const sizeHeader = res.headers?.get("Content-Length");
    if (sizeHeader && Number(sizeHeader) > maxBytes)
        throw onOverSizeLimit({ maxBytes, observedBytes: Number(sizeHeader), viaContentLength: true });

    // Native fetch / undici (browser and Node >= 18) expose a WHATWG ReadableStream.
    if (res.body?.getReader !== undefined) {
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (value) {
                total += value.length;
                if (total > maxBytes) {
                    await reader.cancel().catch(() => {});
                    throw onOverSizeLimit({ maxBytes, observedBytes: total, viaContentLength: false });
                }
                chunks.push(value);
            }
            if (done) break;
        }
        return concatBodyChunks(chunks, total);
    }

    // node-fetch path (no getReader): its Response body is a Node Readable, which is async-iterable. Stream it
    // the same way so the ceiling holds without buffering the whole body first — the up-front Content-Length
    // check alone can't stop a dishonest/missing header. (`as unknown as` because the WHATWG Response type
    // doesn't model the Node stream's async iterator; this branch only runs when the body really is one.)
    const iterableBody = res.body as unknown as AsyncIterable<Uint8Array> | undefined;
    if (iterableBody?.[Symbol.asyncIterator] !== undefined) {
        const chunks: Uint8Array[] = [];
        let total = 0;
        for await (const chunk of iterableBody) {
            total += chunk.length;
            if (total > maxBytes) throw onOverSizeLimit({ maxBytes, observedBytes: total, viaContentLength: false });
            chunks.push(chunk);
        }
        return concatBodyChunks(chunks, total);
    }

    // Last resort: a body that is neither a WHATWG stream nor async-iterable. Buffer fully, then reject if the
    // Content-Length omitted or under-reported the real size.
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw onOverSizeLimit({ maxBytes, observedBytes: buf.byteLength, viaContentLength: false });
    return buf;
}

export async function getIpnsRecordInLocalKuboNode(kuboRpcClient: KuboRpcClient, ipnsName: string) {
    const gatewayMultiaddr = await kuboRpcClient._client.config.get("Addresses.Gateway"); // need to be fetched from config Addresses.Gateway
    const parts = gatewayMultiaddr.split("/").filter(Boolean);
    const gatewayUrl = `http://${parts[1]}:${parts[3]}`;
    const ipnsFetchUrl = `${gatewayUrl}/ipns/${ipnsName}?format=ipns-record`;
    const res = await fetch(ipnsFetchUrl);
    if (res.status !== 200)
        throw new PKCError("ERR_FAILED_TO_LOAD_LOCAL_RAW_IPNS_RECORD", {
            ipnsFetchUrl,
            ipnsName,
            status: res.status,
            statusText: res.statusText
        });
    const ipnsRecordRaw = await readRawIpnsRecordBody(
        res,
        ({ maxBytes, observedBytes, viaContentLength }) =>
            new PKCError("ERR_FAILED_TO_LOAD_LOCAL_RAW_IPNS_RECORD", {
                ipnsFetchUrl,
                ipnsName,
                reason: "Local IPNS record exceeds the maximum allowed size",
                maxBytes,
                observedBytes,
                viaContentLength
            })
    );
    try {
        const { unmarshalIPNSRecord } = await import("ipns");
        return unmarshalIPNSRecord(ipnsRecordRaw);
    } catch (e) {
        throw new PKCError("ERR_FAILED_TO_PARSE_LOCAL_RAW_IPNS_RECORD", { ipnsName, ipnsFetchUrl, parseError: e });
    }
}

// Fetches a raw IPNS record from an (untrusted) gateway via the ?format=ipns-record path
// param, validates its signature against the IPNS name's routing key, and returns the
// unmarshalled record. Used to verify a delegated IPNS chain (anchor -> ... -> terminal)
// independently of the gateway's own recursion, which cannot be trusted.
// See docs/protocol/delegated-ipns.md.
export async function fetchAndValidateIpnsRecordFromGateway(
    gatewayUrl: string,
    ipnsName: string,
    // recordContext is merged into every error this raises so the caller's domain knowledge (e.g.
    // which hop of a delegated chain this name is — anchor vs minter) survives into error.details.
    opts?: { abortSignal?: AbortSignal; recordContext?: Record<string, unknown> }
): Promise<IPNSRecord> {
    const ipnsFetchUrl = `${gatewayUrl.replace(/\/$/, "")}/ipns/${ipnsName}?format=ipns-record`;
    const recordContext = opts?.recordContext;
    let ipnsRecordRaw: Uint8Array;
    try {
        const res = await fetch(ipnsFetchUrl, {
            headers: { Accept: "application/vnd.ipfs.ipns-record" },
            signal: opts?.abortSignal
        });
        if (res.status !== 200)
            throw new PKCError("ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID", {
                reason: "Gateway did not return the raw IPNS record",
                ...recordContext,
                ipnsFetchUrl,
                ipnsName,
                status: res.status,
                statusText: res.statusText
            });
        ipnsRecordRaw = await readRawIpnsRecordBody(
            res,
            ({ maxBytes, observedBytes, viaContentLength }) =>
                new PKCError("ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID", {
                    reason: "IPNS record served by the gateway exceeds the maximum allowed size",
                    ...recordContext,
                    ipnsFetchUrl,
                    ipnsName,
                    maxBytes,
                    observedBytes,
                    viaContentLength
                })
        );
    } catch (e) {
        // Don't remap aborts: a cancelled fetch is not a chain-validation failure, and remapping it
        // would misclassify parent-driven aborts and break their abort logic.
        if (isAbortError(e)) throw e;
        if (e instanceof PKCError) throw e;
        throw new PKCError("ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID", {
            reason: "Failed to fetch the raw IPNS record from the gateway",
            ...recordContext,
            ipnsFetchUrl,
            ipnsName,
            fetchError: e
        });
    }

    const { multihashToIPNSRoutingKey, unmarshalIPNSRecord } = await import("ipns");
    const { ipnsValidator } = await import("ipns/validator");
    // Validate the record's signature AND validity (EOL) against the routing key derived from the
    // IPNS name. This is what makes following the chain through an untrusted gateway safe.
    try {
        const routingKey = multihashToIPNSRoutingKey(peerIdFromString(ipnsName).toMultihash());
        await ipnsValidator(routingKey, ipnsRecordRaw);
    } catch (e) {
        // ipnsValidator rejects for several distinct reasons; surface an accurate one. An expired
        // record (validity EOL passed) is NOT a forgery — for a delegated anchor record this is the
        // liveness cliff described in docs/protocol/delegated-ipns.md (the offline owner must
        // re-publish before EOL). Everything else means the gateway served a record not signed by the
        // key the IPNS name commits to (forged or tampered).
        const reason =
            (e as Error)?.name === "RecordExpiredError"
                ? "IPNS record has expired: its validity (EOL) is in the past"
                : "IPNS record signature is invalid: the record served by the gateway is not signed by the IPNS name's key (forged or tampered record)";
        throw new PKCError("ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID", {
            reason,
            ...recordContext,
            ipnsFetchUrl,
            ipnsName,
            validationError: e
        });
    }

    try {
        return unmarshalIPNSRecord(ipnsRecordRaw);
    } catch (e) {
        throw new PKCError("ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID", {
            reason: "Failed to parse the IPNS record",
            ...recordContext,
            ipnsFetchUrl,
            ipnsName,
            parseError: e
        });
    }
}

const textEncoder = new TextEncoder();

export async function calculateStringSizeSameAsIpfsAddCidV0(content: string): Promise<number> {
    const { MemoryBlockstore } = await import("blockstore-core");
    const { importFile } = await import("ipfs-unixfs-importer");
    const blockstore = new MemoryBlockstore();
    const entry = await importFile({ path: "content.json", content: textEncoder.encode(content) }, blockstore, {
        cidVersion: 0,
        rawLeaves: false,
        wrapWithDirectory: false
    });
    return Number(entry.size);
}

export type NetworkErrorDetails = {
    name: string;
    message: string;
    code?: string;
    errno?: number;
    syscall?: string;
    address?: string;
    port?: number;
    causes?: NetworkErrorDetails[];
};

// Unwraps `TypeError("fetch failed")` and similar wrappers so the thrown PKCError carries
// the real socket-level detail (ECONNREFUSED, ECONNRESET, UND_ERR_SOCKET, etc.) that Node's
// default inspect hides as "[AggregateError]" or "[cause]". Walks `cause` chains and expands
// AggregateError.errors recursively. Depth-capped to avoid cycles.
export function extractNetworkErrorDetails(err: unknown, depth = 0): NetworkErrorDetails | undefined {
    if (depth > 4 || !err || typeof err !== "object") return undefined;
    const e = err as Error & {
        code?: string;
        errno?: number;
        syscall?: string;
        address?: string;
        port?: number;
        cause?: unknown;
        errors?: unknown[];
    };
    const details: NetworkErrorDetails = {
        name: e.name || "Error",
        message: typeof e.message === "string" ? e.message : String(e)
    };
    if (typeof e.code === "string") details.code = e.code;
    if (typeof e.errno === "number") details.errno = e.errno;
    if (typeof e.syscall === "string") details.syscall = e.syscall;
    if (typeof e.address === "string") details.address = e.address;
    if (typeof e.port === "number") details.port = e.port;

    const nested: NetworkErrorDetails[] = [];
    if (Array.isArray(e.errors)) {
        for (const sub of e.errors) {
            const subDetails = extractNetworkErrorDetails(sub, depth + 1);
            if (subDetails) nested.push(subDetails);
        }
    }
    if (e.cause !== undefined && e.cause !== null) {
        const causeDetails = extractNetworkErrorDetails(e.cause, depth + 1);
        if (causeDetails) nested.push(causeDetails);
    }
    if (nested.length > 0) details.causes = nested;
    return details;
}
