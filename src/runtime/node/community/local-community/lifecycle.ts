import Logger from "../../../../logger.js";
import { clone, keys } from "remeda";
import { LRUCache } from "lru-cache";
import { PKCError } from "../../../../pkc-error.js";
import env from "../../../../version.js";
import { pubsubTopicToDhtKey, removeMfsFilesSafely, sleepUntilTimeoutOrAbort } from "../../../../util.js";
import { moveCommunityDbToDeletedDirectory, refreshCommunitiesList } from "../../util.js";
import { deriveCommunityChallengesOrThrow } from "../challenges/index.js";
import { collectChallengeSettingsValidationFailures } from "../challenges/validate-challenge-settings.js";
import {
    findStartedCommunity,
    findUpdatingCommunity,
    trackStartedCommunity,
    trackUpdatingCommunity,
    untrackStartedCommunity,
    untrackUpdatingCommunity
} from "../../../../pkc/tracked-instance-registry-util.js";
import { LocalCommunity } from "../local-community.js";
import { findProcessStartedCommunity, processStartedCommunities, syncProcessStartedCommunity } from "./registry.js";
import { syncPageSortsWithRegistry } from "./registry-sync.js";
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
    // After stop() the loop runs on while an edit is pending so the record carrying it goes out before the community
    // goes down. Pending edits drain only on a successful publish, so a cycle that fails after stop() ends the loop
    // instead of retrying forever (the edit is in the DB and ships on the next start): otherwise an all-throwing page
    // sort configuration, or an unreachable Kubo, would make stop() hang.
    let syncFailedSinceStop = false;

    const shouldStopPublishLoop = () => {
        return (
            community.state !== "started" ||
            (community._stopHasBeenCalled && (community._pendingEditProps.length === 0 || syncFailedSinceStop))
        );
    };

    // A failed cycle leaves the update trigger set, so waking on it would retry on the next 100ms tick and emit the same
    // error about ten times a second (issue #430). After a failure the loop wakes only for a new request for a record
    // (an edit, a new publication), counted by _updateTriggerGeneration, and otherwise waits the full sync interval.
    const waitUntilNextSync = async ({ lastSyncFailed }: { lastSyncFailed: boolean }) => {
        const doneWithLoopTime = Date.now();
        // the state the failed cycle tried to publish is not a new request: take it in before the snapshot
        if (lastSyncFailed) calculateLatestUpdateTrigger(community);
        const triggerGenerationAfterFailure = community._updateTriggerGeneration;
        await new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                const syncIntervalMsPassedSinceDoneWithLoop = Date.now() - doneWithLoopTime >= syncIntervalMs;
                calculateLatestUpdateTrigger(community); // will update community._communityUpdateTrigger
                const wokenByTrigger = lastSyncFailed
                    ? community._updateTriggerGeneration !== triggerGenerationAfterFailure
                    : community._communityUpdateTrigger;
                if (wokenByTrigger || shouldStopPublishLoop() || syncIntervalMsPassedSinceDoneWithLoop) {
                    clearInterval(checkInterval);
                    resolve(1);
                }
            }, 100);
        });
    };

    while (!shouldStopPublishLoop()) {
        let lastSyncFailed = false;
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
            lastSyncFailed = true;
            if (community._stopHasBeenCalled) syncFailedSinceStop = true;
            community.emit("error", e as Error);
        } finally {
            await waitUntilNextSync({ lastSyncFailed });
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
            ttl: community._challengeExchangeTtlMs
        });
    if (!community._challengeAnswerResolveReject)
        community._challengeAnswerResolveReject = new LRUCache<
            string,
            { resolve: (answers: DecryptedChallengeAnswer["challengeAnswers"]) => void; reject: (error: Error) => void }
        >({
            max: 1000,
            ttl: community._challengeExchangeTtlMs
        });
    if (!community._ongoingChallengeExchanges)
        community._ongoingChallengeExchanges = new LRUCache<string, boolean>({
            max: 1000,
            ttl: community._challengeExchangeTtlMs
        });
    if (!community._duplicatePublicationAttempts)
        community._duplicatePublicationAttempts = new LRUCache<string, number>({
            max: 1000,
            ttl: community._challengeExchangeTtlMs
        });
    await community._dbHandler.initDbIfNeeded();
}

