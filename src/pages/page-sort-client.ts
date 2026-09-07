import { PKCError } from "../pkc-error.js";
import { PageSortFileFactorySchema } from "../community/schema.js";
import { getEquivalentCommunityAddresses } from "../util.js";
import { parseReservedPageSortOptions, type ParsedReservedPageSortOptions } from "./page-sort-options.js";
import type { CommunityPageSortSetting, PageSortFile, PageSortFileFactoryInput } from "../community/types.js";
import type { PageIpfs, PageSortDb, PageSortExclusionOptionName } from "./types.js";

// Client-side page sorting (issue #73, docs/protocol/page-sorts.md "Client-side re-sorting"). Browser-safe: no
// database, only what a page entry carries. The community publishes every option a sort runs with in
// community.pageSorts[sortName].publicOptions, so a client holding a page and the package registered under
// community.pageSorts[sortName].name can reproduce the community's own order, or apply any other sort it has.

type PageComment = PageIpfs["comments"][number];

// There is no community database on a client. A factory that prepares statements in its closure still instantiates
// (prepare returns a statement whose execution throws), so the same package works in both places; the RPC settings
// listing uses this facade too.
export function createUnavailablePageSortDb(reason: string): PageSortDb {
    const notAvailable = () => {
        throw Error(reason);
    };
    const lazyStatement = new Proxy({}, { get: () => notAvailable }) as unknown as ReturnType<PageSortDb["prepare"]>;
    return { prepare: () => lazyStatement, exclusionClauses: () => ({ sql: "", params: {} }) };
}

// Build the PageSortFile of a package without a community: what a client does with PKC.pageSorts[name].
export function instantiatePageSortFileWithoutDb({
    factory,
    pageSortSettings
}: {
    factory: PageSortFileFactoryInput;
    pageSortSettings: CommunityPageSortSetting;
}): PageSortFile {
    const parsedFactory = PageSortFileFactorySchema.parse(factory);
    return parsedFactory({ pageSortSettings, db: createUnavailablePageSortDb("The db facade is not available outside a community") });
}

// The reserved exclusions as a client applies them to page entries. Mirrors the SQL clauses in DbHandler
// (exclusionClauses): a comment is removed when commentUpdate.removed is true, deleted when its author's edit says so,
// disapproved when commentUpdate.approved is false, pending when commentUpdate.pendingApproval is true.
export function applyPageSortExclusions({
    comments,
    exclusions,
    communityAddress
}: {
    comments: PageComment[];
    exclusions: Record<PageSortExclusionOptionName, boolean>;
    communityAddress?: string; // the community the page belongs to; needed only for excludeCommentsWithDifferentCommunityAddress
}): PageComment[] {
    const equivalentAddresses = communityAddress ? new Set(getEquivalentCommunityAddresses(communityAddress)) : undefined;
    return comments.filter(({ comment, commentUpdate }) => {
        if (exclusions.excludeRemovedComments && commentUpdate.removed === true) return false;
        if (exclusions.excludeDeletedComments && commentUpdate.edit?.deleted === true) return false;
        if (exclusions.excludeCommentWithApprovedFalse && commentUpdate.approved === false) return false;
        if (exclusions.excludeCommentPendingApproval && commentUpdate.pendingApproval === true) return false;
        if (exclusions.excludeCommentsWithDifferentCommunityAddress && equivalentAddresses) {
            const belongs =
                (comment.communityPublicKey ? equivalentAddresses.has(comment.communityPublicKey) : false) ||
                (comment.communityName ? equivalentAddresses.has(comment.communityName) : false);
            if (!belongs) return false;
        }
        return true;
    });
}

