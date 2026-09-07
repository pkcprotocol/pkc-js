// A sort usable under posts and replies that ranks by the size of the scored comment's subtree. With
// `requireReplies`, a post receives every descendant surviving the sort's exclusions and a reply receives its own
// descendants, on the community (from the database) and on a client (from the reply pages the caller walked).
export default function mostRepliesPageSort() {
    return {
        sortName: "mostReplies",
        description: "Largest reply subtree first, ties by age (newest first)",
        requireReplies: true,
        score({ comment, replies }) {
            return replies.length * 1e10 + comment.timestamp;
        }
    };
}
