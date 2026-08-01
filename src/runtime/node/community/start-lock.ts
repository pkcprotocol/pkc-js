import path from "path";
import lockfile from "@pkcprotocol/proper-lock-file";

// How long a start lockfile may go un-refreshed before it is treated as abandoned (a crashed
// process leaves its lockfile behind). Shared by the DbHandler method and the standalone check
// below so both agree on what "started" means.
export const STALE_START_LOCK_MS = 10000;

// A community's `started` flag is derived purely from whether its start lockfile is held: the lock
// is held for as long as some process is running that community, and it is visible across
// processes. Nothing here touches the community's sqlite db.
//
// This lives as a standalone function - not only as a DbHandler method - because answering
// "is it started?" for N communities over RPC used to mean transferring each community's entire
// internal record just to read one boolean off it (14.8MB across 17 communities on the production
// host). The RPC server's listCommunitiesStartedState uses this to answer for every community in a
// single pass of cheap fs checks instead.
export async function isCommunityStartLockedByAddress({
    dataPath,
    communityAddress
}: {
    dataPath: string;
    communityAddress: string;
}): Promise<boolean> {
    const lockfilePath = path.join(dataPath, "communities", `${communityAddress}.start.lock`);
    const communityDbPath = path.join(dataPath, "communities", communityAddress);
    return lockfile.check(communityDbPath, { lockfilePath, realpath: false, stale: STALE_START_LOCK_MS });
}
