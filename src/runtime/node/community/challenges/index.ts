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

export type GetChallengeAnswers = (challenges: Omit<Challenge, "verify">[]) => Promise<DecryptedChallengeAnswer["challengeAnswers"]>;

type ChallengeVerificationSuccess = { challengeSuccess: true; pendingApprovalSuccess: boolean };
type ChallengeVerificationPending = { pendingChallenges: PendingChallenge[]; pendingApprovalSuccess: boolean };
type ChallengeVerificationFailure = {
    challengeSuccess: false;
    challengeErrors: NonNullable<ChallengeVerificationMessageType["challengeErrors"]>;
};

// Use structural typing for the pkc param to avoid circular import issues
type PKCWithSettingsChallenges = {
    settings?: { challenges?: Record<string, ChallengeFileFactoryInput> };
};

const resolveChallengeFactoryByName = (name: string, pkc?: PKCWithSettingsChallenges): ChallengeFileFactoryInput | undefined => {
    // User-defined shadows built-ins
    return pkc?.settings?.challenges?.[name] ?? pkcJsChallenges[name];
};

const pkcJsChallenges: Record<string, ChallengeFileFactoryInput> = {
    "text-math": textMath,
    fail: fail,
    blacklist: blacklist,
    whitelist: whitelist,
    question: question,
    "publication-match": publicationMatch
};

const validateChallengeFileFactory = (challengeFileFactory: ChallengeFileFactory, challengeIndex: number, community: LocalCommunity) => {
    const communityChallengeSettings = community?.settings?.challenges?.[challengeIndex];
    if (typeof challengeFileFactory !== "function") {
        throw Error(
            `invalid challenge file factory export from community challenge '${communityChallengeSettings?.name || communityChallengeSettings?.path}' (challenge #${challengeIndex + 1})`
        );
    }
};

const validateChallengeFile = (challengeFile: ChallengeFile, challengeIndex: number, community: LocalCommunity) => {
    const communityChallengeSettings = community.settings?.challenges?.[challengeIndex];
    if (typeof challengeFile?.getChallenge !== "function") {
        throw Error(
            `invalid challenge file from community challenge '${communityChallengeSettings?.name || communityChallengeSettings?.path}' (challenge #${challengeIndex + 1})`
        );
    }
};

const validateChallengeResult = (challengeResult: ChallengeResult, challengeIndex: number, community: LocalCommunity) => {
    const communityChallengeSettings = community.settings?.challenges?.[challengeIndex];
    const error = `invalid challenge result from community challenge '${communityChallengeSettings?.name || communityChallengeSettings?.path}' (challenge #${challengeIndex + 1})`;
    if (typeof challengeResult?.success !== "boolean") {
        throw Error(error);
    }
};

const validateChallengeOrChallengeResult = (
    challengeOrChallengeResult: Challenge | ChallengeResult,
    challengeIndex: number,
    community: LocalCommunity
) => {
    if ("success" in challengeOrChallengeResult) {
        validateChallengeResult(challengeOrChallengeResult, challengeIndex, community);
    } else if (
        typeof challengeOrChallengeResult?.["challenge"] !== "string" ||
        typeof challengeOrChallengeResult?.["type"] !== "string" ||
        typeof challengeOrChallengeResult?.["verify"] !== "function"
    ) {
        throw Error("The challenge does not contain the correct {challenge, type, verify}");
    }
};

