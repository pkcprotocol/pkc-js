import fs from "node:fs";
import path from "node:path";
import Logger from "../../../../logger.js";
import { clone, keys, omit, omitBy, pick } from "remeda";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { sha256 } from "js-sha256";
import { doesDomainAddressHaveCapitalLetter, isStringDomain } from "../../../../util.js";
import { PKCError } from "../../../../pkc-error.js";
import { parseCommunityEditOptionsSchemaWithPKCErrorIfItFails } from "../../../../schema/schema-util.js";
import { findStartedCommunity, trackStartedCommunity } from "../../../../pkc/tracked-instance-registry-util.js";
import { getCommunityChallengeFromCommunityChallengeSettings } from "../challenges/index.js";
import { throwIfChallengeSettingsAreInvalid } from "../challenges/validate-challenge-settings.js";
import { derivePublicPageSorts, lookupPageSortFactories, resolvePageSortsOrThrow, type ResolvedPageSorts } from "../page-sorts/index.js";
import type {
    CommunityEditOptions,
    CommunityIpfsType,
    InternalCommunityRecordAfterFirstUpdateType,
    PageSortFileFactoryInput,
    ParsedCommunityEditOptions
} from "../../../../community/types.js";
import type { LocalCommunity } from "../local-community.js";
import { isDefaultChallengeStructure } from "./defaults.js";
import { findProcessStartedCommunity, processStartedCommunities, syncProcessStartedCommunity } from "./registry.js";
import { updateDbInternalState, updateInstancePropsWithStartedCommunityOrDb } from "./db-state.js";
import { setResolvedPageSorts } from "./registry-sync.js";
import { communityIdentityPublicKey } from "./identity.js";
import { refreshCommunitiesList, removeFileRetryingWhileBusy } from "../../util.js";
import { findCommunitiesEntry } from "../../../../community/communities-entry-util.js";

export async function movePostUpdatesFolderToNewAddress(community: LocalCommunity, oldAddress: string, newAddress: string) {
    const log = Logger("pkc-js:local-community:_movePostUpdatesFolderToNewAddress");
    const kuboRpc = community._clientsManager.getDefaultKuboRpcClient();
    try {
        await kuboRpc._client.files.mv(`/${oldAddress}`, `/${newAddress}`); // Could throw
    } catch (e) {
        if (e instanceof Error && e.message !== "file does not exist") {
            log.error("Failed to move directory of post updates in MFS", community.address, e);
            throw e; // A critical error
        }
    }
}

export async function parseRolesToEdit(
    community: LocalCommunity,
    newRawRoles: NonNullable<CommunityEditOptions["roles"]>
): Promise<NonNullable<InternalCommunityRecordAfterFirstUpdateType["roles"]>> {
    for (const [roleAddress, roleValue] of Object.entries(newRawRoles)) {
        if (roleValue === undefined || roleValue === null) continue; // skip removals
        // Use community._clientsManager (not community._pkc) so nameResolver state changes emit on the community's clients
        if (isStringDomain(roleAddress)) {
            let resolved: string | null;
            // Kept so the owner learns which of the four things went wrong. The code stays
            // ERR_ROLE_ADDRESS_NAME_COULD_NOT_BE_RESOLVED, which is already the right classification for an
            // owner-facing edit; what was missing is the cause, not the classification. Issue #353.
            let resolveError: unknown;
            try {
                ({ resolvedAuthorName: resolved } = await community._clientsManager.resolveAuthorNameIfNeeded({
                    authorName: roleAddress,
                    abortSignal: AbortSignal.timeout(community._pkc._timeouts["resolve-author-name"]),
                    // Role edits must apply to current state — bypass cache.
                    cache: { maxAge: 0 }
                }));
            } catch (e) {
                resolved = null;
                resolveError = e;
            }
            if (!resolved) throw new PKCError("ERR_ROLE_ADDRESS_NAME_COULD_NOT_BE_RESOLVED", { roleAddress, resolveError });
        }
    }
    return <NonNullable<CommunityIpfsType["roles"]>>omitBy(newRawRoles, (val, key) => val === undefined || val === null);
}

