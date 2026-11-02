// A flat reply sort that declines everything below the post's direct replies, so its page holds only depth 1 entries and
// looks like a page of direct replies, while those entries still had their own `replies` left out.
export default function flatDirectRepliesOnlyPageSort() {
    return {
        sortName: "flatDirect",
        description: "Newest first, flat, the post's direct replies only",
        flat: true,
        score({ comment }) {
            return comment.depth === 1 ? comment.timestamp : null;
        }
    };
}
