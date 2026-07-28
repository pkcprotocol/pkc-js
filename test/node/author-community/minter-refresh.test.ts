// Test foundations for author-communities (issue #31, docs/protocol/author-communities.md).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: minter-side freshness of cross-posted entries. Division of labor:
// discovery of new entries is client-push only (sync RPC); freshness of known entries is
// the minter's job (it is delegated with handling the profile). The client MAY seed a
// community-signed CommentUpdate through syncAuthorComments, but never owns freshness:
// stored mod-state advances by max(stored, candidate) on updatedAt, on both paths.
import { describe, it } from "vitest";

describe("minter-side CommentUpdate refresh", () => {
    it.todo("periodically re-loads the CommentUpdate of each cross-posted entry from its canonical community");
    it.todo("verifies the community signature of a fetched CommentUpdate before replacing the snapshot");
    it.todo("rejects a fetched CommentUpdate with an invalid community signature and keeps the old snapshot");
    it.todo("replaces the embedded snapshot on the next record mint");
    it.todo("reflects a canonical-side removal (removed/deleted set) in the refreshed snapshot");
    it.todo("keeps the last known snapshot when the canonical community is unreachable (entry is not dropped)");
});

describe("interplay with client-seeded mod-state", () => {
    it.todo("overwrites a client-pushed snapshot once it fetches a newer one from the canonical community");
    it.todo("keeps the stored snapshot when the fetched one has a lower updatedAt (monotonic on the fetch path too)");
    it.todo("refreshes an entry the client synced without any commentUpdate");
    it.todo("does not re-fetch on every mint for an entry whose canonical community is permanently gone (backoff)");
});

describe("refresh scope limits", () => {
    it.todo("only fetches CommentUpdates for CIDs already stored for hosted profiles (bounded work)");
    it.todo("never crawls foreign communities to discover new author posts (discovery is client-push only)");
    it.todo("never fetches anything during the sync RPC call itself");
});
