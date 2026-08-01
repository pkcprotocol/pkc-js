import Logger from "../../../../logger.js";
import { clone, keys } from "remeda";
import { LRUCache } from "lru-cache";
import { PKCError } from "../../../../pkc-error.js";
import env from "../../../../version.js";
import { pubsubTopicToDhtKey, removeMfsFilesSafely, sleepUntilTimeoutOrAbort } from "../../../../util.js";
import { moveCommunityDbToDeletedDirectory } from "../../util.js";
import { getCommunityChallengeFromCommunityChallengeSettings } from "../challenges/index.js";
import {
    findCommunityInRegistry,
    findStartedCommunity,
    findUpdatingCommunity,
    syncCommunityRegistryEntry,
    trackStartedCommunity,
    trackUpdatingCommunity,
    untrackStartedCommunity,
    untrackUpdatingCommunity
} from "../../../../pkc/tracked-instance-registry-util.js";
import { LocalCommunity } from "../local-community.js";
import { processStartedCommunities } from "./registry.js";
import { communityChallengePubsubTopic } from "./comment-updates.js";
import { providePubsubTopicRoutingCidsIfNeeded } from "./pubsub.js";
import { reprovideOnAddressChangeIfDue } from "./reprovide-on-address-change.js";
import { repinCommentUpdateIfNeeded, unpinStaleCids } from "./cleanup.js";
import {
    importCommunitySignerIntoIpfsIfNeeded,
    setChallengesToDefaultIfNotDefined,
    updateDbInternalState,
    updateInstancePropsWithStartedCommunityOrDb,
    updateInstanceStateWithDbState
} from "./db-state.js";
import { calculateLatestUpdateTrigger, syncIpnsWithDb } from "./ipns-publishing.js";
import { getPersistedAnchorRecordBytes, reprovideAnchorRecordIfDue, reprovideAnchorRecordIfNeeded } from "./anchor-publishing.js";
import type { CommunityState, CommunityUpdatingState } from "../../../../community/types.js";
import type { DecryptedChallengeAnswer } from "../../../../pubsub-messages/types.js";
import type { RemoteCommunity } from "../../../../community/remote-community.js";

export async function publishLoop(community: LocalCommunity, syncIntervalMs: number) {
    const log = Logger("pkc-js:local-community:_publishLoop");
    // we need to continue the loop if there's at least one pending edit

    const shouldStopPublishLoop = () => {
        return community.state !== "started" || (community._stopHasBeenCalled && community._pendingEditProps.length === 0);
    };

    const waitUntilNextSync = async () => {
        const doneWithLoopTime = Date.now();
        await new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                const syncIntervalMsPassedSinceDoneWithLoop = Date.now() - doneWithLoopTime >= syncIntervalMs;
                calculateLatestUpdateTrigger(community); // will update community._communityUpdateTrigger
                if (community._communityUpdateTrigger || shouldStopPublishLoop() || syncIntervalMsPassedSinceDoneWithLoop) {
                    clearInterval(checkInterval);
                    resolve(1);
                }
            }, 100);
        });
    };

    while (!shouldStopPublishLoop()) {
        try {
            await syncIpnsWithDb(community);
            // Re-announce browser-dialable (WSS/WebRTC) addresses to HTTP routers when they rotate, so browsers
            // don't hit NoValidAddressesError against stale addresses. Throttled internally; runs inside the
            // publish loop so it's torn down with the loop on stop(). Its own failures must not break publishing.
            await reprovideOnAddressChangeIfDue(community).catch((e) =>
                log.error("Failed to re-provide connection CIDs on address change", e)
            );
            // Keep the anchor -> minter binding alive: its routers expire it, and this node is the only
            // party online that can put it (the owner holds As and is offline by design). Its failures
            // must not break publishing either.
            await reprovideAnchorRecordIfDue(community).catch((e) => log.error("Failed to re-provide the anchor record", e));
        } catch (e) {
            community.emit("error", e as Error);
        } finally {
            await waitUntilNextSync();
        }
    }
    log("Stopping the publishing loop of community", community.address);
}

