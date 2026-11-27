import { clone, isDeepEqual, isEmpty, omit, pick } from "remeda";
import type { Logger } from "@pkcprotocol/pkc-logger";
import { v4 as uuidV4 } from "uuid";
import { timestamp } from "../../../../util.js";
import { PKCError } from "../../../../pkc-error.js";
import env from "../../../../version.js";
import { STORAGE_KEYS } from "../../../../constants.js";
import { parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails } from "../../../../schema/schema-util.js";
import { closeSync, existsSync, openSync } from "node:fs";
import Database from "better-sqlite3";
import {
    deriveDbPosts,
    resolveDbPostsCidRefs,
    importSignerIntoKuboNode,
    forgetCommunityThatFailedToBeDeleted,
    removeFileRetryingWhileBusy
} from "../../util.js";
import { SignerWithPublicKeyAddress } from "../../../../signer/index.js";
import { getIpfsKeyFromPrivateKey, getPublicKeyFromPrivateKey } from "../../../../signer/util.js";
import { findStartedCommunity } from "../../../../pkc/tracked-instance-registry-util.js";
import { getCommunityChallengeFromCommunityChallengeSettings } from "../challenges/index.js";
import { throwIfChallengeSettingsAreInvalid } from "../challenges/validate-challenge-settings.js";
import { derivePublicPageSorts, resolvePageSortsOrThrow } from "../page-sorts/index.js";
import type {
    CommunityIpfsType,
    CreateNewLocalCommunityParsedOptions,
    InternalCommunityRecordAfterFirstUpdateType,
    InternalCommunityRecordBeforeFirstUpdateType
} from "../../../../community/types.js";
import type { DbPostsFormat } from "../../../../publications/comment/types.js";
import type { LocalCommunity } from "../local-community.js";
import { generateDefaultChallenges, isDefaultChallengeStructure } from "./defaults.js";
import { findProcessStartedCommunity, processStartedCommunities, syncProcessStartedCommunity } from "./registry.js";
import { CommunitySignedPropertyNames } from "../../../../community/schema.js";
import { DbHandler } from "../db-handler.js";
import { getHighestAcceptedAnchorSequence } from "./anchor-publishing.js";
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

    await importSignerIntoKuboNode(
        community.signer.ipnsKeyName,
        community.signer.ipfsKey,
        {
            url: community._pkc.kuboRpcClientsOptions![0].url!.toString(),
            headers: community._pkc.kuboRpcClientsOptions![0].headers
        },
        community._log
    );
}

export function getDbInternalState(
    community: LocalCommunity
): InternalCommunityRecordAfterFirstUpdateType | InternalCommunityRecordBeforeFirstUpdateType {
    const log = community._log;
    if (!community._dbHandler.keyvHas(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY]))
        throw new PKCError("ERR_COMMUNITY_HAS_NO_INTERNAL_STATE", { address: community.address, dataPath: community._pkc.dataPath });
    try {
        const internalState = community._dbHandler.keyvGet(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY]);
        if (!internalState)
            throw new PKCError("ERR_COMMUNITY_HAS_NO_INTERNAL_STATE", { address: community.address, dataPath: community._pkc.dataPath });
        return internalState as InternalCommunityRecordAfterFirstUpdateType | InternalCommunityRecordBeforeFirstUpdateType;
    } catch (e) {
        log.error("_getDbInternalState: Failed to get community", community.address, "internal state from db", e);
        throw e;
    }
}

type InternalStateProps = Partial<InternalCommunityRecordBeforeFirstUpdateType | InternalCommunityRecordAfterFirstUpdateType>;

