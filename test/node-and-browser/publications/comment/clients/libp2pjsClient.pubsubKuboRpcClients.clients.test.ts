import { beforeAll, afterAll, describe, it } from "vitest";
import signers from "../../../../fixtures/signers.js";
import {
    generateMockPost,
    mockRemotePKC,
    getAvailablePKCConfigsToTestAgainst,
    publishWithExpectedResult,
    generatePostToAnswerMathQuestion,
    mockPKCV2
} from "../../../../../dist/node/test/test-util.js";
import { createMockPubsubClient } from "../../../../../dist/node/test/mock-ipfs-client.js";
import type { PKC } from "../../../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../../../dist/node/pkc-error.js";
import type { Comment } from "../../../../../dist/node/publications/comment/comment.js";

// Helper type for accessing private properties on Comment
type CommentWithInternals = { _publishToDifferentProviderThresholdSeconds: number };

const communityAddress = signers[0].address;
const mathCliCommunityAddress = signers[1].address;

type ClientsRecord = Record<string, Record<string, { on: (event: string, handler: (state: string) => void) => void; state: string }>>;

const clientsFieldName: Record<string, string> = {
    "remote-libp2pjs": "libp2pJsClients",
    "remote-kubo-rpc": "pubsubKuboRpcClients"
};

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs"] }).map((config) => {
    const clientFieldName = clientsFieldName[config.testConfigCode];
    describe(`comment.clients.${clientFieldName} - ${config.name}`, async () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });
        afterAll(async () => {
            await pkc.destroy();
        });

        it(`comment.clients.${clientFieldName}[url].state is stopped by default`, async () => {
            const mockPost = await generateMockPost({ communityAddress: communityAddress, pkc: pkc });
            for (const client of Object.values(mockPost.clients[clientFieldName as keyof typeof mockPost.clients]))
                expect((client as { state: string }).state).to.equal("stopped");
        });

        it(`correct order of ${clientFieldName} state when publishing a comment with a sub that skips challenge`, async () => {
            const mockPost = await generateMockPost({ communityAddress: signers[0].address, pkc: pkc });

            const pubsubUrls = Object.keys((pkc.clients as Record<string, Record<string, unknown>>)[clientFieldName]);
            // Only first pubsub url is used for subscription. For publishing we use all providers

            const expectedStates: Record<string, string[]> = Object.assign(
                {},
                ...pubsubUrls.map(
                    (url): Record<string, string[]> => ({
                        [url]: []
                    })
                )
            );
            expectedStates[pubsubUrls[0]] = ["subscribing-pubsub", "publishing-challenge-request", "waiting-challenge", "stopped"];

            const actualStates: Record<string, string[]> = Object.assign(
                {},
                ...pubsubUrls.map(
                    (url): Record<string, string[]> => ({
                        [url]: []
                    })
                )
            );

            for (const pubsubUrl of Object.keys(expectedStates))
                (mockPost.clients as unknown as ClientsRecord)[clientFieldName][pubsubUrl].on("statechange", (newState: string) =>
                    actualStates[pubsubUrl].push(newState)
                );

            const community = await pkc.getCommunity({ address: signers[0].address });
            mockPost._getCommunityCache = (): ReturnType<Comment["_getCommunityCache"]> => {
                const ipfs = community.raw.communityIpfs;
                if (!ipfs) return undefined;
                return {
                    address: community.address,
                    publicKey: community.publicKey!,
                    encryption: ipfs.encryption,
                    pubsubTopic: ipfs.pubsubTopic
                };
            }; // so libp2pjs client state won't include fetching community states
            await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

            expect(actualStates).to.deep.equal(expectedStates);
        });

        it(`correct order of ${clientFieldName} state when publishing a comment with a sub that requires challenge`, async () => {
            const mockPost = await generatePostToAnswerMathQuestion({ communityAddress: mathCliCommunityAddress }, pkc);

            const pubsubUrls = Object.keys((mockPost.clients as Record<string, Record<string, unknown>>)[clientFieldName]);
            // Only first pubsub url is used for subscription. For publishing we use all providers

            const expectedStates: Record<string, string[]> = Object.assign(
                {},
                ...pubsubUrls.map(
                    (url): Record<string, string[]> => ({
                        [url]: []
                    })
                )
            );
            expectedStates[pubsubUrls[0]] = [
                ...(config.testConfigCode === "remote-libp2pjs" ? ["fetching-community-ipns", "fetching-community-ipfs", "stopped"] : []),
                "subscribing-pubsub",
                "publishing-challenge-request",
                "waiting-challenge",
                "waiting-challenge-answers",
                "publishing-challenge-answer",
                "waiting-challenge-verification",
                "stopped"
            ];

            const actualStates: Record<string, string[]> = Object.assign(
                {},
                ...pubsubUrls.map(
                    (url): Record<string, string[]> => ({
                        [url]: []
                    })
                )
            );

            for (const pubsubUrl of Object.keys(expectedStates))
                (mockPost.clients as unknown as ClientsRecord)[clientFieldName][pubsubUrl].on("statechange", (newState: string) =>
                    actualStates[pubsubUrl].push(newState)
                );

            await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

            expect(actualStates).to.deep.equal(expectedStates);
        });

        if (config.testConfigCode === "remote-kubo-rpc")
            it(`correct order of ${clientFieldName} state when failing to publish a comment and the error is from the pubsub provider`, async () => {
                const offlinePubsubUrl = "http://localhost:13173"; // Should be down
                const offlinePubsubPKC = await config.pkcInstancePromise({
                    pkcOptions: {
                        pubsubKuboRpcClientsOptions: [offlinePubsubUrl]
                    }
                });

                const mockPost = await generateMockPost({ communityAddress: signers[1].address, pkc: offlinePubsubPKC });

                const actualStates: string[] = [];

                mockPost.clients.pubsubKuboRpcClients[offlinePubsubUrl].on("statechange", (newState: string) =>
                    actualStates.push(newState)
                );

                try {
                    await mockPost.publish();
                    expect.fail("Should have thrown");
                } catch (e) {
                    expect((e as PKCError).code).to.equal("ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS");
                }

                const expectedStates = new Array(Object.keys(mockPost._challengeExchanges).length)
                    .fill(null)
                    .map(() => ["subscribing-pubsub", "stopped"])
                    .flat();
                expect(actualStates).to.deep.equal(expectedStates);
            });

        if (config.testConfigCode === "remote-kubo-rpc")
            it(`Correct order of ${clientFieldName} state when failing to publish a comment on one pubsub provider and moving on to the other one`, async () => {
                const offlinePubsubUrl = "http://localhost:13173"; // Should be down
                const upPubsubUrl = "http://localhost:15002/api/v0";
                const pkc: PKC = await mockRemotePKC({
                    pkcOptions: { pubsubKuboRpcClientsOptions: [offlinePubsubUrl, upPubsubUrl] }
                });

                pkc.clients.pubsubKuboRpcClients[upPubsubUrl]._client = createMockPubsubClient(); // Use mock pubsub to be on the same pubsub as the community

                const mockPost = await generateMockPost({ communityAddress: signers[0].address, pkc: pkc });

                const expectedStates = {
                    [offlinePubsubUrl]: ["subscribing-pubsub", "stopped"],
                    [upPubsubUrl]: ["subscribing-pubsub", "publishing-challenge-request", "waiting-challenge", "stopped"]
                };

                const actualStates: Record<string, string[]> = { [offlinePubsubUrl]: [], [upPubsubUrl]: [] };

                for (const pubsubUrl of Object.keys(expectedStates))
                    mockPost.clients.pubsubKuboRpcClients[pubsubUrl].on("statechange", (newState: string) =>
                        actualStates[pubsubUrl].push(newState)
                    );

                await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

                expect(actualStates).to.deep.equal(expectedStates);
            });

        if (config.testConfigCode === "remote-kubo-rpc")
            it(`Correct order of pubsubKuboRpcClients state when provider 1 is not responding and moving on to the other one`, async () => {
                const notRespondingPubsubUrl = "http://localhost:15005/api/v0"; // Should take msgs but not respond, never throws errors
                const upPubsubUrl = "http://localhost:15002/api/v0";
                const pkc: PKC = await mockPKCV2({
                    pkcOptions: {
                        pubsubKuboRpcClientsOptions: [notRespondingPubsubUrl, upPubsubUrl]
                    },
                    forceMockPubsub: false,
                    remotePKC: true
                });

                pkc.clients.pubsubKuboRpcClients[upPubsubUrl]._client = createMockPubsubClient(); // Use mock pubsub to be on the same pubsub as the community

                const mockPost = await generateMockPost({ communityAddress: signers[0].address, pkc: pkc });
                (mockPost as unknown as CommentWithInternals)._publishToDifferentProviderThresholdSeconds = 5;

                const expectedStates = {
                    [notRespondingPubsubUrl]: ["subscribing-pubsub", "publishing-challenge-request", "waiting-challenge", "stopped"],
                    [upPubsubUrl]: ["subscribing-pubsub", "publishing-challenge-request", "waiting-challenge", "stopped"]
                };

                const actualStates: Record<string, string[]> = { [notRespondingPubsubUrl]: [], [upPubsubUrl]: [] };

                for (const pubsubUrl of Object.keys(pkc.clients.pubsubKuboRpcClients))
                    mockPost.clients.pubsubKuboRpcClients[pubsubUrl].on("statechange", (newState: string) =>
                        actualStates[pubsubUrl].push(newState)
                    );

                await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

                expect(actualStates).to.deep.equal(expectedStates);
            });

        if (config.testConfigCode === "remote-kubo-rpc")
            it(`correct order of pubsubKuboRpcClients state when publishing a comment with a sub that requires challenge (pubsub provider 0 fail to receive a response in alotted time)`, async () => {
                const notRespondingPubsubUrl = "http://localhost:15005/api/v0"; // Should take pubsub msgs but not respond, never throws errors
                const upPubsubUrl = "http://localhost:15002/api/v0";
                const pkc: PKC = await mockRemotePKC({
                    pkcOptions: { pubsubKuboRpcClientsOptions: [notRespondingPubsubUrl, upPubsubUrl] }
                });

                pkc.clients.pubsubKuboRpcClients[upPubsubUrl]._client = createMockPubsubClient(); // Use mock pubsub to be on the same pubsub as the community

                const mockPost = await generatePostToAnswerMathQuestion({ communityAddress: mathCliCommunityAddress }, pkc);
                (mockPost as unknown as CommentWithInternals)._publishToDifferentProviderThresholdSeconds = 5;

                const expectedStates = {
                    [notRespondingPubsubUrl]: [
                        "subscribing-pubsub",
                        "publishing-challenge-request",
                        "waiting-challenge",
                        "waiting-challenge-answers",
                        "waiting-challenge-verification",
                        "stopped"
                    ],
                    [upPubsubUrl]: [
                        "subscribing-pubsub",
                        "publishing-challenge-request",
                        "waiting-challenge",
                        "waiting-challenge-answers",
                        "publishing-challenge-answer",
                        "waiting-challenge-verification",
                        "stopped"
                    ]
                };

                const actualStates: Record<string, string[]> = { [notRespondingPubsubUrl]: [], [upPubsubUrl]: [] };

                for (const pubsubUrl of Object.keys(expectedStates))
                    mockPost.clients.pubsubKuboRpcClients[pubsubUrl].on("statechange", (newState: string) =>
                        actualStates[pubsubUrl].push(newState)
                    );

                await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

                expect(actualStates).to.deep.equal(expectedStates);
            });
    });
});
