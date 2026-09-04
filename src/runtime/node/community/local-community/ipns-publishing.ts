import Logger from "../../../../logger.js";
import { difference, isEmpty, keys, omit, pick, unique } from "remeda";
import * as cborg from "cborg";
import { sha256 } from "js-sha256";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import {
    getIpnsRecordInLocalKuboNode,
    removeBlocksFromKuboNode,
    retryKuboIpfsAddAndProvide,
    statMfsPathSafely,
    timestamp
} from "../../../../util.js";
import env from "../../../../version.js";
import { PKCError } from "../../../../pkc-error.js";
import { STORAGE_KEYS } from "../../../../constants.js";
import { calculateExpectedSignatureSize } from "../../util.js";
import { iterateOverPageCidsToFindAllCids } from "../../../../pages/util.js";
import { cleanUpBeforePublishing, signCommunity } from "../../../../signer/signatures.js";
import { CommunityIpfsSchema } from "../../../../community/schema.js";
import { MAX_FILE_SIZE_BYTES_FOR_COMMUNITY_IPFS } from "../../../../community/community-client-manager.js";
import type { CommunityIpfsType } from "../../../../community/types.js";
import type { CommentUpdateType } from "../../../../publications/comment/types.js";
import type { LocalCommunity } from "../local-community.js";
import type { CommentUpdateToWriteToDbAndPublishToIpfs } from "./defaults.js";
import {
    adjustPostUpdatesBucketsIfNeeded,
    challengeExchangePubsubTopic,
    syncPostUpdatesWithIpfs,
    updateCommentsThatNeedToBeUpdated
} from "./comment-updates.js";
import { cleanUpIpfsRepoIfDue, purgeDisapprovedCommentsOlderThan, unpinStaleCids } from "./cleanup.js";
import { providePubsubTopicRoutingCidsIfNeeded } from "./pubsub.js";

export async function calculateNewPostUpdates(community: LocalCommunity): Promise<CommunityIpfsType["postUpdates"]> {
    const postUpdates: CommunityIpfsType["postUpdates"] = {};
    const kuboRpcClient = community._clientsManager.getDefaultKuboRpcClient();
    for (const timeBucket of community._postUpdatesBuckets) {
        try {
            // Retries on transient Kubo connection errors so a daemon blip doesn't silently drop a bucket.
            const statRes = await statMfsPathSafely({ kuboRpcClient, path: `/${community.address}/postUpdates/${timeBucket}` });
            if (statRes.blocks !== 0) postUpdates[String(timeBucket)] = String(statRes.cid);
        } catch {}
    }
    if (isEmpty(postUpdates)) return undefined;
    return postUpdates;
}

export function calculateLatestUpdateTrigger(community: LocalCommunity) {
    const lastPublishTooOld = (community.updatedAt || 0) < timestamp() - 60 * 15; // Publish a community record every 15 minutes at least

    // these two checks below are for rare cases where a purged comments or post is not forcing community for a new update
    const lastPostCidChanged = community.lastPostCid !== community._dbHandler.queryLatestPostCid()?.cid;
    const lastCommentCidChanged = community.lastCommentCid !== community._dbHandler.queryLatestCommentCid()?.cid;

    community._communityUpdateTrigger =
        community._communityUpdateTrigger ||
        lastPublishTooOld ||
        community._pendingEditProps.length > 0 ||
        community._blocksToRm.length > 0 ||
        lastCommentCidChanged ||
        lastPostCidChanged; // we have at least one edit to include in new ipns
}

export function requireCommunityUpdateIfModQueueChanged(community: LocalCommunity) {
    const combinedHashOfAllQueuedComments = community._dbHandler.queryCombinedHashOfPendingComments();

    if (community._combinedHashOfPendingCommentsCids !== combinedHashOfAllQueuedComments) community._communityUpdateTrigger = true;
}