// Report every invalid persisted challenge as its own `error` event, one per challenge, and keep going.
// Loading a challenge file can itself throw (a `path` that no longer exists, a `name` this node does not
// have registered); that is a startup problem in its own right and is reported the same way rather than
// swallowed, since the caller only asked us to look at the config.
async function emitChallengeSettingsValidationErrors(community: LocalCommunity, log: Logger) {
    let failures: Awaited<ReturnType<typeof collectChallengeSettingsValidationFailures>>;
    try {
        failures = await collectChallengeSettingsValidationFailures({
            challengeSettings: community.settings?.challenges ?? [],
            pkc: community._pkc
        });
    } catch (e) {
        log.error("Failed to validate settings.challenges on start", community.address, e);
        community.emit("error", e as PKCError);
        return;
    }
    for (const { error, challengeIndex, challengeName } of failures) {
        error.details = { ...error.details, challengeIndex, challengeName, communityAddress: community.address };
        log.error("Invalid challenge settings on start", community.address, error);
        community.emit("error", error);
    }
}

// Marks the start() or update() that is still setting this instance up until it settles. stop() waits for it, so it tears
// down what the call set up rather than racing it: a stop() that ran during start() used to leave a "stopped" community
// subscribed to challenge requests, and one that ran during update()'s first load left it in the updating registry.
async function runAsStartOrUpdateInFlight({
    community,
    setUp
}: {
    community: LocalCommunity;
    setUp: (releaseMark: () => void) => Promise<void>;
}) {
    let settle!: () => void;
    const inFlight = new Promise<void>((resolve) => (settle = resolve));
    community._startOrUpdateInFlight = inFlight;
    // Clears this call's own mark only. A start() that began once the mark was released (from a "stopped" listener during a
    // failed start()'s own stop()) has set its own mark by then, and clearing that one let a stop() skip waiting for it.
    const releaseMark = () => {
        if (community._startOrUpdateInFlight === inFlight) community._startOrUpdateInFlight = undefined;
    };
    try {
        await setUp(releaseMark);
    } finally {
        releaseMark();
        settle();
    }
}

export async function start(community: LocalCommunity) {
    if (community.state === "updating")
        throw new PKCError("ERR_NEED_TO_STOP_UPDATING_COMMUNITY_BEFORE_STARTING", { address: community.address });
    // Refused before anything on the instance changes: this instance is running, still stopping (stop() keeps the state
    // "started" until its teardown is done) or already starting. Clearing _stopHasBeenCalled under a stop() in flight kept
    // the publish loop it waits for running forever, and a second start() tore the first one down once it lost the lock.
    if (community.state === "started" || community._startOrUpdateInFlight)
        throw new PKCError("ERR_COMMUNITY_ALREADY_STARTED", { address: community.address });
    await runAsStartOrUpdateInFlight({ community, setUp: (releaseMark) => startCommunity({ community, releaseMark }) });
}

