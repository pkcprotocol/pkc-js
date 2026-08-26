import type { Comment } from "../publications/comment/comment.js";
import type { LocalCommunity } from "../runtime/node/community/local-community.js";
import type { RemoteCommunity } from "../community/remote-community.js";
import type { RpcLocalCommunity } from "../community/rpc-local-community.js";
import type { RpcRemoteCommunity } from "../community/rpc-remote-community.js";
import type { PKC } from "./pkc.js";
import type { TrackedInstanceRegistry } from "./tracked-instance-registry.js";
import { PKCError } from "../pkc-error.js";

type TrackedCommunity = RemoteCommunity | RpcRemoteCommunity | RpcLocalCommunity | LocalCommunity;
type StartedCommunity = LocalCommunity | RpcLocalCommunity;

type CommunityLookup = {
    name?: string;
    publicKey?: string;
};

type CommunityWithAliases = {
    name?: string;
    publicKey?: string;
    signer?: { address?: string } | undefined;
};

type CommentLookup = {
    cid?: string;
};

const trackedAliasHistorySymbol = Symbol("trackedAliasHistory");

// One history per (object, registry). A single Set shared by every registry let the per-PKC
// registries (unscoped) and processStartedCommunities (dataPath-scoped) feed each other's aliases:
// the process registry ended up holding bare aliases that matched across dataPaths, defeating the
// #238 scope. The history holds UNSCOPED aliases and the scope is applied on every sync, so a
// community re-tracked under a new dataPath (RPC setSettings swaps community._pkc) drops the old
// scope while a renamed community stays reachable by its old name within the same scope.
type TrackedAliasHistoryHolder = object & {
    [trackedAliasHistorySymbol]?: WeakMap<object, Set<string>>;
};

function isEthAliasDomain(address: string): boolean {
    const lower = address.toLowerCase();
    return lower.endsWith(".eth") || lower.endsWith(".bso");
}

function getEquivalentCommunityAliases(address: string): string[] {
    const lower = address.toLowerCase();
    if (lower.endsWith(".bso")) return [address, `${address.slice(0, -4)}.eth`];
    if (lower.endsWith(".eth")) return [address, `${address.slice(0, -4)}.bso`];
    return [address];
}

function dedupeAliases(aliases: (string | undefined)[]): string[] {
    return [...new Set(aliases.filter((alias): alias is string => typeof alias === "string" && alias.length > 0))];
}

function getTrackedAliasHistory(target: object, registry: object): Set<string> {
    const holder = target as TrackedAliasHistoryHolder;
    if (!holder[trackedAliasHistorySymbol]) {
        Object.defineProperty(holder, trackedAliasHistorySymbol, {
            value: new WeakMap<object, Set<string>>(),
            enumerable: false,
            configurable: false,
            writable: false
        });
    }
    const histories = holder[trackedAliasHistorySymbol]!;
    let history = histories.get(registry);
    if (!history) {
        history = new Set<string>();
        histories.set(registry, history);
    }
    return history;
}

function persistAliases<T extends object>(target: T, registry: object, aliases: string[]): string[] {
    const aliasHistory = getTrackedAliasHistory(target, registry);
    aliases.forEach((alias) => aliasHistory.add(alias));
    return [...aliasHistory];
}

// Aliases are scoped to the dataPath they belong to when one is given. processStartedCommunities is
// a module-level registry shared by every PKC instance in the process, and the registry matches on
// ANY alias, so without a scope two LocalCommunity instances backed by different dataPaths but
// sharing an address resolve to each other: one then adopts the other's posts/updateCid through a
// signer it does not hold, and every publish after that fails signature validation (issue #238).
// The scope is a prefix rather than an extra alias on purpose — a bare dataPath alias would instead
// make every community *within* one dataPath collide.
// A registry that is already scoped by construction (the per-PKC pkc._updatingCommunities and
// pkc._startedCommunities) passes no dataPath and is left unprefixed.
const REGISTRY_SCOPE_SEPARATOR = "\u0000";

function scopeAliasesToDataPath(aliases: string[], dataPath: string | undefined): string[] {
    if (dataPath === undefined) return aliases;
    return aliases.map((alias) => `${dataPath}${REGISTRY_SCOPE_SEPARATOR}${alias}`);
}

