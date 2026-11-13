import path from "path";
import lockfile from "@pkcprotocol/proper-lock-file";

// Whether a local community is started: its start lock is held by some process on this dataPath. community.started
// and the `started` of its pkc.communities entry (issue #455) both come from here, so they always agree.

// A start lock whose holder has not refreshed it for this long is stale: its process is gone, and the next start takes
// the lock over. Same value as the lock library's default, which lockCommunityStart relies on.
export const START_LOCK_STALE_MS = 10000;

const START_LOCK_CHECK_OPTIONS = { realpath: false, stale: START_LOCK_STALE_MS };

function getStartLockPaths({ dataPath, communityAddress }: { dataPath: string; communityAddress: string }) {
    const communityDbPath = path.join(dataPath, "communities", communityAddress);
    return { communityDbPath, lockfilePath: `${communityDbPath}.start.lock` };
}

export async function isCommunityStartLocked(args: { dataPath: string; communityAddress: string }): Promise<boolean> {
    const { communityDbPath, lockfilePath } = getStartLockPaths(args);
    return lockfile.check(communityDbPath, { ...START_LOCK_CHECK_OPTIONS, lockfilePath });
}

export function isCommunityStartLockedSync(args: { dataPath: string; communityAddress: string }): boolean {
    const { communityDbPath, lockfilePath } = getStartLockPaths(args);
    return lockfile.checkSync(communityDbPath, { ...START_LOCK_CHECK_OPTIONS, lockfilePath });
}
