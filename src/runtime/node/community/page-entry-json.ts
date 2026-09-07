import { Buffer } from "buffer";
import type { PageIpfs } from "../../../pages/types.js";
import type { CommentUpdateType } from "../../../publications/comment/types.js";

// The JSON a page holds for one comment: `{"comment":C,"commentUpdate":U}` where U is the CommentUpdate row's
// fields with the wire `replies` (commentUpdates.wireReplies, the canonical JSON signed with the update) spliced in
// at its sorted position. Entries come from the positional row mapper with sorted keys, so plain JSON.stringify of
// each part is canonical and the splice reproduces safe-stable-stringify of the resolved entry byte for byte
// (issue #351). `head` and `tail` are the bytes around the replies; an entry without replies is `head` alone.

type PageComment = PageIpfs["comments"][number];

const REPLIES_KEY = "replies";

export type PageEntryJsonParts = { head: string; tail: string; hasReplies: boolean };

// `replies` on a loaded entry is the DB-format CID refs (or absent); it is never serialized itself
export function pageEntryJsonParts(entry: PageComment, hasReplies: boolean): PageEntryJsonParts {
    if (!hasReplies) return { head: JSON.stringify(entry), tail: "", hasReplies: false }; // the entry as loaded, untouched
    const { replies: _dbReplies, ...rest } = entry.commentUpdate as CommentUpdateType & { replies?: unknown };
    const prefix = `{"comment":${JSON.stringify(entry.comment)},"commentUpdate":`;
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) (key < REPLIES_KEY ? before : after)[key] = value;
    const beforeJson = JSON.stringify(before); // "{...}" or "{}"
    const afterJson = JSON.stringify(after);
    const head = `${prefix}${beforeJson.length > 2 ? `${beforeJson.slice(0, -1)},` : "{"}"${REPLIES_KEY}":`;
    const tail = `${afterJson.length > 2 ? `,${afterJson.slice(1)}` : "}"}}`;
    return { head, tail, hasReplies: true };
}

export function pageEntryJson(parts: PageEntryJsonParts, wireReplies?: string): string {
    if (!parts.hasReplies) return parts.head;
    if (wireReplies === undefined) throw new Error("page entry has replies but no wire replies to splice");
    return parts.head + wireReplies + parts.tail;
}

// UTF-8 size of pageEntryJson, from the stored replies' byte length alone
export function pageEntryJsonBytes(parts: PageEntryJsonParts, wireRepliesBytes?: number): number {
    if (!parts.hasReplies) return Buffer.byteLength(parts.head);
    if (wireRepliesBytes === undefined) throw new Error("page entry has replies but no wire replies size");
    return Buffer.byteLength(parts.head) + wireRepliesBytes + Buffer.byteLength(parts.tail);
}
