import { beforeEach, afterEach } from "vitest";
import { pkcJsChallenges, getPendingChallengesOrChallengeVerification } from "../../dist/node/runtime/node/community/challenges/index.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "../../dist/node/pubsub-messages/types.js";
import type { LocalCommunity } from "../../dist/node/runtime/node/community/local-community.js";
import type { ChallengeVerificationMessageType } from "../../dist/node/pubsub-messages/types.js";
import type { Challenge, ChallengeResult } from "../../dist/node/community/types.js";
import * as remeda from "remeda";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

// Flattened type for challenge verification result - allows direct property access in tests
type PendingChallenge = Challenge & { index: number };
type ChallengeVerificationResult = {
    challengeSuccess?: boolean;
    challengeErrors?: NonNullable<ChallengeVerificationMessageType["challengeErrors"]>;
    pendingChallenges?: PendingChallenge[];
    pendingApprovalSuccess?: boolean;
};

// Wrapper function for type assertion boilerplate
const testGetPendingChallengesOrChallengeVerification = async (
    challengeRequestMessage: Record<string, unknown>,
    community: Record<string, unknown>
): Promise<ChallengeVerificationResult> => {
    return getPendingChallengesOrChallengeVerification(
        challengeRequestMessage as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor,
        community as unknown as LocalCommunity
    ) as Promise<ChallengeVerificationResult>;
};

