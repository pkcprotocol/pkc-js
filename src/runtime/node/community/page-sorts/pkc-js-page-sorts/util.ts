import type { PageSortFile } from "../../../../../community/types.js";
import type { PageIpfs } from "../../../../../pages/types.js";

// The pure built-ins (hot, new, old, best, top*, controversial) all score one comment at a time from fields the
// comment already carries. This lifts such a per-comment scorer to the whole-set scoreAll contract every page
// sort file implements.
export function scoreAllFromPerCommentScore(score: (entry: PageIpfs["comments"][number]) => number): PageSortFile["scoreAll"] {
    return ({ comments }) => new Map(comments.map((entry) => [entry.commentUpdate.cid, score(entry)]));
}
