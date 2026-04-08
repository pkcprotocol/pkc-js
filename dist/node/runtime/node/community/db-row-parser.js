import { createSchemaRowParser } from "../../../schema/schema-util.js";
import { CommentIpfsSchema, CommentUpdateSchema, CommentUpdateTableRowSchema, CommentsTableRowSchema } from "../../../publications/comment/schema.js";
import { CommentEditsTableRowSchema } from "../../../publications/comment-edit/schema.js";
import { VoteTablesRowSchema } from "../../../publications/vote/schema.js";
const parsePrefixedCommentIpfsSchema = createSchemaRowParser(CommentIpfsSchema.extend({
    extraProps: CommentsTableRowSchema.shape.extraProps
}), { prefix: "commentIpfs_", validate: false });
const parsePrefixedCommentUpdateSchema = createSchemaRowParser(CommentUpdateSchema, { prefix: "commentUpdate_", validate: false });
const parseCommentsTableRowSchema = createSchemaRowParser(CommentsTableRowSchema, { validate: false });
const parseCommentUpdatesTableRowSchema = createSchemaRowParser(CommentUpdateTableRowSchema, { validate: false });
const parseCommentEditsTableRowSchema = createSchemaRowParser(CommentEditsTableRowSchema, { validate: false });
const parseVotesTableRowSchema = createSchemaRowParser(VoteTablesRowSchema, { validate: false });
export function parsePrefixedComment(row) {
    if (row["commentIpfs_depth"] === 0)
        delete row["commentIpfs_postCid"];
    const commentIpfsParsed = parsePrefixedCommentIpfsSchema(row);
    const commentUpdateParsed = parsePrefixedCommentUpdateSchema(row);
    return {
        comment: commentIpfsParsed.data,
        commentUpdate: commentUpdateParsed.data,
        extras: { ...commentIpfsParsed.extras, ...commentUpdateParsed.extras }
    };
}
export function parseCommentsTableRow(row) {
    const { data } = parseCommentsTableRowSchema(row);
    return data;
}
export function parseCommentUpdateRow(row) {
    const { data } = parseCommentUpdatesTableRowSchema(row);
    return data;
}
export function parseCommentEditsRow(row) {
    const { data } = parseCommentEditsTableRowSchema(row);
    return data;
}
export function parseVoteRow(row) {
    const { data } = parseVotesTableRowSchema(row);
    return data;
}
//# sourceMappingURL=db-row-parser.js.map