import { pathToFileURL } from "node:url";
import { PKCError } from "../../../../pkc-error.js";
import { PageSortFileFactorySchema, PageSortFileSchema } from "../../../../community/schema.js";
import {
    DEFAULT_EXCLUSION_OPTIONS,
    parseReservedPageSortOptions,
    RESERVED_PAGE_SORT_OPTION_NAMES,
    type ParsedReservedPageSortOptions
} from "./reserved-options.js";
import hot from "./pkc-js-page-sorts/hot.js";
import newSort from "./pkc-js-page-sorts/new.js";
import old from "./pkc-js-page-sorts/old.js";
import best from "./pkc-js-page-sorts/best.js";
import top from "./pkc-js-page-sorts/top.js";
import topHour from "./pkc-js-page-sorts/top-hour.js";
import topDay from "./pkc-js-page-sorts/top-day.js";
import topWeek from "./pkc-js-page-sorts/top-week.js";
import topMonth from "./pkc-js-page-sorts/top-month.js";
import topYear from "./pkc-js-page-sorts/top-year.js";
import topAll from "./pkc-js-page-sorts/top-all.js";
import active from "./pkc-js-page-sorts/active.js";
import controversial from "./pkc-js-page-sorts/controversial.js";
import newFlat from "./pkc-js-page-sorts/new-flat.js";
import oldFlat from "./pkc-js-page-sorts/old-flat.js";
import type {
    CommunityPageSort,
    CommunityPageSortSetting,
    CommunityPageSorts,
    CommunityPagesSettings,
    PageSortFile,
    PageSortFileFactory,
    PageSortFileFactoryInput,
    PageSortScope
} from "../../../../community/types.js";
import type { PageSortDb } from "../../../../pages/types.js";
import type { FailedPageSorts } from "../page-generator.js";
import Logger from "../../../../logger.js";
import type { LocalCommunity } from "../local-community.js";

// Configurable page sorts (settings.pages, issue #73). Mirrors the challenges module: a registry of built-ins that
// PKC options may extend or shadow, files resolved by `name` against it or by `path` from disk, settings validated
// against what the file declares, and a public projection of the config for the community record.

// Use structural typing for the pkc param to avoid circular import issues
export type PKCWithSettingsPageSorts = {
    settings?: { pageSorts?: Record<string, PageSortFileFactoryInput> };
};

// all page sorts included with pkc-js, in PKC.pageSorts
export const pkcJsPageSorts: Record<string, PageSortFileFactoryInput> = {
    hot,
    new: newSort,
    old,
    best,
    top,
    topHour,
    topDay,
    topWeek,
    topMonth,
    topYear,
    topAll,
    active,
    controversial,
    newFlat,
    oldFlat
};

// What an unset settings.pages generates: today's sort sets, in today's key order, with today's preloaded sorts.
export const DEFAULT_POST_SORT_SETTINGS: readonly CommunityPageSortSetting[] = Object.freeze([
    { name: "hot", preloaded: true },
    { name: "new" },
    { name: "active" },
    { name: "topHour" },
    { name: "topDay" },
    { name: "topWeek" },
    { name: "topMonth" },
    { name: "topYear" },
    { name: "topAll" }
]);

export const DEFAULT_REPLY_SORT_SETTINGS: readonly CommunityPageSortSetting[] = Object.freeze([
    { name: "new" },
    { name: "best", preloaded: true },
    { name: "old" },
    { name: "newFlat" },
    { name: "oldFlat" }
]);

const resolvePageSortFactoryByName = ({
    name,
    pkc
}: {
    name: string;
    pkc?: PKCWithSettingsPageSorts;
}): PageSortFileFactoryInput | undefined =>
    // User-defined shadows built-ins
    pkc?.settings?.pageSorts?.[name] ?? pkcJsPageSorts[name];

const describePageSort = (pageSortSettings: CommunityPageSortSetting): string =>
    pageSortSettings.name || pageSortSettings.path || "unknown page sort";

