// Reference implementation of a keyword no-bump page sort, loaded through settings.pages[].path in the
// page-sort tests. It is the `active` built-in with one extra rule: a reply whose content carries one of
// the configured keywords does not bump its thread. Nothing here knows the word "sage"; the board supplies
// its own vocabulary through `noBumpKeywords`, a comma-separated list (page sort options are strings only,
// like challenge options). This is what @pkcprotocol/active-page-sort starts from.
//
// Match mode: the keyword must be a whole line of the content (exact, case-sensitive). A reply saying
// "sage is overused" in prose keeps bumping; a reply whose content is "sage" or has a line "sage" does not.

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

// The same exclusions the community's SQL applies to descendants (db.exclusionClauses), read off the merged options
// a client gets from community.pageSorts[sortName].publicOptions.
const isExcluded = (entry, options) =>
    (options.excludeRemovedComments === "true" && entry.commentUpdate.removed === true) ||
    (options.excludeDeletedComments === "true" && entry.commentUpdate.edit?.deleted === true) ||
    (options.excludeCommentWithApprovedFalse === "true" && entry.commentUpdate.approved === false) ||
    (options.excludeCommentPendingApproval === "true" && entry.commentUpdate.pendingApproval === true);

// Client-side bump score: MAX(timestamp) over the post and the descendants carried in its preloaded reply pages,
// skipping no-bump replies. Same rule as scoreAll below, over what a page entry carries instead of the DB.
const bumpScoreFromEntry = ({ comment, commentUpdate, keywords, options }) => {
    let score = comment.timestamp;
    const walk = (entry) => {
        for (const page of Object.values(entry.commentUpdate.replies?.pages ?? {}))
            for (const child of page.comments) {
                if (isExcluded(child, options)) continue;
                if (!isNoBump(child.comment.content, keywords)) score = Math.max(score, child.comment.timestamp);
                walk(child);
            }
    };
    walk({ comment, commentUpdate });
    return score;
};

export default function activeNoBumpKeywordPageSort({ pageSortSettings }) {
    const keywords = splitKeywords(pageSortSettings.options?.noBumpKeywords);

    return {
        sortName: "active",
        description: "Bump order where replies whose content is one of the configured keywords do not bump the thread",
        scope: "posts",
        optionInputs: [
            {
                option: "noBumpKeywords",
                label: "No-bump keywords",
                description: "Comma-separated list. A reply whose content is exactly one of these lines does not bump its thread.",
                placeholder: "sage,nobump"
            }
        ],
        // Per-comment scorer for clients re-sorting a page locally (no database): walks the nested reply pages the
        // post entry carries. See docs/protocol/page-sorts.md, "Two scoring functions".
        score({ comment, commentUpdate, options }) {
            return bumpScoreFromEntry({ comment, commentUpdate, keywords, options });
        },
        // Whole-set scorer: MAX(timestamp) over each post's descendants, skipping no-bump replies. Descendants of a
        // no-bump reply are still walked, so a normal reply under a no-bump one bumps as usual.
        scoreAll({ comments, db, options }) {
            const root = db.exclusionClauses(options, { comment: "p", update: "cu_root", paramPrefix: "root" });
            const desc = db.exclusionClauses(options, { comment: "c", update: "cu", paramPrefix: "desc" });
            const params = { ...root.params, ...desc.params };
            const keywordMatches = keywords.map((keyword, i) => {
                params[`kw${i}`] = keyword;
                return `(c.content = :kw${i} OR c.content LIKE :kw${i} || char(10) || '%' OR c.content LIKE '%' || char(10) || :kw${i} || char(10) || '%' OR c.content LIKE '%' || char(10) || :kw${i})`;
            });
            const noBumpExpr = keywordMatches.length > 0 ? `CASE WHEN ${keywordMatches.join(" OR ")} THEN 1 ELSE 0 END` : "0";
            const sql = `
                WITH RECURSIVE descendants AS (
                    SELECT p.cid AS post_cid, p.cid AS current_cid, p.timestamp AS ts, 0 AS no_bump
                    FROM comments p INNER JOIN commentUpdates cu_root ON p.cid = cu_root.cid
                    WHERE p.depth = 0 ${root.sql ? `AND ${root.sql}` : ""}
                    UNION ALL
                    SELECT d.post_cid, c.cid, c.timestamp, ${noBumpExpr}
                    FROM comments c INNER JOIN commentUpdates cu ON c.cid = cu.cid
                    JOIN descendants d ON c.parentCid = d.current_cid
                    ${desc.sql ? `WHERE ${desc.sql}` : ""}
                )
                SELECT post_cid, MAX(CASE WHEN no_bump = 1 THEN NULL ELSE ts END) AS score FROM descendants GROUP BY post_cid
            `;
            const rows = db.prepare(sql).all(params);
            const scores = new Map(rows.map((row) => [row.post_cid, row.score]));
            return new Map(
                comments.map((entry) => [entry.commentUpdate.cid, scores.get(entry.commentUpdate.cid) ?? entry.comment.timestamp])
            );
        }
    };
}
