// A page sort whose scorer always throws, for the failure-handling tests. The factory itself succeeds so the
// entry passes config validation; the failure only shows up at generation time.
export default function throwingPageSort() {
    return {
        sortName: "throwing",
        description: "Always throws inside scoreAll",
        scoreAll() {
            throw new Error("throwing page sort fixture: scoreAll failed on purpose");
        }
    };
}
