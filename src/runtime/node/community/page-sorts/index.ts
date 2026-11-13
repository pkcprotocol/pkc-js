import { pathToFileURL } from "node:url";
import { sha256 } from "js-sha256";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { PKCError } from "../../../../pkc-error.js";
import { PageSortFileFactorySchema } from "../../../../community/schema.js";
import { validatePageSortFile } from "../../../../pages/page-sort-scoring.js";
import {
    DEFAULT_RESERVED_OPTIONS,
    parseReservedPageSortOptions,
    RESERVED_PAGE_SORT_OPTION_NAMES,
    REMOVED_PAGE_SORT_OPTION_NAMES,
    type ParsedReservedPageSortOptions
} from "../../../../pages/page-sort-options.js";
import { pkcJsPageSorts } from "../../../../pages/pkc-js-page-sorts/index.js";
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
import type { FailedPageSorts } from "../page-generator.js";
import Logger from "../../../../logger.js";
import { cleanUpBeforePublishing } from "../../../../signer/signatures.js";
import type { LocalCommunity } from "../local-community.js";

// Configurable page sorts (settings.pages, issue #73). Mirrors the challenges module: a registry of built-ins that
// PKC options may extend or shadow, files resolved by `name` against it or by `path` from disk, settings validated
// against what the file declares, and a public projection of the config for the community record.

// Use structural typing for the pkc param to avoid circular import issues
export type PKCWithSettingsPageSorts = {
    settings?: { pageSorts?: Record<string, PageSortFileFactoryInput> };
};

// The built-in registry lives with the pure scorers in src/pages/pkc-js-page-sorts so the browser runtime exports it too
export { pkcJsPageSorts };

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

// The built-ins as pkc-js shipped them. A consumer may shadow one in the shared registry, so "is this the built-in"
// is an identity check against this snapshot, not a lookup in the registry.
const shippedBuiltInPageSorts: Readonly<Record<string, PageSortFileFactoryInput>> = Object.freeze({ ...pkcJsPageSorts });

const entriesOfEveryScope = (
    pagesSettings: CommunityPagesSettings | undefined
): { scope: PageSortScope; entries: readonly CommunityPageSortSetting[] }[] => [
    { scope: "posts", entries: pagesSettings?.posts ?? DEFAULT_POST_SORT_SETTINGS },
    { scope: "replies", entries: pagesSettings?.replies ?? DEFAULT_REPLY_SORT_SETTINGS }
];

// The factory each settings.pages entry resolves to right now, in posts-then-replies order. A `path` entry is
// undefined: Node caches the imported module for the life of the process, so it can only change across a restart,
// which the fingerprint below catches. Comparing two snapshots with === is how a running community notices that a
// consumer replaced a package in the registry (issue #411).
export function lookupPageSortFactories({
    pagesSettings,
    pkc
}: {
    pagesSettings: CommunityPagesSettings | undefined;
    pkc?: PKCWithSettingsPageSorts;
}): (PageSortFileFactoryInput | undefined)[] {
    return entriesOfEveryScope(pagesSettings).flatMap(({ entries }) =>
        entries.map((entry) => (entry.name ? resolvePageSortFactoryByName({ name: entry.name, pkc }) : undefined))
    );
}

