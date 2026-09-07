import { oldScore } from "../../../../../pages/util.js";
import { perCommentScore } from "./util.js";
import type { PageSortFileFactory } from "../../../../../community/types.js";

const old: PageSortFileFactory = () => ({
    sortName: "old",
    description: "Oldest first",
    optionInputs: [], // reads nothing beyond the reserved options (maxAge, pinnedFirst, exclude*)
    score: perCommentScore(oldScore)
});

export default old;
