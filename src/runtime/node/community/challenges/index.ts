import {
    shouldExcludeChallengeCommentCids,
    shouldExcludePublication,
    shouldExcludeChallengeSuccess,
    addToRateLimiter
} from "./exclude/index.js";

// all challenges included with pkc-js, in PKC.challenges
import textMath from "./pkc-js-challenges/text-math.js";
import fail from "./pkc-js-challenges/fail.js";
import blacklist from "./pkc-js-challenges/blacklist.js";
import whitelist from "./pkc-js-challenges/whitelist.js";
import question from "./pkc-js-challenges/question.js";
import publicationMatch from "./pkc-js-challenges/publication-match.js";
import type {
    ChallengeVerificationMessageType,
    DecryptedChallengeAnswer,
    DecryptedChallengeRequestMessageTypeWithCommunityAuthor
} from "../../../../pubsub-messages/types.js";
import type {
    Challenge,
    ChallengeFile,
    ChallengeFileFactory,
    ChallengeFileFactoryInput,
    ChallengeResult,
    CommunityChallenge,
    CommunityChallengeSetting
} from "../../../../community/types.js";
import { LocalCommunity } from "../local-community.js";
import * as remeda from "remeda";
import { ChallengeFileFactorySchema, ChallengeFileSchema, CommunityChallengeSettingSchema } from "../../../../community/schema.js";
import { PKCError } from "../../../../pkc-error.js";
import { pathToFileURL } from "node:url";

type PendingChallenge = Challenge & { index: number };

type DeferredChallenge = { index: number; communityChallenge: CommunityChallenge };

export type GetChallengeAnswers = (challenges: Omit<Challenge, "verify">[]) => Promise<DecryptedChallengeAnswer["challengeAnswers"]>;

type ChallengeVerificationSuccess = { challengeSuccess: true; pendingApprovalSuccess: boolean };
type ChallengeVerificationPending = {
    pendingChallenges: PendingChallenge[];
    pendingApprovalSuccess: boolean;
    deferredChallenges?: DeferredChallenge[];
    partialResults?: (Challenge | ChallengeResult | undefined)[];
    communityChallenges?: CommunityChallenge[];
};
type ChallengeVerificationFailure = {
    challengeSuccess: false;
    challengeErrors: NonNullable<ChallengeVerificationMessageType["challengeErrors"]>;
};

// Use structural typing for the pkc param to avoid circular import issues
type PKCWithSettingsChallenges = {
    settings?: { challenges?: Record<string, ChallengeFileFactoryInput> };
};

const resolveChallengeFactoryByName = ({
    name,
    pkc
}: {
    name: string;
    pkc?: PKCWithSettingsChallenges;
}): { factory: ChallengeFileFactoryInput | undefined } => {
    // User-defined shadows built-ins
    return { factory: pkc?.settings?.challenges?.[name] ?? pkcJsChallenges[name] };
};

const pkcJsChallenges: Record<string, ChallengeFileFactoryInput> = {
    "text-math": textMath,
    fail: fail,
    blacklist: blacklist,
    whitelist: whitelist,
    question: question,
    "publication-match": publicationMatch
};

const validateChallengeFileFactory = ({
    challengeFileFactory,
    challengeIndex,
    community
}: {
    challengeFileFactory: ChallengeFileFactory;
    challengeIndex: number;
    community: LocalCommunity;
}): { ok: true } => {
    const communityChallengeSettings = community?.settings?.challenges?.[challengeIndex];
    if (typeof challengeFileFactory !== "function") {
        throw Error(
            `invalid challenge file factory export from community challenge '${communityChallengeSettings?.name || communityChallengeSettings?.path}' (challenge #${challengeIndex + 1})`
        );
    }
    return { ok: true };
};

const validateChallengeFile = ({
    challengeFile,
    challengeIndex,
    community
}: {
    challengeFile: ChallengeFile;
    challengeIndex: number;
    community: LocalCommunity;
}): { ok: true } => {
    const communityChallengeSettings = community.settings?.challenges?.[challengeIndex];
    if (typeof challengeFile?.getChallenge !== "function") {
        throw Error(
            `invalid challenge file from community challenge '${communityChallengeSettings?.name || communityChallengeSettings?.path}' (challenge #${challengeIndex + 1})`
        );
    }
    return { ok: true };
};