export function getCommunityRegistryAliases(community: CommunityWithAliases, dataPath?: string): string[] {
    // community.address is deliberately absent: setAddress keeps it equal to `name || publicKey`, so
    // it is never an identity name/publicKey does not already carry. signer.address is NOT
    // redundant — communityIdentityPublicKey() is `anchor?.publicKey ?? signer.address`, so on a
    // delegated community publicKey is the anchor while signer.address is the minter that signs its
    // records, and both have to resolve to the instance.
    const aliases = dedupeAliases([community.name, community.publicKey, community.signer?.address]);
    if (aliases.length === 0) throw new PKCError("ERR_COMMUNITY_REGISTRY_LOOKUP_HAS_NO_ALIASES", { community });

    return scopeAliasesToDataPath(
        dedupeAliases(
            aliases.flatMap((alias) => {
                if (isEthAliasDomain(alias)) return getEquivalentCommunityAliases(alias);
                return [alias];
            })
        ),
        dataPath
    );
}

export function getCommentRegistryAliases(comment: CommentLookup): string[] {
    return dedupeAliases([comment.cid]);
}

export function syncCommunityRegistryEntry<T extends CommunityWithAliases>(
    registry: TrackedInstanceRegistry<T>,
    community: T,
    dataPath?: string
): T {
    return registry.track({
        value: community,
        aliases: scopeAliasesToDataPath(persistAliases(community, registry, getCommunityRegistryAliases(community)), dataPath)
    });
}

export function syncCommentRegistryEntry<T extends CommentLookup>(registry: TrackedInstanceRegistry<T>, comment: T): T {
    return registry.track({ value: comment, aliases: persistAliases(comment, registry, getCommentRegistryAliases(comment)) });
}

export function findCommunityInRegistry<T extends CommunityWithAliases>(
    registry: TrackedInstanceRegistry<T>,
    lookup: CommunityLookup,
    dataPath?: string
): T | undefined {
    return registry.findByAliases(getCommunityRegistryAliases(lookup, dataPath));
}

export function findCommentInRegistry<T extends CommentLookup>(registry: TrackedInstanceRegistry<T>, lookup: CommentLookup): T | undefined {
    return registry.findByAliases(getCommentRegistryAliases(lookup));
}

export function listRegistryValues<T extends object>(registry: TrackedInstanceRegistry<T>): T[] {
    return registry.values();
}

export function trackUpdatingCommunity(pkc: PKC, community: TrackedCommunity): TrackedCommunity {
    return syncCommunityRegistryEntry(pkc._updatingCommunities, community);
}

export function trackStartedCommunity(pkc: PKC, community: StartedCommunity): StartedCommunity {
    return syncCommunityRegistryEntry(pkc._startedCommunities, community);
}

export function trackUpdatingComment(pkc: PKC, comment: Comment): Comment {
    return syncCommentRegistryEntry(pkc._updatingComments, comment);
}

export function untrackUpdatingCommunity(pkc: PKC, community: TrackedCommunity): void {
    pkc._updatingCommunities.untrack(community);
}

export function untrackStartedCommunity(pkc: PKC, community: StartedCommunity): void {
    pkc._startedCommunities.untrack(community);
}

export function untrackUpdatingComment(pkc: PKC, comment: Comment): void {
    pkc._updatingComments.untrack(comment);
}

export function refreshTrackedCommunityAliases(pkc: PKC, community: TrackedCommunity): void {
    if (pkc._updatingCommunities.has(community)) syncCommunityRegistryEntry(pkc._updatingCommunities, community);
    if (pkc._startedCommunities.has(community as StartedCommunity))
        syncCommunityRegistryEntry(pkc._startedCommunities, community as StartedCommunity);
}

export function refreshTrackedCommentAliases(pkc: PKC, comment: Comment): void {
    if (pkc._updatingComments.has(comment)) syncCommentRegistryEntry(pkc._updatingComments, comment);
}

export function findUpdatingCommunity(pkc: PKC, lookup: CommunityLookup): TrackedCommunity | undefined {
    return findCommunityInRegistry(pkc._updatingCommunities, lookup);
}

export function findStartedCommunity(pkc: PKC, lookup: CommunityLookup): StartedCommunity | undefined {
    return findCommunityInRegistry(pkc._startedCommunities, lookup);
}

export function findUpdatingComment(pkc: PKC, lookup: CommentLookup): Comment | undefined {
    return findCommentInRegistry(pkc._updatingComments, lookup);
}

export function listUpdatingCommunities(pkc: PKC): TrackedCommunity[] {
    return listRegistryValues(pkc._updatingCommunities);
}

export function listStartedCommunities(pkc: PKC): StartedCommunity[] {
    return listRegistryValues(pkc._startedCommunities);
}

export function listUpdatingComments(pkc: PKC): Comment[] {
    return listRegistryValues(pkc._updatingComments);
}