export async function initBeforeStarting(community: LocalCommunity) {
    community.protocolVersion = env.PROTOCOL_VERSION;
    if (!community.signer?.address) throw new PKCError("ERR_COMMUNITY_SIGNER_NOT_DEFINED");
    if (!community._challengeAnswerPromises)
        community._challengeAnswerPromises = new LRUCache<string, Promise<DecryptedChallengeAnswer["challengeAnswers"]>>({
            max: 1000,
            ttl: 600000
        });
    if (!community._challengeAnswerResolveReject)
        community._challengeAnswerResolveReject = new LRUCache<
            string,
            { resolve: (answers: DecryptedChallengeAnswer["challengeAnswers"]) => void; reject: (error: Error) => void }
        >({
            max: 1000,
            ttl: 600000
        });
    if (!community._ongoingChallengeExchanges)
        community._ongoingChallengeExchanges = new LRUCache<string, boolean>({
            max: 1000,
            ttl: 600000
        });
    if (!community._duplicatePublicationAttempts)
        community._duplicatePublicationAttempts = new LRUCache<string, number>({
            max: 1000,
            ttl: 600000
        });
    await community._dbHandler.initDbIfNeeded();
}

export async function start(community: LocalCommunity) {
    const log = Logger("pkc-js:local-community:start");
    if (community.state === "updating")
        throw new PKCError("ERR_NEED_TO_STOP_UPDATING_COMMUNITY_BEFORE_STARTING", { address: community.address });
    community._stopHasBeenCalled = false;
    community._firstUpdateAfterStart = true;
    // Re-baseline address-change re-provide for this run (start() provides everything fresh below).
    community._lastProvidedBrowserDialableSelfAddrs = undefined;
    community._lastAddressReprovideCheckAt = undefined;
    if (!community._clientsManager.getDefaultKuboRpcClientOrHelia())
        throw Error("You need to define an IPFS client in your pkc instance to be able to start a local community");
    await community.initDbHandlerIfNeeded();
    await community._updateStartedValue();
    if (
        community.started ||
        findStartedCommunity(community._pkc, { publicKey: community.publicKey, name: community.name }) ||
        findCommunityInRegistry(processStartedCommunities, { publicKey: community.publicKey, name: community.name })
    )
        throw new PKCError("ERR_COMMUNITY_ALREADY_STARTED", { address: community.address });
    try {
        await initBeforeStarting(community);
        // A delegated community whose anchor record was never published is half-created: nothing points
        // the anchor at this minter, so readers cannot resolve it and publishers cannot reach it. Starting
        // it would publish minter records nobody can find. Publishing the record later completes it with
        // no re-create (#234). See docs/protocol/delegated-ipns.md.
        if (community.anchor && !getPersistedAnchorRecordBytes(community))
            throw new PKCError("ERR_DELEGATED_COMMUNITY_HAS_NO_ANCHOR_RECORD", {
                address: community.address,
                anchorPublicKey: community.anchor.publicKey,
                minterAddress: community.signer.address
            });
        // update started value twice because it could be started prior lockCommunityStart
        community._setState("started");
        await community._updateStartedValue();
        await community._dbHandler.lockCommunityStart(); // Will throw if community is locked already
        trackStartedCommunity(community._pkc, community);
        syncCommunityRegistryEntry(processStartedCommunities, community);
        await community._updateStartedValue();
        await community._dbHandler.initDbIfNeeded();
        await community._dbHandler.createOrMigrateTablesIfNeeded();
        await updateInstanceStateWithDbState(community); // sync in-memory state after potential migration
        await community._loadExportsFromKeyv();

        await setChallengesToDefaultIfNotDefined(community, log);
        // Import community keys onto ipfs node
        await importCommunitySignerIntoIpfsIfNeeded(community);
        // Force-provides the never-changing pubsub-topic routing CIDs (the connection-critical CIDs the
        // address-change re-provide watches) with the node's current browser-dialable addresses on start.
        await providePubsubTopicRoutingCidsIfNeeded(community, true);
        // A restarted kubo still has the anchor record in its datastore but is no longer subscribed to
        // the anchor's ipns-over-pubsub topic, so it silently stops answering for the anchor. Putting
        // once at start is what re-subscribes it. See anchor-publishing.ts.
        await reprovideAnchorRecordIfNeeded(community).catch((e) => log.error("Failed to re-provide the anchor record on start", e));

        community._communityUpdateTrigger = true;
        community._setStartedStateWithEmission("publishing-ipns");
        await community._repinCommentsIPFSIfNeeded();
        await repinCommentUpdateIfNeeded(community);
        await community._listenToIncomingRequests();
        community.challenges = await Promise.all(
            community.settings.challenges!.map(
                async (cs) =>
                    (await getCommunityChallengeFromCommunityChallengeSettings({ communityChallengeSettings: cs, pkc: community._pkc }))
                        .communityChallenge
            )
        ); // make sure community.challenges is using latest props from settings.challenges
    } catch (e) {
        await community.stop(); // Make sure to reset the community state
        //@ts-expect-error
        e.details = { ...e.details, communityAddress: community.address };
        throw e;
    }

    community._publishLoopPromise = publishLoop(community, community._pkc.publishInterval).catch((err) => {
        log.error(err);
        community.emit("error", err);
    });
}

