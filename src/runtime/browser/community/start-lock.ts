// Start locks are files in a node dataPath. The RPC server is the only shared code that imports this module.

export const START_LOCK_STALE_MS = 10000;

export async function isCommunityStartLocked(_args: { dataPath: string; communityAddress: string }): Promise<boolean> {
    throw Error("isCommunityStartLocked should not be called in browser");
}