// What survives a restart: settings.pages, what each entry resolved to, and the source of every sort that did not
// ship with pkc-js. A package replaced while the node was down changes it, so start can regenerate every CommentUpdate.
// Built-in sources are left out on purpose: a pkc-js upgrade that only reformats its bundle must not regenerate every
// board. Code that lives only in a helper a package imports from another file is not covered; the in-process identity
// check is exact, this is best-effort.
export function computePageSortsFingerprint({
    pagesSettings,
    resolved,
    factories
}: {
    pagesSettings: CommunityPagesSettings | undefined;
    resolved: ResolvedPageSorts;
    factories: (PageSortFileFactoryInput | undefined)[]; // the lookupPageSortFactories snapshot `resolved` was built from
}): string {
    const entries = entriesOfEveryScope(pagesSettings).flatMap(({ entries }) => entries);
    const factoryOfEntry = new Map(entries.map((entry, i) => [entry, factories[i]]));
    const isShippedBuiltIn = (entry: CommunityPageSortSetting) => {
        const factory = factoryOfEntry.get(entry);
        return factory !== undefined && typeof entry.name === "string" && shippedBuiltInPageSorts[entry.name] === factory;
    };
    // a `path` entry or a missing factory is null: a path file's source is covered by the resolved file below
    const describeFactory = (entry: CommunityPageSortSetting) => {
        const factory = factoryOfEntry.get(entry);
        if (factory === undefined) return null;
        return isShippedBuiltIn(entry) ? "built-in" : factory.toString();
    };
    const describeResolved = (sort: ResolvedPageSort) => ({
        settings: sort.settings,
        sortName: sort.sortName,
        options: sort.options,
        file: {
            description: sort.file.description,
            optionInputs: sort.file.optionInputs,
            defaultOptions: sort.file.defaultOptions,
            scope: sort.file.scope,
            flat: sort.file.flat,
            requireReplies: sort.file.requireReplies,
            ...(isShippedBuiltIn(sort.settings)
                ? {}
                : { score: sort.file.score.toString(), validatePageSortSettings: sort.file.validatePageSortSettings?.toString() })
        }
    });
    return sha256(
        deterministicStringify({
            pages: pagesSettings ?? null,
            factories: entries.map(describeFactory),
            posts: resolved.posts.map(describeResolved),
            replies: resolved.replies.map(describeResolved)
        }) ?? ""
    );
}

const describePageSort = (pageSortSettings: CommunityPageSortSetting): string =>
    pageSortSettings.name || pageSortSettings.path || "unknown page sort";

// The wire key of an entry: its own `sortName` when the owner set one, else the file's (issue #483). Everything keyed
// by sort name on the wire and in the database follows it: pages / pageCids, community.pageSorts and the duplicate check.
const resolveSortName = ({ pageSortSettings, file }: { pageSortSettings: CommunityPageSortSetting; file: PageSortFile }): string =>
    pageSortSettings.sortName ?? file.sortName;

