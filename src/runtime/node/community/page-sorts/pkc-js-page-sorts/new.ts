import { newScore } from "../../../../../pages/util.js";
import { perCommentScore } from "./util.js";
import type { PageSortFileFactory } from "../../../../../community/types.js";

const newSort: PageSortFileFactory = () => ({
    sortName: "new",
    description: "Newest first",
    optionInputs: [], // reads nothing beyond the reserved options (maxAge, pinnedFirst, exclude*)
    score: perCommentScore(newScore)
});

export default newSort;