// The read of the stored record, the merge and the write run as one synchronous write transaction on the community DB
// (see DbHandler.runInWriteTransaction), so no other writer, in this process or another, gets between them. A lock file
// guarded them before, which a killed process left behind (issue #561).
// A writer of the whole record (the publish cycle, stop()) passes a function that builds it, called inside that
// transaction. A record built before it lacked an edit of a started community that stored itself in the meantime, and was
// written over it. The instance it is built from gets such an edit only once edit() resumes after its write, so until
// then the edit's props are in community._editsStoredNotApplied, and are laid over the record built here.
export async function updateDbInternalState(
    community: LocalCommunity,
    propsOrBuildProps: InternalStateProps | (() => InternalStateProps)
): Promise<InternalCommunityRecordBeforeFirstUpdateType | InternalCommunityRecordAfterFirstUpdateType> {
    const log = community._log;
    if (typeof propsOrBuildProps !== "function" && isEmpty(propsOrBuildProps))
        throw Error("props to update DB internal state should not be empty");
    await community._dbHandler.initDbIfNeeded();

    let props: InternalStateProps = typeof propsOrBuildProps === "function" ? {} : propsOrBuildProps;
    try {
        const internalStateUpdateId = uuidV4();
        const mergedInternalState = community._dbHandler.runInWriteTransaction(() => {
            if (typeof propsOrBuildProps === "function")
                props = Object.assign(propsOrBuildProps(), ...community._editsStoredNotApplied) as InternalStateProps;
            props._internalStateUpdateId = internalStateUpdateId;
            const internalStateBefore = community._getDbInternalState(); // through the method, which tests patch
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
            const merged = { ...internalStateBefore, ...propsToStore };
            community._dbHandler.keyvSet(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY], merged);
            return merged;
        });
        community._internalStateUpdateId = internalStateUpdateId;
        log.trace(
            "_updateDbInternalState: Updated community",
            community.address,
            "internal state in db with new props",
            Object.keys(props)
        );
        if (community.updateCid && community.raw.communityIpfs) {
            community.raw.localCommunity = community.toJSONInternalRpcAfterFirstUpdate();
        } else if (community.settings) {
            community.raw.localCommunity = community.toJSONInternalRpcBeforeFirstUpdate();
        }
        return mergedInternalState as InternalCommunityRecordBeforeFirstUpdateType | InternalCommunityRecordAfterFirstUpdateType;
    } catch (e) {
        log.error(
            "_updateDbInternalState: Failed to update community",
            community.address,
            "internal state in db with new props",
            Object.keys(props),
            e
        );
        throw e;
    }
}

export async function updateInstanceStateWithDbState(community: LocalCommunity) {
    const currentDbState = community._getDbInternalState();

    if ("updatedAt" in currentDbState) {
        // Resolve CID-ref posts from DB back to full wire format with preloaded pages.
        // DB stores posts in compact CID-ref format (no preloaded page data).
        // _dbHandler is guaranteed to be initialized here since we're loading from DB.
        if (currentDbState.posts && !("pages" in currentDbState.posts)) {
            if (community._dbHandler.hasCommentsAndCommentUpdatesTables()) {
                const dbPosts = currentDbState.posts as unknown as DbPostsFormat;
                currentDbState.posts = resolveDbPostsCidRefs({ dbPosts, dbHandler: community._dbHandler }) as typeof currentDbState.posts;
            } else {
                // A killed migration left the DB without a table the posts are read from. Throwing here would fail
                // pkc.createCommunity({ address }), and with it the only way to the start() that finishes the migration
                // and restores the table. So the community loads without its posts, and start() loads them again once
                // the tables are back.
                community._log.error(
                    `updateInstanceStateWithDbState: The DB of community (${community.address}) is missing its comments or commentUpdates table, most likely after an interrupted migration. Loading it without posts, start() will restore them`
                );
                delete currentDbState.posts;
            }
        }
        await community.initInternalCommunityAfterFirstUpdateNoMerge(currentDbState);
    } else await community.initInternalCommunityBeforeFirstUpdateNoMerge(currentDbState);

    // Both NoMerge helpers replay the internal record through the RPC init path, which assigns
    // anchorRecordSequence from that record — and the internal record deliberately omits it, since
    // publishAnchorRecord owns its own keyv slot. So the replay always clears the live value, and every
    // caller of this function (start() included) has to put it back from the slot that owns it.
    // Without this, start() leaves anchorRecordSequence undefined on a community whose anchor record
    // has been published, which is how it reaches an RPC client.
    community.anchorRecordSequence = getHighestAcceptedAnchorSequence(community)?.toString();
}