// Pinned placement and the maxAge window, the two reserved options that shape every sort's set and order. Pinned
// comments sort first and bypass the window when pinnedFirst is on (the default), so a sticky never ages out of a
// windowed index; with pinnedFirst off they are ordinary comments. Shared with the community's page generator.
export function partitionPageCommentsForSort({
    comments,
    reserved,
    baseTimestamp
}: {
    comments: PageComment[];
    reserved: Pick<ParsedReservedPageSortOptions, "pinnedFirst" | "maxAgeSeconds">;
    baseTimestamp: number;
}): { pinned: PageComment[]; unpinned: PageComment[] } {
    const pinned = reserved.pinnedFirst ? comments.filter((entry) => entry.commentUpdate.pinned === true) : [];
    let unpinned = reserved.pinnedFirst ? comments.filter((entry) => entry.commentUpdate.pinned !== true) : comments;
    if (typeof reserved.maxAgeSeconds === "number") {
        const timestampLower = baseTimestamp - reserved.maxAgeSeconds;
        unpinned = unpinned.filter((entry) => entry.comment.timestamp >= timestampLower);
    }
    return { pinned, unpinned };
}

// Order pinned then unpinned by descending score. A missing or non-numeric score is a bug in the sort file.
export function orderPageCommentsByScore({
    pinned,
    unpinned,
    scoreOf,
    sortName
}: {
    pinned: PageComment[];
    unpinned: PageComment[];
    scoreOf: (entry: PageComment) => number | undefined;
    sortName: string;
}): PageComment[] {
    const scores = new Map<string, number>();
    for (const entry of [...pinned, ...unpinned]) {
        const score = scoreOf(entry);
        if (typeof score !== "number" || Number.isNaN(score))
            throw Error(`Page sort ${sortName} returned no numeric score for comment ${entry.commentUpdate.cid}`);
        scores.set(entry.commentUpdate.cid, score);
    }
    const byScoreDesc = (a: PageComment, b: PageComment) => scores.get(b.commentUpdate.cid)! - scores.get(a.commentUpdate.cid)!;
    return [...pinned].sort(byScoreDesc).concat([...unpinned].sort(byScoreDesc));
}

// What a UI holds: either the wire entries of a PageIpfs, or the parsed page comments of community.posts.pages /
// comment.replies.pages, which keep the wire entry under `raw`. Sorting returns the same shape it was given.
type SortablePageComment = PageComment | { raw: PageComment };

const toWireEntry = (entry: SortablePageComment): PageComment => ("raw" in entry ? entry.raw : entry);

// Sort a page's comments the way the community would for `file` under `options`: the full option set the sort runs
// with (community.pageSorts[sortName].publicOptions, or the same merge a community does). Applies the reserved
// exclusions, pinned placement and the window, then the file's per-comment `score`. A file with only scoreAll cannot
// be applied on a client: it needs the community database.
export function sortPageComments<T extends SortablePageComment>({
    comments,
    file,
    options,
    baseTimestamp,
    communityAddress
}: {
    comments: T[];
    file: PageSortFile;
    options: Record<string, string>;
    baseTimestamp: number;
    communityAddress?: string;
}): T[] {
    const score = file.score;
    if (!score) throw new PKCError("ERR_PAGE_SORT_FILE_HAS_NO_CLIENT_SCORER", { sortName: file.sortName });
    const reserved = parseReservedPageSortOptions(options);
    const byCid = new Map(comments.map((entry) => [toWireEntry(entry).commentUpdate.cid, entry]));
    const included = applyPageSortExclusions({ comments: comments.map(toWireEntry), exclusions: reserved.exclusions, communityAddress });
    const { pinned, unpinned } = partitionPageCommentsForSort({ comments: included, reserved, baseTimestamp });
    const ordered = orderPageCommentsByScore({
        pinned,
        unpinned,
        sortName: file.sortName,
        scoreOf: (entry) => score({ comment: entry.comment, commentUpdate: entry.commentUpdate, options, baseTimestamp })
    });
    return ordered.map((entry) => byCid.get(entry.commentUpdate.cid)!);
}

// A whole-set scorer from a per-comment one, for the community's generator when a file has only `score`.
export function scoreAllFromScore(score: NonNullable<PageSortFile["score"]>): NonNullable<PageSortFile["scoreAll"]> {
    return ({ comments, options, baseTimestamp }) =>
        new Map(
            comments.map((entry) => [
                entry.commentUpdate.cid,
                score({ comment: entry.comment, commentUpdate: entry.commentUpdate, options, baseTimestamp })
            ])
        );
}
