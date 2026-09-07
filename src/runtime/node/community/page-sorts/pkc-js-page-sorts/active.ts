import type { PageSortFileFactory } from "../../../../../community/types.js";

// Bump order: a post's score is the newest timestamp among the post and its surviving replies, which is what its
// CommentUpdate already carries as lastReplyTimestamp (the recursive MAX(timestamp) the community computes when a
// descendant changes, before pages are generated in the same cycle). A per-comment score like every other built-in,
// so a client re-sorts by bump order from the page alone. lastReplyTimestamp hard-codes the removed/deleted/unapproved
// exclusions, so an owner who turns excludeRemovedComments off for posts still does not get removed replies bumping
// threads: bump time is what the CommentUpdate carries.
const active: PageSortFileFactory = () => ({
    sortName: "active",
    description: "Most recently bumped first: posts ordered by the newest reply anywhere in their thread",
    optionInputs: [], // reads nothing beyond the reserved options (maxAge, pinnedFirst, exclude*)
    scope: "posts",
    score: ({ comment, commentUpdate }) => Math.max(comment.timestamp, commentUpdate.lastReplyTimestamp ?? 0)
});

export default active;