const validateChallengeResult = ({
    challengeResult,
    challengeIndex,
    community
}: {
    challengeResult: ChallengeResult;
    challengeIndex: number;
    community: LocalCommunity;
}): { ok: true } => {
    const communityChallengeSettings = community.settings?.challenges?.[challengeIndex];
    const error = `invalid challenge result from community challenge '${communityChallengeSettings?.name || communityChallengeSettings?.path}' (challenge #${challengeIndex + 1})`;
    if (typeof challengeResult?.success !== "boolean") {
        throw Error(error);
    }
    return { ok: true };
};

const validateChallengeOrChallengeResult = ({
    challengeOrChallengeResult,
    challengeIndex,
    community
}: {
    challengeOrChallengeResult: Challenge | ChallengeResult;
    challengeIndex: number;
    community: LocalCommunity;
}): { ok: true } => {
    if ("success" in challengeOrChallengeResult) {
        validateChallengeResult({ challengeResult: challengeOrChallengeResult, challengeIndex, community });
    } else if (
        typeof challengeOrChallengeResult?.["challenge"] !== "string" ||
        typeof challengeOrChallengeResult?.["type"] !== "string" ||
        typeof challengeOrChallengeResult?.["verify"] !== "function"
    ) {
        throw Error("The challenge does not contain the correct {challenge, type, verify}");
    }
    return { ok: true };
};

// load and validate a challenge factory + ChallengeFile for one challenge index
const loadChallengeFile = async ({
    communityChallengeSettings,
    challengeIndex,
    community
}: {
    communityChallengeSettings: CommunityChallengeSetting;
    challengeIndex: number;
    community: LocalCommunity;
}): Promise<{ challengeFile: ChallengeFile }> => {
    if (
        !communityChallengeSettings.path &&
        !resolveChallengeFactoryByName({ name: communityChallengeSettings.name!, pkc: community._pkc }).factory
    )
        throw Error("You have to provide either path or a stored pkc-js challenge");
    let ChallengeFileFactory: ChallengeFileFactory;
    try {
        ChallengeFileFactory = ChallengeFileFactorySchema.parse(
            communityChallengeSettings.path
                ? (await import(pathToFileURL(communityChallengeSettings.path).href)).default
                : resolveChallengeFactoryByName({ name: communityChallengeSettings.name!, pkc: community._pkc }).factory
        );
        validateChallengeFileFactory({ challengeFileFactory: ChallengeFileFactory, challengeIndex, community });
    } catch (e) {
        throw new PKCError("ERR_FAILED_TO_IMPORT_CHALLENGE_FILE_FACTORY", {
            path: communityChallengeSettings.path,
            communityChallengeSettings,
            error: e,
            challengeIndex
        });
    }
    const challengeFile = ChallengeFileFactory({ challengeSettings: communityChallengeSettings });
    validateChallengeFile({ challengeFile, challengeIndex, community });
    return { challengeFile };
};

// invoke getChallenge() with shared error handling and result validation
const callGetChallenge = async ({
    challengeFile,
    communityChallengeSettings,
    challengeRequestMessage,
    challengeIndex,
    community
}: {
    challengeFile: ChallengeFile;
    communityChallengeSettings: CommunityChallengeSetting;
    challengeRequestMessage: DecryptedChallengeRequestMessageTypeWithCommunityAuthor;
    challengeIndex: number;
    community: LocalCommunity;
}): Promise<{ challengeOrChallengeResult: Challenge | ChallengeResult }> => {
    let challengeOrChallengeResult: Challenge | ChallengeResult;
    try {
        challengeOrChallengeResult = await challengeFile.getChallenge({
            challengeSettings: communityChallengeSettings,
            challengeRequestMessage,
            challengeIndex,
            community
        });
        validateChallengeOrChallengeResult({ challengeOrChallengeResult, challengeIndex, community });
    } catch (e) {
        throw new PKCError("ERR_INVALID_RESULT_FROM_GET_CHALLENGE_FUNCTION", {
            communityChallengeSettings,
            challengeName: communityChallengeSettings.name || communityChallengeSettings.path,
            challengeRequestMessage,
            challengeIndex: challengeIndex + 1,
            error: e
        });
    }
    return { challengeOrChallengeResult };
};

