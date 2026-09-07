import type { PageSortFile } from "../../../../../community/types.js";
import type { PageIpfs } from "../../../../../pages/types.js";

// The pure built-ins (hot, new, old, best, top*, controversial and the flat variants) all score one comment at a time
// from fields the comment already carries, so they expose the per-comment `score`: it runs on the community (lifted
// to scoreAll by the generator) and on clients re-sorting a page locally. Only `active` needs scoreAll over SQL.
export function perCommentScore(score: (entry: PageIpfs["comments"][number]) => number): NonNullable<PageSortFile["score"]> {
    return ({ comment, commentUpdate }) => score({ comment, commentUpdate });
}