export async function initMirroringStartedOrUpdatingCommunity(community: LocalCommunity, startedCommunity: LocalCommunity) {
    const updatingStateChangeListener = (newState: CommunityUpdatingState) => {
        community._setUpdatingStateWithEventEmissionIfNewState(newState);
    };

    const startedStateChangeListener = (newState: LocalCommunity["startedState"]) => {
        community._setStartedStateWithEmission(newState);
        updatingStateChangeListener(newState);
    };

    const updateListener = async (updatedCommunity: RemoteCommunity) => {
        const startedCommunity = updatedCommunity as LocalCommunity;
        if (startedCommunity.updateCid)
            await community.initInternalCommunityAfterFirstUpdateNoMerge(startedCommunity.toJSONInternalAfterFirstUpdate());
        else await community.initInternalCommunityBeforeFirstUpdateNoMerge(startedCommunity.toJSONInternalBeforeFirstUpdate());
        community.started = startedCommunity.started;
        // The internal record omits anchorRecordSequence, so the NoMerge call above clears it on this
        // mirror. The started instance is the writer that owns the value, same as in
        // updateInstancePropsWithStartedCommunityOrDb.
        community.anchorRecordSequence = startedCommunity.anchorRecordSequence;
        community.emit("update", community);
    };
    const stateChangeListener = async (newState: CommunityState) => {
        // pkc._startedCommunities[address].stop() has been called, we need to stop mirroring
        // or pkc._updatingCommunities[address].stop(), we need to stop mirroring
        if (newState === "stopped") await cleanUpMirroredStartedOrUpdatingCommunity(community);
    };
    community._mirroredStartedOrUpdatingCommunity = {
        community: startedCommunity,
        updatingstatechange: updatingStateChangeListener,
        update: updateListener,
        statechange: stateChangeListener,
        startedstatechange: startedStateChangeListener,
        error: (err: PKCError | Error) => community.emit("error", err),
        challengerequest: (challengeRequest) => community.emit("challengerequest", challengeRequest),
        challengeverification: (challengeVerification) => community.emit("challengeverification", challengeVerification),
        challengeanswer: (challengeAnswer) => community.emit("challengeanswer", challengeAnswer),
        challenge: (challenge) => community.emit("challenge", challenge)
    };

    community._mirroredStartedOrUpdatingCommunity.community.on("update", community._mirroredStartedOrUpdatingCommunity.update);
    community._mirroredStartedOrUpdatingCommunity.community.on(
        "startedstatechange",
        community._mirroredStartedOrUpdatingCommunity.startedstatechange
    );
    community._mirroredStartedOrUpdatingCommunity.community.on(
        "updatingstatechange",
        community._mirroredStartedOrUpdatingCommunity.updatingstatechange
    );
    community._mirroredStartedOrUpdatingCommunity.community.on("statechange", community._mirroredStartedOrUpdatingCommunity.statechange);
    community._mirroredStartedOrUpdatingCommunity.community.on("error", community._mirroredStartedOrUpdatingCommunity.error);
    community._mirroredStartedOrUpdatingCommunity.community.on(
        "challengerequest",
        community._mirroredStartedOrUpdatingCommunity.challengerequest
    );
    community._mirroredStartedOrUpdatingCommunity.community.on(
        "challengeverification",
        community._mirroredStartedOrUpdatingCommunity.challengeverification
    );
    community._mirroredStartedOrUpdatingCommunity.community.on(
        "challengeanswer",
        community._mirroredStartedOrUpdatingCommunity.challengeanswer
    );
    community._mirroredStartedOrUpdatingCommunity.community.on("challenge", community._mirroredStartedOrUpdatingCommunity.challenge);

    const clientKeys = keys(community.clients);
    for (const clientType of clientKeys)
        if (community.clients[clientType])
            for (const clientUrl of Object.keys(community.clients[clientType]))
                if (clientUrl in community._mirroredStartedOrUpdatingCommunity.community.clients[clientType])
                    community.clients[clientType][clientUrl].mirror(
                        community._mirroredStartedOrUpdatingCommunity.community.clients[clientType][clientUrl]
                    );
    if (startedCommunity.updateCid)
        await community.initInternalCommunityAfterFirstUpdateNoMerge(startedCommunity.toJSONInternalAfterFirstUpdate());
    else await community.initInternalCommunityBeforeFirstUpdateNoMerge(startedCommunity.toJSONInternalBeforeFirstUpdate());
    community.anchorRecordSequence = startedCommunity.anchorRecordSequence; // cleared by the NoMerge call above, see updateListener
    community.emit("update", community);
}

