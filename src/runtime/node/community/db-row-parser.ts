import {
    coerceSchemaRowBoolean,
    coerceSchemaRowJson,
    collectSchemaRowCoercions,
    createSchemaRowParser
} from "../../../schema/schema-util.js";
import {
    CommentIpfsSchema,
    CommentUpdateSchema,
    CommentUpdateTableRowSchema,
    CommentsTableRowSchema
} from "../../../publications/comment/schema.js";
import { CommentEditsTableRowSchema } from "../../../publications/comment-edit/schema.js";
import { VoteTablesRowSchema } from "../../../publications/vote/schema.js";
import { CommentModerationsTableRowSchema } from "../../../publications/comment-moderation/schema.js";
import type { CommentUpdateType, CommentsTableRow, CommentUpdatesRow, CommentIpfsType } from "../../../publications/comment/types.js";
import { withSortedKeys, withSortedKeysDeep } from "../../../util.js";
import type { CommentEditsTableRow } from "../../../publications/comment-edit/types.js";
import type { VotesTableRow } from "../../../publications/vote/types.js";
import type { CommentModerationTableRow } from "../../../publications/comment-moderation/types.js";

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
const parseCommentModerationRowSchema = createSchemaRowParser(CommentModerationsTableRowSchema, { validate: false });

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

export function parseCommentModerationRow(row: unknown): CommentModerationTableRow {
    const { data } = parseCommentModerationRowSchema(row as Record<string, unknown>);
    return data as CommentModerationTableRow;
}

// A compiled mapper for the page queries (issue #351): the same comment/CommentUpdate entry the prefixed schema row
// parser produces, from a `.raw(true)` array row instead of an object row. Per column it applies the parser's
// coercions (booleans from 0/1, JSON columns parsed), drops null, spreads `extraProps` into the comment (the legacy
// `subplebbitAddress` rows lose the community fields, as before) and drops `postCid` at depth 0. Column order is the
// mapper's own select list; any trailing column a query adds (tree_parent, tree_level) is ignored.
//
// Every object it builds lists its keys in sorted order (columns are assigned sorted, parsed JSON values are
// re-sorted deep, an extraProps spread re-sorts the comment), and the tree assembly in DbHandler keeps that up, so a
// page entry serializes canonically through plain JSON.stringify: byte-identical to safe-stable-stringify at native
// speed, which is how the page generator builds pages (issue #351; pinned by
// test/node/community/page-generation/nested-posts-pages.page.generation.community.test.ts).
type ColumnKind = 0 | 1 | 2; // plain | boolean | json
type CompiledColumn = { key: string; kind: ColumnKind };

const commentIpfsCoercions = collectSchemaRowCoercions({ ...CommentIpfsSchema.shape, extraProps: CommentsTableRowSchema.shape.extraProps });
const commentUpdateCoercions = collectSchemaRowCoercions(CommentUpdateSchema.shape);

function compileColumns(columns: string[], coercions: { booleanKeys: Set<string>; jsonKeys: Set<string> }): CompiledColumn[] {
    return columns.map((key) => ({ key, kind: coercions.booleanKeys.has(key) ? 1 : coercions.jsonKeys.has(key) ? 2 : 0 }));
}

const sortedUnique = (columns: string[]): string[] => [...new Set(columns)].sort();

function assignColumns(target: Record<string, unknown>, row: unknown[], offset: number, columns: CompiledColumn[], prefix: string) {
    for (let i = 0; i < columns.length; i++) {
        const value = row[offset + i];
        if (value === null || value === undefined) continue;
        const { key, kind } = columns[i];
        target[key] =
            kind === 0 ? value : kind === 1 ? coerceSchemaRowBoolean(value) : withSortedKeysDeep(coerceSchemaRowJson(value, key, prefix));
    }
}

export type PositionalCommentRowMapper = {
    commentIpfsCols: string[];
    commentUpdateCols: string[];
    // The SELECT list in the mapper's column order, each column through the given expression (usually `alias.col`)
    selectList: (commentColumn: (col: string) => string, updateColumn: (col: string) => string) => string;
    map: (row: unknown[]) => { comment: CommentIpfsType; commentUpdate: CommentUpdateType };
};

export function createPositionalCommentRowMapper(cols: {
    commentIpfsCols: string[];
    commentUpdateCols: string[];
}): PositionalCommentRowMapper {
    const commentIpfsCols = sortedUnique(cols.commentIpfsCols);
    const commentUpdateCols = sortedUnique(cols.commentUpdateCols);
    const commentColumns = compileColumns(commentIpfsCols, commentIpfsCoercions);
    const updateColumns = compileColumns(commentUpdateCols, commentUpdateCoercions);
    const updateOffset = commentColumns.length;
    return {
        commentIpfsCols,
        commentUpdateCols,
        selectList: (commentColumn, updateColumn) =>
            [
                ...commentIpfsCols.map((col) => `${commentColumn(col)} AS commentIpfs_${col}`),
                ...commentUpdateCols.map((col) => `${updateColumn(col)} AS commentUpdate_${col}`)
            ].join(", "),
        map: (row) => {
            let comment: Record<string, unknown> = {};
            assignColumns(comment, row, 0, commentColumns, "commentIpfs_");
            if (comment.depth === 0) delete comment.postCid;
            const extraProps = comment.extraProps;
            delete comment.extraProps;
            if (extraProps && typeof extraProps === "object") {
                for (const [key, value] of Object.entries(extraProps)) {
                    if (value === null || value === undefined)
                        delete comment[key]; // a null extra prop hid the column, as the spread did
                    else comment[key] = value;
                }
                if ("subplebbitAddress" in comment) {
                    // pre-wire-format rows: the original CommentIpfs had no community fields, keep its CID reproducible
                    delete comment.communityPublicKey;
                    delete comment.communityName;
                }
                comment = withSortedKeys(comment);
            }
            const commentUpdate: Record<string, unknown> = {};
            assignColumns(commentUpdate, row, updateOffset, updateColumns, "commentUpdate_");
            return { comment: comment as CommentIpfsType, commentUpdate: commentUpdate as CommentUpdateType };
        }
    };
}
