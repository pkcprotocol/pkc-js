// The one definition of how a signed CommentUpdate maps to a `comment_updates` row and back (issue #572).
//
// The community signs a CommentUpdate once (comment-updates.ts) and then ships it two ways: serialized into the
// post-updates MFS folder as is, and as an entry of a page, rebuilt from the `comment_updates` row. Both must be the
// same signed record, or a page embeds something its comment did not sign. The row has a column per
// CommentUpdateSchema key, so a key outside the schema (a challenge's `commentUpdate: { tip }`) would drop out of the
// page entry while still listed in `signature.signedPropertyNames`. Such keys travel in `extraProps`, as they do in
// the comments, commentEdits, commentModerations and votes tables.
//
// `extraProps` is a snapshot of the record that was signed, not a source of truth: comment_updates is dropped and
// rebuilt on every DB_VERSION bump, and the update cycle re-derives the keys from comments.challengeCommentUpdate.
//
// Row -> record is done by createPositionalCommentRowMapper (db-row-parser.ts), which calls
// spreadCommentUpdateExtraProps; keep the two directions in this file's terms.

import { CommentUpdateSchema } from "../../../publications/comment/schema.js";
import type { CommentUpdatesTableRowInsert, CommentUpdateType } from "../../../publications/comment/types.js";

const commentUpdateSchemaKeys: ReadonlySet<string> = new Set(Object.keys(CommentUpdateSchema.shape));

// Keys of a signed CommentUpdate that CommentUpdateSchema does not know: the ones that go to `extraProps`
export function commentUpdateExtraKeys(update: Record<string, unknown>): string[] {
    return Object.keys(update).filter((key) => !commentUpdateSchemaKeys.has(key));
}

// The row fields that exist only in the DB: not part of the signed record, so never extras
type CommentUpdateDbOnlyFields = Pick<
    CommentUpdatesTableRowInsert,
    "replies" | "postUpdatesBucket" | "publishedToPostUpdatesMFS" | "insertedAt"
>;

// Signed record + the DB-only fields -> row. Only the signed record decides what an extra is: its unknown keys move
// into `extraProps`. `dbOnlyFields.replies` is the DB form (CID refs) of the record's `replies`
export function commentUpdateToDbRow({
    update,
    dbOnlyFields
}: {
    update: CommentUpdateType;
    dbOnlyFields: CommentUpdateDbOnlyFields;
}): CommentUpdatesTableRowInsert {
    const record: Record<string, unknown> = { ...update };
    const extraProps: Record<string, unknown> = {};
    for (const key of commentUpdateExtraKeys(update)) {
        const value = record[key];
        delete record[key];
        if (value !== undefined) extraProps[key] = value;
    }
    // the DB-only fields go on last, so an extra that shares a name with one (insertedAt) cannot touch the column
    const row: Record<string, unknown> = { ...record, ...dbOnlyFields };
    if (Object.keys(extraProps).length > 0) row.extraProps = extraProps;
    return row as CommentUpdatesTableRowInsert;
}

// Row -> signed record, the extras part: put the `extraProps` keys back on the record. A key the schema knows is never
// overwritten by an extra (the split above never produces one)
export function spreadCommentUpdateExtraProps(record: Record<string, unknown>, extraProps: unknown): void {
    if (!extraProps || typeof extraProps !== "object") return;
    for (const [key, value] of Object.entries(extraProps)) {
        if (value === null || value === undefined || commentUpdateSchemaKeys.has(key)) continue;
        record[key] = value;
    }
}