export async function resolveIpnsAndLogIfPotentialProblematicSequence(community: LocalCommunity) {
    const log = Logger("pkc-js:local-community:_resolveIpnsAndLogIfPotentialProblematicSequence");
    if (!community.signer.ipnsKeyName) throw Error("IPNS key name is not defined");
    if (!community.updateCid) return;
    try {
        const { cid: ipnsCid } = await community._clientsManager.resolveIpnsToCidP2P(community.signer.ipnsKeyName, { timeoutMs: 120000 });
        log.trace("Resolved community", community.address, "IPNS key", community.signer.ipnsKeyName, "to", ipnsCid);

        if (ipnsCid && community.updateCid && ipnsCid !== community.updateCid) {
            log.error(
                "community",
                community.address,
                "IPNS key",
                community.signer.ipnsKeyName,
                "points to",
                ipnsCid,
                "but we expected it to point to",
                community.updateCid,
                "This could result an IPNS record with invalid sequence number"
            );
        }
    } catch (e) {
        log.trace("Failed to resolve community before publishing", community.address, "IPNS key", community.signer.ipnsKeyName, e);
    }
}

export async function addOldPageCidsToCidsToUnpin(
    community: LocalCommunity,
    curPages: CommentUpdateType["replies"] | CommunityIpfsType["posts"] | CommunityIpfsType["modQueue"],
    newPages: CommentUpdateType["replies"] | CommunityIpfsType["posts"] | CommunityIpfsType["modQueue"],
    addToBlockRm?: boolean
) {
    if (!curPages && !newPages) return;
    else if (curPages && !newPages) {
        // we had to reset our community pages, maybe because we purged all comments or changed community address
        const allPageCidsUnderCurPages = await iterateOverPageCidsToFindAllCids({
            pages: curPages,
            clientManager: community._clientsManager
        });
        allPageCidsUnderCurPages.forEach((cid) => {
            community._cidsToUnPin.add(cid);
            if (addToBlockRm) community._blocksToRm.push(cid);
        });
    } else if (curPages && newPages) {
        // need to find cids for both, and compare them and only keep ones in newPages
        const allPageCidsUnderCurPages = await iterateOverPageCidsToFindAllCids({
            pages: curPages,
            clientManager: community._clientsManager
        });
        const allPageCidsUnderNewPages = await iterateOverPageCidsToFindAllCids({
            pages: newPages,
            clientManager: community._clientsManager
        });
        // unique() first: remeda v2's difference is multiset, so a cid appearing twice under the
        // current pages but once under the new pages would otherwise be unpinned despite still being
        // referenced. Set semantics (v1) is what we want here — only unpin cids absent from newPages.
        const cidsToUnpin = difference(unique(allPageCidsUnderCurPages), allPageCidsUnderNewPages);
        cidsToUnpin.forEach((cid) => {
            community._cidsToUnPin.add(cid);
            if (addToBlockRm) community._blocksToRm.push(cid);
        });
    }
}

export function shouldResolveDomainForVerification(community: LocalCommunity) {
    return community.address.includes(".") && Math.random() < 0.005; // Resolving domain should be a rare process because default rpcs throttle if we resolve too much
}

// Internal state passed between the orchestrator's sub-phases.
type CommunityRecordBuild = {
    log: Logger;
    latestPost: ReturnType<LocalCommunity["_dbHandler"]["queryLatestPostCid"]>;
    latestComment: ReturnType<LocalCommunity["_dbHandler"]["queryLatestCommentCid"]>;
    newIpns: Omit<CommunityIpfsType, "signature">;
    newPostsAllPageCids: Record<string, string[]> | undefined;
    newModQueue: Awaited<ReturnType<LocalCommunity["_pageGenerator"]["generateModQueuePages"]>>;
    editIdsToIncludeInNextUpdate: (string | undefined)[];
};