export async function cleanUpMirroredStartedOrUpdatingCommunity(community: LocalCommunity) {
    if (!community._mirroredStartedOrUpdatingCommunity) return;
    community._mirroredStartedOrUpdatingCommunity.community.removeListener("update", community._mirroredStartedOrUpdatingCommunity.update);
    community._mirroredStartedOrUpdatingCommunity.community.removeListener(
        "updatingstatechange",
        community._mirroredStartedOrUpdatingCommunity.updatingstatechange
    );

    community._mirroredStartedOrUpdatingCommunity.community.removeListener(
        "startedstatechange",
        community._mirroredStartedOrUpdatingCommunity.startedstatechange
    );
    community._mirroredStartedOrUpdatingCommunity.community.removeListener(
        "statechange",
        community._mirroredStartedOrUpdatingCommunity.statechange
    );
    community._mirroredStartedOrUpdatingCommunity.community.removeListener("error", community._mirroredStartedOrUpdatingCommunity.error);
    community._mirroredStartedOrUpdatingCommunity.community.removeListener(
        "challengerequest",
        community._mirroredStartedOrUpdatingCommunity.challengerequest
    );
    community._mirroredStartedOrUpdatingCommunity.community.removeListener(
        "challengeverification",
        community._mirroredStartedOrUpdatingCommunity.challengeverification
    );
    community._mirroredStartedOrUpdatingCommunity.community.removeListener(
        "challengeanswer",
        community._mirroredStartedOrUpdatingCommunity.challengeanswer
    );
    community._mirroredStartedOrUpdatingCommunity.community.removeListener(
        "challenge",
        community._mirroredStartedOrUpdatingCommunity.challenge
    );

    const clientKeys = keys(community.clients);

    for (const clientType of clientKeys)
        if (community.clients[clientType])
            for (const clientUrl of Object.keys(community.clients[clientType])) community.clients[clientType][clientUrl].unmirror();

    community._mirroredStartedOrUpdatingCommunity = undefined;
}

export async function updateOnce(community: LocalCommunity) {
    const log = Logger("pkc-js:local-community:_updateOnce");
    await community.initDbHandlerIfNeeded();
    await community._updateStartedValue();
    const startedCommunity = <LocalCommunity | undefined>(
        (findStartedCommunity(community._pkc, { publicKey: community.publicKey, name: community.name }) ||
            findCommunityInRegistry(processStartedCommunities, { publicKey: community.publicKey, name: community.name }))
    );
    if (community._mirroredStartedOrUpdatingCommunity)
        return; // we're already mirroring a started or updating community
    else if (startedCommunity) {
        // let's mirror the started community in this process
        await initMirroringStartedOrUpdatingCommunity(community, startedCommunity);
        untrackUpdatingCommunity(community._pkc, community);
        return;
    } else {
        const updatingCommunity = findUpdatingCommunity(community._pkc, { publicKey: community.publicKey, name: community.name });
        if (updatingCommunity instanceof LocalCommunity && updatingCommunity !== community) {
            // different instance is updating, let's mirror it
            await initMirroringStartedOrUpdatingCommunity(community, updatingCommunity as LocalCommunity);
            return;
        }
        // this community is not started or updated anywhere, but maybe another process will call edit() on it
        trackUpdatingCommunity(community._pkc, community);
        const oldUpdateId = clone(community._internalStateUpdateId);
        await updateInstancePropsWithStartedCommunityOrDb(community); // will update this instance props with DB
        if (community._internalStateUpdateId !== oldUpdateId) {
            log(
                `Local Community (${community.address}) received a new update from db with updatedAt (${community.updatedAt}). Will emit an update event`
            );

            community._changeStateEmitEventEmitStateChangeEvent({
                event: { name: "update", args: [community] },
                newUpdatingState: "succeeded"
            });
        }
    }
}

