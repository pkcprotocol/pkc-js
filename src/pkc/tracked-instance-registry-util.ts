import type { Comment } from "../publications/comment/comment.js";
import type { LocalSubplebbit } from "../runtime/node/community/local-community.js";
import type { RemoteSubplebbit } from "../community/remote-community.js";
import type { RpcLocalSubplebbit } from "../community/rpc-local-community.js";
import type { RpcRemoteSubplebbit } from "../community/rpc-remote-community.js";
import type { Plebbit } from "./pkc.js";
import type { TrackedInstanceRegistry } from "./tracked-instance-registry.js";

type TrackedSubplebbit = RemoteSubplebbit | RpcRemoteSubplebbit | RpcLocalSubplebbit | LocalSubplebbit;
type StartedSubplebbit = LocalSubplebbit | RpcLocalSubplebbit;

type SubplebbitLookup = {
    address?: string;
    name?: string;
    publicKey?: string;
};

type SubplebbitWithAliases = SubplebbitLookup & {
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

function getEquivalentSubplebbitAliases(address: string): string[] {
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

export function getSubplebbitRegistryAliases(subplebbit: SubplebbitWithAliases): string[] {
    const aliases = dedupeAliases([subplebbit.address, subplebbit.name, subplebbit.publicKey, subplebbit.signer?.address]);

    return dedupeAliases(
        aliases.flatMap((alias) => {
            if (isEthAliasDomain(alias)) return getEquivalentSubplebbitAliases(alias);
            return [alias];
        })
    );
}

export function getCommentRegistryAliases(comment: CommentLookup): string[] {
    return dedupeAliases([comment.cid]);
}

export function syncSubplebbitRegistryEntry<T extends SubplebbitWithAliases>(registry: TrackedInstanceRegistry<T>, subplebbit: T): T {
    return registry.track({ value: subplebbit, aliases: persistAliases(subplebbit, getSubplebbitRegistryAliases(subplebbit)) });
}

export function syncCommentRegistryEntry<T extends CommentLookup>(registry: TrackedInstanceRegistry<T>, comment: T): T {
    return registry.track({ value: comment, aliases: persistAliases(comment, getCommentRegistryAliases(comment)) });
}

export function findSubplebbitInRegistry<T extends SubplebbitWithAliases>(
    registry: TrackedInstanceRegistry<T>,
    lookup: SubplebbitLookup
): T | undefined {
    return registry.findByAliases(getSubplebbitRegistryAliases(lookup));
}

export function findCommentInRegistry<T extends CommentLookup>(registry: TrackedInstanceRegistry<T>, lookup: CommentLookup): T | undefined {
    return registry.findByAliases(getCommentRegistryAliases(lookup));
}

export function listRegistryValues<T extends object>(registry: TrackedInstanceRegistry<T>): T[] {
    return registry.values();
}

export function trackUpdatingSubplebbit(plebbit: Plebbit, subplebbit: TrackedSubplebbit): TrackedSubplebbit {
    return syncSubplebbitRegistryEntry(plebbit._updatingSubplebbits, subplebbit);
}

export function trackStartedSubplebbit(plebbit: Plebbit, subplebbit: StartedSubplebbit): StartedSubplebbit {
    return syncSubplebbitRegistryEntry(plebbit._startedSubplebbits, subplebbit);
}

export function trackUpdatingComment(plebbit: Plebbit, comment: Comment): Comment {
    return syncCommentRegistryEntry(plebbit._updatingComments, comment);
}

export function untrackUpdatingSubplebbit(plebbit: Plebbit, subplebbit: TrackedSubplebbit): void {
    plebbit._updatingSubplebbits.untrack(subplebbit);
}

export function untrackStartedSubplebbit(plebbit: Plebbit, subplebbit: StartedSubplebbit): void {
    plebbit._startedSubplebbits.untrack(subplebbit);
}

export function untrackUpdatingComment(plebbit: Plebbit, comment: Comment): void {
    plebbit._updatingComments.untrack(comment);
}

export function refreshTrackedSubplebbitAliases(plebbit: Plebbit, subplebbit: TrackedSubplebbit): void {
    if (plebbit._updatingSubplebbits.has(subplebbit)) syncSubplebbitRegistryEntry(plebbit._updatingSubplebbits, subplebbit);
    if (plebbit._startedSubplebbits.has(subplebbit as StartedSubplebbit))
        syncSubplebbitRegistryEntry(plebbit._startedSubplebbits, subplebbit as StartedSubplebbit);
}

export function refreshTrackedCommentAliases(plebbit: Plebbit, comment: Comment): void {
    if (plebbit._updatingComments.has(comment)) syncCommentRegistryEntry(plebbit._updatingComments, comment);
}

export function findUpdatingSubplebbit(plebbit: Plebbit, lookup: SubplebbitLookup): TrackedSubplebbit | undefined {
    return findSubplebbitInRegistry(plebbit._updatingSubplebbits, lookup);
}

export function findStartedSubplebbit(plebbit: Plebbit, lookup: SubplebbitLookup): StartedSubplebbit | undefined {
    return findSubplebbitInRegistry(plebbit._startedSubplebbits, lookup);
}

export function findUpdatingComment(plebbit: Plebbit, lookup: CommentLookup): Comment | undefined {
    return findCommentInRegistry(plebbit._updatingComments, lookup);
}

export function listUpdatingSubplebbits(plebbit: Plebbit): TrackedSubplebbit[] {
    return listRegistryValues(plebbit._updatingSubplebbits);
}

export function listStartedSubplebbits(plebbit: Plebbit): StartedSubplebbit[] {
    return listRegistryValues(plebbit._startedSubplebbits);
}

export function listUpdatingComments(plebbit: Plebbit): Comment[] {
    return listRegistryValues(plebbit._updatingComments);
}