// Phase 1: gather DB stats, sync post updates to MFS, compute the new (unsigned) community record + posts/modQueue.
async function calculateNextCommunityRecord(
    community: LocalCommunity,
    commentUpdateRowsToPublishToIpfs: CommentUpdateToWriteToDbAndPublishToIpfs[],
    log: Logger
): Promise<CommunityRecordBuild> {
    community._dbHandler.createTransaction();
    const latestPost = community._dbHandler.queryLatestPostCid();
    const latestComment = community._dbHandler.queryLatestCommentCid();
    community._dbHandler.commitTransaction();

    const stats = community._dbHandler.queryCommunityStats();

    // No MFS-timeout recovery branch here on purpose. Until kubo 0.43.0 an MFS timeout meant the
    // daemon was permanently wedged (ipfs/kubo#10842), so we nuked /<address> and forced a full
    // republish. 0.43.0 both removes the wedge and makes a timeout an ordinary, recoverable event:
    // GC and in-flight MFS writes now hold each other off, so "a single write can pause for the
    // length of a GC and, with a short client timeout, look like it timed out and then succeed on
    // retry". Nuking a community's whole postUpdates tree over that would turn a few seconds of
    // contention into a full republish. Let the error propagate and let the retries do their job.
    if (commentUpdateRowsToPublishToIpfs.length > 0) await syncPostUpdatesWithIpfs(community, commentUpdateRowsToPublishToIpfs);

    const newPostUpdates = await community._calculateNewPostUpdates();
    const newModQueue = await community._pageGenerator.generateModQueuePages();

    const kuboRpcClient = community._clientsManager.getDefaultKuboRpcClient();

    const statsCid = (
        await retryKuboIpfsAddAndProvide({
            ipfsClient: kuboRpcClient._client,
            log,
            content: deterministicStringify(stats),
            addOptions: { pin: true },
            provideOptions: { recursive: true },
            provideInBackground: true
        })
    ).path;
    if (community.statsCid && statsCid !== community.statsCid) community._cidsToUnPin.add(community.statsCid);

    const currentTimestamp = timestamp();
    const updatedAt =
        typeof community?.updatedAt === "number" && community.updatedAt >= currentTimestamp ? community.updatedAt + 1 : currentTimestamp;
    const editIdsToIncludeInNextUpdate = community._pendingEditProps.map((editProps) => editProps.editId);
    const pendingCommunityIpfsEditProps = Object.assign(
        {}, //@ts-expect-error
        ...community._pendingEditProps.map((editProps) => pick(editProps, keys(CommunityIpfsSchema.shape)))
    );
    if (community._pendingEditProps.length > 0) log("Including edit props in next IPNS update", community._pendingEditProps);
    const newIpns: Omit<CommunityIpfsType, "signature"> = {
        ...cleanUpBeforePublishing({
            ...omit(community._toJSONIpfsBaseNoPosts(), ["signature"]),
            ...pendingCommunityIpfsEditProps,
            // Resolved last so it wins over a pending pubsubTopic edit. undefined when the exchange is
            // disabled, and cleanUpBeforePublishing purges it from the record (issue #229). The instance
            // keeps community.pubsubTopic so a custom topic survives a disable/enable cycle.
            pubsubTopic: challengeExchangePubsubTopic(community),
            lastPostCid: latestPost?.cid,
            lastCommentCid: latestComment?.cid,
            statsCid,
            updatedAt,
            postUpdates: newPostUpdates,
            protocolVersion: env.PROTOCOL_VERSION
        })
    };

    const preloadedPostsPages = "hot";
    // Calculate size taken by community without posts and signature
    const communityWithoutPostsSignatureSize = Buffer.byteLength(JSON.stringify(newIpns), "utf8");

    // Calculate expected signature size
    const expectedSignatureSize = calculateExpectedSignatureSize(newIpns);

    // Calculate remaining space for posts
    const availablePostsSize = MAX_FILE_SIZE_BYTES_FOR_COMMUNITY_IPFS - communityWithoutPostsSignatureSize - expectedSignatureSize - 1000;

    const generatedPosts = await community._pageGenerator.generateCommunityPosts(preloadedPostsPages, availablePostsSize);

    // posts should not be cleaned up because we want to make sure not to modify authors' posts

    // Extract allPageCids from generation result for DB CID-ref storage and unpinning
    const newPostsAllPageCids = generatedPosts && !("singlePreloadedPage" in generatedPosts) ? generatedPosts.allPageCids : undefined;

    if (generatedPosts) {
        if ("singlePreloadedPage" in generatedPosts) newIpns.posts = { pages: generatedPosts.singlePreloadedPage };
        else if (generatedPosts.pageCids) {
            // multiple pages
            newIpns.posts = {
                pageCids: generatedPosts.pageCids,
                pages: pick(generatedPosts.pages, [preloadedPostsPages])
            };
        }
    } else {
        await community._updateDbInternalState({ posts: undefined }); // make sure db resets posts as well
    }

    // Unpin old posts page CIDs using direct allPageCids comparison (no IPFS fetches needed)
    {
        const oldCids = new Set(community._postsAllPageCids ? Object.values(community._postsAllPageCids).flat() : []);
        const newCids = new Set(newPostsAllPageCids ? Object.values(newPostsAllPageCids).flat() : []);
        for (const cid of oldCids) {
            if (!newCids.has(cid)) community._cidsToUnPin.add(cid);
        }
    }
    community._postsAllPageCids = newPostsAllPageCids;

    if (newModQueue) {
        newIpns.modQueue = { pageCids: newModQueue.pageCids };
    } else {
        await community._updateDbInternalState({ modQueue: undefined });
        community.modQueue.resetPages();
    }

    return { log, latestPost, latestComment, newIpns, newPostsAllPageCids, newModQueue, editIdsToIncludeInNextUpdate };
}

