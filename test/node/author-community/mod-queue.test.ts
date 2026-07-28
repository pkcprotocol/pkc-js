// Test foundations for author-communities (issue #31, docs/protocol/author-communities.md).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Covers: modQueue and the pending-approval flow on an author-community. Inherited unchanged: a
// profile that challenge-gates replies has the same reason to hold one for approval as any
// community. The author-community-specific rule is that the queue only ever holds NATIVE content,
// since cross-posts are not publications to this community, are not rows in `comments`, and cannot
// be approved or disapproved here.
import { describe, it } from "vitest";

describe("pending approval of foreign replies", () => {
    it.todo("holds a foreign reply flagged pendingApproval instead of publishing it into the feed");
    it.todo("approving it folds the reply into the profile's pages like any community");
    it.todo("disapproving it keeps it out of the feed");
    it.todo("the owner approves and disapproves via the same publication types as any community owner");
    it.todo("honors settings.maxPendingApprovalCount");
    it.todo("honors purgeDisapprovedCommentsOlderThan");
});

describe("modQueue in AuthorCommunityIpfs", () => {
    it.todo("carries modQueue with the same ModQueuePagesIpfs shape as CommunityIpfs");
    it.todo("publishes a modQueue page listing pending native replies");
    it.todo("verifies modQueue pages with the shared mod-queue verification (native content only)");
    it.todo("omits modQueue when nothing is pending");
});

describe("the mod queue never holds cross-posts", () => {
    it.todo("a synced cross-post never appears in the mod queue");
    it.todo("syncAuthorComments does not create a pending-approval entry");
    it.todo("a cross-post cannot be approved or disapproved through the mod queue");
    it.todo("dropping a cross-post is omission from the next sync, not a disapproval");
});

// features carries over whole: prepareCommentWithAnonymity reads community.features.pseudonymityMode,
// so a profile could not offer pseudonymous replies without it.
describe("other inherited CommunityIpfs fields", () => {
    it.todo("carries features and applies pseudonymityMode to replies");
    it.todo("carries requireAuthorFlairs and applies it to repliers");
    it.todo("carries title, description, rules, suggested, and flairs, all editable via CommunityEdit");
    it.todo("lastPostCid and lastCommentCid reflect native content only, never cross-posts");
    it.todo("the profile's own metadata fields coexist with the inherited ones in one record");
});
