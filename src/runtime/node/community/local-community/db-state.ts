import Logger from "../../../../logger.js";
import * as remeda from "remeda";
import { v4 as uuidV4 } from "uuid";
import { ipnsNameToIpnsOverPubsubTopic, pubsubTopicToDhtKey, timestamp } from "../../../../util.js";
import { PKCError } from "../../../../pkc-error.js";
import env from "../../../../version.js";
import { STORAGE_KEYS } from "../../../../constants.js";
import { parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails } from "../../../../schema/schema-util.js";
import { deriveDbPosts, resolveDbPostsCidRefs, importSignerIntoKuboNode } from "../../util.js";
import { SignerWithPublicKeyAddress } from "../../../../signer/index.js";
import { getIpfsKeyFromPrivateKey, getPublicKeyFromPrivateKey } from "../../../../signer/util.js";
import { findCommunityInRegistry, findStartedCommunity } from "../../../../pkc/tracked-instance-registry-util.js";
import { getCommunityChallengeFromCommunityChallengeSettings } from "../challenges/index.js";
import type {
    CommunityIpfsType,
    CreateNewLocalCommunityParsedOptions,
    InternalCommunityRecordAfterFirstUpdateType,
    InternalCommunityRecordBeforeFirstUpdateType
} from "../../../../community/types.js";
import type { DbPostsFormat } from "../../../../publications/comment/types.js";
import type { LocalCommunity } from "../local-community.js";
import { generateDefaultChallenges, isDefaultChallengeStructure } from "./defaults.js";
import { processStartedCommunities } from "./registry.js";
import { CommunitySignedPropertyNames } from "../../../../community/schema.js";
import { syncCommunityRegistryEntry } from "../../../../pkc/tracked-instance-registry-util.js";
import { DbHandler } from "../db-handler.js";
import { PageGenerator } from "../page-generator.js";

export async function initSignerProps(community: LocalCommunity, newSignerProps: InternalCommunityRecordBeforeFirstUpdateType["signer"]) {
    community.signer = new SignerWithPublicKeyAddress(newSignerProps);
    if (!community.signer?.ipfsKey?.byteLength || community.signer?.ipfsKey?.byteLength <= 0)
        community.signer.ipfsKey = new Uint8Array(await getIpfsKeyFromPrivateKey(community.signer.privateKey));
    if (!community.signer.ipnsKeyName) community.signer.ipnsKeyName = community.signer.address;
    if (!community.signer.publicKey) community.signer.publicKey = await getPublicKeyFromPrivateKey(community.signer.privateKey);

    community.encryption = {
        type: "ed25519-aes-gcm",
        publicKey: community.signer.publicKey
    };
}

export async function importCommunitySignerIntoIpfsIfNeeded(community: LocalCommunity) {
    if (!community.signer.ipnsKeyName) throw Error("community.signer.ipnsKeyName is not defined");
    if (!community.signer.ipfsKey) throw Error("community.signer.ipfsKey is not defined");

    await importSignerIntoKuboNode(community.signer.ipnsKeyName, community.signer.ipfsKey, {
        url: community._pkc.kuboRpcClientsOptions![0].url!.toString(),
        headers: community._pkc.kuboRpcClientsOptions![0].headers
    });
}

export async function getDbInternalState(
    community: LocalCommunity,
    lock: boolean
): Promise<InternalCommunityRecordAfterFirstUpdateType | InternalCommunityRecordBeforeFirstUpdateType> {
    const log = Logger("pkc-js:local-community:_getDbInternalState");
    if (!community._dbHandler.keyvHas(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY]))
        throw new PKCError("ERR_COMMUNITY_HAS_NO_INTERNAL_STATE", { address: community.address, dataPath: community._pkc.dataPath });
    let lockedIt = false;
    try {
        if (lock) {
            await community._dbHandler.lockCommunityState();
            lockedIt = true;
        }
        const internalState = await community._dbHandler.keyvGet(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY]);
        if (!internalState)
            throw new PKCError("ERR_COMMUNITY_HAS_NO_INTERNAL_STATE", { address: community.address, dataPath: community._pkc.dataPath });
        return internalState as InternalCommunityRecordAfterFirstUpdateType | InternalCommunityRecordBeforeFirstUpdateType;
    } catch (e) {
        log.error("Failed to get community", community.address, "internal state from db", e);
        throw e;
    } finally {
        if (lockedIt) await community._dbHandler.unlockCommunityState();
    }
}