// Phase 2: sign and run schema/signature validation, returning the final record.
async function validateAndSignCommunityRecord(community: LocalCommunity, build: CommunityRecordBuild): Promise<CommunityIpfsType> {
    const signature = await signCommunity({ community: build.newIpns, signer: community.signer });
    const newCommunityRecord = <CommunityIpfsType>{ ...build.newIpns, signature };

    await community._validateCommunitySizeSchemaAndSignatureBeforePublishing(newCommunityRecord);
    return newCommunityRecord;
}

// Phase 3: upload to IPFS, publish IPNS, perform post-publish cleanup, and update in-memory + DB state.
async function publishCommunityRecordToIpns(
    community: LocalCommunity,
    build: CommunityRecordBuild,
    newCommunityRecord: CommunityIpfsType,
    cycleStartedAtMs: number
): Promise<void> {
    const { log, newIpns, newModQueue, editIdsToIncludeInNextUpdate } = build;
    const kuboRpcClient = community._clientsManager.getDefaultKuboRpcClient();

    const contentToPublish = deterministicStringify(newCommunityRecord);
    const file = await retryKuboIpfsAddAndProvide({
        ipfsClient: kuboRpcClient._client,
        log,
        content: contentToPublish, // you need to do deterministic here or otherwise cids in commentUpdate.replies won't match up correctly
        addOptions: { pin: true },
        provideOptions: { recursive: true },
        provideInBackground: false
    });
    if (file.size > MAX_FILE_SIZE_BYTES_FOR_COMMUNITY_IPFS) {
        throw new PKCError("ERR_LOCAL_COMMUNITY_RECORD_TOO_LARGE", {
            calculatedSizeOfNewCommunityRecord: file.size,
            maxSize: MAX_FILE_SIZE_BYTES_FOR_COMMUNITY_IPFS,
            newCommunityRecord,
            address: community.address
        });
    }

    if (!community.signer.ipnsKeyName) throw Error("IPNS key name is not defined");
    // after kubo 0.40 implements fetching IPNS record from local blockstore, we don't need line below anymore
    if (community._firstUpdateAfterStart) await community._resolveIpnsAndLogIfPotentialProblematicSequence();
    const ttl = `${community._pkc.publishInterval * 3}ms`; // default publish interval is 20s, so default ttl is 60s
    const lastPublishedIpnsRecordData = <any | undefined>await community._dbHandler.keyvGet(STORAGE_KEYS[STORAGE_KEYS.LAST_IPNS_RECORD]);
    const decodedIpnsRecord: any | undefined = lastPublishedIpnsRecordData
        ? cborg.decode(new Uint8Array(Object.values(lastPublishedIpnsRecordData)))
        : undefined;
    const ipnsSequence: BigInt | undefined = decodedIpnsRecord ? BigInt(decodedIpnsRecord.sequence) + 1n : undefined;
    const publishRes = await kuboRpcClient._client.name.publish(file.path, {
        key: community.signer.ipnsKeyName,
        allowOffline: true,
        resolve: true,
        ttl
        // enable below line after kubo fixes their problems with fetching IPNS records from local blockstore
        // ...(ipnsSequence ? { sequence: ipnsSequence } : undefined)
    });
    log(
        `Published a new IPNS record for community(${community.address}) on IPNS (${publishRes.name}) that points to file (${publishRes.value}) with updatedAt (${newCommunityRecord.updatedAt}) and TTL (${ttl})`
    );

    community._clientsManager.updateKuboRpcState("stopped", kuboRpcClient.url);
    addOldPageCidsToCidsToUnpin(community, community.raw.communityIpfs?.modQueue, newIpns.modQueue).catch((err) =>
        log.error("Failed to add old page cids of community.modQueue to _cidsToUnpin", err)
    );
    // Queue the record this publish just superseded BEFORE the flush below (issue #336): it was
    // generated while any comment a pending purge just deleted was still in the DB, so the purge
    // guarantee extends to it, and queueing it after unpinStaleCids would leave it to sit out the
    // issue #305 grace period pinned. The new record is already added, pinned and IPNS-published
    // at this point, so the old cid is safely superseded.
    if (community.updateCid && community.updateCid !== file.path) community._cidsToUnPin.add(community.updateCid);
    await unpinStaleCids(community, { cycleStartedAtMs });
    if (community._blocksToRm.length > 0) {
        const removedBlocks = await removeBlocksFromKuboNode({
            ipfsClient: community._clientsManager.getDefaultKuboRpcClient()._client,
            log,
            cids: community._blocksToRm,
            options: { force: true }
        });
        log("Removed blocks", removedBlocks, "from kubo node");
        community._blocksToRm = community._blocksToRm.filter((blockCid) => !removedBlocks.includes(blockCid));
    }
    const configuredPubsubTopic = community.pubsubTopic;
    // A pubsubTopic edit is applied to the instance through the published record, so while the exchange
    // is disabled it would be swallowed: the record omits the topic by design. Land it on the configured
    // topic instead, which is what the next enable publishes.
    const editedPubsubTopic = community._pendingEditProps
        .filter((editProps) => editProps.editId && editIdsToIncludeInNextUpdate.includes(editProps.editId))
        .map((editProps) => editProps.pubsubTopic)
        .filter((topic): topic is string => typeof topic === "string")
        .pop();
    community.initCommunityIpfsPropsNoMerge(newCommunityRecord);
    // A read-only community publishes no pubsubTopic, and the line above overwrites every CommunityIpfs
    // prop from the record it just published. Restore the configured topic so it is not lost on the
    // round trip and survives a disable/enable cycle (issue #229) — settings is the only switch.
    if (!newCommunityRecord.pubsubTopic) {
        const topicToKeep = editedPubsubTopic ?? configuredPubsubTopic;
        if (topicToKeep) community.pubsubTopic = topicToKeep;
    }
    community.updateCid = file.path;
    community._pendingEditProps = community._pendingEditProps.filter(
        (editProps) => !editIdsToIncludeInNextUpdate.includes(editProps.editId)
    );

    // Re-apply remaining pending edits to in-memory state.
    // initCommunityIpfsPropsNoMerge above overwrites all CommunityIpfs properties from the
    // published IPNS record. If edit() was called during the long IPNS publish await,
    // those edits are still in _pendingEditProps but their in-memory values were overwritten.
    if (community._pendingEditProps.length > 0) {
        const remainingEditProps = Object.assign(
            {}, //@ts-expect-error
            ...community._pendingEditProps.map((editProps) => pick(editProps, keys(CommunityIpfsSchema.shape)))
        );
        Object.assign(community, remainingEditProps);
    }

    // The update trigger was consumed at the start of this cycle in updateCommunityIpnsIfNeeded, so a
    // write that landed during the publish keeps it set for the next cycle.
    community._firstUpdateAfterStart = false;

    try {
        // this call will fail if we have http routers + kubo 0.38 and earlier
        const ipnsRecord = await getIpnsRecordInLocalKuboNode(kuboRpcClient, community.signer.address);

        await community._dbHandler.keyvSet(STORAGE_KEYS[STORAGE_KEYS.LAST_IPNS_RECORD], cborg.encode(ipnsRecord));
    } catch (e) {
        log.trace("Failed to update IPNS record in sqlite record, not a critical error and will most likely be fixed by kubo past 0.38", e);
    }

    community._combinedHashOfPendingCommentsCids = newModQueue?.combinedHashOfCids || sha256("");

    log.trace("Updated combined hash of pending comments to", community._combinedHashOfPendingCommentsCids);

    await community._updateDbInternalState(community.toJSONInternalAfterFirstUpdate());

    community._changeStateEmitEventEmitStateChangeEvent({
        newStartedState: "succeeded",
        event: { name: "update", args: [community] }
    });
}

