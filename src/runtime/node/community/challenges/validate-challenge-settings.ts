import { PKCError } from "../../../../pkc-error.js";
import { loadChallengeFileFromCommunityChallengeSettings } from "./index.js";
import type { ChallengeFile, CommunityChallengeSetting } from "../../../../community/types.js";
import type { PKCWithSettingsChallenges } from "./index.js";

// One challenge's rejection, as it appears in the aggregated edit-path throw and in the per-challenge
// start-path error events. `challengeName` is settings.challenges[i].name, or its `path` for a challenge
// loaded from disk, so an owner can tell which entry is broken without counting array indices.
export interface ChallengeSettingsValidationFailure {
    challengeIndex: number;
    challengeName: string;
    error: PKCError;
}

const describeChallenge = (communityChallengeSettings: CommunityChallengeSetting): string =>
    communityChallengeSettings.name || communityChallengeSettings.path || "unknown challenge";

// `required` means present, nothing more. An option set to "" is deliberately accepted: whether an empty
// value is meaningful is the challenge's own business, and its validateChallengeSettings hook is where to
// reject one.
const isOptionSet = (value: string | undefined): boolean => value !== undefined && value !== null;

// Generic validation of a settings entry against the challenge file's own optionInputs. No challenge code
// is involved: every one of these checks is mechanical, and each would otherwise be reimplemented by every
// package. Returns the first failure, or undefined when the entry is valid.
//
// optionInputs is optional. A challenge file that declares none makes no promises about which options it
// reads, so the declared-key checks are skipped for it rather than rejecting every option it was given.
export function validateChallengeSettingsAgainstChallengeFile({
    challengeSettings,
    challengeFile,
    challengeIndex
}: {
    challengeSettings: CommunityChallengeSetting;
    challengeFile: ChallengeFile;
    challengeIndex: number;
}): PKCError | undefined {
    const challengeName = describeChallenge(challengeSettings);
    const baseDetails = { challengeIndex, challengeName };
    const { optionInputs } = challengeFile;

    if (optionInputs) {
        const declaredOptions = new Set(optionInputs.map((optionInput) => optionInput.option));

        // An undeclared key can only be a typo: nothing reads it, and it is never published either, so it
        // is dead config by definition. Silently ignoring it is how `anwser` instead of `answer` ends up
        // rejecting every author with no signal to the owner.
        for (const optionName of Object.keys(challengeSettings.options ?? {}))
            if (!declaredOptions.has(optionName))
                return new PKCError("ERR_CHALLENGE_OPTION_NOT_DECLARED_IN_OPTION_INPUTS", {
                    ...baseDetails,
                    offendingOption: optionName,
                    declaredOptions: [...declaredOptions]
                });

        // This is what finally makes ChallengeOptionInputSchema's `required` comment true.
        for (const optionInput of optionInputs)
            if (optionInput.required && !isOptionSet(challengeSettings.options?.[optionInput.option]))
                return new PKCError("ERR_CHALLENGE_REQUIRED_OPTION_MISSING", {
                    ...baseDetails,
                    missingOption: optionInput.option
                });

        for (const optionName of challengeSettings.publicOptions ?? [])
            if (!declaredOptions.has(optionName))
                return new PKCError("ERR_CHALLENGE_PUBLIC_OPTION_NOT_DECLARED_IN_OPTION_INPUTS", {
                    ...baseDetails,
                    offendingOption: optionName,
                    declaredOptions: [...declaredOptions]
                });
    }

    // The challenge's own semantic validation, for what core cannot know. It may throw anything, so no
    // pkc-js import is needed on the package side. We keep the original as `cause` for a local consumer,
    // and copy its message into details.validationError, which is the part that survives RPC serialization.
    if (challengeFile.validateChallengeSettings)
        try {
            challengeFile.validateChallengeSettings({ challengeSettings });
        } catch (e) {
            const wrapped = new PKCError("ERR_CHALLENGE_SETTINGS_VALIDATION_FAILED", {
                ...baseDetails,
                validationError: e instanceof Error ? e.message : String(e)
            });
            // Object.assign rather than `wrapped.cause = e` because the build targets ES2021, whose Error
            // type predates the standard `cause` property. It is still there at runtime on every Node we support.
            Object.assign(wrapped, { cause: e });
            return wrapped;
        }

    return undefined;
}

// Validate every entry of settings.challenges and collect the failures rather than stopping at the first,
// so an owner editing several challenges learns about all of them at once instead of one edit at a time.
// Loading a challenge file is itself allowed to throw (a bad `path`, an unregistered `name`); that is a
// different failure from an invalid setting, so it propagates instead of being collected.
export async function collectChallengeSettingsValidationFailures({
    challengeSettings,
    pkc
}: {
    challengeSettings: CommunityChallengeSetting[];
    pkc?: PKCWithSettingsChallenges;
}): Promise<ChallengeSettingsValidationFailure[]> {
    const failures: ChallengeSettingsValidationFailure[] = [];
    for (const [challengeIndex, communityChallengeSettings] of challengeSettings.entries()) {
        const challengeFile = await loadChallengeFileFromCommunityChallengeSettings({ communityChallengeSettings, pkc });
        const error = validateChallengeSettingsAgainstChallengeFile({
            challengeSettings: communityChallengeSettings,
            challengeFile,
            challengeIndex
        });
        if (error) failures.push({ challengeIndex, challengeName: describeChallenge(communityChallengeSettings), error });
    }
    return failures;
}

// The edit and creation paths reject the whole write: nothing is persisted yet on either, so one
// aggregated throw carrying every failure is safe and is the most useful thing for an owner-facing UI.
export async function throwIfChallengeSettingsAreInvalid({
    challengeSettings,
    pkc,
    communityAddress
}: {
    challengeSettings: CommunityChallengeSetting[];
    pkc?: PKCWithSettingsChallenges;
    communityAddress?: string;
}): Promise<void> {
    const failures = await collectChallengeSettingsValidationFailures({ challengeSettings, pkc });
    if (failures.length)
        throw new PKCError("ERR_CHALLENGE_SETTINGS_VALIDATION_FAILED_FOR_CHALLENGES", {
            communityAddress,
            failures: failures.map(({ challengeIndex, challengeName, error }) => ({ challengeIndex, challengeName, error }))
        });
}