// Phase 2 decision for a single not-yet-decided challenge. Unlike `shouldExcludeChallengeSuccess`,
// this works without `results[i]` being populated — it just looks at the deps:
//   "exclude" — at least one exclude rule's `.challenges` are all decided-success → skip getChallenge.
//   "defer"   — at least one rule has all deps decided-success-or-pending with ≥1 pending dep that
//               does NOT mutually reference i. Calling i wouldn't change the pending dep's outcome,
//               so we hold off and let verify-time decide.
//   "ready"   — every rule's deps are decided AND no rule meets the exclude/defer criteria.
//   "skip"    — at least one rule has an undecided dep that could still flip; try again next round.
//
// The mutual-reference rule for "defer": if dep j is pending and j's own exclude.challenges
// references i, then calling i could resolve j (i success would exclude j). In that case we want
// to call i, not defer it (e.g. the question-OR-whitelist pattern). If j doesn't reference i back,
// calling i has no influence on j's outcome — defer i and let verify decide (the issue #81 case:
// AI moderation defers behind a one-way pending spam-blocker iframe).
type PhaseExclusionDecision = "exclude" | "defer" | "ready" | "skip";
const evaluatePhase2Exclusion = ({
    i,
    communityChallenges,
    decided,
    results
}: {
    i: number;
    communityChallenges: CommunityChallenge[];
    decided: boolean[];
    results: (Challenge | ChallengeResult | undefined)[];
}): { decision: PhaseExclusionDecision } => {
    const communityChallenge = communityChallenges[i];
    if (!communityChallenge.exclude?.length) return { decision: "ready" };
    let allRulesEvaluable = true;
    let anyDeferRule = false;
    for (const item of communityChallenge.exclude) {
        if (!item.challenges?.length) continue;
        let allDecided = true;
        for (const j of item.challenges) {
            if (!decided[j]) {
                allDecided = false;
                break;
            }
        }
        if (!allDecided) {
            allRulesEvaluable = false;
            continue;
        }
        let allSuccessOrPending = true;
        let anyPending = false;
        const pendingDeps: number[] = [];
        for (const j of item.challenges) {
            const r = results[j];
            if (r === undefined) {
                allSuccessOrPending = false;
                break;
            }
            if ("success" in r) {
                if (r.success !== true) {
                    allSuccessOrPending = false;
                    break;
                }
            } else {
                anyPending = true;
                pendingDeps.push(j);
            }
        }
        if (!allSuccessOrPending) continue;
        if (!anyPending) return { decision: "exclude" }; // all deps succeeded → definitively exclude i
        // Tentative match (some pending). Defer only if no pending dep references i back —
        // otherwise calling i could affect the pending dep's exclusion, so we should call.
        let allOneWay = true;
        for (const j of pendingDeps) {
            const cj = communityChallenges[j];
            const referencesBack = cj.exclude?.some((it) => it.challenges?.includes(i));
            if (referencesBack) {
                allOneWay = false;
                break;
            }
        }
        if (allOneWay) anyDeferRule = true;
    }
    if (anyDeferRule) return { decision: "defer" };
    return { decision: allRulesEvaluable ? "ready" : "skip" };
};

