// Reference implementation of a keyword no-bump page sort, loaded through settings.pages[].path in the
// page-sort tests. It is the `active` built-in with one extra rule: a reply whose content carries one of
// the configured keywords does not bump its thread. Nothing here knows the word "sage"; the board supplies
// its own vocabulary through `noBumpKeywords`, a comma-separated list (page sort options are strings only,
// like challenge options). This is what @pkcprotocol/active-page-sort starts from.
//
// Match mode: the keyword must be a whole line of the content (exact, case-sensitive). A reply saying
// "sage is overused" in prose keeps bumping; a reply whose content is "sage" or has a line "sage" does not.
//
// The file is `score`-only and declares `requireReplies`, so pkc-js hands it every descendant of the scored
// post as a flat list (the community builds it from the database, a client from the reply pages it walked),
// already reduced by the sort's exclusion options. The file reads nothing but content and timestamp.

const splitKeywords = (raw) =>
    (raw ?? "")
        .split(",")
        .map((keyword) => keyword.trim())
        .filter(Boolean);

const isNoBump = (content, keywords) => {
    if (typeof content !== "string") return false;
    const lines = content.split("\n");
    return keywords.some((keyword) => lines.includes(keyword));
};

export default function activeNoBumpKeywordPageSort({ pageSortSettings }) {
    const keywords = splitKeywords(pageSortSettings.options?.noBumpKeywords);

    return {
        sortName: "active",
        description: "Bump order where replies whose content is one of the configured keywords do not bump the thread",
        scope: "posts",
        requireReplies: true,
        optionInputs: [
            {
                option: "noBumpKeywords",
                label: "No-bump keywords",
                description: "Comma-separated list. A reply whose content is exactly one of these lines does not bump its thread.",
                placeholder: "sage,nobump"
            }
        ],
        // MAX(timestamp) over the post and its descendants, skipping no-bump replies. Descendants of a no-bump reply
        // are still counted, so a normal reply under a no-bump one bumps as usual.
        score({ comment, replies }) {
            let score = comment.timestamp;
            for (const reply of replies) if (!isNoBump(reply.comment.content, keywords)) score = Math.max(score, reply.comment.timestamp);
            return score;
        }
    };
}
