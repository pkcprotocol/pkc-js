// Browser counterpart of runtime/node/community/start-lock.ts. Start locks are files in the node
// data directory, so there is nothing to check here; this stub exists only because the browser build
// rewrites runtime/node imports to runtime/browser, and the RPC server module (node-only at runtime)
// is still copied into dist/browser.

export const STALE_START_LOCK_MS = 10000;

export function isCommunityStartLockedByAddress(): never {
    throw Error("Community start locks should not be used in browser");
}