async function startCommunity({ community, releaseMark }: { community: LocalCommunity; releaseMark: () => void }) {
    const log = Logger("pkc-js:local-community:start");
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
        findProcessStartedCommunity(community)
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
        // Refuse an unloadable challenge before entering the started state: from there on a failed start goes
        // through the running-community teardown in stop(), which unsubscribes from pubsub and unpins (issue #428).
        // Checked again below against the settings as refreshed from the db.
        await deriveCommunityChallengesOrThrow({
            challengeSettings: community.settings?.challenges ?? [],
            pkc: community._pkc,
            communityAddress: community.address
        });
        // Locked before entering the started state, so a start() that loses the race for the lock throws while still
        // "stopped" and the stop() below does nothing. From "started" it ran the running-community teardown, which unlocks
        // by path and released the lock of the start() that won (held locks are keyed by path, per process).
        await community._dbHandler.lockCommunityStart(); // Will throw if community is locked already
        community._setState("started");
        await community._updateStartedValue();
        trackStartedCommunity(community._pkc, community);
        syncProcessStartedCommunity(community);
        await community._updateStartedValue();
        await community._dbHandler.initDbIfNeeded();
        await community._dbHandler.createOrMigrateTablesIfNeeded();
        await updateInstanceStateWithDbState(community); // sync in-memory state after potential migration
        await community._loadExportsFromKeyv();

        await setChallengesToDefaultIfNotDefined(community, log);
        // A challenge that cannot be loaded (its package uninstalled, its path gone) can never run, so the community
        // stays offline until the owner removes it from settings.challenges or installs it again. Checked here, before
        // anything touches the network, and on every start (issue #428). Also makes sure community.challenges is
        // using the latest props from settings.challenges.
        community.challenges = await deriveCommunityChallengesOrThrow({
            challengeSettings: community.settings.challenges!,
            pkc: community._pkc,
            communityAddress: community.address
        });
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

        // Option validation only reports; it never throws. A config that was persisted before these checks existed, or
        // one that a stricter challenge version now rejects, must not take startup down. It is re-emitted
        // on every start until the owner fixes it, because a suppressed error is how a misconfiguration
        // gets forgotten.
        await emitChallengeSettingsValidationErrors(community, log);
        // Resolve settings.pages against the sort files now, so page generation reuses the instances; each invalid entry
        // is its own error event and is skipped, the rest of the config still publishes (issue #73). A package replaced
        // while the node was down changes the persisted fingerprint and regenerates every CommentUpdate (issue #411).
        community._pageSorts = undefined;
        community._pageSortFactories = undefined;
        await syncPageSortsWithRegistry(community);
    } catch (e) {
        // Released first, so this failed start's own stop() does not wait for it, and a start() called during that stop()
        // (from a "stopped" statechange listener) is not refused. A stop() that was already waiting for this start() resumes
        // only when it settles, after this teardown, so the two never tear the community down at the same time.
        releaseMark();
        await community.stop(); // Make sure to reset the community state
        // A start() that failed before entering the started state (it lost the race for the start lock, say) leaves stop()
        // nothing to tear down, but initBeforeStarting() opened the DB. A start() or update() begun since owns the connection.
        if (community.state === "stopped" && !community._startOrUpdateInFlight) community._dbHandler.destoryConnection();
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
            findProcessStartedCommunity(community))
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
    // a start() still in flight: it has not entered the started state yet
    if (community._startOrUpdateInFlight) throw new PKCError("ERR_COMMUNITY_ALREADY_STARTED", { address: community.address });

    await runAsStartOrUpdateInFlight({
        community,
        setUp: async () => {
            // Marked in flight before the "updating" statechange, so a stop() that a listener of it calls waits too
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
    });
}

