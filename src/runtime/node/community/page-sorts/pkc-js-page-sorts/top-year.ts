import { topScore } from "../../../../../pages/util.js";
import { perCommentScore } from "./util.js";
import type { PageSortFileFactory } from "../../../../../community/types.js";

const topYear: PageSortFileFactory = () => ({
    sortName: "topYear",
    description: "Highest vote score first among comments posted in the last year",
    optionInputs: [], // reads nothing beyond the reserved options (maxAge, pinnedFirst, exclude*)
    defaultOptions: { maxAge: "1y" },
    score: perCommentScore(topScore)
});

export default topYear;
