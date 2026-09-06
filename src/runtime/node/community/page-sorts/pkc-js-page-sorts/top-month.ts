import { topScore } from "../../../../../pages/util.js";
import { scoreAllFromPerCommentScore } from "./util.js";
import type { PageSortFileFactory } from "../../../../../community/types.js";

const topMonth: PageSortFileFactory = () => ({
    sortName: "topMonth",
    description: "Highest vote score first among comments posted in the last month",
    optionInputs: [], // reads nothing beyond the reserved options (maxAge, pinnedFirst, exclude*)
    defaultOptions: { maxAge: "1M" },
    scoreAll: scoreAllFromPerCommentScore(topScore)
});

export default topMonth;