export async function updateInstancePropsWithStartedCommunityOrDb(community: LocalCommunity) {
    // if it's started in the same pkc instance, we will load it from the started community instance
    // if it's started in another process, we will throw an error
    // if community is not started, load the InternalCommunity props from the local db

    const log = community._log;
    const startedCommunity = <LocalCommunity | undefined>(
        (findStartedCommunity(community._pkc, { publicKey: community.publicKey, name: community.name }) ||
            findProcessStartedCommunity(community))
    );
    if (startedCommunity) {
        log("_updateInstancePropsWithStartedCommunityOrDb: Loading local community", community.address, "from started community instance");
        if (startedCommunity.updatedAt)
            await community.initInternalCommunityAfterFirstUpdateNoMerge(startedCommunity.toJSONInternalAfterFirstUpdate());
        else await community.initInternalCommunityBeforeFirstUpdateNoMerge(startedCommunity.toJSONInternalBeforeFirstUpdate());
        community.started = true;
        // Read exports from the matched started instance, which is in-process and already holds
        // the live (writer) DB connection with its exports loaded. Do NOT open a second connection
        // to the same DB file here: it races with a concurrent stop()/edit() that is tearing the
        // file down and throws "unable to open database file" on Windows/macOS (see the
        // edit.community concurrency tests). The started instance is the canonical writer, so its
        // in-memory exports are the freshest view of the keyv-persisted records.
        community._exports = startedCommunity.exports;
        community.anchorRecordSequence = startedCommunity.anchorRecordSequence;
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

            await community._loadExportsFromKeyv(); // Load community.exports from DB
            // anchorRecordSequence is re-derived inside updateInstanceStateWithDbState above, from the
            // keyv slot publishAnchorRecord owns. Absent on a delegated community means no anchor
            // record has ever been accepted for it.
            await community._updateStartedValue();
            log("_updateInstancePropsWithStartedCommunityOrDb: Loaded local community", community.address, "from db");
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
                    "_updateInstancePropsWithStartedCommunityOrDb: Local community",
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

        if (!isDeepEqual(community.settings?.challenges, community._defaultCommunityChallenges)) {
            await community.edit({ settings: { ...community.settings, challenges: community._defaultCommunityChallenges } });
            // edit() recalculates _usingDefaultChallenge via _isDefaultChallengeStructure,
            // which may return false for non-standard defaults (e.g. []).
            // Re-assert true since we know this is still a default-driven upgrade.
            community._usingDefaultChallenge = true;
            log(
                `_updateInstancePropsWithStartedCommunityOrDb: Upgraded default challenge for community (${community.address})`,
                community._defaultCommunityChallenges[0]?.options?.answer
                    ? `with answer: ${community._defaultCommunityChallenges[0].options!.answer}`
                    : `to ${community._defaultCommunityChallenges.length} challenge(s)`
            );
        }
    }
}

// Whether the DB file holds a community's internal state: true, false, or undefined when the file could not be read
// well enough to tell (locked by another connection, an I/O error). A file that is missing, is not a database or has
// no keyv table holds none
function doesDbFileHoldInternalState({
    dbFilePath,
    internalStateKey,
    log
}: {
    dbFilePath: string;
    internalStateKey: string;
    log: Logger;
}): boolean | undefined {
    if (!existsSync(dbFilePath)) return false;
    let db: Database.Database | undefined;
    try {
        db = new Database(dbFilePath, { readonly: true, fileMustExist: true });
        return db.prepare("SELECT 1 FROM keyv WHERE key = ?").get(`keyv:${internalStateKey}`) !== undefined;
    } catch (e) {
        const code = (e as { code?: unknown }).code;
        if (typeof code === "string" && ["SQLITE_NOTADB", "SQLITE_ERROR"].includes(code)) return false;
        log.error(
            `doesDbFileHoldInternalState: Failed to tell whether ${dbFilePath} holds an internal state, leaving the file in place`,
            e
        );
        return undefined;
    } finally {
        db?.close();
    }
}

