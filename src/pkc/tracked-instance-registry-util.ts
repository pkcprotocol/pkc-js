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
    address?: string;
    name?: string;
    publicKey?: string;
};

type CommunityWithAliases = CommunityLookup & {
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

export function getCommunityRegistryAliases(subplebbit: CommunityWithAliases): string[] {
    const aliases = dedupeAliases([subplebbit.address, subplebbit.name, subplebbit.publicKey, subplebbit.signer?.address]);

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

export function syncCommunityRegistryEntry<T extends CommunityWithAliases>(registry: TrackedInstanceRegistry<T>, subplebbit: T): T {
    return registry.track({ value: subplebbit, aliases: persistAliases(subplebbit, getCommunityRegistryAliases(subplebbit)) });
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

export function trackUpdatingCommunity(plebbit: PKC, subplebbit: TrackedCommunity): TrackedCommunity {
    return syncCommunityRegistryEntry(plebbit._updatingCommunitys, subplebbit);
}

export function trackStartedCommunity(plebbit: PKC, subplebbit: StartedCommunity): StartedCommunity {
    return syncCommunityRegistryEntry(plebbit._startedCommunitys, subplebbit);
}

export function trackUpdatingComment(plebbit: PKC, comment: Comment): Comment {
    return syncCommentRegistryEntry(plebbit._updatingComments, comment);
}

export function untrackUpdatingCommunity(plebbit: PKC, subplebbit: TrackedCommunity): void {
    plebbit._updatingCommunitys.untrack(subplebbit);
}

export function untrackStartedCommunity(plebbit: PKC, subplebbit: StartedCommunity): void {
    plebbit._startedCommunitys.untrack(subplebbit);
}

export function untrackUpdatingComment(plebbit: PKC, comment: Comment): void {
    plebbit._updatingComments.untrack(comment);
}

export function refreshTrackedCommunityAliases(plebbit: PKC, subplebbit: TrackedCommunity): void {
    if (plebbit._updatingCommunitys.has(subplebbit)) syncCommunityRegistryEntry(plebbit._updatingCommunitys, subplebbit);
    if (plebbit._startedCommunitys.has(subplebbit as StartedCommunity))
        syncCommunityRegistryEntry(plebbit._startedCommunitys, subplebbit as StartedCommunity);
}

export function refreshTrackedCommentAliases(plebbit: PKC, comment: Comment): void {
    if (plebbit._updatingComments.has(comment)) syncCommentRegistryEntry(plebbit._updatingComments, comment);
}

export function findUpdatingCommunity(plebbit: PKC, lookup: CommunityLookup): TrackedCommunity | undefined {
    return findCommunityInRegistry(plebbit._updatingCommunitys, lookup);
}

export function findStartedCommunity(plebbit: PKC, lookup: CommunityLookup): StartedCommunity | undefined {
    return findCommunityInRegistry(plebbit._startedCommunitys, lookup);
}

export function findUpdatingComment(plebbit: PKC, lookup: CommentLookup): Comment | undefined {
    return findCommentInRegistry(plebbit._updatingComments, lookup);
}

export function listUpdatingCommunitys(plebbit: PKC): TrackedCommunity[] {
    return listRegistryValues(plebbit._updatingCommunitys);
}

export function listStartedCommunitys(plebbit: PKC): StartedCommunity[] {
    return listRegistryValues(plebbit._startedCommunitys);
}

export function listUpdatingComments(plebbit: PKC): Comment[] {
    return listRegistryValues(plebbit._updatingComments);
}
