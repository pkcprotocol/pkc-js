import { areEquivalentNames } from "../domain-util.js";
import type { PKCCommunitiesEntry, PKCCommunitiesWireEntry } from "../clients/rpc-client/types.js";

// Membership checks against pkc.communities (issue #455). An entry is found by its identity key or by an equivalent
// name, so a caller that only knows a community's key finds it even when it is listed under its domain. Every identifier
// the caller supplies has to match the same entry: { name: A, publicKey: <B's key> } matches neither A nor B.

export type CommunitiesEntryIdentity = { name?: string; publicKey: string };
export type CommunitiesEntryLookup = { address?: string; name?: string; publicKey?: string };

export function doesCommunitiesEntryMatch(entry: CommunitiesEntryIdentity, lookup: CommunitiesEntryLookup): boolean {
    const identifiers = [lookup.address, lookup.name, lookup.publicKey].filter((id): id is string => typeof id === "string");
    if (identifiers.length === 0) return false;
    return identifiers.every((id) => id === entry.publicKey || (entry.name !== undefined && areEquivalentNames(entry.name, id)));
}

export function findCommunitiesEntry<T extends CommunitiesEntryIdentity>(entries: T[], lookup: CommunitiesEntryLookup): T | undefined {
    return entries.find((entry) => doesCommunitiesEntryMatch(entry, lookup));
}

// The runtime entry of pkc.communities, with `address` computed like community.address: its name when it has one, else
// its identity key. Any other field, including an `address` received over RPC, is dropped
export function toCommunitiesEntry({ name, publicKey, started }: PKCCommunitiesWireEntry): PKCCommunitiesEntry {
    return name !== undefined ? { name, publicKey, address: name, started } : { publicKey, address: publicKey, started };
}

// The entry as the RPC server sends it: `address` is runtime-only, so it stays off the wire
export function toCommunitiesWireEntry({ name, publicKey, started }: PKCCommunitiesEntry): PKCCommunitiesWireEntry {
    return name !== undefined ? { name, publicKey, started } : { publicKey, started };
}