const getPendingChallengesOrChallengeVerification = async ({
    challengeRequestMessage,
    community
}: {
    challengeRequestMessage: DecryptedChallengeRequestMessageTypeWithCommunityAuthor;
    community: LocalCommunity;
}): Promise<ChallengeVerificationSuccess | ChallengeVerificationPending | ChallengeVerificationFailure> => {
    // if community has no challenges, no need to send a challenge
    if (!Array.isArray(community.settings?.challenges))
        return {
            challengeSuccess: true,
            pendingApprovalSuccess: false
        };
    const challengeCount = community.settings.challenges.length;
    const results: (Challenge | ChallengeResult | undefined)[] = new Array(challengeCount);
    const decided: boolean[] = new Array(challengeCount).fill(false);

    // Phase 0: load CommunityChallenge records for every index in parallel.
    const communityChallenges = await Promise.all(
        community.settings.challenges.map(
            async (s) =>
                (
                    await getCommunityChallengeFromCommunityChallengeSettings({
                        communityChallengeSettings: s,
                        pkc: community._pkc
                    })
                ).communityChallenge
        )
    );

    // Phase 0b: load challenge files (factories) for every index in parallel — needed for getChallenge calls
    // in phases 2/3. Loading them upfront avoids re-importing during the dependency-ordered loop.
    const challengeFiles = await Promise.all(
        community.settings.challenges.map(
            async (s, i) => (await loadChallengeFile({ communityChallengeSettings: s, challengeIndex: i, community })).challengeFile
        )
    );

    // Phase 1: request-only excludes (parallel). Indexes excluded here never reach getChallenge.
    await Promise.all(
        communityChallenges.map(async (communityChallenge, i) => {
            if (shouldExcludePublication(communityChallenge, challengeRequestMessage, community)) {
                decided[i] = true;
                return;
            }
            if (await shouldExcludeChallengeCommentCids(communityChallenge, challengeRequestMessage, community._pkc)) {
                decided[i] = true;
            }
        })
    );

    // Phase 2 + 3: dependency-ordered resolution with incremental cycle-break.
    // `deferred[i] = true` means index i was decided but its result is not yet known — it will be
    // resolved at verify time once pending challenges produce verify outcomes.
    const deferred: boolean[] = new Array(challengeCount).fill(false);
    while (true) {
        let progress = false;

        for (let i = 0; i < challengeCount; i++) {
            if (decided[i]) continue;
            const { decision } = evaluatePhase2Exclusion({ i, communityChallenges, decided, results });
            if (decision === "skip") continue;
            if (decision === "exclude") {
                decided[i] = true;
            } else if (decision === "defer") {
                decided[i] = true;
                deferred[i] = true;
            } else {
                results[i] = (
                    await callGetChallenge({
                        challengeFile: challengeFiles[i],
                        communityChallengeSettings: community.settings.challenges[i],
                        challengeRequestMessage,
                        challengeIndex: i,
                        community
                    })
                ).challengeOrChallengeResult;
                decided[i] = true;
            }
            progress = true;
        }

        if (progress) continue;
        // Stalled. Decide between phase 3 (cycle-break) and phase 4 (defer remaining).
        const hasPending = results.some((r) => r !== undefined && !("success" in r));
        const firstUndecided = decided.findIndex((d) => !d);
        if (firstUndecided === -1) break;
        if (hasPending) {
            // Defer all remaining undecided to verify time.
            for (let i = 0; i < challengeCount; i++) {
                if (!decided[i]) {
                    decided[i] = true;
                    deferred[i] = true;
                }
            }
            break;
        }
        // Phase 3: cycle-break by calling getChallenge for the lowest-index undecided challenge.
        results[firstUndecided] = (
            await callGetChallenge({
                challengeFile: challengeFiles[firstUndecided],
                communityChallengeSettings: community.settings.challenges[firstUndecided],
                challengeRequestMessage,
                challengeIndex: firstUndecided,
                community
            })
        ).challengeOrChallengeResult;
        decided[firstUndecided] = true;
    }

    // Phase 4: collect deferred-bucket entries.
    const deferredChallenges: DeferredChallenge[] = [];
    for (let i = 0; i < challengeCount; i++) {
        if (deferred[i]) deferredChallenges.push({ index: i, communityChallenge: communityChallenges[i] });
    }

    // Phase 5: classification — tally failures, pending, pendingApproval over the populated result
    // array. Mirrors the original two-pass orchestrator: shouldExcludeChallengeSuccess is applied
    // uniformly to every populated slot before classifying its result.
    let challengeFailureCount = 0;
    let pendingChallenges: PendingChallenge[] = [];
    const challengeErrors: NonNullable<ChallengeVerificationMessageType["challengeErrors"]> = {};
    let pendingApprovalSuccess = false;
    for (let i = 0; i < challengeCount; i++) {
        const r = results[i];
        if (r === undefined) continue; // excluded earlier (phase 1 or phase 2)
        if (shouldExcludeChallengeSuccess(communityChallenges[i], i, results as (Challenge | ChallengeResult)[])) continue;
        if ("success" in r && r.success === false) {
            challengeFailureCount++;
            challengeErrors[i] = r.error;
        } else if ("success" in r && r.success === true) {
            if (communityChallenges[i].pendingApproval) pendingApprovalSuccess = true;
        } else {
            pendingChallenges.push({ ...r, index: i });
        }
    }

    let challengeSuccess: boolean | undefined = undefined;

    // any failure short-circuits pending and deferred
    if (challengeFailureCount > 0) {
        challengeSuccess = false;
        pendingChallenges = [];
    }
    if (pendingChallenges.length === 0 && challengeFailureCount === 0) {
        challengeSuccess = true;
    }

    if (challengeSuccess === true) return { challengeSuccess, pendingApprovalSuccess };
    if (challengeSuccess === false) return { challengeSuccess, challengeErrors };
    return {
        pendingChallenges,
        pendingApprovalSuccess,
        deferredChallenges: deferredChallenges.length > 0 ? deferredChallenges : undefined,
        partialResults: results,
        communityChallenges
    };
};

