import { newScore } from "../../../../../pages/util.js";
import { scoreAllFromPerCommentScore } from "./util.js";
import type { PageSortFileFactory } from "../../../../../community/types.js";

const newSort: PageSortFileFactory = () => ({
    sortName: "new",
    description: "Newest first",
    optionInputs: [], // reads nothing beyond the reserved options (maxAge, pinnedFirst, exclude*)
    scoreAll: scoreAllFromPerCommentScore(newScore)
});

export default newSort;