// One settings.pages[] entry, loaded and merged with everything pkc-js derives from it. Built once per community
// start and per settings edit, then reused by every generation, so a file may prepare statements in its closure.
export type ResolvedPageSort = ParsedReservedPageSortOptions & {
    sortName: string;
    scope: PageSortScope; // where the entry sits, not what the file declares
    file: PageSortFile;
    settings: CommunityPageSortSetting;
    preloaded: boolean;
    flat: boolean;
    options: Record<string, string>; // scope defaults, then the file's defaultOptions, then the entry's options
};

export type ResolvedPageSorts = {
    posts: ResolvedPageSort[];
    replies: ResolvedPageSort[];
};

export async function loadPageSortFile({
    pageSortSettings,
    pkc,
    db
}: {
    pageSortSettings: CommunityPageSortSetting;
    pkc?: PKCWithSettingsPageSorts;
    db: PageSortDb;
}): Promise<PageSortFile> {
    let factory: PageSortFileFactory;
    try {
        const factoryInput = pageSortSettings.path
            ? (await import(pathToFileURL(pageSortSettings.path).href)).default
            : resolvePageSortFactoryByName({ name: pageSortSettings.name!, pkc });
        if (!factoryInput) throw Error(`No page sort registered under the name "${pageSortSettings.name}"`);
        factory = PageSortFileFactorySchema.parse(factoryInput);
    } catch (e) {
        throw new PKCError("ERR_FAILED_TO_IMPORT_PAGE_SORT_FILE_FACTORY", {
            path: pageSortSettings.path,
            name: pageSortSettings.name,
            pageSortSettings,
            error: e
        });
    }
    let file: PageSortFile;
    try {
        file = PageSortFileSchema.parse(factory({ pageSortSettings, db }));
    } catch (e) {
        throw new PKCError("ERR_PAGE_SORT_FILE_INVALID", { pageSortSettings, error: e });
    }
    return file;
}

export interface PageSortSettingsValidationFailure {
    scope: PageSortScope;
    pageSortIndex: number;
    pageSortName: string;
    error: PKCError;
}

// Generic validation of one entry against its loaded file, plus the reserved-option parsing pkc-js needs anyway.
// Returns the resolved sort, or the first failure. A file that declares no optionInputs makes no promise about
// which options it reads, so the declared-key check is skipped for it, same as challenges.
function resolveOneEntry({
    pageSortSettings,
    file,
    scope,
    pageSortIndex
}: {
    pageSortSettings: CommunityPageSortSetting;
    file: PageSortFile;
    scope: PageSortScope;
    pageSortIndex: number;
}): { resolved: ResolvedPageSort } | { error: PKCError } {
    const baseDetails = { scope, pageSortIndex, pageSortName: describePageSort(pageSortSettings), sortName: file.sortName };
    const entryOptions = pageSortSettings.options ?? {};

    if (file.scope && file.scope !== scope)
        return { error: new PKCError("ERR_PAGE_SORT_SCOPE_MISMATCH", { ...baseDetails, fileScope: file.scope }) };

    if (file.optionInputs) {
        const declaredOptions = new Set([
            ...RESERVED_PAGE_SORT_OPTION_NAMES,
            ...file.optionInputs.map((optionInput) => optionInput.option)
        ]);
        for (const optionName of Object.keys(entryOptions))
            if (!declaredOptions.has(optionName))
                return {
                    error: new PKCError("ERR_PAGE_SORT_OPTION_NOT_DECLARED_IN_OPTION_INPUTS", {
                        ...baseDetails,
                        offendingOption: optionName,
                        declaredOptions: [...declaredOptions]
                    })
                };
        for (const optionInput of file.optionInputs)
            if (optionInput.required && entryOptions[optionInput.option] === undefined)
                return {
                    error: new PKCError("ERR_PAGE_SORT_REQUIRED_OPTION_MISSING", { ...baseDetails, missingOption: optionInput.option })
                };
    }

    for (const optionName of pageSortSettings.privateOptions ?? [])
        if (entryOptions[optionName] === undefined)
            return { error: new PKCError("ERR_PAGE_SORT_PRIVATE_OPTION_NOT_SET", { ...baseDetails, offendingOption: optionName }) };

    const options: Record<string, string> = { ...DEFAULT_EXCLUSION_OPTIONS[scope], ...file.defaultOptions, ...entryOptions };
    let reserved: ParsedReservedPageSortOptions;
    try {
        reserved = parseReservedPageSortOptions(options);
    } catch (e) {
        const error = e as PKCError;
        error.details = { ...error.details, ...baseDetails };
        return { error };
    }

    if (file.validatePageSortSettings)
        try {
            file.validatePageSortSettings({ pageSortSettings });
        } catch (e) {
            const wrapped = new PKCError("ERR_PAGE_SORT_SETTINGS_VALIDATION_FAILED", {
                ...baseDetails,
                validationError: e instanceof Error ? e.message : String(e)
            });
            Object.assign(wrapped, { cause: e });
            return { error: wrapped };
        }

    return {
        resolved: {
            ...reserved,
            sortName: file.sortName,
            scope,
            file,
            settings: pageSortSettings,
            preloaded: pageSortSettings.preloaded === true,
            flat: file.flat === true,
            options
        }
    };
}