export async function parseChallengesToEdit(
    community: LocalCommunity,
    newChallengeSettings: NonNullable<NonNullable<CommunityEditOptions["settings"]>["challenges"]>
): Promise<NonNullable<Pick<InternalCommunityRecordAfterFirstUpdateType, "challenges" | "_usingDefaultChallenge">>> {
    // A dedicated pass first, before anything below is derived or persisted, so an invalid edit is rejected
    // whole. Failures are aggregated across every challenge rather than thrown one at a time.
    await throwIfChallengeSettingsAreInvalid({
        challengeSettings: newChallengeSettings,
        pkc: community._pkc,
        communityAddress: community.address
    });
    return {
        challenges: await Promise.all(
            newChallengeSettings.map(
                async (cs, challengeIndex) =>
                    (
                        await getCommunityChallengeFromCommunityChallengeSettings({
                            communityChallengeSettings: cs,
                            challengeIndex,
                            pkc: community._pkc
                        })
                    ).communityChallenge
            )
        ),
        _usingDefaultChallenge: isDefaultChallengeStructure(newChallengeSettings)
    };
}

// settings.pages: validate the new entries against their files (rejecting the whole edit on failure, like
// challenges) and derive the public community.pageSorts for the record. Pure, like parseRolesToEdit: nothing on the
// instance or in the DB changes here, because the edit may still be rejected (address validation runs later) and
// must be atomic. The side effects live in applyPagesEdit, called once the edit is persisted.
export type PagesEdit = {
    pageSorts: InternalCommunityRecordAfterFirstUpdateType["pageSorts"];
    resolved: ResolvedPageSorts;
    factories: (PageSortFileFactoryInput | undefined)[]; // the registry snapshot taken before resolving (issue #411)
    pagesChanged: boolean;
};

export async function parsePagesToEdit(
    community: LocalCommunity,
    newSettings: NonNullable<CommunityEditOptions["settings"]>
): Promise<PagesEdit> {
    await community._dbHandler.initDbIfNeeded();
    const factories = lookupPageSortFactories({ pagesSettings: newSettings.pages, pkc: community._pkc });
    const resolved = await resolvePageSortsOrThrow({
        pagesSettings: newSettings.pages,
        pkc: community._pkc,
        communityAddress: community.address
    });
    const pagesChanged = deterministicStringify(community.settings?.pages ?? null) !== deterministicStringify(newSettings.pages ?? null);
    return { pageSorts: derivePublicPageSorts({ pagesSettings: newSettings.pages, resolved }), resolved, factories, pagesChanged };
}

// Apply a persisted settings.pages edit to the running instance. Any change to settings.pages, however small,
// regenerates every CommentUpdate: reply pages are only rebuilt for flagged comments, so without this an untouched
// comment would carry its old reply sorts indefinitely. Runs after any restart of the community, since start()
// resolves whatever settings were persisted at that moment. Needs an open DB. Also records the factories and the
// fingerprint, so the registry sync (issue #411) does not take an edit for a registry change.
async function applyPagesEdit(community: LocalCommunity, pagesEdit: PagesEdit | undefined): Promise<void> {
    if (!pagesEdit) return;
    if (pagesEdit.pagesChanged) community._dbHandler.forceUpdateOnAllComments();
    await setResolvedPageSorts(community, pagesEdit.resolved, pagesEdit.factories);
}

