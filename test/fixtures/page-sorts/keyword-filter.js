// A sort that declines comments: newest first, minus any comment whose content has a line equal to one of the
// configured keywords. `score` returning null drops the comment from this sort's pages on the community and on a
// client re-sorting with the same options, a pinned comment included; nothing else about the comment changes.
// The shape a "no nsfw" or "images only" package would take.
const splitKeywords = (raw) =>
    (raw ?? "")
        .split(",")
        .map((keyword) => keyword.trim())
        .filter(Boolean);

export default function keywordFilterPageSort({ pageSortSettings }) {
    const keywords = splitKeywords(pageSortSettings.options?.dropKeywords);
    return {
        sortName: "filtered",
        description: "Newest first, without comments carrying a configured keyword",
        optionInputs: [
            { option: "dropKeywords", label: "Drop keywords", description: "Comma-separated list of lines that hide a comment" }
        ],
        score({ comment }) {
            const lines = typeof comment.content === "string" ? comment.content.split("\n") : [];
            if (keywords.some((keyword) => lines.includes(keyword))) return null;
            return comment.timestamp;
        }
    };
}