// Load every entry of settings.pages, validate it and collect the failures rather than stopping at the first, so an
// owner editing several sorts learns about all of them at once. Loading a file is allowed to throw (a bad `path`, an
// unregistered `name`); that is a different failure from an invalid setting and propagates instead of being collected.
export async function resolvePageSortsAndCollectFailures({
    pagesSettings,
    pkc,
    db,
    tolerateLoadErrors = false
}: {
    pagesSettings: CommunityPagesSettings | undefined;
    pkc?: PKCWithSettingsPageSorts;
    db: PageSortDb;
    tolerateLoadErrors?: boolean; // start path: a file that no longer imports is a failure to report, not a reason to stop
}): Promise<{ resolved: ResolvedPageSorts; failures: PageSortSettingsValidationFailure[] }> {
    const failures: PageSortSettingsValidationFailure[] = [];
    const resolved: ResolvedPageSorts = { posts: [], replies: [] };
    const scopes: { scope: PageSortScope; entries: readonly CommunityPageSortSetting[] }[] = [
        { scope: "posts", entries: pagesSettings?.posts ?? DEFAULT_POST_SORT_SETTINGS },
        { scope: "replies", entries: pagesSettings?.replies ?? DEFAULT_REPLY_SORT_SETTINGS }
    ];
    for (const { scope, entries } of scopes) {
        const seenSortNames = new Set<string>();
        for (const [pageSortIndex, pageSortSettings] of entries.entries()) {
            const pageSortName = describePageSort(pageSortSettings);
            let file: PageSortFile;
            try {
                file = await loadPageSortFile({ pageSortSettings, pkc, db });
            } catch (e) {
                if (!tolerateLoadErrors) throw e;
                failures.push({ scope, pageSortIndex, pageSortName, error: e as PKCError });
                continue;
            }
            if (seenSortNames.has(file.sortName)) {
                failures.push({
                    scope,
                    pageSortIndex,
                    pageSortName,
                    error: new PKCError("ERR_PAGE_SORT_DUPLICATE_SORT_NAME", {
                        scope,
                        pageSortIndex,
                        pageSortName,
                        sortName: file.sortName
                    })
                });
                continue;
            }
            seenSortNames.add(file.sortName);
            const result = resolveOneEntry({ pageSortSettings, file, scope, pageSortIndex });
            if ("error" in result) failures.push({ scope, pageSortIndex, pageSortName, error: result.error });
            else resolved[scope].push(result.resolved);
        }
    }
    return { resolved, failures };
}

// The edit and creation paths reject the whole write, so one aggregated throw carrying every failure is the most
// useful thing for an owner-facing UI. Same shape as ERR_CHALLENGE_SETTINGS_VALIDATION_FAILED_FOR_CHALLENGES.
export async function resolvePageSortsOrThrow({
    pagesSettings,
    pkc,
    db,
    communityAddress
}: {
    pagesSettings: CommunityPagesSettings | undefined;
    pkc?: PKCWithSettingsPageSorts;
    db: PageSortDb;
    communityAddress?: string;
}): Promise<ResolvedPageSorts> {
    const { resolved, failures } = await resolvePageSortsAndCollectFailures({ pagesSettings, pkc, db });
    if (failures.length)
        throw new PKCError("ERR_PAGE_SORT_SETTINGS_VALIDATION_FAILED_FOR_PAGE_SORTS", {
            communityAddress,
            failures: failures.map(({ scope, pageSortIndex, pageSortName, error }) => ({ scope, pageSortIndex, pageSortName, error }))
        });
    return resolved;
}