export async function validateNewAddressBeforeEditing(community: LocalCommunity, newAddress: string, log: Logger) {
    if (doesDomainAddressHaveCapitalLetter(newAddress))
        throw new PKCError("ERR_COMMUNITY_NAME_HAS_CAPITAL_LETTER", { communityAddress: newAddress });
    // Check if any other community already has the new address as its name (exact or .eth/.bso alias) or its key. This
    // community's own entry is skipped by its key, which unlike its address does not change with the edit. Not
    // community.publicKey: that is undefined on a domain-addressed community that has not published a record yet
    const existingEquivalent = findCommunitiesEntry(
        community._pkc.communities.filter((entry) => entry.publicKey !== communityIdentityPublicKey(community)),
        { address: newAddress }
    );
    if (existingEquivalent)
        throw new PKCError("ERR_COMMUNITY_OWNER_ATTEMPTED_EDIT_NEW_ADDRESS_THAT_ALREADY_EXISTS", {
            currentCommunityAddress: community.address,
            newCommunityAddress: newAddress,
            currentSubs: community._pkc.communities
        });
    community._assertDomainResolvesCorrectly(newAddress).catch((err: PKCError) => {
        log.error(err);
        community.emit("error", err);
    });
}

// A community's address is its name when it has one, else its identity key, so an edit of either is one move: the
// DB file, the start lock and the MFS postUpdates folder follow the new address, and the page rule filters by it
// (issue #430). Normalizes the edit so both are set: { name: M } and { address: M } become { name: M, address: M } for
// a domain M; { name: undefined } and { address: <identity key> } drop the name and return the address to the key.
// Both given and naming different addresses is rejected rather than guessing which one the owner meant.
export function deriveNameAndAddressEdit<T extends Pick<ParsedCommunityEditOptions, "name" | "address">>(
    community: LocalCommunity,
    editOptions: T
): T {
    const hasName = "name" in editOptions;
    const hasAddress = typeof editOptions.address === "string";
    if (!hasName && !hasAddress) return editOptions;
    const addressFromName = hasName ? editOptions.name ?? communityIdentityPublicKey(community) : undefined;
    if (hasAddress && hasName && editOptions.address !== addressFromName)
        throw new PKCError("ERR_COMMUNITY_EDIT_NAME_AND_ADDRESS_MISMATCH", {
            name: editOptions.name,
            address: editOptions.address,
            communityAddress: community.address
        });
    const address = hasAddress ? editOptions.address! : addressFromName!;
    return { ...editOptions, address, name: isStringDomain(address) ? address : undefined };
}

// Lists the new address now, not when the filesystem watcher fires (issue #430). The DB still holds the old name at
// this point, which is fine: pkc.communities takes a community's name from its DB's filename (issue #455)
function listRenamedCommunityNow(community: LocalCommunity) {
    refreshCommunitiesList(community._pkc);
}

// Moves the postUpdates folder back under the old address after the DB rename that follows the move failed (issue
// #469). Resolves to the error when the folder can't be moved back; the caller reports it, since edit() rejects with the
// rename's own error.
async function movePostUpdatesFolderBack({
    community,
    oldAddress,
    newAddress,
    log
}: {
    community: LocalCommunity;
    oldAddress: string;
    newAddress: string;
    log: Logger;
}): Promise<Error | undefined> {
    try {
        await movePostUpdatesFolderToNewAddress(community, newAddress, oldAddress);
        return undefined;
    } catch (moveBackError) {
        log.error(`Failed to move the postUpdates folder of community (${oldAddress}) back from ${newAddress}`, moveBackError);
        return moveBackError as Error;
    }
}

// Restarts a started community under its old address after its rename failed (issue #469). edit() rejects with the
// rename's own error, so a failure here is emitted as an error event instead.
async function restartCommunityAfterFailedRename({
    community,
    oldAddress,
    newAddress,
    log
}: {
    community: LocalCommunity;
    oldAddress: string;
    newAddress: string;
    log: Logger;
}) {
    try {
        await community.start();
    } catch (restartError) {
        log.error(`Failed to restart community (${oldAddress}) after its rename to ${newAddress} failed`, restartError);
        community.emit("error", restartError as Error);
    }
}

