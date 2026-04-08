import { messages } from "./errors.js";
import { PKCError } from "./pkc-error.js";
//@ts-expect-error
import extName from "ext-name";
import { CID } from "kubo-rpc-client";
import * as Digest from "multiformats/hashes/digest";
import { Buffer } from "buffer";
import { base58btc } from "multiformats/bases/base58";
import * as remeda from "remeda";
import { DecryptedChallengeRequestPublicationSchema } from "./pubsub-messages/schema.js";
import pTimeout from "p-timeout";
import { of as calculateIpfsCidV0Lib } from "typestub-ipfs-only-hash";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import { sha256 } from "js-sha256";
import { base32 } from "multiformats/bases/base32";
import Logger from "./logger.js";
import retry from "retry";
import PeerId from "peer-id";
import { unmarshalIPNSRecord } from "ipns";
import { importFile } from "ipfs-unixfs-importer";
import { MemoryBlockstore } from "blockstore-core";
import { findUpdatingCommunity } from "./pkc/tracked-instance-registry-util.js";
export function timestamp() {
    return Math.round(Date.now() / 1000);
}
export function createAbortError(message = "The operation was aborted") {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
}
export function isAbortError(error) {
    return error instanceof Error && error.name === "AbortError";
}
export function throwIfAbortSignalAborted(signal) {
    if (!signal?.aborted)
        return;
    if (signal.reason instanceof Error) {
        signal.reason.name = signal.reason.name || "AbortError";
        throw signal.reason;
    }
    if (typeof signal.reason === "string" && signal.reason.length > 0)
        throw createAbortError(signal.reason);
    throw createAbortError();
}
export function replaceXWithY(obj, x, y) {
    // obj is a JS object
    if (!remeda.isPlainObject(obj))
        return obj;
    const newObj = {};
    Object.entries(obj).forEach(([key, value]) => {
        if (obj[key] === x)
            newObj[key] = y;
        // `typeof`` gives browser transpiling error "Uncaught ReferenceError: exports is not defined"
        // don't know why but it can be fixed by replacing with `instanceof`
        // else if (typeof value === "object" && value !== null) newObj[key] = replaceXWithY(value, x, y);
        else if (remeda.isPlainObject(value))
            newObj[key] = replaceXWithY(value, x, y);
        else if (Array.isArray(value))
            newObj[key] = value.map((iterValue) => replaceXWithY(iterValue, x, y));
        else
            newObj[key] = value;
    });
    return newObj;
}
export function removeNullUndefinedValues(obj) {
    return remeda.pickBy(obj, remeda.isNonNullish);
}
function removeUndefinedValues(obj) {
    return remeda.pickBy(obj, remeda.isDefined.strict);
}
function removeNullUndefinedEmptyObjectValues(obj) {
    const firstStep = removeNullUndefinedValues(obj); // remove undefined and null values
    const secondStep = remeda.omitBy(firstStep, (value) => remeda.isPlainObject(value) && remeda.isEmpty(value)); // remove empty {} values
    return secondStep;
}
// A safe function that you can use that will not modify a JSON by removing null or empty objects
export function removeUndefinedValuesRecursively(obj) {
    if (Array.isArray(obj))
        return obj.map(removeUndefinedValuesRecursively);
    if (!remeda.isPlainObject(obj))
        return obj;
    const cleanedObj = removeUndefinedValues(obj);
    for (const [key, value] of Object.entries(cleanedObj))
        if (remeda.isPlainObject(value) || Array.isArray(value))
            cleanedObj[key] = removeUndefinedValuesRecursively(value);
    return cleanedObj;
}
export function removeNullUndefinedEmptyObjectsValuesRecursively(obj) {
    if (Array.isArray(obj))
        return obj.map(removeNullUndefinedEmptyObjectsValuesRecursively);
    if (!remeda.isPlainObject(obj))
        return obj;
    const cleanedObj = removeNullUndefinedEmptyObjectValues(obj);
    for (const key of Object.keys(cleanedObj)) {
        if (remeda.isPlainObject(cleanedObj[key]) || Array.isArray(cleanedObj[key]))
            cleanedObj[key] = removeNullUndefinedEmptyObjectsValuesRecursively(cleanedObj[key]);
        if (remeda.isPlainObject(cleanedObj[key]) && remeda.isEmpty(cleanedObj[key]))
            delete cleanedObj[key];
    }
    return cleanedObj;
}
const parseIfJsonString = (jsonString) => {
    if (typeof jsonString !== "string" || (!jsonString.startsWith("{") && !jsonString.startsWith("[")))
        return undefined;
    try {
        return JSON.parse(jsonString);
    }
    catch {
        return undefined;
    }
};
// Only for DB
export const parseDbResponses = (obj) => {
    // This function is gonna be called for every query on db, it should be optimized
    if (obj === "[object Object]")
        throw Error(`Object shouldn't be [object Object]`);
    if (Array.isArray(obj))
        return obj.map((o) => parseDbResponses(o));
    const parsedJsonString = parseIfJsonString(obj);
    if (!remeda.isPlainObject(obj) && !parsedJsonString)
        return obj;
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
        if (value === "[object Object]")
            throw Error(`key (${key}) shouldn't be [object Object]`);
        if (booleanFields.includes(key) && (value === 1 || value === 0))
            newObj[key] = Boolean(value);
        else
            newObj[key] = parseIfJsonString(value) || value;
    }
    if (newObj.extraProps)
        return { ...newObj, ...newObj.extraProps };
    else if (newObj["commentIpfs_extraProps"]) {
        // needed when creating pages
        const mappedExtraPropsOnCommentIpfs = remeda.mapKeys(newObj["commentIpfs_extraProps"], (key) => `commentIpfs_${String(key)}`);
        return { ...newObj, ...mappedExtraPropsOnCommentIpfs };
    }
    return newObj;
};
export function shortifyAddress(address) {
    if (address.includes("."))
        return address; // If a domain then no need to shortify
    // Remove prefix (12D3KooW)
    const removedPrefix = address.slice(8);
    // Return first 12 characters
    const shortAddress = removedPrefix.slice(0, 12);
    return shortAddress;
}
export function shortifyCid(cid) {
    // Remove prefix (Qm)
    // Return first 12 characters
    return cid.slice(2).slice(0, 12);
}
export function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export function firstResolve(promises) {
    return new Promise((resolve) => promises.forEach((promise) => promise.then(resolve)));
}
export function getErrorCodeFromMessage(message) {
    const codes = remeda.keys.strict(messages);
    for (const code of codes)
        if (messages[code] === message)
            return code;
    throw Error(`No error code was found for message (${message})`);
}
export function doesDomainAddressHaveCapitalLetter(domainAddress) {
    if (!domainAddress.includes("."))
        return false;
    return /[A-Z]/.test(domainAddress); // Regex test for capital letters in English only
}
export function getPostUpdateTimestampRange(postUpdates, postTimestamp) {
    if (!postUpdates)
        throw Error("community has no post updates");
    if (!postTimestamp)
        throw Error("post has no timestamp");
    return (remeda.keys
        .strict(postUpdates)
        // sort from smallest to biggest
        .sort((a, b) => Number(a) - Number(b))
        // find the smallest timestamp range where comment.timestamp is newer
        .filter((timestampRange) => timestamp() - Number(timestampRange) <= postTimestamp));
}
export function isLinkValid(link) {
    try {
        const url = new URL(link);
        if (url.protocol !== "https:")
            throw Error("Not a valid https url");
        return true;
    }
    catch (e) {
        return false;
    }
}
export function isLinkOfMedia(link) {
    if (!link)
        return false;
    let mime;
    try {
        mime = extName(new URL(link).pathname.toLowerCase().replace("/", ""))[0]?.mime;
    }
    catch (e) {
        return false;
    }
    if (mime?.startsWith("image") || mime?.startsWith("video") || mime?.startsWith("audio"))
        return true;
    return false;
}
function getMimeFromUrl(url) {
    try {
        return extName(new URL(url).pathname.toLowerCase().replace("/", ""))[0]?.mime;
    }
    catch {
        return undefined;
    }
}
function isUrlOfImage(url) {
    const mime = getMimeFromUrl(url);
    return mime?.startsWith("image") ?? false;
}
function isUrlOfVideo(url) {
    const mime = getMimeFromUrl(url);
    return mime?.startsWith("video") ?? false;
}
export function isLinkOfImage(link) {
    if (!link)
        return false;
    return isUrlOfImage(link);
}
export function isLinkOfVideo(link) {
    if (!link)
        return false;
    return isUrlOfVideo(link);
}
// Known animated image MIME types
const ANIMATED_IMAGE_MIMES = new Set(["image/gif", "image/apng"]);
function isUrlOfAnimatedImage(url) {
    const mime = getMimeFromUrl(url);
    return mime !== undefined && ANIMATED_IMAGE_MIMES.has(mime);
}
export function isLinkOfAnimatedImage(link) {
    if (!link)
        return false;
    return isUrlOfAnimatedImage(link);
}
function isUrlOfAudio(url) {
    const mime = getMimeFromUrl(url);
    return mime?.startsWith("audio") ?? false;
}
export function isLinkOfAudio(link) {
    if (!link)
        return false;
    return isUrlOfAudio(link);
}
export function contentContainsMarkdownImages(content) {
    if (!content)
        return false;
    // Check for HTML img tags
    const htmlImgTagRegex = /<img\s+[^>]*src\s*=\s*["']([^"']+)["'][^>]*\/?>/gi;
    if (htmlImgTagRegex.test(content))
        return true;
    // Check for markdown image syntax: ![alt](url)
    // Negative lookbehind (?<!\\) ensures it's not escaped
    const markdownImageRegex = /(?<!\\)!\[[^\]]*\]\(([^)]+)\)/g;
    const matches = content.matchAll(markdownImageRegex);
    for (const match of matches) {
        const url = match[1];
        // If URL has image extension OR no extension (could be an image), flag it
        if (isUrlOfImage(url))
            return true;
        // Also flag URLs without extensions (e.g., imgur direct links)
        const mime = getMimeFromUrl(url);
        if (mime === undefined) {
            // URL has no recognizable extension, still flag markdown images
            return true;
        }
    }
    return false;
}
export function contentContainsMarkdownAudio(content) {
    if (!content)
        return false;
    // Check for HTML audio tags
    const htmlAudioTagRegex = /<audio[\s>]/gi;
    if (htmlAudioTagRegex.test(content))
        return true;
    // Check for markdown image syntax with audio URLs: ![alt](url)
    const markdownImageRegex = /(?<!\\)!\[[^\]]*\]\(([^)]+)\)/g;
    const matches = content.matchAll(markdownImageRegex);
    for (const match of matches) {
        const url = match[1];
        if (isUrlOfAudio(url))
            return true;
    }
    return false;
}
export function contentContainsMarkdownVideos(content) {
    if (!content)
        return false;
    // Check for HTML video tags
    const htmlVideoTagRegex = /<video[\s>]/gi;
    if (htmlVideoTagRegex.test(content))
        return true;
    // Check for HTML iframe tags (YouTube/Vimeo embeds)
    const htmlIframeTagRegex = /<iframe[\s>]/gi;
    if (htmlIframeTagRegex.test(content))
        return true;
    // Check for markdown image syntax with video URLs: ![alt](url)
    const markdownImageRegex = /(?<!\\)!\[[^\]]*\]\(([^)]+)\)/g;
    const matches = content.matchAll(markdownImageRegex);
    for (const match of matches) {
        const url = match[1];
        if (isUrlOfVideo(url) || isUrlOfAnimatedImage(url))
            return true;
    }
    return false;
}
export async function genToArray(gen) {
    const out = [];
    for await (const x of gen) {
        out.push(x);
    }
    return out;
}
export function isStringDomain(x) {
    return typeof x === "string" && x.includes(".");
}
export function isEthAliasDomain(address) {
    const lower = address.toLowerCase();
    return lower.endsWith(".eth") || lower.endsWith(".bso");
}
export function normalizeEthAliasDomain(address) {
    return address.endsWith(".bso") ? address.slice(0, -4) + ".eth" : address;
}
export function areEquivalentCommunityAddresses(addressA, addressB) {
    if (addressA === addressB)
        return true;
    const lowerA = addressA.toLowerCase();
    const lowerB = addressB.toLowerCase();
    if (!isEthAliasDomain(lowerA) || !isEthAliasDomain(lowerB))
        return false;
    return normalizeEthAliasDomain(lowerA) === normalizeEthAliasDomain(lowerB);
}
export function getEquivalentCommunityAddresses(address) {
    const lower = address.toLowerCase();
    if (lower.endsWith(".bso"))
        return [address, address.slice(0, -4) + ".eth"];
    if (lower.endsWith(".eth"))
        return [address, address.slice(0, -4) + ".bso"];
    return [address];
}
export function isIpns(x) {
    // This function will test if a string is of IPNS address (12D)
    try {
        Digest.decode(base58btc.decode(`z${x}`));
        return true;
    }
    catch {
        return false;
    }
}
export function isIpfsCid(x) {
    try {
        return Boolean(CID.parse(x));
    }
    catch {
        return false;
    }
}
export function isIpfsPath(x) {
    return x.startsWith("/ipfs/");
}
function isMultiaddrLike(value) {
    if (typeof value !== "object" || value === null)
        return false;
    if (!("bytes" in value))
        return false;
    const candidate = value;
    return candidate.bytes instanceof Uint8Array;
}
export function parseIpfsRawOptionToIpfsOptions(kuboRpcRawOption) {
    if (!kuboRpcRawOption)
        throw Error("Need to define the ipfs options");
    if (typeof kuboRpcRawOption === "string" || kuboRpcRawOption instanceof URL) {
        const url = new URL(kuboRpcRawOption);
        const authorization = url.username && url.password ? "Basic " + Buffer.from(`${url.username}:${url.password}`).toString("base64") : undefined;
        return {
            url: authorization ? url.origin + url.pathname : kuboRpcRawOption.toString(),
            ...(authorization ? { headers: { authorization, origin: "http://localhost" } } : undefined)
        };
    }
    else if (isMultiaddrLike(kuboRpcRawOption))
        return { url: kuboRpcRawOption };
    else
        return kuboRpcRawOption;
}
// Deep merge runtimeFields from RPC server into parsed data.
// Handles nested objects (recursive), arrays (element-by-element), and primitives (overwrite).
// For getter-only properties (e.g. updatingState), sets the backing _field directly.
export function deepMergeRuntimeFields(target, source) {
    if (!source || typeof source !== "object")
        return;
    if (!target || typeof target !== "object")
        return;
    for (const key of Object.keys(source)) {
        if (Array.isArray(source[key]) && Array.isArray(target?.[key])) {
            for (let i = 0; i < source[key].length; i++) {
                if (i < target[key].length)
                    deepMergeRuntimeFields(target[key][i], source[key][i]);
            }
        }
        else if (source[key] && typeof source[key] === "object" && target?.[key] && typeof target[key] === "object") {
            deepMergeRuntimeFields(target[key], source[key]);
        }
        else if (source[key] !== undefined) {
            // Don't create new complex (object/array) properties on the target from runtimeFields.
            // RuntimeFields should only merge into existing structures, not create new pages/comments/etc.
            if ((typeof source[key] === "object" || Array.isArray(source[key])) && !(key in target)) {
                continue;
            }
            // Check if the property is getter-only (no setter)
            let descriptor;
            let proto = target;
            while (proto && !descriptor) {
                descriptor = Object.getOwnPropertyDescriptor(proto, key);
                proto = Object.getPrototypeOf(proto);
            }
            if (descriptor?.get && !descriptor.set) {
                // Set the backing _field directly (e.g. _updatingState for updatingState)
                target[`_${key}`] = source[key];
            }
            else {
                target[key] = source[key];
            }
        }
    }
}
export function hideClassPrivateProps(_this) {
    // make props that start with _ not enumerable
    for (const propertyName in _this) {
        if (propertyName.startsWith("_"))
            Object.defineProperty(_this, propertyName, { enumerable: false });
    }
}
export function derivePublicationFromChallengeRequest(request) {
    const publicationFieldNames = remeda.keys.strict(DecryptedChallengeRequestPublicationSchema.shape);
    for (const pubName of publicationFieldNames) {
        const publication = request[pubName];
        if (publication)
            return publication;
    }
    throw Error("Failed to find publication on ChallengeRequest");
}
export function isRequestPubsubPublicationOfReply(request) {
    return Boolean(request.comment && request.comment.parentCid);
}
export function isRequestPubsubPublicationOfPost(request) {
    return Boolean(request.comment && !request.comment.parentCid);
}
export async function resolveWhenPredicateIsTrue(options) {
    const { toUpdate, predicate, eventName = "update" } = options;
    await new Promise((resolve, reject) => {
        const listener = async () => {
            try {
                const conditionStatus = await predicate();
                if (conditionStatus) {
                    toUpdate.removeListener(eventName, listener);
                    resolve();
                }
            }
            catch (error) {
                toUpdate.removeListener(eventName, listener);
                reject(error);
            }
        };
        toUpdate.on(eventName, listener);
        listener(); // initial check — no await, errors flow through reject()
    });
}
export async function waitForUpdateInCommunityInstanceWithErrorAndTimeout(community, timeoutMs) {
    const wasUpdating = community.state === "updating";
    const updatingStates = [];
    const updatingStateChangeListener = (state) => updatingStates.push(state);
    community.on("updatingstatechange", updatingStateChangeListener);
    // Wait specifically for communityIpfs to be defined — intermediate "update" events
    // (e.g. resetInstance, toJSONInternalRpcBeforeFirstUpdate) may fire without it
    let updateListener;
    const updatePromise = new Promise((resolve) => {
        updateListener = () => {
            if (community.raw.communityIpfs) {
                community.removeListener("update", updateListener);
                resolve();
            }
        };
        community.on("update", updateListener);
    });
    let updateError;
    const errorListener = (err) => (updateError = err);
    community.on("error", errorListener);
    try {
        if (community.state !== "started")
            await community.update();
        await pTimeout(Promise.race([updatePromise, new Promise((resolve) => community.once("error", resolve))]), {
            milliseconds: timeoutMs,
            message: updateError ||
                new PKCError("ERR_GET_COMMUNITY_TIMED_OUT", {
                    communityAddress: community.address,
                    timeoutMs,
                    error: updateError,
                    updatingStates,
                    community
                })
        });
        if (updateError)
            throw updateError;
    }
    catch (e) {
        if (updateError)
            throw updateError;
        const updatingCommunity = findUpdatingCommunity(community._pkc, { address: community.address });
        if (updatingCommunity?._clientsManager._ipnsLoadingOperation?.mainError())
            throw updatingCommunity._clientsManager._ipnsLoadingOperation.mainError();
        throw e;
    }
    finally {
        if (updateListener)
            community.removeListener("update", updateListener);
        community.removeListener("error", errorListener);
        community.removeListener("updatingstatechange", updatingStateChangeListener);
        if (!wasUpdating && community.state !== "started")
            await community.stop();
    }
}
export function calculateIpfsCidV0(content) {
    return calculateIpfsCidV0Lib(content);
}
/**
 * converts a binary record key to a pubsub topic key
 */