export async function createNewLocalCommunityDb(community: LocalCommunity) {
    // We're creating a totally new community here with a new db
    // This function should be called only once per community
    const log = community._log;
    await initSignerProps(community, community.signer); // init this.encryption as well

    // A read-only community gets no backfilled topic: absence of pubsubTopic on the wire is what tells
    // readers the challenge exchange is disabled (issue #229). An explicit custom topic is left alone
    // so it survives a disable/enable cycle.
    if (!community.pubsubTopic && !community.settings?.disablePubsubChallengeExchange)
        community.pubsubTopic = clone(community.signer.address);
    if (typeof community.createdAt !== "number") community.createdAt = timestamp();
    if (!community.protocolVersion) community.protocolVersion = env.PROTOCOL_VERSION;
    if (!community.settings?.maxPendingApprovalCount) community.settings = { ...community.settings, maxPendingApprovalCount: 500 };
    if (!community.settings?.challenges) {
        community.settings = { ...community.settings, challenges: community._defaultCommunityChallenges };
        community._usingDefaultChallenge = true;
        log(
            `_createNewLocalCommunityDb: Generated default challenge for community (${community.address}) with answer:`,
            community._defaultCommunityChallenges[0].options!.answer
        );
    }
    if (typeof community.settings?.purgeDisapprovedCommentsOlderThan !== "number") {
        community.settings = { ...community.settings, purgeDisapprovedCommentsOlderThan: 1.21e6 }; // two weeks
    }

    // Creation can throw: the DB file is only created further down, after every check that can refuse the settings,
    // so a refused creation leaves nothing on disk (issue #540).
    await throwIfChallengeSettingsAreInvalid({
        challengeSettings: community.settings.challenges!,
        pkc: community._pkc,
        communityAddress: community.address
    });

    community.challenges = await Promise.all(
        community.settings.challenges!.map(
            async (cs, challengeIndex) =>
                (
                    await getCommunityChallengeFromCommunityChallengeSettings({
                        communityChallengeSettings: cs,
                        challengeIndex,
                        pkc: community._pkc
                    })
                ).communityChallenge
        )
    );

    // settings.pages is validated the same way: an invalid entry refuses creation before the DB file is created
    community._pageSorts = await resolvePageSortsOrThrow({
        pagesSettings: community.settings.pages,
        pkc: community._pkc,
        communityAddress: community.address,
        log: community._log
    });
    community.pageSorts = derivePublicPageSorts({ pagesSettings: community.settings.pages, resolved: community._pageSorts });

    // The settings are valid, so the DB can be created. A DB with its tables and no internal state is not a community:
    // it is left out of pkc.communities and nothing would ever remove it. So if a step fails before the internal state
    // is written, the connection is closed and the file is removed, but only a file this call created. Nothing
    // serializes two creations of the same community, in this process or across processes, so "this call created it"
    // is decided by creating the file exclusively: one caller wins, and a file that was already there, or that another
    // call created a moment ago, belongs to someone else and is left alone.
    await community.initDbHandlerIfNeeded();
    // A failed deletion of this address may still be queued for the next start, which would delete the new DB
    await forgetCommunityThatFailedToBeDeleted({ communityAddress: community.address, pkc: community._pkc, log: community._log });
    await community._dbHandler.initDbConfigIfNeeded();
    const dbFilePath = community._dbHandler.getDbConfig().filename;
    let createdDbFile = false;
    if (dbFilePath !== ":memory:")
        try {
            closeSync(openSync(dbFilePath, "wx")); // an empty file is an empty SQLite DB
            createdDbFile = true;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
    const internalStateKey = STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY];
    try {
        await community._dbHandler.initDbIfNeeded({ fileMustExist: false });
        await community._dbHandler.createOrMigrateTablesIfNeeded();

        if (community._dbHandler.keyvHas(internalStateKey)) throw Error("Internal state exists already");

        await community._dbHandler.keyvSet(internalStateKey, community.toJSONInternalBeforeFirstUpdate());
    } catch (e) {
        try {
            community._dbHandler.destoryConnection();
        } catch (closeError) {
            log.error(
                `_createNewLocalCommunityDb: Failed to close the DB of community (${community.address}) after its creation failed`,
                closeError
            );
        }
        // Another call may have written its internal state into the file this one created. Then it is a community and
        // stays. The file is read for that, not the connection, which a failed table creation has closed already. The
        // file is removed only when it is known to hold no internal state, which is asked again before every attempt:
        // a file that stays busy for a while on Windows may be busy because another creator is writing its state
        const isNotKnownToBeStateless = () => doesDbFileHoldInternalState({ dbFilePath, internalStateKey, log }) !== false;
        if (createdDbFile)
            for (const filePath of [dbFilePath, `${dbFilePath}-wal`, `${dbFilePath}-shm`])
                await removeFileRetryingWhileBusy(filePath, { log, keepIf: isNotKnownToBeStateless }).catch((removeError) =>
                    log.error(
                        `_createNewLocalCommunityDb: Failed to remove ${filePath} after the creation of community (${community.address}) failed`,
                        removeError
                    )
                );
        throw e;
    }

    // The internal state is written, so the community exists from here on: a failure below closes the connection and
    // keeps the DB
    try {
        await community._updateStartedValue();
    } catch (e) {
        community._dbHandler.destoryConnection();
        throw e;
    }

    community._dbHandler.destoryConnection(); // Need to destory connection so process wouldn't hang
    community._updateIpnsPubsubPropsIfNeeded({
        ...community.toJSONInternalBeforeFirstUpdate(), //@ts-expect-error
        signature: { publicKey: community.signer.publicKey }
    });
}