// community.pageSorts: what the record says about each configured sort. Only present when settings.pages is set, so
// an unconfigured community publishes the same record it always has. Every option the owner set is public unless
// named in privateOptions; the scope defaults and the file's own defaultOptions are not options the owner set.
export function derivePublicPageSorts({
    pagesSettings,
    resolved
}: {
    pagesSettings: CommunityPagesSettings | undefined;
    resolved: ResolvedPageSorts;
}): CommunityPageSorts | undefined {
    if (!pagesSettings) return undefined;
    const project = (sorts: ResolvedPageSort[]): Record<string, CommunityPageSort> | undefined => {
        const record: Record<string, CommunityPageSort> = {};
        for (const sort of sorts) {
            const privateOptions = new Set(sort.settings.privateOptions ?? []);
            const publicOptions = Object.fromEntries(
                Object.entries(sort.settings.options ?? {}).filter(([name]) => !privateOptions.has(name))
            );
            record[sort.sortName] = {
                ...(sort.settings.name ? { name: sort.settings.name } : {}),
                ...(sort.file.description ? { description: sort.file.description } : {}),
                ...(Object.keys(publicOptions).length > 0 ? { publicOptions } : {})
            };
        }
        return record;
    };
    return {
        ...(pagesSettings.posts !== undefined ? { posts: project(resolved.posts) } : {}),
        ...(pagesSettings.replies !== undefined ? { replies: project(resolved.replies) } : {})
    };
}

// Start path: resolve settings.pages with every failure reported as its own `error` event, one per entry, and keep
// going with the valid ones. Same treatment as emitChallengeSettingsValidationErrors. Also the lazy path for a
// community whose pages are generated without start() (tests drive the generator directly).
export async function loadPageSortsForStartedCommunity(community: LocalCommunity): Promise<ResolvedPageSorts> {
    const log = Logger("pkc-js:local-community:page-sorts:load");
    await community._dbHandler.initDbIfNeeded();
    const { resolved, failures } = await resolvePageSortsAndCollectFailures({
        pagesSettings: community.settings?.pages,
        pkc: community._pkc,
        db: community._dbHandler.createPageSortDb(),
        tolerateLoadErrors: true
    });
    for (const { error, scope, pageSortIndex, pageSortName } of failures) {
        error.details = { ...error.details, scope, pageSortIndex, pageSortName, communityAddress: community.address };
        log.error("Invalid settings.pages entry on start, skipping it", community.address, error);
        community.emit("error", error);
    }
    community._pageSorts = resolved;
    return resolved;
}

// "Configured but not producing": every cycle that generates pages and finds a sort that threw emits on the community's
// error event. The operator's config is not being honoured, so it is reported every time rather than deduped; a
// legitimate settings edit never looks like this, unlike the key-set change below.
export function reportFailedPageSorts(community: LocalCommunity, failedSorts: FailedPageSorts | undefined, log: Logger): void {
    for (const error of Object.values(failedSorts ?? {})) {
        error.details = { ...error.details, communityAddress: community.address };
        log.error("A configured page sort failed to generate and was skipped for this cycle", community.address, error);
        community.emit("error", error);
    }
}

// "Generated key set changed since the previous cycle": ambiguous by nature (a settings.pages edit and a package
// rename look identical), so it warns with both key sets rather than erroring. Tracked per scope on the community.
export function warnIfGeneratedSortKeysChanged({
    community,
    scope,
    generatedKeys,
    log
}: {
    community: LocalCommunity;
    scope: PageSortScope;
    generatedKeys: string[];
    log: Logger;
}): void {
    const previous = community._lastGeneratedPageSortKeys[scope];
    const current = [...generatedKeys].sort();
    if (previous && (previous.length !== current.length || previous.some((key, i) => key !== current[i])))
        log.error(`Generated ${scope} page sort keys changed since the previous cycle`, community.address, { previous, current });
    community._lastGeneratedPageSortKeys[scope] = current;
}
