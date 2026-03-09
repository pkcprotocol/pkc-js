import {
    shouldExcludeChallengeCommentCids,
    shouldExcludePublication,
    shouldExcludeChallengeSuccess,
    addToRateLimiter
} from "./exclude/index.js";

// all challenges included with plebbit-js, in Plebbit.challenges
import textMath from "./plebbit-js-challenges/text-math.js";
import fail from "./plebbit-js-challenges/fail.js";
import blacklist from "./plebbit-js-challenges/blacklist.js";
import whitelist from "./plebbit-js-challenges/whitelist.js";
import question from "./plebbit-js-challenges/question.js";
import publicationMatch from "./plebbit-js-challenges/publication-match.js";
import type {
    ChallengeVerificationMessageType,
    DecryptedChallengeAnswer,
    DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor
} from "../../../../pubsub-messages/types.js";
import type {
    Challenge,
    ChallengeFile,
    ChallengeFileFactory,
    ChallengeFileFactoryInput,
    ChallengeResult,
    SubplebbitChallenge,
    SubplebbitChallengeSetting
} from "../../../../subplebbit/types.js";
import { LocalSubplebbit } from "../local-subplebbit.js";
import * as remeda from "remeda";
import { ChallengeFileFactorySchema, ChallengeFileSchema, SubplebbitChallengeSettingSchema } from "../../../../subplebbit/schema.js";
import { PlebbitError } from "../../../../plebbit-error.js";
import { pathToFileURL } from "node:url";

type PendingChallenge = Challenge & { index: number };

export type GetChallengeAnswers = (challenges: Omit<Challenge, "verify">[]) => Promise<DecryptedChallengeAnswer["challengeAnswers"]>;

type ChallengeVerificationSuccess = { challengeSuccess: true; pendingApprovalSuccess: boolean };
type ChallengeVerificationPending = { pendingChallenges: PendingChallenge[]; pendingApprovalSuccess: boolean };
type ChallengeVerificationFailure = {
    challengeSuccess: false;
    challengeErrors: NonNullable<ChallengeVerificationMessageType["challengeErrors"]>;
};

// Use structural typing for the plebbit param to avoid circular import issues
type PlebbitWithSettingsChallenges = {
    settings?: { challenges?: Record<string, ChallengeFileFactoryInput> };
};

const resolveChallengeFactoryByName = (name: string, plebbit?: PlebbitWithSettingsChallenges): ChallengeFileFactoryInput | undefined => {
    // User-defined shadows built-ins
    return plebbit?.settings?.challenges?.[name] ?? plebbitJsChallenges[name];
};

const plebbitJsChallenges: Record<string, ChallengeFileFactoryInput> = {
    "text-math": textMath,
    fail: fail,
    blacklist: blacklist,
    whitelist: whitelist,
    question: question,
    "publication-match": publicationMatch
};

const validateChallengeFileFactory = (challengeFileFactory: ChallengeFileFactory, challengeIndex: number, subplebbit: LocalSubplebbit) => {
    const subplebbitChallengeSettings = subplebbit?.settings?.challenges?.[challengeIndex];
    if (typeof challengeFileFactory !== "function") {
        throw Error(
            `invalid challenge file factory export from subplebbit challenge '${subplebbitChallengeSettings?.name || subplebbitChallengeSettings?.path}' (challenge #${challengeIndex + 1})`
        );
    }
};

const validateChallengeFile = (challengeFile: ChallengeFile, challengeIndex: number, subplebbit: LocalSubplebbit) => {
    const subplebbitChallengeSettings = subplebbit.settings?.challenges?.[challengeIndex];
    if (typeof challengeFile?.getChallenge !== "function") {
        throw Error(
            `invalid challenge file from subplebbit challenge '${subplebbitChallengeSettings?.name || subplebbitChallengeSettings?.path}' (challenge #${challengeIndex + 1})`
        );
    }
};

const validateChallengeResult = (challengeResult: ChallengeResult, challengeIndex: number, subplebbit: LocalSubplebbit) => {
    const subplebbitChallengeSettings = subplebbit.settings?.challenges?.[challengeIndex];
    const error = `invalid challenge result from subplebbit challenge '${subplebbitChallengeSettings?.name || subplebbitChallengeSettings?.path}' (challenge #${challengeIndex + 1})`;
    if (typeof challengeResult?.success !== "boolean") {
        throw Error(error);
    }
};