export async function initNewLocalCommunityPropsNoMerge(community: LocalCommunity, newProps: CreateNewLocalCommunityParsedOptions) {
    await initSignerProps(community, newProps.signer);
    // A delegated community is identified by its anchor (An) while it signs with the minter we just
    // initialized above. Replaying the chain into ipnsHops is what makes the inherited identity code
    // report the anchor as publicKey. See docs/protocol/delegated-ipns.md.
    community.anchor = newProps.anchor;
    if (newProps.anchor) community.ipnsHops = [newProps.anchor.publicKey, community.signer.address];
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
        community: pick(newProps, keysOfCommunityIpfs) as CommunityIpfsType,
        localCommunity: {
            signer: pick(newProps.signer as SignerWithPublicKeyAddress, ["publicKey", "address", "shortAddress", "type"]),
            anchor: newProps.anchor,
            settings: newProps.settings,
            _usingDefaultChallenge: newProps._usingDefaultChallenge,
            address: newProps.address,
            started: community.started,
            startedState: community.startedState
        },
        runtimeFields: { updateCid: newProps.updateCid }
    });
    // The community half above overwrites pubsubTopic from the published record, which carries no topic
    // while the challenge exchange is disabled (issue #229). Restore the configured one so a disabled
    // community keeps the topic it will publish again when the setting is turned off. Only when the
    // record has no topic: a published topic is the authority, and this state can be a row read that
    // predates the latest publish, which must not drag the instance back to a superseded topic. Older
    // rows have no _configuredPubsubTopic and fall back to whatever the record said, as they meant.
    if (!newProps.pubsubTopic && newProps._configuredPubsubTopic) community.pubsubTopic = newProps._configuredPubsubTopic;
    await initSignerProps(community, newProps.signer);
    community._internalStateUpdateId = newProps._internalStateUpdateId;
    if (Array.isArray(newProps._cidsToUnPin)) newProps._cidsToUnPin.forEach((cid) => community._cidsToUnPin.add(cid));
    if (Array.isArray(newProps._mfsPathsToRemove)) newProps._mfsPathsToRemove.forEach((path) => community._mfsPathsToRemove.add(path));
    community._updateIpnsPubsubPropsIfNeeded(newProps);
    if (processStartedCommunities.has(community)) syncProcessStartedCommunity(community);
    if (community.updateCid) community.raw.localCommunity = community.toJSONInternalRpcAfterFirstUpdate();
}

export async function initInternalCommunityBeforeFirstUpdateNoMerge(
    community: LocalCommunity,
    newProps: InternalCommunityRecordBeforeFirstUpdateType
) {
    community.initRpcInternalCommunityBeforeFirstUpdateNoMerge({
        localCommunity: {
            ...omit(newProps, ["signer", "_internalStateUpdateId", "_pendingEditProps"]),
            signer: pick(newProps.signer as SignerWithPublicKeyAddress, ["publicKey", "address", "shortAddress", "type"]),
            started: community.started,
            startedState: community.startedState
        }
    });
    await initSignerProps(community, newProps.signer);
    community._internalStateUpdateId = newProps._internalStateUpdateId;
    // LocalCommunity's override always derives these from signer.address, so the explicit
    // minter-based assignment that used to follow this call is no longer needed here.
    community._updateIpnsPubsubPropsIfNeeded(newProps);
    if (processStartedCommunities.has(community)) syncProcessStartedCommunity(community);
    community.raw.localCommunity = community.toJSONInternalRpcBeforeFirstUpdate();
}

export async function initDbHandlerIfNeeded(community: LocalCommunity) {
    if (!community._dbHandler) {
        community._dbHandler = new DbHandler(community);
        await community._dbHandler.initDbConfigIfNeeded();
        community._pageGenerator = new PageGenerator(community);
    }
}
