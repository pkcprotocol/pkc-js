import {
    mockPKC,
    generateMockPost,
    publishWithExpectedResult,
    mockPKCNoDataPathWithOnlyKuboClient,
    publishRandomPost,
    resolveWhenConditionIsTrue,
    itSkipIfRpc,
    waitTillPostInCommunityPages,
    describeIfRpc
} from "../../../../dist/node/test/test-util.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { RemoteCommunity } from "../../../../dist/node/community/remote-community.js";
import type { ChallengeVerificationMessageType, DecryptedChallengeMessageType } from "../../../../dist/node/pubsub-messages/types.js";
import type { CommunityChallengeSetting } from "../../../../dist/node/community/types.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";

describe.concurrent(`community.settings.challenges`, async () => {
    let pkc: PKCType;
    let remotePKC: PKCType;
    const defaultSettingsChallenges: CommunityChallengeSetting[] = [
        {
            name: "question",
            options: {
                question: "Placeholder challenge. Set your own challenges otherwise you risk getting spammed",
                answer: "Placeholder answer"
            }
        }
    ];
    const defaultChallengeDescriptions = ["Ask a question, like 'What is the password?'"];
    const defaultChallengeTypes = ["text/plain"];

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
    });

    afterAll(async () => {
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it(`default challenges are configured on new community`, async () => {
        // Should be set to default on community.start()
        const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
        // community?.settings?.challenges should be set to defaultSettingsChallenges
        // also community.challenges should reflect community.settings.challenges
        expect(community?.settings?.challenges).to.deep.equal(defaultSettingsChallenges);

        expect(community._usingDefaultChallenge).to.be.true;

        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        const remoteSub = (await remotePKC.getCommunity({ address: community.address })) as RemoteCommunity;
        for (const _community of [community, remoteSub]) {
            expect(_community.challenges!.length).to.equal(defaultSettingsChallenges.length);
            _community.challenges!.forEach((challenge, index) => {
                expect(challenge.type).to.equal(defaultChallengeTypes[index]);
                expect(challenge.description).to.equal(defaultChallengeDescriptions[index]);
                expect(challenge.exclude).to.deep.equal(defaultSettingsChallenges[index].exclude);
            });
            expect(_community.challenges![0].challenge).to.equal(defaultSettingsChallenges[0].options!.question);
        }
        // clean up
        await community.delete();
    });

    it(`Default challenges reject authors with wrong answer`, async () => {
        const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        const challengeVerificationPromise = new Promise<ChallengeVerificationMessageType>((resolve) =>
            community.once("challengeverification", resolve)
        );
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: { challengeRequest: { challengeAnswers: ["wrong answer"] } }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: false });
        const challengeVerification = await challengeVerificationPromise;
        expect(challengeVerification.challengeSuccess).to.equal(false);
        expect(challengeVerification.challengeErrors).to.not.equal(undefined);
        expect(Object.keys(challengeVerification.challengeErrors!)).to.have.members(["0"]);
        expect(challengeVerification.challengeErrors?.["0"]).to.equal("Wrong answer.");
        await community.delete();
    });

    it(`settings.challenges=[] means sub won't send a challenge`, async () => {
        const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
        await community.edit({ settings: { challenges: [] } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        const post = await publishRandomPost({ communityAddress: community.address, pkc: pkc }); // won't get a challenge
        await waitTillPostInCommunityPages(post as Comment & { cid: string }, pkc);

        await community.delete();
    });

    itSkipIfRpc(`pkc-js will upgrade default challenge if there is a new one`, async () => {
        const community = (await pkc.createCommunity({})) as LocalCommunity;
        expect(community?.settings?.challenges).to.deep.equal(defaultSettingsChallenges);
        expect(community._usingDefaultChallenge).to.be.true;
        const differentDefaultChallenges: CommunityChallengeSetting[] = [];
        // Access private property via bracket notation to bypass TypeScript's access checks
        // @ts-expect-error - Accessing private property for testing purposes
        community._defaultCommunityChallenges = differentDefaultChallenges;
        await community.start(); // Should check value of default challenge, and upgrade to this one above
        await new Promise((resolve) => community.once("update", resolve));
        expect(community.settings!.challenges).to.deep.equal([]);
        expect(community.challenges).to.deep.equal([]);
        expect(community._usingDefaultChallenge).to.be.true;
        const post = await publishRandomPost({ communityAddress: community.address, pkc: pkc }); // won't get a challenge
        await waitTillPostInCommunityPages(post as Comment & { cid: string }, pkc);
        await community.delete();
    });

    it(`Can set a basic question challenge system`, async () => {
        const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
        const challenges: CommunityChallengeSetting[] = [{ name: "question", options: { question: "1+1=?", answer: "2" } }];
        await community.edit({ settings: { challenges } });
        expect(community._usingDefaultChallenge).to.be.false;

        expect(community?.settings?.challenges).to.deep.equal(challenges);

        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        const remoteSub = (await remotePKC.getCommunity({ address: community.address })) as RemoteCommunity;

        expect(community.updatedAt).to.equal(remoteSub.updatedAt);
        for (const _community of [community, remoteSub]) {
            expect(_community.challenges![0].challenge).to.equal("1+1=?");
            expect(_community.challenges![0].description).to.equal("Ask a question, like 'What is the password?'");
            expect(_community.challenges![0].exclude).to.be.undefined;
            expect(_community.challenges![0].type).to.equal("text/plain");
        }

        const mockPost = await generateMockPost({
            communityAddress: community.address,
            pkc: pkc,
            postProps: { challengeRequest: { challengeAnswers: ["2"] } }
        });

        expect(mockPost.challengeRequest!.challengeAnswers).to.deep.equal(["2"]);

        let receivedChallenge = false;
        mockPost.once("challenge", () => {
            receivedChallenge = true;
        });

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

        expect(receivedChallenge).to.be.false;

        await community.delete();
    });

    it(`community.settings.challenges isn't overridden with community.start() if it was edited before starting the sub`, async () => {
        const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
        await community.edit({ settings: { challenges: [] } });
        expect(community.settings!.challenges).to.deep.equal([]);
        expect(community._usingDefaultChallenge).to.be.false;
        expect(community.challenges).to.deep.equal([]);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        expect(community.settings!.challenges).to.deep.equal([]);
        const remoteSub = (await remotePKC.getCommunity({ address: community.address })) as RemoteCommunity;
        for (const _community of [community, remoteSub]) expect(_community.challenges).to.deep.equal([]);

        await community.delete();
    });
});

describeIfRpc(`community.settings.challenges with path (RPC)`, async () => {
    let pkc: PKCType;

    beforeAll(async () => {
        pkc = await mockPKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`RPC server throws error when editing with a challenge path that doesn't exist on the server`, async () => {
        const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;

        // This path exists on the client machine but not necessarily on the RPC server
        // In RPC mode, the server tries to import this file and should fail
        const nonExistentPath = "/path/to/nonexistent/challenge/on/server.js";
        const challenges: CommunityChallengeSetting[] = [
            {
                path: nonExistentPath,
                options: { question: "What is 2+2?", answer: "4" }
            }
        ];

        try {
            await community.edit({ settings: { challenges } });
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

        await community.delete();
    });
});
