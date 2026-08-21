import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mockPKC, resolveWhenConditionIsTrue } from "../../../../dist/node/test/test-util.js";
import { updateDbInternalState } from "../../../../dist/node/runtime/node/community/local-community/db-state.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { CommunityChallengeSetting } from "../../../../dist/node/community/types.js";
import type { PKCError } from "../../../../dist/node/pkc-error.js";

// settings.challenges[i] is validated in two layers: core checks the mechanical things optionInputs
// describes (undeclared keys, missing required options, undeclared publicOptions entries), and the
// challenge's own optional validateChallengeSettings hook checks what only it can know. Both run on the
// edit, creation and start paths, with the same error codes on each. See
// docs/protocol/challenge-authoring.md.

const failuresOf = (e: unknown): { challengeIndex: number; challengeName: string; error: { code: string; details: any } }[] => {
    const details = (e as PKCError).details;
    expect(details, `error carried no details: ${e}`).to.be.an("object");
    expect(details.failures, `error carried no failures: ${JSON.stringify(details)}`).to.be.an("array");
    return details.failures;
};

describe.concurrent(`validateChallengeSettings and core optionInputs validation`, async () => {
    let pkc: PKCType;

    beforeAll(async () => {
        pkc = await mockPKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    describe(`edit() rejects the whole edit and aggregates every failure`, async () => {
        it(`rejects an options key that no optionInputs entry declares`, async () => {
            const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
            const before = community.settings!.challenges;
            // 'anwser' is a typo for 'answer': nothing would ever read it, and every author would be
            // rejected from then on with no signal to the owner
            const challenges: CommunityChallengeSetting[] = [{ name: "question", options: { question: "q?", anwser: "a" } }];

            let thrown: unknown;
            try {
                await community.edit({ settings: { challenges } });
            } catch (e) {
                thrown = e;
            }
            expect(thrown, "edit() should have thrown").to.exist;
            expect((thrown as PKCError).code).to.equal("ERR_CHALLENGE_SETTINGS_VALIDATION_FAILED_FOR_CHALLENGES");

            const failures = failuresOf(thrown);
            expect(failures).to.have.length(1);
            expect(failures[0].challengeIndex).to.equal(0);
            expect(failures[0].challengeName).to.equal("question");
            expect(failures[0].error.code).to.equal("ERR_CHALLENGE_OPTION_NOT_DECLARED_IN_OPTION_INPUTS");
            expect(failures[0].error.details.offendingOption).to.equal("anwser");

            // nothing was persisted: the settings are untouched
            expect(community.settings!.challenges).to.deep.equal(before);
            await community.delete();
        });

        it(`rejects a missing option whose optionInputs entry is required`, async () => {
            const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
            // question's 'answer' optionInput carries required: true
            const challenges: CommunityChallengeSetting[] = [{ name: "question", options: { question: "q?" } }];

            let thrown: unknown;
            try {
                await community.edit({ settings: { challenges } });
            } catch (e) {
                thrown = e;
            }
            const failures = failuresOf(thrown);
            expect(failures[0].error.code).to.equal("ERR_CHALLENGE_REQUIRED_OPTION_MISSING");
            expect(failures[0].error.details.missingOption).to.equal("answer");
            await community.delete();
        });

        // `required` means present, nothing more: whether "" is meaningful is the challenge's own business
        it(`accepts a required option that is present but empty`, async () => {
            const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
            const challenges: CommunityChallengeSetting[] = [{ name: "question", options: { question: "q?", answer: "" } }];
            await community.edit({ settings: { challenges } });
            expect(community.settings!.challenges).to.deep.equal(challenges);
            await community.delete();
        });

        it(`rejects a publicOptions entry that no optionInputs entry declares`, async () => {
            const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
            const challenges: CommunityChallengeSetting[] = [
                { name: "question", options: { question: "q?", answer: "a" }, publicOptions: ["quesion"] }
            ];

            let thrown: unknown;
            try {
                await community.edit({ settings: { challenges } });
            } catch (e) {
                thrown = e;
            }
            const failures = failuresOf(thrown);
            expect(failures[0].error.code).to.equal("ERR_CHALLENGE_PUBLIC_OPTION_NOT_DECLARED_IN_OPTION_INPUTS");
            expect(failures[0].error.details.offendingOption).to.equal("quesion");
            await community.delete();
        });

        it(`reports every invalid challenge at once instead of one per edit`, async () => {
            const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
            const challenges: CommunityChallengeSetting[] = [
                { name: "question", options: { question: "q?", answer: "a" } }, // valid
                { name: "question", options: { question: "q?" } }, // missing required answer
                { name: "publication-match", options: { matches: "[{" } }, // hook: unparseable JSON
                { name: "blacklist", options: { urls: "not a url" } } // hook: unfetchable url
            ];

            let thrown: unknown;
            try {
                await community.edit({ settings: { challenges } });
            } catch (e) {
                thrown = e;
            }
            const failures = failuresOf(thrown);
            expect(failures.map((f) => f.challengeIndex)).to.deep.equal([1, 2, 3]);
            expect(failures.map((f) => f.challengeName)).to.deep.equal(["question", "publication-match", "blacklist"]);
            expect(failures.map((f) => f.error.code)).to.deep.equal([
                "ERR_CHALLENGE_REQUIRED_OPTION_MISSING",
                "ERR_CHALLENGE_SETTINGS_VALIDATION_FAILED",
                "ERR_CHALLENGE_SETTINGS_VALIDATION_FAILED"
            ]);
            // the challenge's own message is preserved, so an owner-facing UI can show what is wrong
            expect(failures[1].error.details.validationError).to.include("matches is not valid JSON");
            expect(failures[2].error.details.validationError).to.include("not a valid URL");
            await community.delete();
        });

        it(`accepts a valid edit that exercises every built-in hook`, async () => {
            const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
            const challenges: CommunityChallengeSetting[] = [
                { name: "question", options: { question: "q?", answer: "a" }, publicOptions: ["question"] },
                { name: "publication-match", options: { matches: `[{"propertyName":"author.address","regexp":"\\\\.bso$"}]` } },
                { name: "blacklist", options: { addresses: "a.bso,b.bso", urls: "https://example.com/list.json" } },
                { name: "whitelist", options: { addresses: "c.bso", urls: "http://example.com/list.json" } },
                { name: "text-math", options: { difficulty: "2" } },
                { name: "fail", options: { error: "no" } }
            ];
            await community.edit({ settings: { challenges } });
            expect(community.settings!.challenges).to.deep.equal(challenges);
            await community.delete();
        });
    });

    describe(`built-in hooks`, async () => {
        const expectHookRejection = async (challenge: CommunityChallengeSetting, expectedMessage: string) => {
            const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
            let thrown: unknown;
            try {
                await community.edit({ settings: { challenges: [challenge] } });
            } catch (e) {
                thrown = e;
            }
            const failures = failuresOf(thrown);
            expect(failures[0].error.code).to.equal("ERR_CHALLENGE_SETTINGS_VALIDATION_FAILED");
            expect(failures[0].error.details.validationError).to.include(expectedMessage);
            await community.delete();
        };

        // the answer is a secret rather than merely private: publishing it means anyone can pass
        it(`question refuses to publish its answer`, async () =>
            expectHookRejection(
                { name: "question", options: { question: "q?", answer: "a" }, publicOptions: ["answer"] },
                "answer cannot be listed in publicOptions"
            ));

        it(`publication-match rejects a regexp that does not compile`, async () =>
            expectHookRejection(
                { name: "publication-match", options: { matches: `[{"propertyName":"content","regexp":"["}]` } },
                "is not a valid regular expression"
            ));

        it(`publication-match rejects matches that is not an array of objects`, async () =>
            expectHookRejection({ name: "publication-match", options: { matches: `{"propertyName":"content"}` } }, "must be a JSON array"));

        it(`blacklist rejects a urls entry that fetch could never load`, async () =>
            expectHookRejection({ name: "blacklist", options: { urls: "ftp://example.com/list.json" } }, "must use http: or https:"));

        it(`whitelist rejects an empty addresses entry`, async () =>
            expectHookRejection({ name: "whitelist", options: { addresses: "a.bso,,b.bso" } }, "is empty"));
    });

    describe(`the load paths`, async () => {
        it(`creation throws, since nothing has been persisted yet`, async () => {
            let thrown: unknown;
            try {
                await pkc.createCommunity({
                    settings: { challenges: [{ name: "question", options: { question: "q?", anwser: "a" } }] }
                });
            } catch (e) {
                thrown = e;
            }
            expect(thrown, "createCommunity() should have thrown").to.exist;
            expect((thrown as PKCError).code).to.equal("ERR_CHALLENGE_SETTINGS_VALIDATION_FAILED_FOR_CHALLENGES");
            expect(failuresOf(thrown)[0].error.code).to.equal("ERR_CHALLENGE_OPTION_NOT_DECLARED_IN_OPTION_INPUTS");
        });

        // Planting an already-broken persisted config means writing the community's internal DB state
        // directly, which an RPC client has no access to. The RPC side of this (that the start-time error
        // events reach an RpcLocalCommunity subscriber) is covered in
        // test/node/pkc/pkc-settings-challenges-rpc.test.ts.
        describeSkipIfRpc(`start-time reporting`, async () => {
            // A config persisted before these checks existed, or one a stricter challenge version now
            // rejects, must never take startup down: start reports and keeps going.
            it(`start emits one error event per invalid challenge and still starts the community`, async () => {
                const community = (await pkc.createCommunity({})) as LocalCommunity;

                // write the broken config the way an older release could have, bypassing the edit-path check
                const broken: CommunityChallengeSetting[] = [
                    { name: "question", options: { question: "q?" } },
                    { name: "publication-match", options: { matches: "[{" } }
                ];
                community.settings = { ...community.settings, challenges: broken };
                // _usingDefaultChallenge must go false too: start() regenerates the default challenge over
                // whatever is persisted while it is true, which would quietly undo the planted config
                community._usingDefaultChallenge = false;
                await updateDbInternalState(community, { settings: community.settings, _usingDefaultChallenge: false });

                const errors: PKCError[] = [];
                community.on("error", (e) => errors.push(e as PKCError));

                await community.start();
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => errors.length >= 2 });

                // the community started anyway
                expect(community.started).to.be.true;
                expect(community.state).to.equal("started");

                const validationErrors = errors.filter((e) => e.code?.startsWith("ERR_CHALLENGE_"));
                expect(validationErrors.map((e) => e.code)).to.include.members([
                    "ERR_CHALLENGE_REQUIRED_OPTION_MISSING",
                    "ERR_CHALLENGE_SETTINGS_VALIDATION_FAILED"
                ]);
                for (const e of validationErrors) {
                    expect(e.details.communityAddress).to.equal(community.address);
                    expect(e.details.challengeIndex).to.be.a("number");
                    expect(e.details.challengeName).to.equal(e.details.challengeIndex === 0 ? "question" : "publication-match");
                }
                await community.delete();
            });
        });
    });
});
