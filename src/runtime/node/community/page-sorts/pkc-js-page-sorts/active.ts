import type { PageSortFileFactory } from "../../../../../community/types.js";

// Bump order: a post's score is the newest timestamp among the post and every descendant that survives the
// exclusion options (a removed reply does not bump, by default). This is a whole-set aggregate over the reply tree,
// which is why the page sort contract is scoreAll over SQL rather than a per-comment scorer. The query is the one
// db-handler used to own; the exclusions come from the facade so this file and the rest of pkc-js cannot drift
// apart on what "removed" means.
const active: PageSortFileFactory = () => {
    return {
        sortName: "active",
        description: "Most recently bumped first: posts ordered by the newest reply anywhere in their thread",
        optionInputs: [], // reads nothing beyond the reserved options (maxAge, pinnedFirst, exclude*)
        scope: "posts",
        scoreAll: ({ comments, db, options }) => {
            const root = db.exclusionClauses(options, { comment: "p", update: "cu_root", paramPrefix: "activeRoot" });
            const descendants = db.exclusionClauses(options, { comment: "c", update: "cu", paramPrefix: "activeDesc" });
            const sql = `
                WITH RECURSIVE descendants AS (
                    SELECT p.cid AS post_cid, p.cid AS current_cid, p.timestamp AS ts
                    FROM comments p INNER JOIN commentUpdates cu_root ON p.cid = cu_root.cid
                    WHERE p.depth = 0${root.sql ? ` AND ${root.sql}` : ""}
                    UNION ALL
                    SELECT d.post_cid, c.cid, c.timestamp
                    FROM comments c INNER JOIN commentUpdates cu ON c.cid = cu.cid
                    JOIN descendants d ON c.parentCid = d.current_cid
                    ${descendants.sql ? `WHERE ${descendants.sql}` : ""}
                )
                SELECT post_cid, MAX(ts) AS score FROM descendants GROUP BY post_cid
            `;
            const rows = db.prepare(sql).all({ ...root.params, ...descendants.params }) as { post_cid: string; score: number }[];
            const scores = new Map(rows.map((row) => [row.post_cid, row.score]));
            return new Map(
                comments.map((entry) => [entry.commentUpdate.cid, scores.get(entry.commentUpdate.cid) ?? entry.comment.timestamp])
            );
        }
    };
};

export default active;
