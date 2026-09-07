import { topScore } from "../../../../../pages/util.js";
import { perCommentScore } from "./util.js";
import type { PageSortFileFactory } from "../../../../../community/types.js";

const topAll: PageSortFileFactory = () => ({
    sortName: "topAll",
    description: "Highest vote score first, no time window",
    optionInputs: [], // reads nothing beyond the reserved options (maxAge, pinnedFirst, exclude*)
    score: perCommentScore(topScore)
});

export default topAll;