const validateChallengeOrChallengeResult = (
    challengeOrChallengeResult: Challenge | ChallengeResult,
    challengeIndex: number,
    subplebbit: LocalSubplebbit
) => {
    if ("success" in challengeOrChallengeResult) {
        validateChallengeResult(challengeOrChallengeResult, challengeIndex, subplebbit);
    } else if (
        typeof challengeOrChallengeResult?.["challenge"] !== "string" ||
        typeof challengeOrChallengeResult?.["type"] !== "string" ||
        typeof challengeOrChallengeResult?.["verify"] !== "function"
    ) {
        throw Error("The challenge does not contain the correct {challenge, type, verify}");
    }
};

const getPendingChallengesOrChallengeVerification = async (
    challengeRequestMessage: DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor,
    subplebbit: LocalSubplebbit
): Promise<ChallengeVerificationSuccess | ChallengeVerificationPending | ChallengeVerificationFailure> => {
    // if sub has no challenges, no need to send a challenge
    if (!Array.isArray(subplebbit.settings?.challenges))
        return {
            challengeSuccess: true,
            pendingApprovalSuccess: false
        };
    const challengeOrChallengeResults: (Challenge | ChallengeResult)[] = [];
    // interate over all challenges of the subplebbit, can be more than 1
    for (const i in subplebbit.settings.challenges) {
        const challengeIndex = Number(i);
        const subplebbitChallengeSettings = subplebbit.settings.challenges[challengeIndex];

        if (!subplebbitChallengeSettings.path && !resolveChallengeFactoryByName(subplebbitChallengeSettings.name!, subplebbit._plebbit))
            throw Error("You have to provide either path or a stored plebbit-js challenge");
        // if the challenge is an external file, fetch it and override the subplebbitChallengeSettings values
        let ChallengeFileFactory: ChallengeFileFactory;

        try {
            ChallengeFileFactory = ChallengeFileFactorySchema.parse(
                subplebbitChallengeSettings.path
                    ? (await import(pathToFileURL(subplebbitChallengeSettings.path).href)).default
                    : resolveChallengeFactoryByName(subplebbitChallengeSettings.name!, subplebbit._plebbit)
            );
            validateChallengeFileFactory(ChallengeFileFactory, challengeIndex, subplebbit);
        } catch (e) {
            throw new PlebbitError("ERR_FAILED_TO_IMPORT_CHALLENGE_FILE_FACTORY", {
                path: subplebbitChallengeSettings.path,
                subplebbitChallengeSettings,
                error: e,
                challengeIndex
            });
        }

        const challengeFile = ChallengeFileFactory({ challengeSettings: subplebbitChallengeSettings });
        validateChallengeFile(challengeFile, challengeIndex, subplebbit);

        let challengeOrChallengeResult: Challenge | ChallengeResult;
        try {
            // the getChallenge function could throw
            challengeOrChallengeResult = await challengeFile.getChallenge({
                challengeSettings: subplebbitChallengeSettings,
                challengeRequestMessage,
                challengeIndex,
                subplebbit
            });
            validateChallengeOrChallengeResult(challengeOrChallengeResult, challengeIndex, subplebbit);
        } catch (e) {
            throw new PlebbitError("ERR_INVALID_RESULT_FROM_GET_CHALLENGE_FUNCTION", {
                subplebbitChallengeSettings,
                challengeName: subplebbitChallengeSettings.name || subplebbitChallengeSettings.path,
                challengeRequestMessage,
                challengeIndex: challengeIndex + 1,
                error: e
            });
        }
        challengeOrChallengeResults.push(challengeOrChallengeResult);
    }

    // check failures and errors
    let challengeFailureCount = 0;
    let pendingChallenges: PendingChallenge[] = [];
    const challengeErrors: NonNullable<ChallengeVerificationMessageType["challengeErrors"]> = {};
    let pendingApprovalSuccess = false;
    for (const i in challengeOrChallengeResults) {
        const challengeIndex = Number(i);
        const challengeOrChallengeResult = challengeOrChallengeResults[challengeIndex];

        const subplebbitChallengeSettings = subplebbit.settings.challenges[challengeIndex];
        const subplebbitChallenge = await getSubplebbitChallengeFromSubplebbitChallengeSettings(
            subplebbitChallengeSettings,
            subplebbit._plebbit
        );

        // exclude author from challenge based on the subplebbit minimum karma settings
        if (shouldExcludePublication(subplebbitChallenge, challengeRequestMessage, subplebbit)) {
            continue;
        }
        if (await shouldExcludeChallengeCommentCids(subplebbitChallenge, challengeRequestMessage, subplebbit._plebbit)) {
            continue;
        }

        // exclude based on other challenges successes
        if (shouldExcludeChallengeSuccess(subplebbitChallenge, challengeIndex, challengeOrChallengeResults)) {
            continue;
        }

        if ("success" in challengeOrChallengeResult && challengeOrChallengeResult.success === false) {
            challengeFailureCount++;
            challengeErrors[challengeIndex] = challengeOrChallengeResult.error;
        } else if ("success" in challengeOrChallengeResult && challengeOrChallengeResult.success === true) {
            if (subplebbit.challenges?.[challengeIndex]?.pendingApproval) {
                pendingApprovalSuccess = true;
            }
        } else {
            // index is needed to exlude based on other challenge success in getChallengeVerification
            pendingChallenges.push({ ...challengeOrChallengeResult, index: challengeIndex });
        }
    }

    // challenge success can be undefined if there are pending challenges
    let challengeSuccess = undefined;

    // if there are any failures, success is false and pending challenges are ignored
    if (challengeFailureCount > 0) {
        challengeSuccess = false;
        pendingChallenges = [];
    }

    // if there are no pending challenges and no failures, success is true
    if (pendingChallenges.length === 0 && challengeFailureCount === 0) {
        challengeSuccess = true;
    }

    // create return value
    if (challengeSuccess === true) {
        return { challengeSuccess, pendingApprovalSuccess };
    } else if (challengeSuccess === false) {
        return {
            challengeSuccess,
            challengeErrors
        };
    } else {
        return { pendingChallenges, pendingApprovalSuccess };
    }
};

