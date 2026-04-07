import {
    pkcJsChallenges,
    getCommunityChallengeFromCommunityChallengeSettings,
    getPendingChallengesOrChallengeVerification
} from "../../dist/node/runtime/node/community/challenges/index.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "../../dist/node/pubsub-messages/types.js";
import type { LocalCommunity } from "../../dist/node/runtime/node/community/local-community.js";
import * as remeda from "remeda";

import type { ChallengeVerificationMessageType } from "../../dist/node/pubsub-messages/types.js";
import type { Challenge } from "../../dist/node/community/types.js";

// Flattened type for test assertions - allows direct property access
// This is appropriate for tests where we assert on the presence/value of these properties
type PendingChallenge = Challenge & { index: number };
type ChallengeVerificationResult = {
    challengeSuccess?: boolean;
    challengeErrors?: NonNullable<ChallengeVerificationMessageType["challengeErrors"]>;
    pendingChallenges?: PendingChallenge[];
    pendingApprovalSuccess?: boolean;
};

// Wrapper function for type assertion boilerplate
const testGetPendingChallengesOrChallengeVerification = async (
    challengeRequestMessage: unknown,
    community: unknown
): Promise<ChallengeVerificationResult> => {
    return getPendingChallengesOrChallengeVerification(
        challengeRequestMessage as DecryptedChallengeRequestMessageTypeWithCommunityAuthor,
        community as LocalCommunity
    ) as Promise<ChallengeVerificationResult>;
};

interface ChallengeRequestOverrides {
    publication?: Record<string, unknown>;
    [key: string]: unknown;
}

interface CommunityChallengeOptions {
    matches?: string;
    error?: string;
    matchAll?: string;
    description?: string;
}

