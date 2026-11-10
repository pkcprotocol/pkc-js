import { stringify as deterministicStringify } from "safe-stable-stringify";
import { STORAGE_KEYS } from "../../../../constants.js";
import { deriveCommunityChallengesOrThrow, type ChallengeLoadFailure } from "../challenges/index.js";
import type { PKCError } from "../../../../pkc-error.js";
import {
    computePageSortsFingerprint,
    derivePublicPageSorts,
    loadPageSortsForStartedCommunity,
    lookupPageSortFactories,
    type ResolvedPageSorts
} from "../page-sorts/index.js";
import type { LocalCommunity } from "../local-community.js";
import type { PageSortFileFactoryInput } from "../../../../community/types.js";

// Challenge and page sort factories live in a registry a consumer can change while communities run: bitsocial-cli's
// `challenge install` / `page-sort install` re-import a package and replace its entry in PKC.challenges /
// PKC.pageSorts (issues #410, #411). Challenges are resolved per request so they already run the new code; what goes
// stale is everything derived once: the record's community.challenges, the resolved page sorts and the record's
// community.pageSorts. Each cycle re-derives them here before any CommentUpdate or page is generated.

const PAGE_SORTS_FINGERPRINT_KEY = STORAGE_KEYS[STORAGE_KEYS.PAGE_SORTS_FINGERPRINT];

// Install a freshly resolved settings.pages on the instance: the sorts, the factories they came from (for the
// per-cycle identity check), the record's projection, and the fingerprint a restart compares against. `factories` must
// be the lookupPageSortFactories snapshot taken BEFORE resolving: looking the registry up again here would record a
// factory swapped in mid-resolve as already applied, and every later cycle would compare equal and keep the old sort.
export async function setResolvedPageSorts(
    community: LocalCommunity,
    resolved: ResolvedPageSorts,
    factories: (PageSortFileFactoryInput | undefined)[]
): Promise<void> {
    const pagesSettings = community.settings?.pages;
    community._pageSorts = resolved;
    community._pageSortFactories = factories;
    community.pageSorts = derivePublicPageSorts({ pagesSettings, resolved });
    await community._dbHandler.keyvSet(PAGE_SORTS_FINGERPRINT_KEY, computePageSortsFingerprint({ pagesSettings, resolved, factories }));
}

const sameFactories = (a: readonly unknown[] | undefined, b: readonly unknown[]): boolean =>
    a !== undefined && a.length === b.length && a.every((factory, i) => factory === b[i]);

// Re-resolve settings.pages when the registry no longer holds the factories it was resolved from. With nothing in
// memory (start, or a fresh process) the persisted fingerprint decides instead, so a package replaced while the node
// was down is caught too. A change is handled like a settings.pages edit: every CommentUpdate is regenerated (reply
// pages are only rebuilt for flagged comments) and the record is republished with the new community.pageSorts.
export async function syncPageSortsWithRegistry(community: LocalCommunity): Promise<void> {
    const log = community._log;
    await community._dbHandler.initDbIfNeeded();
    const pagesSettings = community.settings?.pages;
    const currentFactories = lookupPageSortFactories({ pagesSettings, pkc: community._pkc });
    const inMemory = community._pageSorts !== undefined && community._pageSortFactories !== undefined;
    if (inMemory && sameFactories(community._pageSortFactories, currentFactories)) return;

    const previousFingerprint = community._dbHandler.keyvGet<string>(PAGE_SORTS_FINGERPRINT_KEY);
    const previousPublicPageSorts = deterministicStringify(community.pageSorts ?? null);
    const resolved = await loadPageSortsForStartedCommunity(community); // reports each entry that no longer resolves
    const factories = community._pageSortFactories!; // the snapshot the loader took before resolving
    const fingerprint = computePageSortsFingerprint({ pagesSettings, resolved, factories });
    // In memory, === already proved the registry changed. From disk, a community that predates the fingerprint has
    // nothing to compare with and only takes the baseline, so upgrading pkc-js does not regenerate every board.
    const changed = inMemory || (previousFingerprint !== undefined && previousFingerprint !== fingerprint);
    await setResolvedPageSorts(community, resolved, factories);
    if (changed) {
        log("page-sorts: Page sort factories changed in the registry, regenerating every CommentUpdate", community.address);
        community._dbHandler.forceUpdateOnAllComments();
        community._communityUpdateTrigger = true;
    } else if (deterministicStringify(community.pageSorts ?? null) !== previousPublicPageSorts) community._communityUpdateTrigger = true;
}

// Recompute the record's community.challenges from the registry and republish only if it changed. A challenge whose
// factory is gone keeps the previous record and the community keeps running: challenge requests fail and report it, and
// an unchanged record costs no IPNS publish. The owner gets one error event per distinct set of unloadable entries
// rather than one per cycle; the next start() refuses to come online until it is fixed (issue #428).
export async function syncChallengesWithRegistry(community: LocalCommunity): Promise<void> {
    const log = community._log;
    const challengeSettings = community.settings?.challenges;
    if (!Array.isArray(challengeSettings)) return;
    let challenges: NonNullable<LocalCommunity["challenges"]>;
    try {
        challenges = await deriveCommunityChallengesOrThrow({
            challengeSettings,
            pkc: community._pkc,
            communityAddress: community.address
        });
    } catch (e) {
        log.error(
            "challenges: Could not recompute community.challenges from the registry, keeping the previous ones",
            community.address,
            e
        );
        const reported = deterministicStringify(
            ((e as PKCError).details?.failures as ChallengeLoadFailure[] | undefined)?.map((f) => [
                f.challengeIndex,
                f.challengeName,
                f.path,
                f.error.code
            ]) ?? String(e)
        );
        if (reported !== community._reportedChallengeLoadFailures) {
            community._reportedChallengeLoadFailures = reported;
            community.emit("error", e as PKCError);
        }
        return;
    }
    community._reportedChallengeLoadFailures = undefined;
    if (deterministicStringify(challenges) === deterministicStringify(community.challenges ?? null)) return;
    log("challenges: community.challenges changed in the registry, republishing", community.address);
    community.challenges = challenges;
    community._communityUpdateTrigger = true;
}

export async function syncWithRegistries(community: LocalCommunity): Promise<void> {
    await syncChallengesWithRegistry(community);
    await syncPageSortsWithRegistry(community);
}
