import {
    mockPlebbit,
    generateMockPost,
    publishWithExpectedResult,
    mockPlebbitNoDataPathWithOnlyKuboClient,
    publishRandomPost,
    resolveWhenConditionIsTrue,
    itSkipIfRpc,
    waitTillPostInSubplebbitPages,
    describeIfRpc
} from "../../../../dist/node/test/test-util.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit as PlebbitType } from "../../../../dist/node/plebbit/plebbit.js";
import type { LocalSubplebbit } from "../../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { RemoteSubplebbit } from "../../../../dist/node/subplebbit/remote-subplebbit.js";
import type { ChallengeVerificationMessageType, DecryptedChallengeMessageType } from "../../../../dist/node/pubsub-messages/types.js";
import type { SubplebbitChallengeSetting } from "../../../../dist/node/subplebbit/types.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

describe.concurrent(`subplebbit.settings.challenges`, async () => {
    let plebbit: PlebbitType;
    let remotePlebbit: PlebbitType;
    const defaultMatches = JSON.stringify([{ propertyName: "author.address", regexp: "\\.(sol|eth|bso)$" }]);
    const defaultSettingsChallenges: SubplebbitChallengeSetting[] = [
        {
            name: "publication-match",
            options: {
                matches: defaultMatches,
                error: "Posting in this community requires a username (author address) that ends with .bso, .sol, or .eth. Go to the settings to set your username."
            },
            exclude: [
                { role: ["moderator", "admin", "owner"] },
                {
                    firstCommentTimestamp: 60 * 60 * 24 * 30,
                    postScore: 3,
                    rateLimit: 2,
                    replyScore: 0
                },
                { challenges: [1] },
                { challenges: [2] }
            ]
        },
        {
            name: "whitelist",
            options: {
                urls: "https://raw.githubusercontent.com/plebbit/lists/refs/heads/master/whitelist-challenge.json",
                error: "Or posting in this community requires being whitelisted. Go to https://t.me/plebbit and ask to be whitelisted. Or"
            },
            exclude: [{ challenges: [0] }, { challenges: [2] }]
        },
        {
            name: "mintpass",
            options: {
                contractAddress: "0xcb60e1dd6944dfc94920e28a277a51a06e9f20d2",
                chainTicker: "eth",
                rpcUrl: "https://sepolia.base.org"
            },
            exclude: [{ challenges: [0] }, { challenges: [1] }]
        }
    ];
    const defaultChallengeDescriptions = [
        "Match publication properties against regex patterns.",
        "Whitelist author addresses.",
        "Verify that the author owns a MintPass NFT of the required type, with transfer cooldown protection."
    ];
    const defaultChallengeTypes = ["text/plain", "text/plain", "url/iframe"];
    const mintpassMissingWalletError = "Author wallet address is not defined. Please set your wallet address in settings.";

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
    });

    afterAll(async () => {
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    it(`default challenges are configured on new subplebbit`, async () => {
        // Should be set to default on subplebbit.start()
        const subplebbit = (await plebbit.createSubplebbit({})) as LocalSubplebbit | RpcLocalSubplebbit;
        // subplebbit?.settings?.challenges should be set to defaultSettingsChallenges
        // also subplebbit.challenges should reflect subplebbit.settings.challenges
        expect(subplebbit?.settings?.challenges).to.deep.equal(defaultSettingsChallenges);

        expect(subplebbit._usingDefaultChallenge).to.be.true;

        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
        const remoteSub = (await remotePlebbit.getSubplebbit({ address: subplebbit.address })) as RemoteSubplebbit;
        for (const _subplebbit of [subplebbit, remoteSub]) {
            expect(_subplebbit.challenges!.length).to.equal(defaultSettingsChallenges.length);
            _subplebbit.challenges!.forEach((challenge, index) => {
                expect(challenge.type).to.equal(defaultChallengeTypes[index]);
                expect(challenge.description).to.equal(defaultChallengeDescriptions[index]);
                expect(challenge.exclude).to.deep.equal(defaultSettingsChallenges[index].exclude);
            });
            expect(_subplebbit.challenges![0].challenge).to.be.undefined;
            expect(_subplebbit.challenges![1].challenge).to.be.undefined;
            expect(_subplebbit.challenges![2].challenge).to.be.undefined;
        }
        // clean up
        await subplebbit.delete();
    });

    it(`Default challenges reject authors without an allowed address`, async () => {
        // skip this test for now till we update mintpass
        const subplebbit = (await plebbit.createSubplebbit({})) as LocalSubplebbit | RpcLocalSubplebbit;
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        const challengeVerificationPromise = new Promise<ChallengeVerificationMessageType>((resolve) =>
            subplebbit.once("challengeverification", resolve)
        );
        const post = await generateMockPost({ subplebbitAddress: subplebbit.address, plebbit: remotePlebbit });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: false });
        const challengeVerification = await challengeVerificationPromise;
        expect(challengeVerification.challengeSuccess).to.equal(false);
        expect(challengeVerification.challengeErrors).to.not.equal(undefined);
        expect(Object.keys(challengeVerification.challengeErrors!)).to.have.members(["0", "1", "2"]);
        expect(challengeVerification.challengeErrors?.["0"]).to.equal(defaultSettingsChallenges[0].options!.error);
        expect(challengeVerification.challengeErrors?.["1"]).to.equal(defaultSettingsChallenges[1].options!.error);
        expect(challengeVerification.challengeErrors?.["2"]).to.equal(mintpassMissingWalletError);
        await subplebbit.delete();
    });

    it(`settings.challenges=[] means sub won't send a challenge`, async () => {
        const subplebbit = (await plebbit.createSubplebbit({})) as LocalSubplebbit | RpcLocalSubplebbit;
        await subplebbit.edit({ settings: { challenges: [] } });
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
        const post = await publishRandomPost({ subplebbitAddress: subplebbit.address, plebbit: plebbit }); // won't get a challenge
        await waitTillPostInSubplebbitPages(post as CommentIpfsWithCidDefined, plebbit);

        await subplebbit.delete();
    });

    itSkipIfRpc(`plebbit-js will upgrade default challenge if there is a new one`, async () => {
        const subplebbit = (await plebbit.createSubplebbit({})) as LocalSubplebbit;
        expect(subplebbit?.settings?.challenges).to.deep.equal(defaultSettingsChallenges);
        expect(subplebbit._usingDefaultChallenge).to.be.true;
        const differentDefaultChallenges: SubplebbitChallengeSetting[] = [];
        // Access private property via bracket notation to bypass TypeScript's access checks
        // @ts-expect-error - Accessing private property for testing purposes
        subplebbit._defaultSubplebbitChallenges = differentDefaultChallenges;
        await subplebbit.start(); // Should check value of default challenge, and upgrade to this one above
        await new Promise((resolve) => subplebbit.once("update", resolve));
        expect(subplebbit.settings!.challenges).to.deep.equal([]);
        expect(subplebbit.challenges).to.deep.equal([]);
        expect(subplebbit._usingDefaultChallenge).to.be.true;
        const post = await publishRandomPost({ subplebbitAddress: subplebbit.address, plebbit: plebbit }); // won't get a challenge
        await waitTillPostInSubplebbitPages(post as CommentIpfsWithCidDefined, plebbit);
        await subplebbit.delete();
    });

    it(`Can set a basic question challenge system`, async () => {
        const subplebbit = (await plebbit.createSubplebbit({})) as LocalSubplebbit | RpcLocalSubplebbit;
        const challenges: SubplebbitChallengeSetting[] = [{ name: "question", options: { question: "1+1=?", answer: "2" } }];
        await subplebbit.edit({ settings: { challenges } });
        expect(subplebbit._usingDefaultChallenge).to.be.false;

        expect(subplebbit?.settings?.challenges).to.deep.equal(challenges);

        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        const remoteSub = (await remotePlebbit.getSubplebbit({ address: subplebbit.address })) as RemoteSubplebbit;

        expect(subplebbit.updatedAt).to.equal(remoteSub.updatedAt);
        for (const _subplebbit of [subplebbit, remoteSub]) {
            expect(_subplebbit.challenges![0].challenge).to.equal("1+1=?");
            expect(_subplebbit.challenges![0].description).to.equal("Ask a question, like 'What is the password?'");
            expect(_subplebbit.challenges![0].exclude).to.be.undefined;
            expect(_subplebbit.challenges![0].type).to.equal("text/plain");
        }

        const mockPost = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: plebbit,
            postProps: { challengeRequest: { challengeAnswers: ["2"] } }
        });

        expect(mockPost.challengeRequest!.challengeAnswers).to.deep.equal(["2"]);

        let receivedChallenge = false;
        mockPost.once("challenge", () => {
            receivedChallenge = true;
        });

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

        expect(receivedChallenge).to.be.false;

        await subplebbit.delete();
    });

    it(`subplebbit.settings.challenges isn't overridden with subplebbit.start() if it was edited before starting the sub`, async () => {
        const subplebbit = (await plebbit.createSubplebbit({})) as LocalSubplebbit | RpcLocalSubplebbit;
        await subplebbit.edit({ settings: { challenges: [] } });
        expect(subplebbit.settings!.challenges).to.deep.equal([]);
        expect(subplebbit._usingDefaultChallenge).to.be.false;
        expect(subplebbit.challenges).to.deep.equal([]);
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
        expect(subplebbit.settings!.challenges).to.deep.equal([]);
        const remoteSub = (await remotePlebbit.getSubplebbit({ address: subplebbit.address })) as RemoteSubplebbit;
        for (const _subplebbit of [subplebbit, remoteSub]) expect(_subplebbit.challenges).to.deep.equal([]);

        await subplebbit.delete();
    });
});