// A DB backup that failed partway leaves a partial DB file at the new address, which lookups by filename would still
// match. Only removed while the old DB is still there, so a failure after the old one was deleted never loses the DB.
// On Windows the file can be busy for a moment, held by a reader of the communities directory that opened it, so the
// removal is retried (issue #514). A file that stays busy is left where it is and named in the error edit() rejects
// with. It is not recorded for a later delete: after a rename that succeeds on another attempt, that path holds the
// community's real DB.
async function removePartialDbCopy({
    community,
    oldAddress,
    newAddress,
    log
}: {
    community: LocalCommunity;
    oldAddress: string;
    newAddress: string;
    log: Logger;
}): Promise<{ removed: true } | { removed: false; path: string; error?: Error }> {
    const communitiesPath = path.join(community._pkc.dataPath!, "communities");
    const partialDbCopyPath = path.join(communitiesPath, newAddress);
    if (!fs.existsSync(path.join(communitiesPath, oldAddress))) return { removed: false, path: partialDbCopyPath };
    try {
        await removeFileRetryingWhileBusy(partialDbCopyPath, { log });
        return { removed: true };
    } catch (e) {
        log.error(`Failed to remove the partial DB copy of community (${oldAddress}) at ${partialDbCopyPath}`, e);
        return { removed: false, path: partialDbCopyPath, error: e as Error };
    }
}

// The cleanup after the DB rename failed, shared by a started and a not started community: removes the partial DB file,
// moves the postUpdates folder back, and builds the error edit() rejects with. It carries the rename's own error and
// what could and could not be undone, so whoever runs the community can tell why the rename failed and what is left.
async function undoRenameAfterDbRenameFailed({
    community,
    oldAddress,
    newAddress,
    dbRenameError,
    log
}: {
    community: LocalCommunity;
    oldAddress: string;
    newAddress: string;
    dbRenameError: unknown;
    log: Logger;
}): Promise<{ error: PKCError; moveBackError: Error | undefined }> {
    const communitiesPath = path.join(community._pkc.dataPath!, "communities");
    const partialDbCopy = await removePartialDbCopy({ community, oldAddress, newAddress, log });
    const moveBackError = await movePostUpdatesFolderBack({ community, oldAddress, newAddress, log });
    const renameError = dbRenameError as Partial<NodeJS.ErrnoException> | undefined;
    const error = new PKCError("ERR_FAILED_TO_RENAME_COMMUNITY_DB", {
        oldAddress,
        newAddress,
        oldDbPath: path.join(communitiesPath, oldAddress),
        newDbPath: path.join(communitiesPath, newAddress),
        error: dbRenameError,
        errorMessage: renameError?.message,
        errorName: renameError?.name,
        errorCode: renameError?.code,
        partialDbCopyRemoved: partialDbCopy.removed,
        ...(partialDbCopy.removed ? {} : { partialDbCopyPath: partialDbCopy.path, partialDbCopyRemovalError: partialDbCopy.error }),
        postUpdatesFolderMovedBack: moveBackError === undefined,
        ...(moveBackError ? { postUpdatesFolderMoveBackError: moveBackError } : {})
    });
    return { error, moveBackError };
}

