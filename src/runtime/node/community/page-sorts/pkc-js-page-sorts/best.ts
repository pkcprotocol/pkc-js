import { bestScore } from "../../../../../pages/util.js";
import { scoreAllFromPerCommentScore } from "./util.js";
import type { PageSortFileFactory } from "../../../../../community/types.js";

const best: PageSortFileFactory = () => ({
    sortName: "best",
    description: "Wilson score confidence of the vote ratio",
    optionInputs: [], // reads nothing beyond the reserved options (maxAge, pinnedFirst, exclude*)
    scoreAll: scoreAllFromPerCommentScore(bestScore)
});

export default best;