describeIfRpc(`subplebbit.settings.challenges with path (RPC)`, async () => {
    let plebbit: PlebbitType;

    beforeAll(async () => {
        plebbit = await mockPlebbit();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`RPC server throws error when editing with a challenge path that doesn't exist on the server`, async () => {
        const subplebbit = (await plebbit.createSubplebbit({})) as LocalSubplebbit | RpcLocalSubplebbit;

        // This path exists on the client machine but not necessarily on the RPC server
        // In RPC mode, the server tries to import this file and should fail
        const nonExistentPath = "/path/to/nonexistent/challenge/on/server.js";
        const challenges: SubplebbitChallengeSetting[] = [
            {
                path: nonExistentPath,
                options: { question: "What is 2+2?", answer: "4" }
            }
        ];

        try {
            await subplebbit.edit({ settings: { challenges } });
            expect.fail("Should have thrown an error for invalid path on RPC server");
        } catch (error) {
            // RPC errors come as JSON-RPC format with code -32000 and the actual error in data property
            // The error.data should contain the message about failing to import the challenge file
            const err = error as { code?: string; message?: string; data?: string };
            const hasExpectedErrorCode =
                err.code === "ERR_FAILED_TO_IMPORT_CHALLENGE_FILE_FACTORY" ||
                err.code === "ERR_MODULE_NOT_FOUND" ||
                (err.message && err.message.includes("Cannot find module")) ||
                (err.data && err.data.includes("Cannot find module"));
            expect(hasExpectedErrorCode, `Expected error related to module import, got: ${JSON.stringify(error)}`).to.be.true;
        }

        await subplebbit.delete();
    });
});
