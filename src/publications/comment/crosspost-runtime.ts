// Runtime handling of comment.crosspost. See docs/protocol/crossposts.md and issue #251.
//
// crosspost.cid hashes the embedded record whole, so the record a Comment instance exposes cannot be
// the same object the wire carries: writing a runtime field onto it would stop it reproducing its own
// cid, break page generation and get the comment purged by the signature sweep.
//
// So comment.crosspost is a copy of the spine — one shallow copy per chain level plus a copy of each
// level's author — while comment.raw.comment.crosspost stays exactly what was signed. Everything
// below an author (signature, flairs, avatar) is shared by reference, since nothing mutates it.
//
// The only runtime field written into the copy is author.nameResolved. Deliberately not address,
// publicKey or shortAddress, which the Comment's own author gets: those would have to be stripped
// again before the record could be republished as a crosspost, and stripping is not safely reversible
// on a record whose author legitimately carries `address` (old wire format). One field that is never
// legitimate on the wire, and is already rejected by check 3 of _verifyCrosspost if it arrives there,
// is reversible by deletion alone.
import { getAuthorNameFromWire } from "../publication-author.js";
import { MAX_CROSSPOST_DEPTH } from "./crosspost-depth.js";
import { sha256 } from "js-sha256";
import type { LRUCache } from "lru-cache";
import type { Crosspost } from "./schema.js";
import type { CrosspostRuntime } from "./types.js";

// Walks the chain into an array, outermost first. Iterative rather than recursive: chain depth is
// attacker-controlled, and while verified records are capped at MAX_CROSSPOST_DEPTH (issue #250),
// nothing here should depend on that cap having already been enforced.
function _chainOf<T extends { comment: { crosspost?: T } }>(crosspost: T): T[] {
    const chain: T[] = [];
    for (let level: T | undefined = crosspost; level; level = level.comment.crosspost) chain.push(level);
    return chain;
}

export function cloneCrosspostForRuntime(crosspost: Crosspost): CrosspostRuntime {
    const chain = _chainOf(crosspost);
    let child: CrosspostRuntime | undefined;
    // Innermost first, so each level can point at the copy of the one below it.
    for (let i = chain.length - 1; i >= 0; i--) {
        const level = chain[i];
        const comment = { ...level.comment } as CrosspostRuntime["comment"];
        if (level.comment.author) comment.author = { ...level.comment.author };
        // `child` is defined exactly when this level had a nested crosspost, so this preserves
        // absence rather than writing an explicit undefined.
        if (child) comment.crosspost = child;
        child = { cid: level.cid, comment };
    }
    return child!;
}

// The authors this comment should trigger background name resolution for: every level of the chain.
//
// A chain is attacker-controlled in both depth and content (#249), but not in cost: #250 caps
// verified chains at MAX_CROSSPOST_DEPTH in schema-util.ts, before anything here runs, so a fetched
// comment is worth at most that many names. resolveAuthorNamesInBackground then hands them to the
// resolver concurrently, and a batching resolver (bso-resolver coalesces concurrent resolves into
// one Multicall3.aggregate3 eth_call) turns the whole chain into a single round trip. A verdict at
// only the first level would leave every deeper "originally by <name>" unrendered, which is the
// impersonation signal #251 exists to give clients.
//
// Kept as a named constant, and as an overridable param, so a caller resolving many chains at once
// can still bound itself.
export const CROSSPOST_LEVELS_TO_RESOLVE_AUTHOR_NAMES_FOR = MAX_CROSSPOST_DEPTH;

export function collectCrosspostAuthorsToResolve({
    crosspost,
    maxLevels = CROSSPOST_LEVELS_TO_RESOLVE_AUTHOR_NAMES_FOR
}: {
    crosspost: CrosspostRuntime;
    maxLevels?: number;
}): Array<{ authorName: string; signaturePublicKey: string }> {
    const authors: Array<{ authorName: string; signaturePublicKey: string }> = [];
    const chain = _chainOf(crosspost).slice(0, maxLevels);
    for (const level of chain) {
        if (typeof level.comment.author?.nameResolved === "boolean") continue;
        const authorName = getAuthorNameFromWire(level.comment.author);
        if (!authorName) continue;
        authors.push({ authorName, signaturePublicKey: level.comment.signature.publicKey });
    }
    return authors;
}

