import { topScore } from "../../../../../pages/util.js";
import { scoreAllFromPerCommentScore } from "./util.js";
import type { PageSortFileFactory } from "../../../../../community/types.js";

// The generic top: pair it with options.maxAge for any window the six legacy top* files do not cover
// (`{ name: "top", options: { maxAge: "2w" } }` produces the key `top`).
const top: PageSortFileFactory = () => ({
    sortName: "top",
    description: "Highest vote score first; set maxAge to window it",
    optionInputs: [], // reads nothing beyond the reserved options (maxAge, pinnedFirst, exclude*)
    scoreAll: scoreAllFromPerCommentScore(topScore)
});

export default top;
