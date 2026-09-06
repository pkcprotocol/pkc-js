import { newScore } from "../../../../../pages/util.js";
import { scoreAllFromPerCommentScore } from "./util.js";
import type { PageSortFileFactory } from "../../../../../community/types.js";

const newFlat: PageSortFileFactory = () => ({
    sortName: "newFlat",
    description: "Newest first over the flattened reply subtree",
    optionInputs: [], // reads nothing beyond the reserved options (maxAge, pinnedFirst, exclude*)
    scope: "replies",
    flat: true,
    scoreAll: scoreAllFromPerCommentScore(newScore)
});

export default newFlat;