const getChallengeVerificationFromChallengeAnswers = async ({
    pendingChallenges,
    challengeAnswers,
    community,
    challengeRequestMessage,
    deferredChallenges,
    partialResults,
    communityChallenges
}: {
    pendingChallenges: PendingChallenge[];
    challengeAnswers: DecryptedChallengeAnswer["challengeAnswers"];
    community: LocalCommunity;
    challengeRequestMessage?: DecryptedChallengeRequestMessageTypeWithCommunityAuthor;
    deferredChallenges?: DeferredChallenge[];
    partialResults?: (Challenge | ChallengeResult | undefined)[];
    communityChallenges?: CommunityChallenge[];
}): Promise<ChallengeVerificationSuccess | ChallengeVerificationFailure> => {
    if (!Array.isArray(community.settings?.challenges)) throw Error("community.settings?.challenges is not defined");
    const challengeCount = community.settings.challenges.length;

    // Run verify() for every pending challenge in parallel.
    const verifyChallengePromises: Promise<ChallengeResult>[] = [];
    for (const i in pendingChallenges) {
        verifyChallengePromises.push(Promise.resolve(pendingChallenges[i].verify(challengeAnswers[i])));
    }
    const challengeResultsWithPendingIndexes = await Promise.all(verifyChallengePromises);
    for (const i in challengeResultsWithPendingIndexes) {
        validateChallengeResult({
            challengeResult: challengeResultsWithPendingIndexes[Number(i)],
            challengeIndex: pendingChallenges[Number(i)].index,
            community
        });
    }

    // Hydrate the result array from the persisted partial state. The pre-verify orchestrator marks
    // excluded slots as undefined, resolved-immediate slots with their {success} object, and the
    // pending slots with their {challenge, verify, type} object — replace those pending slots with
    // the verify result here.
    const results: (Challenge | ChallengeResult | undefined)[] = partialResults ? partialResults.slice() : new Array(challengeCount);
    for (const i in challengeResultsWithPendingIndexes) {
        results[pendingChallenges[i].index] = challengeResultsWithPendingIndexes[i];
    }

    // Lazily reload CommunityChallenge records if the caller didn't pass them through (back-compat).
    const loadedCommunityChallenges =
        communityChallenges ??
        (await Promise.all(
            community.settings.challenges.map(
                async (s) =>
                    (
                        await getCommunityChallengeFromCommunityChallengeSettings({
                            communityChallengeSettings: s,
                            pkc: community._pkc
                        })
                    ).communityChallenge
            )
        ));

    // Resolve the deferred bucket. By this point all originally-pending challenges have a verify
    // result, so the dependency-ordered fixpoint can make progress for any deferred challenge whose
    // exclude.challenges deps are all decided.
    const deferred = deferredChallenges ?? [];
    if (deferred.length > 0) {
        if (!challengeRequestMessage)
            throw Error(
                "getChallengeVerificationFromChallengeAnswers requires challengeRequestMessage when deferredChallenges is non-empty"
            );
        const decided: boolean[] = new Array(challengeCount).fill(true);
        for (const d of deferred) decided[d.index] = false;

        // Reload challenge files lazily — only for deferred indexes whose getChallenge actually fires.
        const challengeFilesByIndex: Record<number, ChallengeFile> = {};
        const ensureChallengeFile = async (i: number): Promise<ChallengeFile> => {
            if (!challengeFilesByIndex[i]) {
                challengeFilesByIndex[i] = (
                    await loadChallengeFile({
                        communityChallengeSettings: community.settings!.challenges![i],
                        challengeIndex: i,
                        community
                    })
                ).challengeFile;
            }
            return challengeFilesByIndex[i];
        };

        while (true) {
            let progress = false;
            for (const d of deferred) {
                const i = d.index;
                if (decided[i]) continue;
                const { decision } = evaluatePhase2Exclusion({
                    i,
                    communityChallenges: loadedCommunityChallenges,
                    decided,
                    results
                });
                if (decision === "skip") continue;
                if (decision === "exclude" || decision === "defer") {
                    // No more pending challenges at verify time, so "defer" collapses to "exclude":
                    // a tentatively-matching rule has all-decided deps and ≥1 was pending — but
                    // those have verify results now, so the rule no longer matches via pending. Treat
                    // as exclude to be safe: the slot stays undefined, which is the same as today's
                    // "filtered out" semantics.
                    decided[i] = true;
                } else {
                    const file = await ensureChallengeFile(i);
                    results[i] = (
                        await callGetChallenge({
                            challengeFile: file,
                            communityChallengeSettings: community.settings!.challenges![i],
                            challengeRequestMessage,
                            challengeIndex: i,
                            community
                        })
                    ).challengeOrChallengeResult;
                    decided[i] = true;
                }
                progress = true;
            }
            if (progress) continue;
            const firstUndecided = decided.findIndex((d) => !d);
            if (firstUndecided === -1) break;
            // Cycle-break: lowest-index undecided deferred index.
            const file = await ensureChallengeFile(firstUndecided);
            results[firstUndecided] = (
                await callGetChallenge({
                    challengeFile: file,
                    communityChallengeSettings: community.settings!.challenges![firstUndecided],
                    challengeRequestMessage,
                    challengeIndex: firstUndecided,
                    community
                })
            ).challengeOrChallengeResult;
            decided[firstUndecided] = true;
        }
    }

    // Classification over the final result array.
    let challengeFailureCount = 0;
    const challengeErrors: NonNullable<ChallengeVerificationMessageType["challengeErrors"]> = {};
    let pendingApprovalSuccess = false;
    for (let i = 0; i < challengeCount; i++) {
        const r = results[i];
        if (r === undefined) continue;
        if ("success" in r && r.success === false) {
            if (shouldExcludeChallengeSuccess(loadedCommunityChallenges[i], i, results as (Challenge | ChallengeResult)[])) continue;
            challengeFailureCount++;
            challengeErrors[i] = r.error;
        } else if ("success" in r && r.success === true) {
            if (shouldExcludeChallengeSuccess(loadedCommunityChallenges[i], i, results as (Challenge | ChallengeResult)[])) continue;
            if (loadedCommunityChallenges[i].pendingApproval) pendingApprovalSuccess = true;
        }
        // Any pending shape left at this point would be unexpected; ignore.
    }

    if (challengeFailureCount > 0) {
        return {
            challengeSuccess: false,
            challengeErrors
        };
    }
    return {
        challengeSuccess: true,
        pendingApprovalSuccess
    };
};

