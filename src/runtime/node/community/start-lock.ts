import path from "path";
import lockfile from "@pkcprotocol/proper-lock-file";

// Whether a local community is started: its start lock is held by some process on this dataPath. community.started
// and the `started` of its pkc.communities entry (issue #455) both come from here, so they always agree.

const START_LOCK_CHECK_OPTIONS = { realpath: false, stale: 10000 };

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
