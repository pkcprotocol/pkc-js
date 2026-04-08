import type { CommentUpdateType, CommentsTableRow, CommentUpdatesRow, CommentIpfsType } from "../../../publications/comment/types.js";
import type { CommentEditsTableRow } from "../../../publications/comment-edit/types.js";
import type { VotesTableRow } from "../../../publications/vote/types.js";
export type CommentIpfsPrefixedColumns = {
    [K in keyof CommentsTableRow as `commentIpfs_${string & K}`]?: CommentsTableRow[K];
};
export type CommentUpdatePrefixedColumns = {
    [K in keyof CommentUpdatesRow as `commentUpdate_${string & K}`]?: CommentUpdatesRow[K];
};
export type PrefixedCommentRow = CommentIpfsPrefixedColumns & CommentUpdatePrefixedColumns;
export declare function parsePrefixedComment(row: PrefixedCommentRow): {
    comment: CommentIpfsType;
    commentUpdate: CommentUpdateType;
    extras: Record<string, unknown>;
};
export declare function parseCommentsTableRow(row: unknown): CommentsTableRow;
export declare function parseCommentUpdateRow(row: unknown): CommentUpdatesRow;
export declare function parseCommentEditsRow(row: unknown): CommentEditsTableRow;
export declare function parseVoteRow(row: unknown): VotesTableRow;
