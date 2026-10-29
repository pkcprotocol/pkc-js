import { areEquivalentNames } from "../domain-util.js";

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

// The address a listed community is reached by: its name when it has one, else its identity key
export function getCommunitiesEntryAddress(entry: CommunitiesEntryIdentity): string {
    return entry.name ?? entry.publicKey;
}