const getPendingChallengesOrChallengeVerification = async (
    challengeRequestMessage: DecryptedChallengeRequestMessageTypeWithCommunityAuthor,
    community: LocalCommunity
): Promise<ChallengeVerificationSuccess | ChallengeVerificationPending | ChallengeVerificationFailure> => {
    // if sub has no challenges, no need to send a challenge
    if (!Array.isArray(community.settings?.challenges))
        return {
            challengeSuccess: true,
            pendingApprovalSuccess: false
        };
    const challengeOrChallengeResults: (Challenge | ChallengeResult)[] = [];
    // interate over all challenges of the community, can be more than 1
    for (const i in community.settings.challenges) {
        const challengeIndex = Number(i);
        const communityChallengeSettings = community.settings.challenges[challengeIndex];

        if (!communityChallengeSettings.path && !resolveChallengeFactoryByName(communityChallengeSettings.name!, community._pkc))
            throw Error("You have to provide either path or a stored pkc-js challenge");
        // if the challenge is an external file, fetch it and override the communityChallengeSettings values
        let ChallengeFileFactory: ChallengeFileFactory;

        try {
            ChallengeFileFactory = ChallengeFileFactorySchema.parse(
                communityChallengeSettings.path
                    ? (await import(pathToFileURL(communityChallengeSettings.path).href)).default
                    : resolveChallengeFactoryByName(communityChallengeSettings.name!, community._pkc)
            );
            validateChallengeFileFactory(ChallengeFileFactory, challengeIndex, community);
        } catch (e) {
            throw new PKCError("ERR_FAILED_TO_IMPORT_CHALLENGE_FILE_FACTORY", {
                path: communityChallengeSettings.path,
                communityChallengeSettings,
                error: e,
                challengeIndex
            });
        }

        const challengeFile = ChallengeFileFactory({ challengeSettings: communityChallengeSettings });
        validateChallengeFile(challengeFile, challengeIndex, community);

        let challengeOrChallengeResult: Challenge | ChallengeResult;
        try {
            // the getChallenge function could throw
            challengeOrChallengeResult = await challengeFile.getChallenge({
                challengeSettings: communityChallengeSettings,
                challengeRequestMessage,
                challengeIndex,
                community
            });
            validateChallengeOrChallengeResult(challengeOrChallengeResult, challengeIndex, community);
        } catch (e) {
            throw new PKCError("ERR_INVALID_RESULT_FROM_GET_CHALLENGE_FUNCTION", {
                communityChallengeSettings,
                challengeName: communityChallengeSettings.name || communityChallengeSettings.path,
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

        const communityChallengeSettings = community.settings.challenges[challengeIndex];
        const communityChallenge = await getCommunityChallengeFromCommunityChallengeSettings(communityChallengeSettings, community._pkc);

        // exclude author from challenge based on the community minimum karma settings
        if (shouldExcludePublication(communityChallenge, challengeRequestMessage, community)) {
            continue;
        }
        if (await shouldExcludeChallengeCommentCids(communityChallenge, challengeRequestMessage, community._pkc)) {
            continue;
        }

        // exclude based on other challenges successes
        if (shouldExcludeChallengeSuccess(communityChallenge, challengeIndex, challengeOrChallengeResults)) {
            continue;
        }

        if ("success" in challengeOrChallengeResult && challengeOrChallengeResult.success === false) {
            challengeFailureCount++;
            challengeErrors[challengeIndex] = challengeOrChallengeResult.error;
        } else if ("success" in challengeOrChallengeResult && challengeOrChallengeResult.success === true) {
            if (community.challenges?.[challengeIndex]?.pendingApproval) {
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
    community: LocalCommunity
): Promise<ChallengeVerificationSuccess | ChallengeVerificationFailure> => {
    const verifyChallengePromises: Promise<ChallengeResult>[] = [];
    for (const i in pendingChallenges) {
        verifyChallengePromises.push(Promise.resolve(pendingChallenges[i].verify(challengeAnswers[i])));
    }
    const challengeResultsWithPendingIndexes = await Promise.all(verifyChallengePromises);

    // validate results
    for (const i in challengeResultsWithPendingIndexes) {
        const challengeResult = challengeResultsWithPendingIndexes[Number(i)];
        validateChallengeResult(challengeResult, pendingChallenges[Number(i)].index, community);
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
        if (!community.settings?.challenges?.[challengeIndex]) throw Error("community.settings.challenges[challengeIndex] does not exist");
        const challengeResult = challengeResults[challengeIndex];

        // the challenge results that were filtered out were already successful
        if (challengeResult === undefined) {
            continue;
        }

        // exclude based on other challenges successes
        if (shouldExcludeChallengeSuccess(community.settings.challenges[challengeIndex], challengeIndex, challengeResults)) {
            continue;
        }

        if (challengeResult.success === false) {
            challengeFailureCount++;
            challengeErrors[challengeIndex] = challengeResult.error;
        } else if (challengeResult.success === true && community.settings.challenges[challengeIndex]?.pendingApproval) {
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
    challengeRequestMessage: DecryptedChallengeRequestMessageTypeWithCommunityAuthor,
    community: LocalCommunity,
    getChallengeAnswers: GetChallengeAnswers
): Promise<Pick<ChallengeVerificationMessageType, "challengeErrors" | "challengeSuccess"> & { pendingApproval?: boolean }> => {
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

    const res = await getPendingChallengesOrChallengeVerification(challengeRequestMessage, community);
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
            community
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
const getCommunityChallengeFromCommunityChallengeSettings = async (
    communityChallengeSettings: CommunityChallengeSetting,
    pkc?: PKCWithSettingsChallenges
): Promise<CommunityChallenge> => {
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
                communityChallengeSettings,
                error: e
            };
            if (e instanceof Error)
                e.message = `getCommunityChallengeFromCommunityChallengeSettings failed importing challenge with path '${communityChallengeSettings.path}': ${e.message}`;
            throw e;
        }
    }
    // else, the challenge is included with pkc-js or user-defined
    else if (communityChallengeSettings.name) {
        const ChallengeFileFactory = ChallengeFileFactorySchema.parse(resolveChallengeFactoryByName(communityChallengeSettings.name, pkc));
        challengeFile = ChallengeFileSchema.parse(ChallengeFileFactory({ challengeSettings: communityChallengeSettings }));
    }
    if (!challengeFile) throw Error("Failed to load challenge file");
    const { challenge, type } = challengeFile;
    return {
        exclude: communityChallengeSettings.exclude,
        description: communityChallengeSettings.description || challengeFile.description,
        challenge,
        type,
        caseInsensitive: challengeFile.caseInsensitive,
        pendingApproval: communityChallengeSettings.pendingApproval
    };
};

export {
    pkcJsChallenges,
    getPendingChallengesOrChallengeVerification,
    getChallengeVerificationFromChallengeAnswers,
    getChallengeVerification,
    getCommunityChallengeFromCommunityChallengeSettings
};
