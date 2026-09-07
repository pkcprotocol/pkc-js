import type { PageSortFile } from "../../../../../community/types.js";
import type { PageIpfs } from "../../../../../pages/types.js";

// The built-ins all score one comment at a time from fields the comment already carries, so they wrap the legacy
// scoring functions of src/pages/util.ts as the file's `score`: the same function runs on the community and on
// clients re-sorting a page locally.
export function perCommentScore(score: (entry: PageIpfs["comments"][number]) => number): PageSortFile["score"] {
    return ({ comment, commentUpdate }) => score({ comment, commentUpdate });
}