export async function updateDbInternalState(
    community: LocalCommunity,
    props: Partial<InternalCommunityRecordBeforeFirstUpdateType | InternalCommunityRecordAfterFirstUpdateType>
): Promise<InternalCommunityRecordBeforeFirstUpdateType | InternalCommunityRecordAfterFirstUpdateType> {
    const log = Logger("pkc-js:local-community:_updateDbInternalState");
    if (remeda.isEmpty(props)) throw Error("props to update DB internal state should not be empty");
    await community._dbHandler.initDbIfNeeded();

    props._internalStateUpdateId = uuidV4();
    let lockedIt = false;
    try {
        await community._dbHandler.lockCommunityState();
        lockedIt = true;
        const internalStateBefore = await getDbInternalState(community, false);
        // Convert posts to CID-ref format for compact DB storage (strip preloaded page data)
        const propsToStore =
            "posts" in props && props.posts
                ? {
                      ...props,
                      posts: deriveDbPosts({
                          posts: props.posts as CommunityIpfsType["posts"],
                          allPageCids: community._postsAllPageCids
                      }) as typeof props.posts
                  }
                : props;
        const mergedInternalState = { ...internalStateBefore, ...propsToStore };
        await community._dbHandler.keyvSet(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY], mergedInternalState);
        community._internalStateUpdateId = props._internalStateUpdateId;
        log.trace("Updated community", community.address, "internal state in db with new props", Object.keys(props));
        if (community.updateCid && community.raw.communityIpfs) {
            community.raw.localCommunity = community.toJSONInternalRpcAfterFirstUpdate();
        } else if (community.settings) {
            community.raw.localCommunity = community.toJSONInternalRpcBeforeFirstUpdate();
        }
        return mergedInternalState as InternalCommunityRecordBeforeFirstUpdateType | InternalCommunityRecordAfterFirstUpdateType;
    } catch (e) {
        log.error("Failed to update community", community.address, "internal state in db with new props", Object.keys(props), e);
        throw e;
    } finally {
        if (lockedIt) await community._dbHandler.unlockCommunityState();
    }
}

export async function updateInstanceStateWithDbState(community: LocalCommunity) {
    const currentDbState = await getDbInternalState(community, false);

    if ("updatedAt" in currentDbState) {
        // Resolve CID-ref posts from DB back to full wire format with preloaded pages.
        // DB stores posts in compact CID-ref format (no preloaded page data).
        // _dbHandler is guaranteed to be initialized here since we're loading from DB.
        if (currentDbState.posts && !("pages" in currentDbState.posts)) {
            const dbPosts = currentDbState.posts as unknown as DbPostsFormat;
            currentDbState.posts = resolveDbPostsCidRefs({ dbPosts, dbHandler: community._dbHandler }) as typeof currentDbState.posts;
        }
        await community.initInternalCommunityAfterFirstUpdateNoMerge(currentDbState);
    } else await community.initInternalCommunityBeforeFirstUpdateNoMerge(currentDbState);
}

export async function updateInstancePropsWithStartedCommunityOrDb(community: LocalCommunity) {
    // if it's started in the same pkc instance, we will load it from the started community instance
    // if it's started in another process, we will throw an error
    // if community is not started, load the InternalCommunity props from the local db

    const log = Logger("pkc-js:local-community:_updateInstancePropsWithStartedCommunityOrDb");
    const startedCommunity = <LocalCommunity | undefined>(
        (findStartedCommunity(community._pkc, { publicKey: community.publicKey, name: community.name }) ||
            findCommunityInRegistry(processStartedCommunities, { publicKey: community.publicKey, name: community.name }))
    );
    if (startedCommunity) {
        log("Loading local community", community.address, "from started community instance");
        if (startedCommunity.updatedAt)
            await community.initInternalCommunityAfterFirstUpdateNoMerge(startedCommunity.toJSONInternalAfterFirstUpdate());
        else await community.initInternalCommunityBeforeFirstUpdateNoMerge(startedCommunity.toJSONInternalBeforeFirstUpdate());
        community.started = true;
    } else {
        await community.initDbHandlerIfNeeded();
        try {
            await community._updateStartedValue();

            const communityDbExists = community._dbHandler.communityDbExists();
            if (!communityDbExists)
                throw new PKCError("CAN_NOT_LOAD_LOCAL_COMMUNITY_IF_DB_DOES_NOT_EXIST", {
                    address: community.address,
                    dataPath: community._pkc.dataPath
                });

            const dbConfig = community.state === "updating" ? { readonly: true } : undefined;
            await community._dbHandler.initDbIfNeeded(dbConfig);

            await updateInstanceStateWithDbState(community); // Load InternalCommunity from DB here
            if (!community.signer)
                throw new PKCError("ERR_LOCAL_COMMUNITY_HAS_NO_SIGNER_IN_INTERNAL_STATE", { address: community.address });

            await community._updateStartedValue();
            log("Loaded local community", community.address, "from db");
        } catch (e) {
            throw e;
        } finally {
            community._dbHandler.destoryConnection(); // Need to destory connection so process wouldn't hang
        }
    }

    // need to validate schema of Community IPFS
    if (community.raw.communityIpfs)
        try {
            parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(community.raw.communityIpfs);
        } catch (e) {
            if (e instanceof Error) {
                log(
                    "Local community",
                    community.address,
                    "has an invalid communityIpfs schema from DB, clearing for re-generation after migration:",
                    e.message
                );
                community.raw.communityIpfs = undefined;
            }
        }
}