export async function updateCommunityIpnsIfNeeded(
    community: LocalCommunity,
    commentUpdateRowsToPublishToIpfs: CommentUpdateToWriteToDbAndPublishToIpfs[]
) {
    const log = Logger("pkc-js:local-community:start:updateCommunityIpnsIfNeeded");

    community._calculateLatestUpdateTrigger();

    if (!community._communityUpdateTrigger) return; // No reason to update

    // Consume the trigger BEFORE the record's DB snapshot below, not after the publish. A write that
    // lands while this cycle is in flight (a vote, a comment edit, a mod-queue comment, a moderation)
    // is not in the record being built; it sets the trigger again and that must survive into the
    // next cycle. Clearing at the end of the cycle swallowed it, and the loop's wake-up check does
    // not look at votes or edits, so the write waited a full publishInterval. A failed cycle re-arms
    // the trigger below so the loop retries on its next pass, as it did when the clear came last.
    community._communityUpdateTrigger = false;
    // Stamped before the record's DB snapshot below: a purge that lands after this point may
    // reference the record this cycle publishes, and unpinStaleCids uses the stamp to keep the
    // pending-purge flush armed for the next cycle in that case (issue #336).
    const cycleStartedAtMs = Date.now();
    try {
        const build = await calculateNextCommunityRecord(community, commentUpdateRowsToPublishToIpfs, log);
        const newCommunityRecord = await validateAndSignCommunityRecord(community, build);
        await publishCommunityRecordToIpns(community, build, newCommunityRecord, cycleStartedAtMs);
    } catch (e) {
        community._communityUpdateTrigger = true;
        throw e;
    }
}

