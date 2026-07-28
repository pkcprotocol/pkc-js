// Test foundations for author-communities (issue #31, docs/protocol/author-communities.md).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: whole-flow scaffolds that cross every seam at once. The other files in this directory are
// unit-shaped; these are the ones that would actually catch an integration mistake between the
// delegated LocalCommunity, the sync RPC, page generation, page verification and read-side state.
//
// Each describe is one scenario, ordered as the steps that make it up.
import { describe, it } from "vitest";

describe("e2e: cross-post appears on the profile as state live", () => {
    it.todo("creates a normal community X and an author-community for the author");
    it.todo("the author publishes a Comment to community X through the normal challenge exchange");
    it.todo("X generates a CommentUpdate for it and serves it in its pages");
    it.todo("the client loads its own comment and syncs it via syncAuthorComments with the CommentUpdate");
    it.todo("the profile regenerates its new feed and republishes the record");
    it.todo("a reader loads the profile through getCommunity and sees the entry in the inline first page");
    it.todo("the reader verifies the entry's CommentIpfs against the author and its CommentUpdate against X");
    it.todo("the entry renders as state live and contributes to karma");
});

describe("e2e: native post with a foreign reply", () => {
    it.todo("the owner publishes a native Comment to their own profile, passing the seeded fail challenge via the owner-address exclude");
    it.todo("a foreign author replies to it and passes the configured reply challenge");
    it.todo("the reply is hosted by the profile (sole host) and appears under the native post");
    it.todo("the owner removes the reply with CommentModeration, authorized by their seeded owner role");
    it.todo("the removed reply disappears from the generated pages");
    it.todo("a reader verifies the native entry's CommentUpdate against the profile itself");
});

describe("e2e: profile survives its cross-posts' community going away", () => {
    it.todo("the author cross-posts to community X and syncs the entry with its CommentUpdate");
    it.todo("community X stops being reachable");
    it.todo("the minter's refresh job fails to fetch and keeps the last known snapshot");
    it.todo("the entry still renders from the embedded snapshot, marked last-known rather than live");
    it.todo("the owner drops the entry by omitting it from the next sync, with X still unreachable");
    it.todo("the entry disappears from the feed without any publication to X");
});

describe("e2e: delegated profile end to end inside pkc-js", () => {
    it.todo("the author signs and publishes the An -> Mn anchor record client-side");
    it.todo("the minter node creates the author-community with the anchor as its identity");
    it.todo("the minter mints the { authorCommunity } envelope signed by Mn");
    it.todo("a reader resolves the anchor, walks one hop, and verifies against the terminal");
    it.todo("a remote client publishes a reply addressed to the anchor and the minter accepts it");
    it.todo("the author rotates to Mn' and readers follow the new binding");
    it.todo("the exported sqlite restored under Mn' preserves native content including foreign replies");
});

describe("e2e: multi-device sync convergence", () => {
    it.todo("device A syncs its cross-posts to the profile");
    it.todo("device B lists stored entries, unions them with its own local comments, and syncs the merged list");
    it.todo("no entry is dropped by B's sync (the list-then-merge-then-sync flow)");
    it.todo("both devices then see the same feed after a reload");
});