export async function editPropsOnStartedCommunity(
    community: LocalCommunity,
    parsedEditOptions: ParsedCommunityEditOptions,
    pagesEdit?: PagesEdit
): Promise<LocalCommunity> {
    // 'community' is the started community with state="started"
    // community._pkc._startedCommunities[community.address] === community
    const log = Logger("pkc-js:local-community:start:editPropsOnStartedCommunity");
    const oldAddress = clone(community.address);
    const uniqueEditId = sha256(deterministicStringify(parsedEditOptions));
    if (typeof parsedEditOptions.address === "string" && community.address !== parsedEditOptions.address) {
        const newAddress = parsedEditOptions.address;
        await validateNewAddressBeforeEditing(community, newAddress, log);

        // The whole rename happens while the community is stopped, so its publish loop never runs a cycle on a
        // half-renamed community (issue #469). start() reloads the internal state from the DB, so the new address has to
        // be stored there first: before, the restarted loop ran under the old address while the postUpdates folder moved
        // under it, failing the cycle or silently leaving the posts' new CommentUpdates in a stale /<old address> folder.
        log(`Attempting to edit community.address from ${oldAddress} to ${newAddress}. We will stop community first`);
        await community.stop();
        // Moved before anything else changes, so a failed move leaves the community as it was
        try {
            await movePostUpdatesFolderToNewAddress(community, oldAddress, newAddress);
        } catch (e) {
            await restartCommunityAfterFailedRename({ community, oldAddress, newAddress, log });
            throw e;
        }
        try {
            await community._dbHandler.changeDbFilename(oldAddress, newAddress);
        } catch (e) {
            const { error, moveBackError } = await undoRenameAfterDbRenameFailed({
                community,
                oldAddress,
                newAddress,
                dbRenameError: e,
                log
            });
            // A folder that can't be moved back leaves the community stopped, since starting it would publish without
            // its postUpdates
            if (moveBackError) community.emit("error", moveBackError);
            else await restartCommunityAfterFailedRename({ community, oldAddress, newAddress, log });
            throw error;
        }
        listRenamedCommunityNow(community);
        community.setAddress(newAddress);
        await community._dbHandler.initDbIfNeeded();
        await updateDbInternalState(community, { ...parsedEditOptions }); // a copy: it sets _internalStateUpdateId on what it gets
        // queued before start() so the restarted loop's first record already carries the edit
        community._pendingEditProps.push({ ...parsedEditOptions, editId: uniqueEditId });
        await community.start();
    } else community._pendingEditProps.push({ ...parsedEditOptions, editId: uniqueEditId });

    if (community.updateCid)
        await community.initInternalCommunityAfterFirstUpdateNoMerge({
            ...community.toJSONInternalAfterFirstUpdate(),
            ...parsedEditOptions,
            _internalStateUpdateId: uniqueEditId
        });
    else
        await community.initInternalCommunityBeforeFirstUpdateNoMerge({
            ...community.toJSONInternalBeforeFirstUpdate(),
            ...parsedEditOptions,
            _internalStateUpdateId: uniqueEditId
        });
    await applyPagesEdit(community, pagesEdit);
    community._communityUpdateTrigger = true;
    log(
        `Community (${community.address}) props (${keys(parsedEditOptions)}) has been edited. Will be including edited props in next update: `,
        pick(community, keys(parsedEditOptions))
    );
    community.emit("update", community);
    if (community.address !== oldAddress) {
        trackStartedCommunity(community._pkc, community);
        syncProcessStartedCommunity(community);
    }
    return community;
}

export async function editPropsOnNotStartedCommunity(
    community: LocalCommunity,
    parsedEditOptions: ParsedCommunityEditOptions,
    pagesEdit?: PagesEdit
): Promise<LocalCommunity> {
    // sceneario 3, the community is not running anywhere, we need to edit the db and update this instance
    const log = Logger("pkc-js:local-community:edit:editPropsOnNotStartedCommunity");
    const oldAddress = clone(community.address);
    await community.initDbHandlerIfNeeded();
    await community._dbHandler.initDbIfNeeded();
    if (typeof parsedEditOptions.address === "string" && community.address !== parsedEditOptions.address) {
        await validateNewAddressBeforeEditing(community, parsedEditOptions.address, log);

        log(`Attempting to edit community.address from ${oldAddress} to ${parsedEditOptions.address}`);

        // in this sceneario we're editing a community that's not started anywhere
        log("will rename the community", community.address, "db in edit() because the community is not being ran anywhere else");
        const newAddress = parsedEditOptions.address;
        await movePostUpdatesFolderToNewAddress(community, oldAddress, newAddress);
        await community._dbHandler.destoryConnection();
        try {
            await community._dbHandler.changeDbFilename(oldAddress, newAddress);
        } catch (e) {
            // The same undo a started community gets, so a failed rename leaves this one as it was: its DB and its
            // postUpdates folder under the old address, and no partial DB file at the new one
            throw (await undoRenameAfterDbRenameFailed({ community, oldAddress, newAddress, dbRenameError: e, log })).error;
        }
        listRenamedCommunityNow(community);
        await community._dbHandler.initDbIfNeeded();
        community.setAddress(parsedEditOptions.address);
    }
    const mergedInternalState = await updateDbInternalState(community, parsedEditOptions);

    if ("updatedAt" in mergedInternalState && mergedInternalState.updatedAt)
        await community.initInternalCommunityAfterFirstUpdateNoMerge(mergedInternalState);
    else await community.initInternalCommunityBeforeFirstUpdateNoMerge(mergedInternalState);
    await applyPagesEdit(community, pagesEdit);
    await community._dbHandler.destoryConnection();
    community.emit("update", community);
    return community;
}

