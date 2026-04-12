import type { Comment } from "../publications/comment/comment.js";
import type { LocalCommunity } from "../runtime/node/community/local-community.js";
import type { RemoteCommunity } from "../community/remote-community.js";
import type { RpcLocalCommunity } from "../community/rpc-local-community.js";
import type { RpcRemoteCommunity } from "../community/rpc-remote-community.js";
import type { PKC } from "./pkc.js";
import type { TrackedInstanceRegistry } from "./tracked-instance-registry.js";

type TrackedCommunity = RemoteCommunity | RpcRemoteCommunity | RpcLocalCommunity | LocalCommunity;
type StartedCommunity = LocalCommunity | RpcLocalCommunity;

type CommunityLookup = {
    name?: string;
    publicKey?: string;
};

type CommunityWithAliases = {
    address?: string;
    name?: string;
    publicKey?: string;
    signer?: { address?: string } | undefined;
};

type CommentLookup = {
    cid?: string;
};

const trackedAliasHistorySymbol = Symbol("trackedAliasHistory");

type TrackedAliasHistoryHolder = object & {
    [trackedAliasHistorySymbol]?: Set<string>;
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

function getTrackedAliasHistory(target: object): Set<string> {
    const holder = target as TrackedAliasHistoryHolder;
    if (!holder[trackedAliasHistorySymbol]) {
        Object.defineProperty(holder, trackedAliasHistorySymbol, {
            value: new Set<string>(),
            enumerable: false,
            configurable: false,
            writable: false
        });
    }
    return holder[trackedAliasHistorySymbol]!;
}

function persistAliases<T extends object>(target: T, aliases: string[]): string[] {
    const aliasHistory = getTrackedAliasHistory(target);
    aliases.forEach((alias) => aliasHistory.add(alias));
    return [...aliasHistory];
}

export function getCommunityRegistryAliases(community: CommunityWithAliases): string[] {
    const aliases = dedupeAliases([community.address, community.name, community.publicKey, community.signer?.address]);

    return dedupeAliases(
        aliases.flatMap((alias) => {
            if (isEthAliasDomain(alias)) return getEquivalentCommunityAliases(alias);
            return [alias];
        })
    );
}

export function getCommentRegistryAliases(comment: CommentLookup): string[] {
    return dedupeAliases([comment.cid]);
}

export function syncCommunityRegistryEntry<T extends CommunityWithAliases>(registry: TrackedInstanceRegistry<T>, community: T): T {
    return registry.track({ value: community, aliases: persistAliases(community, getCommunityRegistryAliases(community)) });
}

export function syncCommentRegistryEntry<T extends CommentLookup>(registry: TrackedInstanceRegistry<T>, comment: T): T {
    return registry.track({ value: comment, aliases: persistAliases(comment, getCommentRegistryAliases(comment)) });
}

export function findCommunityInRegistry<T extends CommunityWithAliases>(
    registry: TrackedInstanceRegistry<T>,
    lookup: CommunityLookup
): T | undefined {
    return registry.findByAliases(getCommunityRegistryAliases(lookup));
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
