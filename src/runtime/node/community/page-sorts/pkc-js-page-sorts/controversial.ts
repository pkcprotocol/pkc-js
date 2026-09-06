import { controversialScore } from "../../../../../pages/util.js";
import { scoreAllFromPerCommentScore } from "./util.js";
import type { PageSortFileFactory } from "../../../../../community/types.js";

const controversial: PageSortFileFactory = () => ({
    sortName: "controversial",
    description: "Comments with many votes split between upvotes and downvotes first",
    optionInputs: [], // reads nothing beyond the reserved options (maxAge, pinnedFirst, exclude*)
    scoreAll: scoreAllFromPerCommentScore(controversialScore)
});

export default controversial;
