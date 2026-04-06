import { createSchemaRowParser } from "../../../schema/schema-util.js";
import {
    CommentIpfsSchema,
    CommentUpdateSchema,
    CommentUpdateTableRowSchema,
    CommentsTableRowSchema
} from "../../../publications/comment/schema.js";
import { CommentEditsTableRowSchema } from "../../../publications/comment-edit/schema.js";
import { VoteTablesRowSchema } from "../../../publications/vote/schema.js";
import type { CommentUpdateType, CommentsTableRow, CommentUpdatesRow, CommentIpfsType } from "../../../publications/comment/types.js";
import type { CommentEditsTableRow } from "../../../publications/comment-edit/types.js";
import type { VotesTableRow } from "../../../publications/vote/types.js";

// Types for query results with prefixed columns
export type CommentIpfsPrefixedColumns = {
    [K in keyof CommentsTableRow as `commentIpfs_${string & K}`]?: CommentsTableRow[K];
};

export type CommentUpdatePrefixedColumns = {
    [K in keyof CommentUpdatesRow as `commentUpdate_${string & K}`]?: CommentUpdatesRow[K];
};

export type PrefixedCommentRow = CommentIpfsPrefixedColumns & CommentUpdatePrefixedColumns;

const parsePrefixedCommentIpfsSchema = createSchemaRowParser(
    CommentIpfsSchema.extend({
        extraProps: CommentsTableRowSchema.shape.extraProps
    }),
    { prefix: "commentIpfs_", validate: false }
);
const parsePrefixedCommentUpdateSchema = createSchemaRowParser(CommentUpdateSchema, { prefix: "commentUpdate_", validate: false });
const parseCommentsTableRowSchema = createSchemaRowParser(CommentsTableRowSchema, { validate: false });
const parseCommentUpdatesTableRowSchema = createSchemaRowParser(CommentUpdateTableRowSchema, { validate: false });
const parseCommentEditsTableRowSchema = createSchemaRowParser(CommentEditsTableRowSchema, { validate: false });
const parseVotesTableRowSchema = createSchemaRowParser(VoteTablesRowSchema, { validate: false });

export function parsePrefixedComment(row: PrefixedCommentRow): {
    comment: CommentIpfsType;
    commentUpdate: CommentUpdateType;
    extras: Record<string, unknown>;
} {
    if (row["commentIpfs_depth"] === 0) delete row["commentIpfs_postCid"];

    const commentIpfsParsed = parsePrefixedCommentIpfsSchema(row);
    const commentUpdateParsed = parsePrefixedCommentUpdateSchema(row);

    return {
        comment: commentIpfsParsed.data,
        commentUpdate: commentUpdateParsed.data,
        extras: { ...commentIpfsParsed.extras, ...commentUpdateParsed.extras }
    };
}

export function parseCommentsTableRow(row: unknown): CommentsTableRow {
    const { data } = parseCommentsTableRowSchema(row as Record<string, unknown>);
    return data as CommentsTableRow;
}

export function parseCommentUpdateRow(row: unknown): CommentUpdatesRow {
    const { data } = parseCommentUpdatesTableRowSchema(row as Record<string, unknown>);
    return data as CommentUpdatesRow;
}

export function parseCommentEditsRow(row: unknown): CommentEditsTableRow {
    const { data } = parseCommentEditsTableRowSchema(row as Record<string, unknown>);
    return data as CommentEditsTableRow;
}

export function parseVoteRow(row: unknown): VotesTableRow {
    const { data } = parseVotesTableRowSchema(row as Record<string, unknown>);
    return data as VotesTableRow;
}
