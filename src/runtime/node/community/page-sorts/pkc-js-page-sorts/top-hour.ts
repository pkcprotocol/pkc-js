import { topScore } from "../../../../../pages/util.js";
import { scoreAllFromPerCommentScore } from "./util.js";
import type { PageSortFileFactory } from "../../../../../community/types.js";

const topHour: PageSortFileFactory = () => ({
    sortName: "topHour",
    description: "Highest vote score first among comments posted in the last hour",
    optionInputs: [], // reads nothing beyond the reserved options (maxAge, pinnedFirst, exclude*)
    defaultOptions: { maxAge: "1h" },
    scoreAll: scoreAllFromPerCommentScore(topScore)
});

export default topHour;
