import { topScore } from "../../../../../pages/util.js";
import { perCommentScore } from "./util.js";
import type { PageSortFileFactory } from "../../../../../community/types.js";

const topMonth: PageSortFileFactory = () => ({
    sortName: "topMonth",
    description: "Highest vote score first among comments posted in the last month",
    optionInputs: [], // reads nothing beyond the reserved options (maxAge, pinnedFirst, exclude*)
    defaultOptions: { maxAge: "1M" },
    score: perCommentScore(topScore)
});

export default topMonth;