export async function updateLoop(community: LocalCommunity) {
    const log = Logger("pkc-js:local-community:update:_updateLoop");
    while (community.state === "updating" && !community._stopHasBeenCalled) {
        try {
            await updateOnce(community);
        } catch (e) {
            log.error("Error in update loop", e);
            community.emit("error", e as PKCError | Error);
        } finally {
            // Re-read the update-loop signal each iteration; sleepUntilTimeoutOrAbort detaches its abort
            // listener on both outcomes so it never leaks on the long-lived signal (see issue #146).
            await sleepUntilTimeoutOrAbort(community._pkc.updateInterval, community._updateLoopAbortController?.signal);
        }
    }
}

export async function update(community: LocalCommunity) {
    if (community.state === "started") throw new PKCError("ERR_COMMUNITY_ALREADY_STARTED", { address: community.address });
    if (community.state === "updating") return;
    community._stopHasBeenCalled = false;
    community._setState("updating");

    try {
        await updateOnce(community);
    } catch (e) {
        community.emit("error", e as PKCError | Error);
    }
    community._updateLoopAbortController = new AbortController();
    community._updateLoopPromise = updateLoop(community);
}

export async function stop(community: LocalCommunity) {
    const log = Logger("pkc-js:local-community:stop");
    community._stopHasBeenCalled = true;
    if (community._updateLoopAbortController) {
        community._updateLoopAbortController.abort();
    }
    community.posts._stop();

    if (community.state === "started") {
        log("Stopping running community", community.address);
        try {
            // Unsubscribe regardless of settings.disablePubsubChallengeExchange — the setting may have
            // been toggled on after we subscribed, and unsubscribing a topic we never joined is a no-op.
            // _subscribedChallengePubsubTopic covers a pubsubTopic that changed since we joined, which
            // the current derivation no longer names.
            const challengeTopics = new Set(
                [communityChallengePubsubTopic(community), community._subscribedChallengePubsubTopic].filter(
                    (topic): topic is string => typeof topic === "string"
                )
            );
            for (const challengeTopic of challengeTopics)
                await community._clientsManager.pubsubUnsubscribe(challengeTopic, community.handleChallengeExchange);
            community._subscribedChallengePubsubTopic = undefined;
        } catch (e) {
            log.error("Failed to unsubscribe from challenge exchange pubsub when stopping community", e);
        }
        if (community._publishLoopPromise) {
            try {
                await community._publishLoopPromise;
            } catch (e) {
                log.error(`Failed to stop community publish loop`, e);
            }
            community._publishLoopPromise = undefined;
        }

        try {
            await unpinStaleCids(community);
        } catch (e) {
            log.error("Failed to unpin stale cids and remove mfs paths before stopping", e);
        }

        try {
            await updateDbInternalState(
                community,
                community.updateCid ? community.toJSONInternalAfterFirstUpdate() : community.toJSONInternalBeforeFirstUpdate()
            );
        } catch (e) {
            log.error("Failed to update db internal state before stopping", e);
        }

        try {
            await community._dbHandler.unlockCommunityStart();
        } catch (e) {
            log.error(`Failed to unlock start lock on community (${community.address})`, e);
        }
        const kuboRpcClient = community._clientsManager.getDefaultKuboRpcClient();

        community._setStartedStateWithEmission("stopped");
        untrackStartedCommunity(community._pkc, community);
        processStartedCommunities.untrack(community);
        community._duplicatePublicationAttempts?.clear();
        await community._dbHandler.rollbackAllTransactions();
        await community._dbHandler.unlockCommunityState();
        await community._updateStartedValue();
        community._clientsManager.updateKuboRpcState("stopped", kuboRpcClient.url);
        community._clientsManager.updateKuboRpcPubsubStateIfProviderExists("stopped");
        if (community._dbHandler) community._dbHandler.destoryConnection();
        log(`Stopped the running of local community (${community.address})`);
        community._setState("stopped");
    } else if (community.state === "updating") {
        if (community._updateLoopPromise) {
            await community._updateLoopPromise;
            community._updateLoopPromise = undefined;
        }
        community._updateLoopAbortController = undefined;
        if (community._dbHandler) community._dbHandler.destoryConnection();
        if (community._mirroredStartedOrUpdatingCommunity) await cleanUpMirroredStartedOrUpdatingCommunity(community);
        if (findUpdatingCommunity(community._pkc, { publicKey: community.publicKey, name: community.name }) === community)
            untrackUpdatingCommunity(community._pkc, community);
        community._setUpdatingStateWithEventEmissionIfNewState("stopped");
        log(`Stopped the updating of local community (${community.address})`);
        community._setState("stopped");
    }
}

