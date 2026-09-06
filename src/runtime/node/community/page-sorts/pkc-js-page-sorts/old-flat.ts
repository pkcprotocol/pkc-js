import { oldScore } from "../../../../../pages/util.js";
import { scoreAllFromPerCommentScore } from "./util.js";
import type { PageSortFileFactory } from "../../../../../community/types.js";

const oldFlat: PageSortFileFactory = () => ({
    sortName: "oldFlat",
    description: "Oldest first over the flattened reply subtree",
    optionInputs: [], // reads nothing beyond the reserved options (maxAge, pinnedFirst, exclude*)
    scope: "replies",
    flat: true,
    scoreAll: scoreAllFromPerCommentScore(oldScore)
});

export default oldFlat;