export async function setChallengesToDefaultIfNotDefined(community: LocalCommunity, log: Logger) {
    if (
        community._usingDefaultChallenge !== false &&
        (!community.settings?.challenges || isDefaultChallengeStructure(community.settings?.challenges))
    )
        community._usingDefaultChallenge = true;

    if (community._usingDefaultChallenge) {
        const currentAnswer = community.settings?.challenges?.[0]?.options?.answer;
        if (currentAnswer && isDefaultChallengeStructure(community._defaultCommunityChallenges)) {
            // Preserve the existing per-community random answer in the template
            community._defaultCommunityChallenges = generateDefaultChallenges(currentAnswer);
        }

        if (!remeda.isDeepEqual(community.settings?.challenges, community._defaultCommunityChallenges)) {
            await community.edit({ settings: { ...community.settings, challenges: community._defaultCommunityChallenges } });
            // edit() recalculates _usingDefaultChallenge via _isDefaultChallengeStructure,
            // which may return false for non-standard defaults (e.g. []).
            // Re-assert true since we know this is still a default-driven upgrade.
            community._usingDefaultChallenge = true;
            log(
                `Upgraded default challenge for community (${community.address})`,
                community._defaultCommunityChallenges[0]?.options?.answer
                    ? `with answer: ${community._defaultCommunityChallenges[0].options!.answer}`
                    : `to ${community._defaultCommunityChallenges.length} challenge(s)`
            );
        }
    }
}

export async function createNewLocalCommunityDb(community: LocalCommunity) {
    // We're creating a totally new community here with a new db
    // This function should be called only once per community
    const log = Logger("pkc-js:local-community:_createNewLocalCommunityDb");
    await community.initDbHandlerIfNeeded();
    await community._dbHandler.initDbIfNeeded({ fileMustExist: false });
    await community._dbHandler.createOrMigrateTablesIfNeeded();
    await initSignerProps(community, community.signer); // init this.encryption as well

    if (!community.pubsubTopic) community.pubsubTopic = remeda.clone(community.signer.address);
    if (typeof community.createdAt !== "number") community.createdAt = timestamp();
    if (!community.protocolVersion) community.protocolVersion = env.PROTOCOL_VERSION;
    if (!community.settings?.maxPendingApprovalCount) community.settings = { ...community.settings, maxPendingApprovalCount: 500 };
    if (!community.settings?.challenges) {
        community.settings = { ...community.settings, challenges: community._defaultCommunityChallenges };
        community._usingDefaultChallenge = true;
        log(
            `Generated default challenge for community (${community.address}) with answer:`,
            community._defaultCommunityChallenges[0].options!.answer
        );
    }
    if (typeof community.settings?.purgeDisapprovedCommentsOlderThan !== "number") {
        community.settings = { ...community.settings, purgeDisapprovedCommentsOlderThan: 1.21e6 }; // two weeks
    }

    community.challenges = await Promise.all(
        community.settings.challenges!.map(
            async (cs) =>
                (await getCommunityChallengeFromCommunityChallengeSettings({ communityChallengeSettings: cs, pkc: community._pkc }))
                    .communityChallenge
        )
    );

    if (community._dbHandler.keyvHas(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY])) throw Error("Internal state exists already");

    await community._dbHandler.keyvSet(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY], community.toJSONInternalBeforeFirstUpdate());

    await community._updateStartedValue();

    community._dbHandler.destoryConnection(); // Need to destory connection so process wouldn't hang
    community._updateIpnsPubsubPropsIfNeeded({
        ...community.toJSONInternalBeforeFirstUpdate(), //@ts-expect-error
        signature: { publicKey: community.signer.publicKey }
    });
}

export async function initNewLocalCommunityPropsNoMerge(community: LocalCommunity, newProps: CreateNewLocalCommunityParsedOptions) {
    await initSignerProps(community, newProps.signer);
    community.title = newProps.title;
    community.description = newProps.description;
    community.setAddress(newProps.address);
    community.pubsubTopic = newProps.pubsubTopic;
    community.roles = newProps.roles;
    community.features = newProps.features;
    community.suggested = newProps.suggested;
    community.rules = newProps.rules;
    community.flairs = newProps.flairs;
    if (newProps.settings) community.settings = newProps.settings;
}