export function binaryKeyToPubsubTopic(key) {
    const b64url = uint8ArrayToString(key, "base64url");
    return `/record/${b64url}`;
}
export function ipnsNameToIpnsOverPubsubTopic(ipnsName) {
    // for ipns over pubsub, the topic is '/record/' + Base64Url(Uint8Array('/ipns/') + Uint8Array('12D...'))
    // https://github.com/ipfs/helia/blob/1561e4a106074b94e421a77b0b8776b065e48bc5/packages/ipns/src/routing/pubsub.ts#L169
    const ipnsNamespaceBytes = new TextEncoder().encode("/ipns/");
    const ipnsNameBytes = PeerId.parse(ipnsName).toBytes(); // accepts base58 (12D...) and base36 (k51...)
    const ipnsNameBytesWithNamespace = new Uint8Array(ipnsNamespaceBytes.length + ipnsNameBytes.length);
    ipnsNameBytesWithNamespace.set(ipnsNamespaceBytes, 0);
    ipnsNameBytesWithNamespace.set(ipnsNameBytes, ipnsNamespaceBytes.length);
    const pubsubTopic = "/record/" + uint8ArrayToString(ipnsNameBytesWithNamespace, "base64url");
    return pubsubTopic;
}
export const pubsubTopicToDhtKey = (pubsubTopic) => {
    return pubsubTopicToDhtKeyCid(pubsubTopic).toString(base32);
};
export const pubsubTopicToDhtKeyCid = (pubsubTopic) => {
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
export async function retryKuboBlockPutPinAndProvidePubsubTopic({ ipfsClient: kuboRpcClient, log, pubsubTopic, inputNumOfRetries, blockPutOptions, pinAddOptions, provideOptions }) {
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
                const cid = (await kuboRpcClient.block.put(bytes, {
                    ...blockPutOptions,
                    format: "raw",
                    mhtype: "sha2-256",
                    version: 1
                }));
                if (!cid.equals(expectedCid)) {
                    throw new Error(`block.put CID mismatch for pubsub topic ${pubsubTopic}: expected ${String(expectedCid)} got ${String(cid)}`);
                }
                await kuboRpcClient.pin.add(cid, pinAddOptions);
                try {
                    const provideEvents = kuboRpcClient.routing.provide(cid, provideOptions);
                    for await (const event of provideEvents) {
                        log.trace(`Provide event for ${String(cid)}:`, event);
                    }
                }
                catch (e) {
                    log.trace("Minor Error, not a big deal: Failed to provide after block.put", e);
                }
                resolve(cid);
            }
            catch (error) {
                log.error(`Failed attempt ${currentAttempt}/${numOfRetries + 1} to store and provide pubsub topic block:`, error);
                if (operation.retry(error))
                    return;
                reject(operation.mainError() || error);
            }
        });
    });
}
export async function retryKuboIpfsAddAndProvide({ ipfsClient: kuboRpcClient, log, content, inputNumOfRetries, addOptions, provideOptions, provideInBackground }) {
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
                    }
                    catch (e) {
                        log.trace("Minor Error, not a big deal: Failed to provide after add", e);
                    }
                };
                if (provideInBackground) {
                    void runProvide();
                }
                else {
                    await runProvide();
                }
                resolve(addRes);
            }
            catch (error) {
                log.error(`Failed attempt ${currentAttempt}/${numOfRetries + 1} to add and provide content to IPFS:`, error);
                if (operation.retry(error))
                    return;
                reject(operation.mainError() || error);
            }
        });
    });
}
export async function retryKuboIpfsAdd({ ipfsClient: kuboRpcClient, log, content, inputNumOfRetries, options }) {
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
            }
            catch (error) {
                log.error(`Failed attempt ${currentAttempt}/${numOfRetries + 1} to add content to IPFS:`, error);
                if (operation.retry(error))
                    return;
                reject(operation.mainError() || error);
            }
        });
    });
}
export async function writeKuboFilesWithTimeout({ ipfsClient: kuboRpcClient, log, path, content, inputNumOfRetries, options, timeoutMs }) {
    const numOfRetries = inputNumOfRetries ?? 3;
    const timeoutMilliseconds = timeoutMs ?? 15_000;
    return new Promise((resolve, reject) => {
        const operation = retry.operation({
            retries: numOfRetries,
            factor: 2,
            minTimeout: 2000
        });
        operation.attempt(async (currentAttempt) => {
            try {
                await pTimeout(kuboRpcClient.files.write(path, content, options), {
                    milliseconds: timeoutMilliseconds,
                    message: `Timed out writing to MFS path ${path} after ${timeoutMilliseconds}ms`
                });
                resolve();
            }
            catch (error) {
                log.error(`Failed attempt ${currentAttempt}/${numOfRetries + 1} to write content to MFS path ${path}:`, error);
                if (operation.retry(error))
                    return;
                reject(operation.mainError() || error);
            }
        });
    });
}
export async function removeBlocksFromKuboNode({ ipfsClient: kuboRpcClient, log, cids, inputNumOfRetries, options }) {
    const cidsToRemove = cids.map((cid) => CID.parse(cid));
    const numOfRetries = inputNumOfRetries ?? 3;
    const removedCids = [];
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
            }
            catch (error) {
                log.error(`Failed attempt ${currentAttempt}/${numOfRetries + 1} to remove blocks from kubo node:`, error);
                if (operation.retry(error))
                    return;
                reject(operation.mainError() || error);
            }
        });
    });
}
export async function removeMfsFilesSafely({ kuboRpcClient, paths, log, inputNumOfRetries, rmOptions }) {
    const logger = log ?? Logger("pkc-js:util:removeMfsFilesSafely");
    const numOfRetries = inputNumOfRetries ?? 3;
    return new Promise((resolve, reject) => {
        const operation = retry.operation({
            retries: numOfRetries,
            factor: 2,
            minTimeout: 1000
        });
        operation.attempt(async (currentAttempt) => {
            try {
                await pTimeout(kuboRpcClient._client.files.rm(paths, {
                    recursive: true,
                    //@ts-expect-error
                    force: true,
                    ...rmOptions
                }), {
                    milliseconds: 120000,
                    message: new PKCError("ERR_TIMED_OUT_RM_MFS_FILE", {
                        toDeleteMfsPaths: paths,
                        kuboRpcUrl: kuboRpcClient.url
                    })
                });
                resolve();
            }
            catch (error) {
                logger.error(`Failed attempt ${currentAttempt}/${numOfRetries + 1} to remove MFS paths ${paths.join(", ")}:`, error);
                if (operation.retry(error))
                    return;
                reject(operation.mainError() || error);
            }
        });
    });
}
export async function getIpnsRecordInLocalKuboNode(kuboRpcClient, ipnsName) {
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
    const ipnsRecordRaw = new Uint8Array(await res.arrayBuffer());
    try {
        return unmarshalIPNSRecord(ipnsRecordRaw);
    }
    catch (e) {
        throw new PKCError("ERR_FAILED_TO_PARSE_LOCAL_RAW_IPNS_RECORD", { ipnsName, ipnsFetchUrl, parseError: e });
    }
}
const textEncoder = new TextEncoder();
export async function calculateStringSizeSameAsIpfsAddCidV0(content) {
    const blockstore = new MemoryBlockstore();
    const entry = await importFile({ path: "content.json", content: textEncoder.encode(content) }, blockstore, {
        cidVersion: 0,
        rawLeaves: false,
        wrapWithDirectory: false
    });
    return Number(entry.size);
}
//# sourceMappingURL=util.js.map