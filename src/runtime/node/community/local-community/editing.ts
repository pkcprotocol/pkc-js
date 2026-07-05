import Logger from "../../../../logger.js";
import { clone, keys, omit, omitBy, pick } from "remeda";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { sha256 } from "js-sha256";
import { areEquivalentCommunityAddresses, doesDomainAddressHaveCapitalLetter, isStringDomain } from "../../../../util.js";
import { PKCError } from "../../../../pkc-error.js";
import { parseCommunityEditOptionsSchemaWithPKCErrorIfItFails } from "../../../../schema/schema-util.js";
import {
    findCommunityInRegistry,
    findStartedCommunity,
    syncCommunityRegistryEntry,
    trackStartedCommunity
} from "../../../../pkc/tracked-instance-registry-util.js";
import { getCommunityChallengeFromCommunityChallengeSettings } from "../challenges/index.js";
import type {
    CommunityEditOptions,
    CommunityIpfsType,
    InternalCommunityRecordAfterFirstUpdateType,
    ParsedCommunityEditOptions
} from "../../../../community/types.js";
import type { LocalCommunity } from "../local-community.js";
import { isDefaultChallengeStructure } from "./defaults.js";
import { processStartedCommunities } from "./registry.js";
import { updateDbInternalState, updateInstancePropsWithStartedCommunityOrDb } from "./db-state.js";

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
            try {
                ({ resolvedAuthorName: resolved } = await community._clientsManager.resolveAuthorNameIfNeeded({
                    authorName: roleAddress,
                    abortSignal: AbortSignal.timeout(community._pkc._timeouts["resolve-author-name"]),
                    // Role edits must apply to current state — bypass cache.
                    cache: { maxAge: 0 }
                }));
            } catch {
                resolved = null;
            }
            if (!resolved) throw new PKCError("ERR_ROLE_ADDRESS_NAME_COULD_NOT_BE_RESOLVED", { roleAddress });
        }
    }
    return <NonNullable<CommunityIpfsType["roles"]>>omitBy(newRawRoles, (val, key) => val === undefined || val === null);
}

export async function parseChallengesToEdit(
    community: LocalCommunity,
    newChallengeSettings: NonNullable<NonNullable<CommunityEditOptions["settings"]>["challenges"]>
): Promise<NonNullable<Pick<InternalCommunityRecordAfterFirstUpdateType, "challenges" | "_usingDefaultChallenge">>> {
    return {
        challenges: await Promise.all(
            newChallengeSettings.map(
                async (cs) =>
                    (await getCommunityChallengeFromCommunityChallengeSettings({ communityChallengeSettings: cs, pkc: community._pkc }))
                        .communityChallenge
            )
        ),
        _usingDefaultChallenge: isDefaultChallengeStructure(newChallengeSettings)
    };
}

export async function validateNewAddressBeforeEditing(community: LocalCommunity, newAddress: string, log: Logger) {
    if (doesDomainAddressHaveCapitalLetter(newAddress))
        throw new PKCError("ERR_COMMUNITY_NAME_HAS_CAPITAL_LETTER", { communityAddress: newAddress });
    // Check if any existing community (other than this one) already has an equivalent address
    // This handles both exact matches and .eth/.bso alias equivalence
    const existingEquivalent = community._pkc.communities.find(
        (existing) => areEquivalentCommunityAddresses(existing, newAddress) && !areEquivalentCommunityAddresses(existing, community.address)
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

export async function editPropsOnStartedCommunity(
    community: LocalCommunity,
    parsedEditOptions: ParsedCommunityEditOptions
): Promise<LocalCommunity> {
    // 'community' is the started community with state="started"
    // community._pkc._startedCommunities[community.address] === community
    const log = Logger("pkc-js:local-community:start:editPropsOnStartedCommunity");
    const oldAddress = clone(community.address);
    if (typeof parsedEditOptions.address === "string" && community.address !== parsedEditOptions.address) {
        await validateNewAddressBeforeEditing(community, parsedEditOptions.address, log);

        log(`Attempting to edit community.address from ${oldAddress} to ${parsedEditOptions.address}. We will stop community first`);
        await community.stop();
        await community._dbHandler.changeDbFilename(oldAddress, parsedEditOptions.address);
        community.setAddress(parsedEditOptions.address);
        await community._dbHandler.initDbIfNeeded();
        await community.start();
        await movePostUpdatesFolderToNewAddress(community, oldAddress, parsedEditOptions.address);
    }

    const uniqueEditId = sha256(deterministicStringify(parsedEditOptions));
    community._pendingEditProps.push({ ...parsedEditOptions, editId: uniqueEditId });

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
    community._communityUpdateTrigger = true;
    log(
        `Community (${community.address}) props (${keys(parsedEditOptions)}) has been edited. Will be including edited props in next update: `,
        pick(community, keys(parsedEditOptions))
    );
    community.emit("update", community);
    if (community.address !== oldAddress) {
        trackStartedCommunity(community._pkc, community);
        syncCommunityRegistryEntry(processStartedCommunities, community);
    }
    return community;
}

export async function editPropsOnNotStartedCommunity(
    community: LocalCommunity,
    parsedEditOptions: ParsedCommunityEditOptions
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
        await movePostUpdatesFolderToNewAddress(community, community.address, parsedEditOptions.address);
        community._dbHandler.destoryConnection();
        await community._dbHandler.changeDbFilename(community.address, parsedEditOptions.address);
        await community._dbHandler.initDbIfNeeded();
        community.setAddress(parsedEditOptions.address);
    }
    const mergedInternalState = await updateDbInternalState(community, parsedEditOptions);

    if ("updatedAt" in mergedInternalState && mergedInternalState.updatedAt)
        await community.initInternalCommunityAfterFirstUpdateNoMerge(mergedInternalState);
    else await community.initInternalCommunityBeforeFirstUpdateNoMerge(mergedInternalState);
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
            findCommunityInRegistry(processStartedCommunities, { publicKey: community.publicKey, name: community.name }))
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

    // Convert backward-compat address → name for wire format when address is a domain
    const editWithDerivedName =
        typeof parsedEditOptions.address === "string" && isStringDomain(parsedEditOptions.address)
            ? { ...parsedEditOptions, name: parsedEditOptions.address }
            : parsedEditOptions;

    const newInternalProps = <Pick<InternalCommunityRecordAfterFirstUpdateType, "roles" | "challenges" | "_usingDefaultChallenge">>{
        ...(editWithDerivedName.roles ? { roles: await parseRolesToEdit(community, editWithDerivedName.roles) } : undefined),
        ...(editWithDerivedName?.settings?.challenges
            ? await parseChallengesToEdit(community, editWithDerivedName.settings.challenges)
            : undefined)
    };

    const newProps = <ParsedCommunityEditOptions>{
        ...omit(editWithDerivedName, ["roles"]), // we omit here to make tsc shut up
        ...newInternalProps
    };

    if (!community.started && !startedCommunity) {
        // sceneario 3
        return editPropsOnNotStartedCommunity(community, newProps);
    }

    if (findStartedCommunity(community._pkc, { publicKey: community.publicKey, name: community.name }) === community) {
        // sceneario 4
        return editPropsOnStartedCommunity(community, newProps);
    }
    throw new Error("Can't edit a community that's started in another process");
}