const getChallengeVerificationFromChallengeAnswers = async (
    pendingChallenges: PendingChallenge[],
    challengeAnswers: DecryptedChallengeAnswer["challengeAnswers"],
    subplebbit: LocalSubplebbit
): Promise<ChallengeVerificationSuccess | ChallengeVerificationFailure> => {
    const verifyChallengePromises: Promise<ChallengeResult>[] = [];
    for (const i in pendingChallenges) {
        verifyChallengePromises.push(Promise.resolve(pendingChallenges[i].verify(challengeAnswers[i])));
    }
    const challengeResultsWithPendingIndexes = await Promise.all(verifyChallengePromises);

    // validate results
    for (const i in challengeResultsWithPendingIndexes) {
        const challengeResult = challengeResultsWithPendingIndexes[Number(i)];
        validateChallengeResult(challengeResult, pendingChallenges[Number(i)].index, subplebbit);
    }

    // when filtering only pending challenges, the original indexes get lost so restore them
    const challengeResults: ChallengeResult[] = [];
    const challengeResultToPendingChallenge: PendingChallenge[] = [];
    for (const i in challengeResultsWithPendingIndexes) {
        challengeResults[pendingChallenges[i].index] = challengeResultsWithPendingIndexes[i];
        challengeResultToPendingChallenge[pendingChallenges[i].index] = pendingChallenges[i];
    }

    let challengeFailureCount = 0;
    const challengeErrors: NonNullable<ChallengeVerificationMessageType["challengeErrors"]> = {};
    let pendingApprovalSuccess = false;
    for (let i in challengeResults) {
        const challengeIndex = Number(i);
        if (!subplebbit.settings?.challenges?.[challengeIndex])
            throw Error("subplebbit.settings.challenges[challengeIndex] does not exist");
        const challengeResult = challengeResults[challengeIndex];

        // the challenge results that were filtered out were already successful
        if (challengeResult === undefined) {
            continue;
        }

        // exclude based on other challenges successes
        if (shouldExcludeChallengeSuccess(subplebbit.settings.challenges[challengeIndex], challengeIndex, challengeResults)) {
            continue;
        }

        if (challengeResult.success === false) {
            challengeFailureCount++;
            challengeErrors[challengeIndex] = challengeResult.error;
        } else if (challengeResult.success === true && subplebbit.settings.challenges[challengeIndex]?.pendingApproval) {
            pendingApprovalSuccess = true;
        }
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

const getChallengeVerification = async (
    challengeRequestMessage: DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor,
    subplebbit: LocalSubplebbit,
    getChallengeAnswers: GetChallengeAnswers
): Promise<Pick<ChallengeVerificationMessageType, "challengeErrors" | "challengeSuccess"> & { pendingApproval?: boolean }> => {
    if (!challengeRequestMessage) {
        throw Error(`getChallengeVerification invalid challengeRequestMessage argument '${challengeRequestMessage}'`);
    }
    if (typeof subplebbit?._plebbit?.getComment !== "function") {
        throw Error(`getChallengeVerification invalid subplebbit argument '${subplebbit}' invalid subplebbit.plebbit instance`);
    }
    if (typeof getChallengeAnswers !== "function") {
        throw Error(`getChallengeVerification invalid getChallengeAnswers argument '${getChallengeAnswers}' not a function`);
    }
    if (!Array.isArray(subplebbit.settings?.challenges)) throw Error("subplebbit.settings?.challenges is not defined");

    const res = await getPendingChallengesOrChallengeVerification(challengeRequestMessage, subplebbit);
    let pendingApprovalSuccess = "pendingApprovalSuccess" in res ? res.pendingApprovalSuccess : false;

    let challengeVerification: Pick<ChallengeVerificationMessageType, "challengeSuccess" | "challengeErrors">;
    // was able to verify without asking author for challenges
    if ("pendingChallenges" in res) {
        const challengeAnswers = await getChallengeAnswers(
            res.pendingChallenges.map((challenge) => remeda.omit(challenge, ["index", "verify"]))
        );
        const verificationFromPending = await getChallengeVerificationFromChallengeAnswers(
            res.pendingChallenges,
            challengeAnswers,
            subplebbit
        );
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
    addToRateLimiter(subplebbit.settings?.challenges, challengeRequestMessage, challengeVerification.challengeSuccess);

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

// get the data to be published publicly to subplebbit.challenges
const getSubplebbitChallengeFromSubplebbitChallengeSettings = async (
    subplebbitChallengeSettings: SubplebbitChallengeSetting,
    plebbit?: PlebbitWithSettingsChallenges
): Promise<SubplebbitChallenge> => {
    subplebbitChallengeSettings = SubplebbitChallengeSettingSchema.parse(subplebbitChallengeSettings);

    // if the challenge is an external file, fetch it and override the subplebbitChallengeSettings values
    let challengeFile: ChallengeFile | undefined = undefined;
    if (subplebbitChallengeSettings.path) {
        try {
            const importedFile = await import(pathToFileURL(subplebbitChallengeSettings.path).href);
            const ChallengeFileFactory = ChallengeFileFactorySchema.parse(importedFile.default);
            challengeFile = ChallengeFileSchema.parse(ChallengeFileFactory({ challengeSettings: subplebbitChallengeSettings }));
        } catch (e) {
            (e as PlebbitError).details = {
                ...(e as PlebbitError).details,
                path: subplebbitChallengeSettings.path,
                subplebbitChallengeSettings,
                error: e
            };
            if (e instanceof Error)
                e.message = `getSubplebbitChallengeFromSubplebbitChallengeSettings failed importing challenge with path '${subplebbitChallengeSettings.path}': ${e.message}`;
            throw e;
        }
    }
    // else, the challenge is included with plebbit-js or user-defined
    else if (subplebbitChallengeSettings.name) {
        const ChallengeFileFactory = ChallengeFileFactorySchema.parse(
            resolveChallengeFactoryByName(subplebbitChallengeSettings.name, plebbit)
        );
        challengeFile = ChallengeFileSchema.parse(ChallengeFileFactory({ challengeSettings: subplebbitChallengeSettings }));
    }
    if (!challengeFile) throw Error("Failed to load challenge file");
    const { challenge, type } = challengeFile;
    return {
        exclude: subplebbitChallengeSettings.exclude,
        description: subplebbitChallengeSettings.description || challengeFile.description,
        challenge,
        type,
        caseInsensitive: challengeFile.caseInsensitive,
        pendingApproval: subplebbitChallengeSettings.pendingApproval
    };
};

export {
    plebbitJsChallenges,
    getPendingChallengesOrChallengeVerification,
    getChallengeVerificationFromChallengeAnswers,
    getChallengeVerification,
    getSubplebbitChallengeFromSubplebbitChallengeSettings
};
