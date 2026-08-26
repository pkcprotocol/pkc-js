import fs from "fs";
import path from "path";
import { TrackedInstanceRegistry } from "../../../../pkc/tracked-instance-registry.js";
import { findCommunityInRegistry, syncCommunityRegistryEntry } from "../../../../pkc/tracked-instance-registry-util.js";
import type { LocalCommunity } from "../local-community.js";

// The shape the process registry needs from a community: its identity aliases plus the dataPath of
// the PKC instance backing it. Structural on purpose so it can be exercised without a LocalCommunity.
export type ProcessStartedCommunity = {
    name?: string;
    publicKey?: string;
    signer?: { address?: string } | undefined;
    _pkc: { dataPath?: string };
};

// A global registry on process level to track started communities
export const processStartedCommunities = new TrackedInstanceRegistry<ProcessStartedCommunity>();

// The registry scope (issue #238) is a string prefix, while the DB and lock files are opened through
// path.join, so `/a` and `/a/`, a relative spelling, or a symlink all open the SAME database but
// would land in different scopes. Resolve to the canonical directory: realpath when it exists, and
// otherwise the realpath of the nearest existing ancestor plus the missing tail (start() creates the
// dataPath, so the registry can be consulted before the directory is there).
export function normalizeRegistryDataPath(dataPath: string | undefined): string | undefined {
    if (dataPath === undefined) return undefined;
    const resolved = path.resolve(dataPath);
    let existing = resolved;
    let tail = "";
    while (true) {
        try {
            return path.join(fs.realpathSync.native(existing), tail);
        } catch {
            const parent = path.dirname(existing);
            if (parent === existing) return resolved; // reached the filesystem root without a realpath
            tail = path.join(path.basename(existing), tail);
            existing = parent;
        }
    }
}

function getLookup(community: ProcessStartedCommunity) {
    return { publicKey: community.publicKey, name: community.name };
}

// Every process-registry access goes through these so the dataPath scope can never be forgotten.
export function findProcessStartedCommunity(community: ProcessStartedCommunity): LocalCommunity | undefined {
    return <LocalCommunity | undefined>(
        findCommunityInRegistry(processStartedCommunities, getLookup(community), normalizeRegistryDataPath(community._pkc.dataPath))
    );
}

export function syncProcessStartedCommunity(community: ProcessStartedCommunity): void {
    syncCommunityRegistryEntry(processStartedCommunities, community, normalizeRegistryDataPath(community._pkc.dataPath));
}