export async function syncIpnsWithDb(community: LocalCommunity) {
    const log = Logger("pkc-js:local-community:sync");

    const kuboRpc = community._clientsManager.getDefaultKuboRpcClient();
    try {
        await community._listenToIncomingRequests();
        await providePubsubTopicRoutingCidsIfNeeded(community);
        await adjustPostUpdatesBucketsIfNeeded(community);
        community._setStartedStateWithEmission("publishing-ipns");
        community._clientsManager.updateKuboRpcState("publishing-ipns", kuboRpc.url);
        await purgeDisapprovedCommentsOlderThan(community);
        const commentUpdateRows = await updateCommentsThatNeedToBeUpdated(community);
        requireCommunityUpdateIfModQueueChanged(community);
        await updateCommunityIpnsIfNeeded(community, commentUpdateRows);
        await cleanUpIpfsRepoIfDue(community);
    } catch (e) {
        //@ts-expect-error
        e.details = { ...e.details, communityAddress: community.address };
        const errorTyped = <Error>e;
        community._setStartedStateWithEmission("failed");
        community._clientsManager.updateKuboRpcState("stopped", kuboRpc.url);

        log.error(
            `Failed to sync community`,
            community.address,
            `due to error,`,
            errorTyped,
            "Error.message",
            errorTyped.message,
            "Error keys",
            Object.keys(errorTyped)
        );

        throw e;
    }
}