const getChallengeVerification = async ({
    challengeRequestMessage,
    community,
    getChallengeAnswers
}: {
    challengeRequestMessage: DecryptedChallengeRequestMessageTypeWithCommunityAuthor;
    community: LocalCommunity;
    getChallengeAnswers: GetChallengeAnswers;
}): Promise<Pick<ChallengeVerificationMessageType, "challengeErrors" | "challengeSuccess"> & { pendingApproval?: boolean }> => {
    if (!challengeRequestMessage) {
        throw Error(`getChallengeVerification invalid challengeRequestMessage argument '${challengeRequestMessage}'`);
    }
    if (typeof community?._pkc?.getComment !== "function") {
        throw Error(`getChallengeVerification invalid community argument '${community}' invalid community.pkc instance`);
    }
    if (typeof getChallengeAnswers !== "function") {
        throw Error(`getChallengeVerification invalid getChallengeAnswers argument '${getChallengeAnswers}' not a function`);
    }
    if (!Array.isArray(community.settings?.challenges)) throw Error("community.settings?.challenges is not defined");

    const res = await getPendingChallengesOrChallengeVerification({ challengeRequestMessage, community });
    let pendingApprovalSuccess = "pendingApprovalSuccess" in res ? res.pendingApprovalSuccess : false;

    let challengeVerification: Pick<ChallengeVerificationMessageType, "challengeSuccess" | "challengeErrors">;
    // was able to verify without asking author for challenges
    if ("pendingChallenges" in res) {
        const challengeAnswers = await getChallengeAnswers(
            res.pendingChallenges.map((challenge) => remeda.omit(challenge, ["index", "verify"]))
        );
        const verificationFromPending = await getChallengeVerificationFromChallengeAnswers({
            pendingChallenges: res.pendingChallenges,
            challengeAnswers,
            community,
            challengeRequestMessage,
            deferredChallenges: res.deferredChallenges,
            partialResults: res.partialResults,
            communityChallenges: res.communityChallenges
        });
        if ("pendingApprovalSuccess" in verificationFromPending) {
            pendingApprovalSuccess = pendingApprovalSuccess || verificationFromPending.pendingApprovalSuccess;
            challengeVerification = remeda.omit(verificationFromPending, ["pendingApprovalSuccess"]);
        } else {
            pendingApprovalSuccess = false;
            challengeVerification = verificationFromPending;
        }
    } else {
        challengeVerification = { challengeSuccess: res.challengeSuccess };
        if ("challengeErrors" in res) challengeVerification.challengeErrors = res.challengeErrors;
    }

    // store the publication result and author address in mem cache for rateLimit exclude challenge settings
    addToRateLimiter(community.settings?.challenges, challengeRequestMessage, challengeVerification.challengeSuccess);

    // scenarios:
    // - all required challenges pass without pendingApproval flag -> publish normally
    // - any challenge fails -> fail request
    // - requester passes every challenge and at least one non-excluded challenge has pendingApproval -> send to pending approval

    const shouldSendToPendingApproval =
        Boolean(challengeRequestMessage.comment) && challengeVerification.challengeSuccess === true && pendingApprovalSuccess;

    if (shouldSendToPendingApproval) {
        return { ...challengeVerification, pendingApproval: true };
    }
    return challengeVerification;
};