export async function edit(community: LocalCommunity, newCommunityOptions: CommunityEditOptions): Promise<LocalCommunity> {
    // scenearios
    // 1 - calling edit() on a community instance that's not running, but the it's started in pkc._startedCommunities (should edit the started community)
    // 2 - calling edit() on a community that's started in another process (should throw)
    // 3 - calling edit() on a community that's not started (should load db and edit it)
    // 4 - calling edit() on the community that's started (should edit the started community)

    const startedCommunity = <LocalCommunity | undefined>(
        (findStartedCommunity(community._pkc, { publicKey: community.publicKey, name: community.name }) ||
            findProcessStartedCommunity(community))
    );
    if (startedCommunity && community.state !== "started") {
        // sceneario 1
        const editRes = await startedCommunity.edit(newCommunityOptions);

        community.setAddress(editRes.address); // need to force an update of the address for this instance
        await updateInstancePropsWithStartedCommunityOrDb(community);
        return community;
    }

    await community.initDbHandlerIfNeeded();
    await community._updateStartedValue();
    if (community.started && community.state !== "started") {
        // sceneario 2
        community._dbHandler.destoryConnection();
        throw new PKCError("ERR_CAN_NOT_EDIT_A_LOCAL_COMMUNITY_THAT_IS_ALREADY_STARTED_IN_ANOTHER_PROCESS", {
            address: community.address,
            dataPath: community._pkc.dataPath
        });
    }

    const parsedEditOptions = parseCommunityEditOptionsSchemaWithPKCErrorIfItFails(newCommunityOptions);

    const editWithDerivedName = deriveNameAndAddressEdit(community, parsedEditOptions);

    // settings is replaced wholesale, so an edit carrying settings without `pages` unsets it too
    const pagesEdit = editWithDerivedName?.settings ? await parsePagesToEdit(community, editWithDerivedName.settings) : undefined;
    const newInternalProps = <
        Pick<InternalCommunityRecordAfterFirstUpdateType, "roles" | "challenges" | "_usingDefaultChallenge" | "pageSorts">
    >{
        ...(editWithDerivedName.roles ? { roles: await parseRolesToEdit(community, editWithDerivedName.roles) } : undefined),
        ...(editWithDerivedName?.settings?.challenges
            ? await parseChallengesToEdit(community, editWithDerivedName.settings.challenges)
            : undefined),
        ...(pagesEdit ? { pageSorts: pagesEdit.pageSorts } : undefined)
    };

    const newProps = <ParsedCommunityEditOptions>{
        ...omit(editWithDerivedName, ["roles"]), // we omit here to make tsc shut up
        ...newInternalProps
    };

    if (!community.started && !startedCommunity) {
        // sceneario 3
        return editPropsOnNotStartedCommunity(community, newProps, pagesEdit);
    }

    if (findStartedCommunity(community._pkc, { publicKey: community.publicKey, name: community.name }) === community) {
        // sceneario 4
        return editPropsOnStartedCommunity(community, newProps, pagesEdit);
    }
    throw new Error("Can't edit a community that's started in another process");
}