export async function stop(community: LocalCommunity) {
    const log = Logger("pkc-js:local-community:stop");
    community._stopHasBeenCalled = true;
    // Set above first, so the publish or update loop the start() or update() launches ends at its first check. Also waits
    // for a start() begun while it waited (from a listener during a failed start()'s teardown), so it stops that one too.
    while (community._startOrUpdateInFlight) {
        await community._startOrUpdateInFlight;
        community._stopHasBeenCalled = true; // a start() begun meanwhile cleared it
    }
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
            // Bypass the unpin grace period: this is the process's last chance to unpin, and a
            // community that never starts again would otherwise leak its queued pins forever.
            await unpinStaleCids(community, { bypassGracePeriod: true });
        } catch (e) {
            log.error("Failed to unpin stale cids and remove mfs paths before stopping", e);
        }

        try {
            // built under the state lock, so it keeps an edit stored meanwhile (see updateDbInternalState)
            await updateDbInternalState(community, () =>
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
        community._inFlightPublicationExchanges.clear();
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

// How many comments delete() reads, queues and unpins at a time (issue #389). 5,000 cids is a few hundred KB.
export const DELETE_UNPIN_SLICE_SIZE = 5000;

export async function deleteCommunity(community: LocalCommunity) {
    const log = Logger("pkc-js:local-community:delete");
    log.trace(`Attempting to stop the community (${community.address}) before deleting, if needed`);

    const startedCommunity = <LocalCommunity | undefined>(
        (findStartedCommunity(community._pkc, { publicKey: community.publicKey, name: community.name }) ||
            findProcessStartedCommunity(community))
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

    // The posts pages of the last record, from what the community recorded when it published them
    // (_postsAllPageCids, the same list the publish cycle unpins superseded pages from) plus the first
    // page of each sort the record names. Not by walking the pages: following the nextCid chains means
    // fetching and parsing every page of the board, 9.4 GB of JSON for a million comments, which ran the
    // heap out before a single comment was unpinned (issue #389). The walk stays only for a board whose
    // internal state predates the recorded list.
    const lastPosts = community.raw?.communityIpfs?.posts;
    if (community._postsAllPageCids) {
        for (const cid of Object.values(community._postsAllPageCids).flat()) community._cidsToUnPin.add(cid);
        for (const cid of Object.values(lastPosts?.pageCids ?? {})) community._cidsToUnPin.add(cid);
    } else if (lastPosts) {
        try {
            await community._addOldPageCidsToCidsToUnpin(lastPosts, undefined);
        } catch (e) {
            log.error("Failed to add old page cids from community.posts to be unpinned", e);
        }
    }
    if (community.ipnsPubsubTopicRoutingCid) community._cidsToUnPin.add(community.ipnsPubsubTopicRoutingCid);
    // pubsubTopicRoutingCid only reflects the topic of the last published record, so derive the
    // configured topic's block too: a community whose exchange is disabled (issue #229), or whose topic
    // changed after the last publish, still has that block pinned from when it was being provided.
    const configuredChallengeTopic = communityChallengePubsubTopic(community);
    if (configuredChallengeTopic) community._cidsToUnPin.add(pubsubTopicToDhtKey(configuredChallengeTopic));
    if (community.pubsubTopicRoutingCid) community._cidsToUnPin.add(community.pubsubTopicRoutingCid);
    if (community.updateCid) community._cidsToUnPin.add(community.updateCid);
    if (community.statsCid) community._cidsToUnPin.add(community.statsCid);

    // Every comment and every reply page of the board, unpinned one slice at a time. The grace period is
    // bypassed throughout: the community is being deleted, nothing will ever run a later unpin pass for
    // it. A slice is queued, unpinned and gone before the next one is read, so a board of a million
    // comments costs a slice of memory, not the board (issue #389); a cid whose pin.rm failed stays
    // queued for the next pass and is logged by unpinStaleCids.
    try {
        await community.initDbHandlerIfNeeded();
        await community._dbHandler.initDbIfNeeded();
        for (const slice of community._dbHandler.iterateCommentCidsAndTheirPageCids(DELETE_UNPIN_SLICE_SIZE)) {
            for (const comment of slice) {
                community._cidsToUnPin.add(comment.cid);
                for (const pageCid of comment.allPageCids) community._cidsToUnPin.add(pageCid);
            }
            await unpinStaleCids(community, { bypassGracePeriod: true });
        }
    } catch (e) {
        log.error("Failed to unpin the comments of this community before deleting it", e);
    }
    try {
        await unpinStaleCids(community, { bypassGracePeriod: true });
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
    refreshCommunitiesList(community._pkc); // unlist the address now, not when the filesystem watcher fires

    log(`Deleted community (${community.address}) successfully`);
}
