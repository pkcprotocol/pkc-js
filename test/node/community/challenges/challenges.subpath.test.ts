import { describe, expect, it } from "vitest";
import type {
    ChallengeFileInput,
    ChallengeInput,
    ChallengeResultInput,
    GetChallengeArgsInput,
    SubplebbitChallengeSetting
} from "../../../../dist/node/challenges.js";

type ChallengeSubpathExports = {
    challengeFileInput: ChallengeFileInput;
    challengeInput: ChallengeInput;
    challengeResultInput: ChallengeResultInput;
    getChallengeArgsInput: GetChallengeArgsInput;
    subplebbitChallengeSetting: SubplebbitChallengeSetting;
};

const _typecheckChallengeSubpathExports: ChallengeSubpathExports | undefined = undefined;
void _typecheckChallengeSubpathExports;

describe("challenge authoring subpath", () => {
    it("keeps the required challenge authoring types exported", () => {
        expect(true).to.equal(true);
    });
});