// get the data to be published publicly to community.challenges
const getCommunityChallengeFromCommunityChallengeSettings = async ({
    communityChallengeSettings,
    pkc
}: {
    communityChallengeSettings: CommunityChallengeSetting;
    pkc?: PKCWithSettingsChallenges;
}): Promise<{ communityChallenge: CommunityChallenge }> => {
    communityChallengeSettings = CommunityChallengeSettingSchema.parse(communityChallengeSettings);

    // if the challenge is an external file, fetch it and override the communityChallengeSettings values
    let challengeFile: ChallengeFile | undefined = undefined;
    if (communityChallengeSettings.path) {
        try {
            const importedFile = await import(pathToFileURL(communityChallengeSettings.path).href);
            const ChallengeFileFactory = ChallengeFileFactorySchema.parse(importedFile.default);
            challengeFile = ChallengeFileSchema.parse(ChallengeFileFactory({ challengeSettings: communityChallengeSettings }));
        } catch (e) {
            (e as PKCError).details = {
                ...(e as PKCError).details,
                path: communityChallengeSettings.path,
                communityChallengeSettings
            };
            if (e instanceof Error)
                e.message = `getCommunityChallengeFromCommunityChallengeSettings failed importing challenge with path '${communityChallengeSettings.path}': ${e.message}`;
            throw e;
        }
    }
    // else, the challenge is included with pkc-js or user-defined
    else if (communityChallengeSettings.name) {
        const ChallengeFileFactory = ChallengeFileFactorySchema.parse(
            resolveChallengeFactoryByName({ name: communityChallengeSettings.name, pkc }).factory
        );
        challengeFile = ChallengeFileSchema.parse(ChallengeFileFactory({ challengeSettings: communityChallengeSettings }));
    }
    if (!challengeFile) throw Error("Failed to load challenge file");
    const { challenge, type } = challengeFile;
    return {
        communityChallenge: {
            exclude: communityChallengeSettings.exclude,
            description: communityChallengeSettings.description || challengeFile.description,
            challenge,
            type,
            caseInsensitive: challengeFile.caseInsensitive,
            pendingApproval: communityChallengeSettings.pendingApproval
        }
    };
};

export {
    pkcJsChallenges,
    getPendingChallengesOrChallengeVerification,
    getChallengeVerificationFromChallengeAnswers,
    getChallengeVerification,
    getCommunityChallengeFromCommunityChallengeSettings
};