// One settings.pages[] entry, loaded and merged with everything pkc-js derives from it. Built once per community
// start, per settings edit and when the registered factory changes (issue #411), then reused by every generation.
export type ResolvedPageSort = ParsedReservedPageSortOptions & {
    sortName: string; // the wire key: the entry's sortName override, else file.sortName
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
    pkc
}: {
    pageSortSettings: CommunityPageSortSetting;
    pkc?: PKCWithSettingsPageSorts;
}): Promise<PageSortFile> {
    let factory: PageSortFileFactory;
    try {
        const factoryInput = pageSortSettings.path
            ? (await import(pathToFileURL(pageSortSettings.path).href)).default
            : resolvePageSortFactoryByName({ name: pageSortSettings.name!, pkc });
        if (!factoryInput) throw Error(`No page sort registered under the name "${pageSortSettings.name}"`);
        PageSortFileFactorySchema.parse(factoryInput); // a function, or the schema says why not
        factory = factoryInput as PageSortFileFactory; // called unwrapped: the output is validated once below
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
        file = validatePageSortFile(factory({ pageSortSettings }));
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

// Drop the reserved options pkc-js no longer reads (REMOVED_PAGE_SORT_OPTION_NAMES) from an option record, so a value
// stored before the removal neither fails the declared-option check nor reaches the file or the published publicOptions.
function withoutRemovedPageSortOptions(options: Record<string, string>, pageSortName: string): Record<string, string> {
    const removed = Object.keys(options).filter((optionName) => REMOVED_PAGE_SORT_OPTION_NAMES.includes(optionName));
    if (removed.length === 0) return options;
    Logger("pkc-js:local-community:page-sorts:resolve")(
        `Ignoring removed page sort options ${removed.join(", ")} of sort ${pageSortName}; the community identity rule now always applies (issue #401)`
    );
    return Object.fromEntries(Object.entries(options).filter(([optionName]) => !removed.includes(optionName)));
}

// The same, applied to a stored entry before its file is loaded: the factory, validatePageSortSettings and the resolved
// settings all see the entry without the removed options, so a file that rejects undeclared options keeps working
function withoutRemovedPageSortSettingOptions(pageSortSettings: CommunityPageSortSetting): CommunityPageSortSetting {
    if (!pageSortSettings.options) return pageSortSettings;
    const options = withoutRemovedPageSortOptions(pageSortSettings.options, describePageSort(pageSortSettings));
    return options === pageSortSettings.options ? pageSortSettings : { ...pageSortSettings, options };
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
    const sortName = resolveSortName({ pageSortSettings, file });
    const baseDetails = { scope, pageSortIndex, pageSortName: describePageSort(pageSortSettings), sortName };
    const entryOptions = pageSortSettings.options ?? {}; // removed options already dropped by the caller

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

    for (const optionName of pageSortSettings.privateOptions ?? []) {
        if (RESERVED_PAGE_SORT_OPTION_NAMES.includes(optionName))
            return {
                error: new PKCError("ERR_PAGE_SORT_RESERVED_OPTION_CANNOT_BE_PRIVATE", { ...baseDetails, offendingOption: optionName })
            };
        if (entryOptions[optionName] === undefined)
            return { error: new PKCError("ERR_PAGE_SORT_PRIVATE_OPTION_NOT_SET", { ...baseDetails, offendingOption: optionName }) };
    }

    const options: Record<string, string> = withoutRemovedPageSortOptions(
        { ...DEFAULT_RESERVED_OPTIONS[scope], ...file.defaultOptions, ...entryOptions },
        baseDetails.pageSortName
    );
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
            sortName,
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
    tolerateLoadErrors = false
}: {
    pagesSettings: CommunityPagesSettings | undefined;
    pkc?: PKCWithSettingsPageSorts;
    tolerateLoadErrors?: boolean; // start path: a file that no longer imports is a failure to report, not a reason to stop
}): Promise<{ resolved: ResolvedPageSorts; failures: PageSortSettingsValidationFailure[] }> {
    const failures: PageSortSettingsValidationFailure[] = [];
    const resolved: ResolvedPageSorts = { posts: [], replies: [] };
    for (const { scope, entries } of entriesOfEveryScope(pagesSettings)) {
        const seenSortNames = new Set<string>();
        for (const [pageSortIndex, storedPageSortSettings] of entries.entries()) {
            const pageSortSettings = withoutRemovedPageSortSettingOptions(storedPageSortSettings);
            const pageSortName = describePageSort(pageSortSettings);
            let file: PageSortFile;
            try {
                file = await loadPageSortFile({ pageSortSettings, pkc });
            } catch (e) {
                if (!tolerateLoadErrors) throw e;
                failures.push({ scope, pageSortIndex, pageSortName, error: e as PKCError });
                continue;
            }
            const sortName = resolveSortName({ pageSortSettings, file });
            if (seenSortNames.has(sortName)) {
                failures.push({
                    scope,
                    pageSortIndex,
                    pageSortName,
                    error: new PKCError("ERR_PAGE_SORT_DUPLICATE_SORT_NAME", { scope, pageSortIndex, pageSortName, sortName })
                });
                continue;
            }
            seenSortNames.add(sortName);
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
    communityAddress
}: {
    pagesSettings: CommunityPagesSettings | undefined;
    pkc?: PKCWithSettingsPageSorts;
    communityAddress?: string;
}): Promise<ResolvedPageSorts> {
    const { resolved, failures } = await resolvePageSortsAndCollectFailures({ pagesSettings, pkc });
    if (failures.length)
        throw new PKCError("ERR_PAGE_SORT_SETTINGS_VALIDATION_FAILED_FOR_PAGE_SORTS", {
            communityAddress,
            failures: failures.map(({ scope, pageSortIndex, pageSortName, error }) => ({ scope, pageSortIndex, pageSortName, error }))
        });
    return resolved;
}

// community.pageSorts: what the record says about each configured sort. Only present when settings.pages is set, so
// an unconfigured community publishes the same record it always has. publicOptions is the full merged option set the
// sort runs with (scope reserved defaults, the file's defaultOptions, the entry's options) minus privateOptions, so a
// client can re-sort locally from the same inputs without knowing pkc-js's defaults. The result goes through the same
// cleanup as the record, so the owner's community.pageSorts is exactly what remote clients see.
export function derivePublicPageSorts({
    pagesSettings,
    resolved
}: {
    pagesSettings: CommunityPagesSettings | undefined;
    resolved: ResolvedPageSorts;
}): CommunityPageSorts | undefined {
    if (!pagesSettings) return undefined;
    const project = (sorts: ResolvedPageSort[]): Record<string, CommunityPageSort> => {
        const record: Record<string, CommunityPageSort> = {};
        for (const sort of sorts) {
            const privateOptions = new Set(sort.settings.privateOptions ?? []);
            const publicOptions = Object.fromEntries(Object.entries(sort.options).filter(([name]) => !privateOptions.has(name)));
            record[sort.sortName] = {
                ...(sort.settings.name ? { name: sort.settings.name } : {}),
                ...(sort.file.description ? { description: sort.file.description } : {}),
                ...(Object.keys(publicOptions).length > 0 ? { publicOptions } : {})
            };
        }
        return record;
    };
    const cleaned = cleanUpBeforePublishing({
        ...(pagesSettings.posts !== undefined ? { posts: project(resolved.posts) } : {}),
        ...(pagesSettings.replies !== undefined ? { replies: project(resolved.replies) } : {})
    });
    return Object.keys(cleaned).length > 0 ? cleaned : undefined; // the record drops an empty pageSorts too (posts: [] and replies: [])
}

// Start path: resolve settings.pages with every failure reported as its own `error` event, one per entry, and keep
// going with the valid ones. Same treatment as emitChallengeSettingsValidationErrors. Also the lazy path for a
// community whose pages are generated without start() (tests drive the generator directly).
export async function loadPageSortsForStartedCommunity(community: LocalCommunity): Promise<ResolvedPageSorts> {
    const log = Logger("pkc-js:local-community:page-sorts:load");
    await community._dbHandler.initDbIfNeeded();
    // Snapshot before resolving: a registry change that lands mid-resolve then shows up as a mismatch on the next
    // cycle (one extra re-resolve) instead of being recorded as already applied
    const factories = lookupPageSortFactories({ pagesSettings: community.settings?.pages, pkc: community._pkc });
    const { resolved, failures } = await resolvePageSortsAndCollectFailures({
        pagesSettings: community.settings?.pages,
        pkc: community._pkc,
        tolerateLoadErrors: true
    });
    for (const { error, scope, pageSortIndex, pageSortName } of failures) {
        error.details = { ...error.details, scope, pageSortIndex, pageSortName, communityAddress: community.address };
        log.error("Invalid settings.pages entry, skipping it", community.address, error);
        community.emit("error", error);
    }
    community._pageSorts = resolved;
    community._pageSortFactories = factories;
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

// Run one scope's page generation and report the sorts that failed, whether the rest published (the result carries
// failedSorts) or none did (ERR_ALL_PAGE_SORTS_FAILED_TO_GENERATE carries them and is rethrown so the cycle aborts).
export async function generatePagesReportingFailedSorts<T extends { failedSorts: FailedPageSorts } | undefined>({
    community,
    log,
    generate
}: {
    community: LocalCommunity;
    log: Logger;
    generate: () => Promise<T>;
}): Promise<T> {
    let generated: T;
    try {
        generated = await generate();
    } catch (e) {
        if (e instanceof PKCError && e.code === "ERR_ALL_PAGE_SORTS_FAILED_TO_GENERATE")
            reportFailedPageSorts(community, (e.details as { failedSorts: FailedPageSorts }).failedSorts, log);
        throw e;
    }
    if (generated) reportFailedPageSorts(community, generated.failedSorts, log);
    return generated;
}
