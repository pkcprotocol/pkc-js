// A page sort that reports the `sortName` of the settings.pages entry it was loaded for (issue #483). The factory
// writes what it saw into `description`, which the community publishes under community.pageSorts, and
// validatePageSortSettings throws unless the entry's sortName equals options.expectedSortName. Its own sortName is
// "echo", so an entry without an override publishes under that key. Ranks newest first, or oldest first with
// options.order = "old", so one file listed twice under two keys can produce two different pages.

export default function sortNameEchoPageSort({ pageSortSettings }) {
    return {
        sortName: "echo",
        description: `factory saw sortName ${String(pageSortSettings.sortName)}`,
        optionInputs: [
            {
                option: "expectedSortName",
                label: "Expected sortName",
                description: "validatePageSortSettings throws unless the entry carries it"
            },
            { option: "order", label: "Order", description: "new (default) or old" }
        ],
        validatePageSortSettings({ pageSortSettings }) {
            const expected = pageSortSettings.options?.expectedSortName;
            if (expected !== undefined && pageSortSettings.sortName !== expected)
                throw Error(`validatePageSortSettings saw sortName ${String(pageSortSettings.sortName)}, expected ${expected}`);
        },
        score({ comment, options }) {
            return options.order === "old" ? -comment.timestamp : comment.timestamp;
        }
    };
}