export async function deleteCommunity(community: LocalCommunity) {
    const log = Logger("pkc-js:local-community:delete");
    log.trace(`Attempting to stop the community (${community.address}) before deleting, if needed`);

    const startedCommunity = <LocalCommunity | undefined>(
        (findStartedCommunity(community._pkc, { publicKey: community.publicKey, name: community.name }) ||
            findCommunityInRegistry(processStartedCommunities, { publicKey: community.publicKey, name: community.name }))
    );
    if (startedCommunity && startedCommunity !== community) {
        await startedCommunity.delete();
        await community.stop();
        return;
    }

    if (community.state === "updating" || community.state === "started") await community.stop();

    const kuboClient = community._clientsManager.getDefaultKuboRpcClient();
    if (!kuboClient) throw Error("Ipfs client is not defined");

    if (typeof community.signer?.ipnsKeyName === "string")
        // Key may not exist on ipfs node
        try {
            await kuboClient._client.key.rm(community.signer.ipnsKeyName);
        } catch (e) {
            log.error("Failed to delete ipns key", community.signer.ipnsKeyName, e);
        }

    try {
        await removeMfsFilesSafely({ kuboRpcClient: kuboClient, paths: ["/" + community.address], log });
    } catch (e) {
        log.error("Failed to delete community mfs folder", "/" + community.address, e);
    }
    // sceneario 1: we call delete() on a community that is not started or updating
    // scenario 2: we call delete() on a community that is updating
    // scenario 3: we call delete() on a community that is started
    // scenario 4: we call delete() on a community that is not started, but the same community is started in pkc._startedCommunities[address]

    try {
        await community._addOldPageCidsToCidsToUnpin(community.raw?.communityIpfs?.posts, undefined);
    } catch (e) {
        log.error("Failed to add old page cids from community.posts to be unpinned", e);
    }
    if (community.ipnsPubsubTopicRoutingCid) community._cidsToUnPin.add(community.ipnsPubsubTopicRoutingCid);
    // pubsubTopicRoutingCid only reflects the topic of the last published record, so derive the
    // configured topic's block too: a community whose exchange is disabled (issue #229), or whose topic
    // changed after the last publish, still has that block pinned from when it was being provided.
    const configuredChallengeTopic = communityChallengePubsubTopic(community);
    if (configuredChallengeTopic) community._cidsToUnPin.add(pubsubTopicToDhtKey(configuredChallengeTopic));
    if (community.pubsubTopicRoutingCid) community._cidsToUnPin.add(community.pubsubTopicRoutingCid);
    try {
        await community.initDbHandlerIfNeeded();
        await community._dbHandler.initDbIfNeeded();
        const cidsAndReplies = community._dbHandler.queryAllCommentCidsAndTheirReplies();
        for (const comment of cidsAndReplies) {
            community._cidsToUnPin.add(comment.cid);
            for (const pageCid of comment.allPageCids) {
                community._cidsToUnPin.add(pageCid);
            }
        }
    } catch (e) {
        log.error("Failed to query all cids under this community to delete them", e);
    }
    if (community.updateCid) community._cidsToUnPin.add(community.updateCid);
    if (community.statsCid) community._cidsToUnPin.add(community.statsCid);

    try {
        await unpinStaleCids(community);
    } catch (e) {
        log.error("Failed to unpin stale cids before deleting", e);
    }

    try {
        await updateDbInternalState(
            community,
            typeof community.updatedAt === "number"
                ? community.toJSONInternalAfterFirstUpdate()
                : community.toJSONInternalBeforeFirstUpdate()
        );
    } catch (e) {
        log.error("Failed to update db internal state before deleting", e);
    } finally {
        community._dbHandler.destoryConnection();
    }

    await moveCommunityDbToDeletedDirectory(community.address, community._pkc);

    log(`Deleted community (${community.address}) successfully`);
}
