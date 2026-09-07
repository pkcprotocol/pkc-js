import { hotScore } from "../../../../../pages/util.js";
import { perCommentScore } from "./util.js";
import type { PageSortFileFactory } from "../../../../../community/types.js";

const hot: PageSortFileFactory = () => ({
    sortName: "hot",
    description: "Reddit-style hot ranking: votes weighted by age",
    optionInputs: [], // reads nothing beyond the reserved options (maxAge, pinnedFirst, exclude*)
    score: perCommentScore(hotScore)
});

export default hot;
