import { topScore } from "../../../../../pages/util.js";
import { scoreAllFromPerCommentScore } from "./util.js";
import type { PageSortFileFactory } from "../../../../../community/types.js";

const topDay: PageSortFileFactory = () => ({
    sortName: "topDay",
    description: "Highest vote score first among comments posted in the last day",
    optionInputs: [], // reads nothing beyond the reserved options (maxAge, pinnedFirst, exclude*)
    defaultOptions: { maxAge: "1d" },
    scoreAll: scoreAllFromPerCommentScore(topScore)
});

export default topDay;
