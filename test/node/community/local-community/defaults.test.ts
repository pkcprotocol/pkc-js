// Unit tests for src/runtime/node/community/local-community/defaults.ts
// These are pure functions with no LocalCommunity dependency, so coverage is thorough.

import { describe, it, expect } from "vitest";
import {
    DUPLICATE_PUBLICATION_ERRORS,
    defaultChallengeQuestionText,
    generateDefaultChallenges,
    isDefaultChallengeStructure
} from "../../../../dist/node/runtime/node/community/local-community/defaults.js";
import { messages } from "../../../../dist/node/errors.js";
import type { CommunityChallengeSetting } from "../../../../dist/node/community/types.js";

describe("defaults: DUPLICATE_PUBLICATION_ERRORS", () => {
    it("contains the three duplicate-publication error messages", () => {
        expect(DUPLICATE_PUBLICATION_ERRORS.has(messages.ERR_DUPLICATE_COMMENT)).to.equal(true);
        expect(DUPLICATE_PUBLICATION_ERRORS.has(messages.ERR_DUPLICATE_COMMENT_EDIT)).to.equal(true);
        expect(DUPLICATE_PUBLICATION_ERRORS.has(messages.ERR_DUPLICATE_COMMENT_MODERATION)).to.equal(true);
    });

    it("has exactly three entries", () => {
        expect(DUPLICATE_PUBLICATION_ERRORS.size).to.equal(3);
    });

    it("does not include unrelated error messages", () => {
        expect(DUPLICATE_PUBLICATION_ERRORS.has(messages.ERR_PUBLICATION_MISSING_FIELD)).to.equal(false);
    });
});

describe("defaults: defaultChallengeQuestionText", () => {
    it("is the canonical default question prompt", () => {
        expect(defaultChallengeQuestionText).to.be.a("string");
        expect(defaultChallengeQuestionText.length).to.be.greaterThan(10);
        // The default text explicitly mentions the settings.challenges path; this is part of the contract.
        expect(defaultChallengeQuestionText.includes("settings.challenges")).to.equal(true);
    });
});

describe("defaults: generateDefaultChallenges", () => {
    it("returns exactly one challenge of type 'question'", () => {
        const challenges = generateDefaultChallenges();
        expect(challenges).to.have.lengthOf(1);
        expect(challenges[0].name).to.equal("question");
    });

    it("uses the canonical default question text", () => {
        const challenges = generateDefaultChallenges();
        expect(challenges[0].options?.question).to.equal(defaultChallengeQuestionText);
    });

    it("generates a random uuid answer when none is provided", () => {
        const a = generateDefaultChallenges();
        const b = generateDefaultChallenges();
        expect(typeof a[0].options?.answer).to.equal("string");
        expect((a[0].options?.answer ?? "").length).to.be.greaterThan(0);
        // Random uuids should not collide between calls.
        expect(a[0].options?.answer).to.not.equal(b[0].options?.answer);
    });

    it("uses the provided answer when supplied", () => {
        const challenges = generateDefaultChallenges("custom-answer");
        expect(challenges[0].options?.answer).to.equal("custom-answer");
    });
});

describe("defaults: isDefaultChallengeStructure", () => {
    it("returns true for the canonical default shape", () => {
        const challenges = generateDefaultChallenges();
        expect(isDefaultChallengeStructure(challenges)).to.equal(true);
    });

    it("returns true for the canonical shape with a custom answer", () => {
        const challenges = generateDefaultChallenges("abc");
        expect(isDefaultChallengeStructure(challenges)).to.equal(true);
    });

    it("returns false when challenges is undefined", () => {
        expect(isDefaultChallengeStructure(undefined)).to.equal(false);
    });

    it("returns false for an empty array", () => {
        expect(isDefaultChallengeStructure([])).to.equal(false);
    });

    it("returns false when there are multiple challenges", () => {
        const challenges = [...generateDefaultChallenges(), ...generateDefaultChallenges()];
        expect(isDefaultChallengeStructure(challenges)).to.equal(false);
    });

    it("returns false when the challenge name is not 'question'", () => {
        const challenges: CommunityChallengeSetting[] = [
            {
                name: "text-math",
                options: { question: defaultChallengeQuestionText, answer: "x" }
            }
        ];
        expect(isDefaultChallengeStructure(challenges)).to.equal(false);
    });

    it("returns false when the question text differs from the default", () => {
        const challenges: CommunityChallengeSetting[] = [
            {
                name: "question",
                options: { question: "different prompt", answer: "x" }
            }
        ];
        expect(isDefaultChallengeStructure(challenges)).to.equal(false);
    });

    it("returns false when the answer is empty or missing", () => {
        const noAnswer: CommunityChallengeSetting[] = [
            {
                name: "question",
                options: { question: defaultChallengeQuestionText, answer: "" }
            }
        ];
        expect(isDefaultChallengeStructure(noAnswer)).to.equal(false);
    });
});