describe("publication-match challenge", () => {
    // Create a standard challenge request message fixture to reuse
    const createChallengeRequestMessage = (overrides: ChallengeRequestOverrides = {}): Record<string, unknown> => {
        const defaultPublication = {
            author: {
                address: "author.bso",
                publicKey: "12D3KooWJJcSwMHrFvsFL7YCNDLD93kBczEfkHpPNdxcjZwR2X2Y"
            },
            content: "content",
            timestamp: 1234567890,
            title: "title",
            link: "link",
            communityAddress: "subplebbitAddress"
        };

        return {
            comment: {
                ...defaultPublication,
                ...(overrides.publication || {})
            },
            ...(remeda.omit(overrides, ["publication"]) || {})
        };
    };

    // Create a standard community fixture with publication-match challenge
    const createCommunity = (
        options: CommunityChallengeOptions = {}
    ): { _pkc: { getComment: () => void }; settings: { challenges: Array<{ name: string; options: CommunityChallengeOptions }> } } => {
        const defaultOptions: CommunityChallengeOptions = {
            matches: JSON.stringify([{ propertyName: "author.address", regexp: "\\.bso$" }]),
            error: "Publication author.address must end with .bso",
            matchAll: "true"
        };

        return {
            _pkc: { getComment: () => {} },
            settings: {
                challenges: [
                    {
                        name: "publication-match",
                        options: {
                            ...defaultOptions,
                            ...options
                        }
                    }
                ]
            }
        };
    };

    // Test that the challenge is properly registered
    it("publication-match challenge is registered", () => {
        expect(pkcJsChallenges["publication-match"]).to.be.a("function");
    });

    // Test the challenge settings conversion
    it("getCommunityChallengeFromCommunityChallengeSettings with publication-match", async () => {
        const communityChallengeSettings = {
            name: "publication-match",
            options: {
                matches: JSON.stringify([
                    { propertyName: "author.address", regexp: "\\.bso$" },
                    { propertyName: "content", regexp: "badword" }
                ]),
                error: "Custom error message",
                matchAll: "true"
            }
        };
        const communityChallenge = await getCommunityChallengeFromCommunityChallengeSettings(communityChallengeSettings);
        expect(communityChallenge.type).to.equal("text/plain");
        expect(communityChallenge.description).to.equal("Match publication properties against regex patterns.");
    });

    // Test custom description option
    it("getCommunityChallengeFromCommunityChallengeSettings with custom description", async () => {
        const communityChallengeSettings = {
            name: "publication-match",
            options: {
                matches: JSON.stringify([{ propertyName: "author.address", regexp: "\\.bso$" }]),
                description: "Authors must have .bso addresses"
            }
        };
        const communityChallenge = await getCommunityChallengeFromCommunityChallengeSettings(communityChallengeSettings);
        expect(communityChallenge.type).to.equal("text/plain");
        expect(communityChallenge.description).to.equal("Authors must have .bso addresses");
    });

    // Test default description when no custom description provided
    it("getCommunityChallengeFromCommunityChallengeSettings uses default description when none provided", async () => {
        const communityChallengeSettings = {
            name: "publication-match",
            options: {
                matches: JSON.stringify([{ propertyName: "author.address", regexp: "\\.bso$" }])
            }
        };
        const communityChallenge = await getCommunityChallengeFromCommunityChallengeSettings(communityChallengeSettings);
        expect(communityChallenge.type).to.equal("text/plain");
        expect(communityChallenge.description).to.equal("Match publication properties against regex patterns.");
    });

    // Test with matching author address (.eth)
    it("publication-match challenge with matching author address .bso", async () => {
        const community = createCommunity();
        const challengeRequestMessage = createChallengeRequestMessage();

        const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);
        expect(result.challengeSuccess).to.be.true;
    });

    it("publication-match challenge can match runtime author.publicKey", async () => {
        const community = createCommunity({
            matches: JSON.stringify([{ propertyName: "author.publicKey", regexp: "^12D3KooW" }]),
            error: "Author public key must start with 12D3KooW"
        });

        const challengeRequestMessage = createChallengeRequestMessage();

        const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);
        expect(result.challengeSuccess).to.be.true;
    });

    // Test with non-matching author address
    it("publication-match challenge with non-matching author address", async () => {
        const community = createCommunity({
            matches: JSON.stringify([{ propertyName: "author.address", regexp: "\\.sol$" }]),
            error: "Author address must end with .sol"
        });

        const challengeRequestMessage = createChallengeRequestMessage();

        const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);
        expect(result.challengeSuccess).to.be.false;
        expect(result.challengeErrors[0]).to.equal("Author address must end with .sol");
    });

    // Test with content containing a specific word
    it("publication-match challenge with content containing specific word", async () => {
        const community = createCommunity({
            matches: JSON.stringify([{ propertyName: "content", regexp: "content" }]),
            error: "Content must contain 'content'"
        });

        const challengeRequestMessage = createChallengeRequestMessage();

        const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);
        expect(result.challengeSuccess).to.be.true;
    });

    // Test with multiple conditions (matchAll = true)
    it("publication-match challenge with multiple conditions (matchAll = true)", async () => {
        const community = createCommunity({
            matches: JSON.stringify([
                { propertyName: "author.address", regexp: "\\.bso$" },
                { propertyName: "content", regexp: "content" }
            ]),
            error: "Publication does not match all required patterns"
        });

        const challengeRequestMessage = createChallengeRequestMessage();

        const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);
        expect(result.challengeSuccess).to.be.true;
    });

    // Test with multiple conditions (matchAll = false, at least one matches)
    it("publication-match challenge with multiple conditions (matchAll = false, at least one matches)", async () => {
        const community = createCommunity({
            matches: JSON.stringify([
                { propertyName: "author.address", regexp: "\\.sol$" }, // This won't match
                { propertyName: "content", regexp: "content" } // This will match
            ]),
            error: "Publication does not match any required pattern",
            matchAll: "false"
        });

        const challengeRequestMessage = createChallengeRequestMessage();

        const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);
        expect(result.challengeSuccess).to.be.true;
    });

    // Test with multiple conditions (matchAll = false, none match)
    it("publication-match challenge with multiple conditions (matchAll = false, none match)", async () => {
        const community = createCommunity({
            matches: JSON.stringify([
                { propertyName: "author.address", regexp: "\\.sol$" }, // This won't match
                { propertyName: "content", regexp: "badword" } // This won't match
            ]),
            error: "Publication does not match any required pattern",
            matchAll: "false"
        });

        const challengeRequestMessage = createChallengeRequestMessage();

        const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);
        expect(result.challengeSuccess).to.be.false;
        expect(result.challengeErrors[0]).to.equal("Publication does not match any required pattern");
    });

    // Test with invalid JSON in matches option
    it("publication-match challenge with invalid JSON in matches option", async () => {
        const community = createCommunity({
            matches: "invalid json"
        });

        const challengeRequestMessage = createChallengeRequestMessage();

        const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);
        expect(result.challengeSuccess).to.be.false;
        expect(result.challengeErrors[0]).to.include("Invalid matches JSON");
    });

    // Test with invalid regex pattern
    it("publication-match challenge with invalid regex pattern", async () => {
        const community = createCommunity({
            matches: JSON.stringify([
                { propertyName: "author.address", regexp: "[" } // Invalid regex
            ])
        });

        const challengeRequestMessage = createChallengeRequestMessage();

        const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);
        expect(result.challengeSuccess).to.be.false;
        expect(result.challengeErrors[0]).to.include("Invalid regex pattern");
    });

    // Test with non-existent property
    it("publication-match challenge with non-existent property", async () => {
        const community = createCommunity({
            matches: JSON.stringify([{ propertyName: "nonexistent.property", regexp: ".*" }]),
            error: "Publication does not match required patterns"
        });

        const challengeRequestMessage = createChallengeRequestMessage();

        const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);
        expect(result.challengeSuccess).to.be.false;
        expect(result.challengeErrors[0]).to.equal("Publication does not match required patterns");
    });

    // Test with empty matches array (should pass)
    it("publication-match challenge with empty matches array", async () => {
        const community = createCommunity({
            matches: "[]"
        });

        const challengeRequestMessage = createChallengeRequestMessage();

        const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);
        expect(result.challengeSuccess).to.be.true;
    });

    // Test with custom publication data
    it("publication-match challenge with custom publication data", async () => {
        const community = createCommunity({
            matches: JSON.stringify([{ propertyName: "author.address", regexp: "custom" }])
        });

        const challengeRequestMessage = createChallengeRequestMessage({
            publication: {
                author: {
                    address: "custom-address"
                }
            }
        });

        const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);
        expect(result.challengeSuccess).to.be.true;
    });
});