// Applies whatever the cache already knows to every level. Returns true if any level changed, so
// callers can decide whether an "update" event is warranted.
export function applyNameResolvedCacheToCrosspost({
    crosspost,
    cache
}: {
    crosspost: CrosspostRuntime;
    cache: LRUCache<string, boolean>;
}): boolean {
    let changed = false;
    for (const level of _chainOf(crosspost)) {
        const author = level.comment.author;
        if (!author) continue;
        const authorName = getAuthorNameFromWire(author);
        if (!authorName) continue;
        const cached = cache.get(sha256(authorName + level.comment.signature.publicKey));
        if (typeof cached !== "boolean" || author.nameResolved === cached) continue;
        author.nameResolved = cached;
        changed = true;
    }
    return changed;
}

// The RPC transport for the above. An RPC client resolves nothing itself (it usually has no
// nameResolvers configured and would wrongly conclude false), so the server ships what it resolved
// alongside the raw records. The shape mirrors the object path it merges onto, which is what lets
// deepMergeRuntimeFields apply it without any special casing.
export type CrosspostRuntimeFields = {
    comment?: { author?: { nameResolved?: boolean }; crosspost?: CrosspostRuntimeFields };
};

function _buildCrosspostRuntimeFields(
    crosspost: Crosspost | CrosspostRuntime,
    nameResolvedOf: (level: CrosspostRuntime) => boolean | undefined
): CrosspostRuntimeFields | undefined {
    const chain = _chainOf(crosspost as CrosspostRuntime);
    let child: CrosspostRuntimeFields | undefined;
    let anyLevelHasAVerdict = false;
    // Innermost first. A level with no verdict of its own is still emitted when something below it
    // has one, because the nesting is the path deepMergeRuntimeFields walks.
    for (let i = chain.length - 1; i >= 0; i--) {
        const nameResolved = nameResolvedOf(chain[i]);
        if (nameResolved === undefined && !child) continue;
        const comment: NonNullable<CrosspostRuntimeFields["comment"]> = {};
        if (nameResolved !== undefined) {
            comment.author = { nameResolved };
            anyLevelHasAVerdict = true;
        }
        if (child) comment.crosspost = child;
        child = { comment };
    }
    return anyLevelHasAVerdict ? child : undefined;
}

export function buildCrosspostRuntimeFieldsFromCache({
    crosspost,
    cache
}: {
    crosspost: Crosspost;
    cache: LRUCache<string, boolean>;
}): CrosspostRuntimeFields | undefined {
    return _buildCrosspostRuntimeFields(crosspost, (level) => {
        const authorName = getAuthorNameFromWire(level.comment.author);
        if (!authorName) return undefined;
        const cached = cache.get(sha256(authorName + level.comment.signature.publicKey));
        return typeof cached === "boolean" ? cached : undefined;
    });
}

export function extractCrosspostRuntimeFields(crosspost: CrosspostRuntime): CrosspostRuntimeFields | undefined {
    return _buildCrosspostRuntimeFields(crosspost, (level) =>
        typeof level.comment.author?.nameResolved === "boolean" ? level.comment.author.nameResolved : undefined
    );
}

// nameResolved is strictly runtime and never on the wire, so it must not ride along into a record
// that is about to be signed, stored or rehashed. Mirrors the `delete instance.author.nameResolved`
// the Comment's own author already gets in pkc.ts.
export function stripNameResolvedFromCrosspost<T extends Crosspost | CrosspostRuntime>(crosspost: T): void {
    for (const level of _chainOf(crosspost as CrosspostRuntime)) {
        if (level.comment.author?.nameResolved !== undefined) delete level.comment.author.nameResolved;
    }
}
