import { topScore } from "../../../../../pages/util.js";
import { scoreAllFromPerCommentScore } from "./util.js";
import type { PageSortFileFactory } from "../../../../../community/types.js";

const topAll: PageSortFileFactory = () => ({
    sortName: "topAll",
    description: "Highest vote score first, no time window",
    optionInputs: [], // reads nothing beyond the reserved options (maxAge, pinnedFirst, exclude*)
    scoreAll: scoreAllFromPerCommentScore(topScore)
});

export default topAll;