describe.skip("voucher challenge", () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = path.join(tmpdir(), "pkc-test-" + Math.random().toString(36));
    });

    afterEach(async () => {
        if (tempDir && fs.existsSync(tempDir)) {
            await fs.promises.rm(tempDir, { recursive: true });
        }
    });

    interface ChallengeRequestOverrides {
        publication?: Record<string, unknown>;
        challengeAnswers?: string[];
        [key: string]: unknown;
    }

    interface VoucherOptions {
        question?: string;
        vouchers?: string;
        invalidVoucherError?: string;
        alreadyRedeemedError?: string;
    }

    // Create a standard challenge request message fixture to reuse
    const createChallengeRequestMessage = (overrides: ChallengeRequestOverrides = {}): Record<string, unknown> => {
        const defaultPublication = {
            author: {
                address: "12D3test123"
            },
            content: "test content",
            timestamp: 1234567890,
            communityAddress: "communityAddress"
        };

        return {
            comment: {
                ...defaultPublication,
                ...(overrides.publication || {})
            },
            ...(remeda.omit(overrides, ["publication"]) || {})
        };
    };

    // Create a standard community fixture with voucher challenge
    const createCommunity = (options: VoucherOptions = {}): Record<string, unknown> => {
        const defaultOptions: VoucherOptions = {
            question: "What is your voucher code?",
            vouchers: "VOUCHER1,VOUCHER2,VOUCHER3"
        };

        return {
            address: "test-community-address",
            _pkc: {
                getComment: () => {},
                dataPath: tempDir
            },
            settings: {
                challenges: [
                    {
                        name: "voucher",
                        options: {
                            ...defaultOptions,
                            ...options
                        }
                    }
                ]
            }
        };
    };

    describe("basic functionality", () => {
        it("voucher challenge exists", () => {
            expect(pkcJsChallenges.voucher).to.be.a("function");
        });

        it("creates voucher challenge with default options", () => {
            const voucherFactory = pkcJsChallenges.voucher;
            const challenge = voucherFactory({ challengeSettings: {} } as Parameters<typeof voucherFactory>[0]);
            expect(challenge.getChallenge).to.be.a("function");
            expect(challenge.optionInputs).to.be.an("array");
            expect(challenge.type).to.equal("text/plain");
        });

        it("has correct option inputs", () => {
            const voucherFactory = pkcJsChallenges.voucher;
            const challenge = voucherFactory({ challengeSettings: {} } as Parameters<typeof voucherFactory>[0]);
            const optionNames = challenge.optionInputs.map((opt) => opt.option);
            expect(optionNames).to.include("question");
            expect(optionNames).to.include("vouchers");
            expect(optionNames).to.include("description");
            expect(optionNames).to.include("invalidVoucherError");
            expect(optionNames).to.include("alreadyRedeemedError");
        });
    });

    describe("challenge verification", () => {
        it("accepts valid voucher codes", async () => {
            const community = createCommunity();
            const challengeRequestMessage = createChallengeRequestMessage();

            const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);

            expect(result.pendingChallenges).to.have.length(1);
            const challenge = result.pendingChallenges[0];

            const verification = await challenge.verify("VOUCHER1");
            expect(verification.success).to.be.true;
        });

        it("rejects invalid voucher codes", async () => {
            const community = createCommunity();
            const challengeRequestMessage = createChallengeRequestMessage();

            const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);

            const challenge = result.pendingChallenges[0];
            const verification = await challenge.verify("INVALID_VOUCHER");

            expect(verification.success).to.be.false;
            if (verification.success === false) {
                expect(verification.error).to.equal("Invalid voucher code.");
            }
        });

        it("allows same author to reuse their voucher", async () => {
            const community = createCommunity();
            const challengeRequestMessage = createChallengeRequestMessage();

            const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);

            const challenge = result.pendingChallenges[0];

            // First use
            const verification1 = await challenge.verify("VOUCHER1");
            expect(verification1.success).to.be.true;

            // Second use by same author
            const verification2 = await challenge.verify("VOUCHER1");
            expect(verification2.success).to.be.true;
        });

        it("rejects voucher already redeemed by different author", async () => {
            const community = createCommunity();

            // First author redeems voucher
            const challengeRequestMessage1 = createChallengeRequestMessage({
                publication: { author: { address: "author1" } }
            });

            const result1 = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage1, community);

            const challenge1 = result1.pendingChallenges[0];
            const verification1 = await challenge1.verify("VOUCHER1");
            expect(verification1.success).to.be.true;

            // Second author tries to use same voucher
            const challengeRequestMessage2 = createChallengeRequestMessage({
                publication: { author: { address: "author2" } }
            });

            const result2 = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage2, community);

            const challenge2 = result2.pendingChallenges[0];
            const verification2 = await challenge2.verify("VOUCHER1");

            expect(verification2.success).to.be.false;
            if (verification2.success === false) {
                expect(verification2.error).to.equal("This voucher has already been redeemed by another author.");
            }
        });

        it("handles pre-answered challenges correctly", async () => {
            const community = createCommunity();
            const challengeRequestMessage = createChallengeRequestMessage({
                challengeAnswers: ["VOUCHER1"]
            });

            const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);

            expect(result.challengeSuccess).to.be.true;
        });

        it("rejects pre-answered challenges with invalid voucher", async () => {
            const community = createCommunity();
            const challengeRequestMessage = createChallengeRequestMessage({
                challengeAnswers: ["INVALID_VOUCHER"]
            });

            const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);

            expect(result.challengeSuccess).to.be.false;
            expect(result.challengeErrors).to.be.an("object");
            expect(result.challengeErrors[0]).to.equal("Invalid voucher code.");
        });
    });

    describe("custom error messages", () => {
        it("uses custom invalid voucher error message", async () => {
            const community = createCommunity({
                invalidVoucherError: "Custom invalid code message"
            });
            const challengeRequestMessage = createChallengeRequestMessage();

            const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);

            const challenge = result.pendingChallenges[0];
            const verification = await challenge.verify("INVALID_VOUCHER");

            expect(verification.success).to.be.false;
            if (verification.success === false) {
                expect(verification.error).to.equal("Custom invalid code message");
            }
        });

        it("uses custom already redeemed error message", async () => {
            const community = createCommunity({
                alreadyRedeemedError: "Custom already used message"
            });

            // First author redeems voucher
            const challengeRequestMessage1 = createChallengeRequestMessage({
                publication: { author: { address: "author1" } }
            });

            const result1 = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage1, community);

            await result1.pendingChallenges[0].verify("VOUCHER1");

            // Second author tries same voucher
            const challengeRequestMessage2 = createChallengeRequestMessage({
                publication: { author: { address: "author2" } }
            });

            const result2 = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage2, community);

            const verification = await result2.pendingChallenges[0].verify("VOUCHER1");

            expect(verification.success).to.be.false;
            if (verification.success === false) {
                expect(verification.error).to.equal("Custom already used message");
            }
        });
    });

    describe("file persistence", () => {
        it("persists voucher redemptions to file", async () => {
            const community = createCommunity();
            const challengeRequestMessage = createChallengeRequestMessage();

            const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);

            const challenge = result.pendingChallenges[0];
            await challenge.verify("VOUCHER1");

            // Check that state file was created
            const stateFilePath = path.join(
                tempDir,
                "communities",
                `${community.address}-challenge-data`,
                "voucher_redemption_states.json"
            );

            expect(fs.existsSync(stateFilePath)).to.be.true;

            const stateData = JSON.parse(fs.readFileSync(stateFilePath, "utf8"));
            expect(stateData).to.have.property("VOUCHER1");
            expect(stateData.VOUCHER1).to.equal("12D3test123");
        });

        it("loads existing redemption state from file", async () => {
            const community = createCommunity();

            // Create state file manually
            const stateDir = path.join(tempDir, "communities", `${community.address}-challenge-data`);
            const stateFilePath = path.join(stateDir, "voucher_redemption_states.json");

            await fs.promises.mkdir(stateDir, { recursive: true });
            await fs.promises.writeFile(
                stateFilePath,
                JSON.stringify({
                    VOUCHER1: "existing_author"
                })
            );

            // Try to use already redeemed voucher
            const challengeRequestMessage = createChallengeRequestMessage({
                publication: { author: { address: "different_author" } }
            });

            const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);

            const verification = await result.pendingChallenges[0].verify("VOUCHER1");

            expect(verification.success).to.be.false;
            if (verification.success === false) {
                expect(verification.error).to.equal("This voucher has already been redeemed by another author.");
            }
        });
    });

    describe("edge cases", () => {
        it("throws error when no vouchers configured", async () => {
            const community = createCommunity({ vouchers: "" });
            const challengeRequestMessage = createChallengeRequestMessage();

            try {
                await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);
                expect.fail("Should have thrown an error");
            } catch (error) {
                // The error gets wrapped by the challenge system
                expect((error as Error).message).to.include("invalid getChallenge response");
            }
        });

        it("handles whitespace in voucher list", async () => {
            const community = createCommunity({
                vouchers: " VOUCHER1 , VOUCHER2 , VOUCHER3 "
            });
            const challengeRequestMessage = createChallengeRequestMessage();

            const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);

            const verification = await result.pendingChallenges[0].verify("VOUCHER2");
            expect(verification.success).to.be.true;
        });

        it("filters out empty voucher codes", async () => {
            const community = createCommunity({
                vouchers: "VOUCHER1,,VOUCHER2,"
            });
            const challengeRequestMessage = createChallengeRequestMessage();

            const result = await testGetPendingChallengesOrChallengeVerification(challengeRequestMessage, community);

            const verification1 = await result.pendingChallenges[0].verify("VOUCHER1");
            expect(verification1.success).to.be.true;

            const verification2 = await result.pendingChallenges[0].verify("VOUCHER2");
            expect(verification2.success).to.be.true;
        });
    });
});
