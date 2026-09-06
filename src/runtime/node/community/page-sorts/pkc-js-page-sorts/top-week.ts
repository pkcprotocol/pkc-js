import { topScore } from "../../../../../pages/util.js";
import { scoreAllFromPerCommentScore } from "./util.js";
import type { PageSortFileFactory } from "../../../../../community/types.js";

const topWeek: PageSortFileFactory = () => ({
    sortName: "topWeek",
    description: "Highest vote score first among comments posted in the last week",
    optionInputs: [], // reads nothing beyond the reserved options (maxAge, pinnedFirst, exclude*)
    defaultOptions: { maxAge: "1w" },
    scoreAll: scoreAllFromPerCommentScore(topScore)
});

export default topWeek;
