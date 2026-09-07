import { PKCError } from "../pkc-error.js";
import type { PageSortExclusionOptionName } from "./types.js";
import type { PageSortScope } from "../community/types.js";

// The options pkc-js itself reads off every settings.pages[] entry (the "reserved options", issue #73). They are
// ordinary string options (a config UI renders them like any other) and are passed through to the sort file
// unstripped, so a file can read the window it runs in; the exclusions themselves are applied by pkc-js, to the
// comment set and to the `replies` a file receives. Browser-safe: a client re-sorting a page locally parses the same options out of
// community.pageSorts[sortName].publicOptions (see sortPageComments in ./page-sort-client.ts).

// `M` and `y` reproduce the windows the legacy topMonth / topYear sorts have always used (TIMEFRAMES_TO_SECONDS),
// so the built-in files produce the same pages as before.
export const MAX_AGE_UNIT_SECONDS: Record<string, number> = Object.freeze({
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
    w: 604800,
    M: 2629746, // average seconds in a month (60 * 60 * 24 * 30.436875)
    y: 31557600 // seconds in a year including leap years (60 * 60 * 24 * 365.25)
});

const MAX_AGE_REGEX = /^(\d+(?:\.\d+)?)\s*([smhdwMy])$/;

export function parseMaxAgeToSeconds(raw: string): number | undefined {
    const match = MAX_AGE_REGEX.exec(raw.trim());
    if (!match) return undefined;
    const seconds = Number(match[1]) * MAX_AGE_UNIT_SECONDS[match[2]];
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export const PAGE_SORT_EXCLUSION_OPTION_NAMES: readonly PageSortExclusionOptionName[] = Object.freeze([
    "excludeRemovedComments",
    "excludeDeletedComments",
    "excludeCommentPendingApproval",
    "excludeCommentWithApprovedFalse",
    "excludeCommentsWithDifferentCommunityAddress"
]);

export const RESERVED_PAGE_SORT_OPTION_NAMES: readonly string[] = Object.freeze([
    "maxAge",
    "pinnedFirst",
    ...PAGE_SORT_EXCLUSION_OPTION_NAMES
]);

// What every sort runs with unless the file's defaultOptions or the entry's options say otherwise: the exclusions
// the generator has always applied per scope (docs/protocol/pages.md, "Moderation Visibility": the posts feed hides
// moderated comments, reply pages keep removed and deleted ones so clients can render tombstones) and pinned
// placement. The full merged set is published per sort in community.pageSorts, so a client never has to know these.
export const DEFAULT_RESERVED_OPTIONS: Record<
    PageSortScope,
    Record<PageSortExclusionOptionName | "pinnedFirst", "true" | "false">
> = Object.freeze({
    posts: {
        pinnedFirst: "true",
        excludeRemovedComments: "true",
        excludeDeletedComments: "true",
        excludeCommentPendingApproval: "true",
        excludeCommentWithApprovedFalse: "true",
        excludeCommentsWithDifferentCommunityAddress: "true"
    },
    replies: {
        pinnedFirst: "true",
        excludeRemovedComments: "false",
        excludeDeletedComments: "false",
        excludeCommentPendingApproval: "true",
        excludeCommentWithApprovedFalse: "false",
        excludeCommentsWithDifferentCommunityAddress: "true"
    }
});

export function parseBooleanOption(raw: string | undefined): boolean | undefined {
    if (raw === undefined) return undefined;
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    return undefined;
}

export type ParsedReservedPageSortOptions = {
    maxAgeSeconds?: number;
    pinnedFirst: boolean;
    exclusions: Record<PageSortExclusionOptionName, boolean>;
};

// Parse the reserved keys out of an already-merged option record. Throws ERR_PAGE_SORT_INVALID_RESERVED_OPTION
// with the offending key so the edit path can reject the entry before anything is persisted.
export function parseReservedPageSortOptions(options: Record<string, string>): ParsedReservedPageSortOptions {
    const invalid = (option: string) => new PKCError("ERR_PAGE_SORT_INVALID_RESERVED_OPTION", { option, value: options[option] });

    let maxAgeSeconds: number | undefined;
    if (options.maxAge !== undefined) {
        maxAgeSeconds = parseMaxAgeToSeconds(options.maxAge);
        if (maxAgeSeconds === undefined) throw invalid("maxAge");
    }

    const pinnedFirst = parseBooleanOption(options.pinnedFirst ?? "true");
    if (pinnedFirst === undefined) throw invalid("pinnedFirst");

    const exclusions = {} as Record<PageSortExclusionOptionName, boolean>;
    for (const name of PAGE_SORT_EXCLUSION_OPTION_NAMES) {
        const parsed = parseBooleanOption(options[name] ?? "false");
        if (parsed === undefined) throw invalid(name);
        exclusions[name] = parsed;
    }

    return { maxAgeSeconds, pinnedFirst, exclusions };
}