export async function initInternalCommunityAfterFirstUpdateNoMerge(
    community: LocalCommunity,
    newProps: InternalCommunityRecordAfterFirstUpdateType
) {
    // Detect CID-ref format posts from DB: wire format always has 'pages' key, CID-ref format doesn't
    if (newProps.posts && !("pages" in newProps.posts)) {
        const dbPosts = newProps.posts as unknown as DbPostsFormat;
        // Extract allPageCids for future unpinning
        const allPageCids: Record<string, string[]> = {};
        for (const [sortName, entry] of Object.entries(dbPosts)) {
            if (entry?.allPageCids?.length) allPageCids[sortName] = entry.allPageCids;
        }
        community._postsAllPageCids = Object.keys(allPageCids).length > 0 ? allPageCids : undefined;
        // Lightweight conversion: just pageCids from allPageCids[0], preloaded pages regenerated on next update.
        // Never use resolveDbPostsCidRefs here — this method is called from many code paths
        // where _dbHandler._db may not be initialized (e.g. updateListener from a mirrored community).
        const pageCids: Record<string, string> = {};
        for (const [sortName, entry] of Object.entries(dbPosts)) {
            if (entry?.allPageCids?.[0]) pageCids[sortName] = entry.allPageCids[0];
        }
        newProps = {
            ...newProps,
            posts: { pages: {}, ...(Object.keys(pageCids).length > 0 ? { pageCids } : {}) } as CommunityIpfsType["posts"]
        };
    }
    const keysOfCommunityIpfs = <(keyof CommunityIpfsType)[]>[...CommunitySignedPropertyNames, "signature"];
    community.initRpcInternalCommunityAfterFirstUpdateNoMerge({
        community: remeda.pick(newProps, keysOfCommunityIpfs) as CommunityIpfsType,
        localCommunity: {
            signer: remeda.pick(newProps.signer as SignerWithPublicKeyAddress, ["publicKey", "address", "shortAddress", "type"]),
            settings: newProps.settings,
            _usingDefaultChallenge: newProps._usingDefaultChallenge,
            address: newProps.address,
            started: community.started,
            startedState: community.startedState
        },
        runtimeFields: { updateCid: newProps.updateCid }
    });
    await initSignerProps(community, newProps.signer);
    community._internalStateUpdateId = newProps._internalStateUpdateId;
    if (Array.isArray(newProps._cidsToUnPin)) newProps._cidsToUnPin.forEach((cid) => community._cidsToUnPin.add(cid));
    if (Array.isArray(newProps._mfsPathsToRemove)) newProps._mfsPathsToRemove.forEach((path) => community._mfsPathsToRemove.add(path));
    community._updateIpnsPubsubPropsIfNeeded(newProps);
    if (processStartedCommunities.has(community)) syncCommunityRegistryEntry(processStartedCommunities, community);
    if (community.updateCid) community.raw.localCommunity = community.toJSONInternalRpcAfterFirstUpdate();
}

export async function initInternalCommunityBeforeFirstUpdateNoMerge(
    community: LocalCommunity,
    newProps: InternalCommunityRecordBeforeFirstUpdateType
) {
    community.initRpcInternalCommunityBeforeFirstUpdateNoMerge({
        localCommunity: {
            ...remeda.omit(newProps, ["signer", "_internalStateUpdateId", "_pendingEditProps"]),
            signer: remeda.pick(newProps.signer as SignerWithPublicKeyAddress, ["publicKey", "address", "shortAddress", "type"]),
            started: community.started,
            startedState: community.startedState
        }
    });
    await initSignerProps(community, newProps.signer);
    community._internalStateUpdateId = newProps._internalStateUpdateId;
    community._updateIpnsPubsubPropsIfNeeded(newProps);
    community.ipnsName = newProps.signer.address;
    community.ipnsPubsubTopic = ipnsNameToIpnsOverPubsubTopic(community.ipnsName);
    community.ipnsPubsubTopicRoutingCid = pubsubTopicToDhtKey(community.ipnsPubsubTopic);
    if (processStartedCommunities.has(community)) syncCommunityRegistryEntry(processStartedCommunities, community);
    community.raw.localCommunity = community.toJSONInternalRpcBeforeFirstUpdate();
}

export async function initDbHandlerIfNeeded(community: LocalCommunity) {
    if (!community._dbHandler) {
        community._dbHandler = new DbHandler(community);
        await community._dbHandler.initDbConfigIfNeeded();
        community._pageGenerator = new PageGenerator(community);
    }
}
