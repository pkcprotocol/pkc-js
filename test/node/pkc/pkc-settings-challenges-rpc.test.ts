import { describe, it, beforeAll, afterAll, expect } from "vitest";
import path from "path";
import net from "node:net";
import PKC from "../../../dist/node/index.js";
import PKCWsServer from "../../../dist/node/rpc/src/index.js";
import {
    mockRpcServerPKC,
    mockRpcServerForTests,
    resolveWhenConditionIsTrue,
    generateMockPost,
    publishWithExpectedResult
} from "../../../dist/node/test/test-util.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { ChallengeVerificationMessageType } from "../../../dist/node/pubsub-messages/types.js";
import type { PKCWsServerSettingsSerialized } from "../../../dist/node/rpc/src/types.js";
import type {
    ChallengeFileInput,
    ChallengeInput,
    ChallengeResultInput,
    GetChallengeArgsInput,
    CommunityChallengeSetting
} from "../../../dist/node/community/types.js";

type PKCWsServerType = Awaited<ReturnType<typeof PKCWsServer.PKCWsServer>>;

// A custom challenge factory for testing
const customSkyChallenge = ({ challengeSettings }: { challengeSettings: CommunityChallengeSetting }): ChallengeFileInput => {
    const type: ChallengeInput["type"] = "text/plain";
    const description = "A custom challenge asking about the sky color.";
    const challenge = "What color is the sky?";

    const getChallenge = async ({
        challengeRequestMessage,
        challengeIndex
    }: GetChallengeArgsInput): Promise<ChallengeInput | ChallengeResultInput> => {
        const challengeAnswer = challengeRequestMessage?.challengeAnswers?.[challengeIndex];
        if (challengeAnswer === undefined) {
            return {
                challenge,
                verify: async (answer: string): Promise<ChallengeResultInput> => {
                    if (answer.toLowerCase() === "blue") return { success: true };
                    return { success: false, error: "Wrong color." };
                },
                type
            };
        }
        if (challengeAnswer.toLowerCase() !== "blue") {
            return { success: false, error: "Wrong color." };
        }
        return { success: true };
    };

    return { getChallenge, type, challenge, description };
};

// A challenge factory that shadows a built-in name
const overriddenQuestionChallenge = ({ challengeSettings }: { challengeSettings: CommunityChallengeSetting }): ChallengeFileInput => {
    const type: ChallengeInput["type"] = "text/plain";
    const description = "Overridden question challenge via settings.";
    const challenge = "What is the answer to life?";

    const getChallenge = async ({
        challengeRequestMessage,
        challengeIndex
    }: GetChallengeArgsInput): Promise<ChallengeInput | ChallengeResultInput> => {
        const challengeAnswer = challengeRequestMessage?.challengeAnswers?.[challengeIndex];
        if (challengeAnswer === undefined) {
            return {
                challenge,
                verify: async (answer: string): Promise<ChallengeResultInput> => {
                    if (answer === "42") return { success: true };
                    return { success: false, error: "Not the answer to life." };
                },
                type
            };
        }
        if (challengeAnswer !== "42") {
            return { success: false, error: "Not the answer to life." };
        }
        return { success: true };
    };

    return { getChallenge, type, challenge, description };
};

const RPC_AUTH_KEY = "test-settings-challenges";

const getAvailablePort = async (startPort = 39660): Promise<number> => {
    for (let port = startPort; port < startPort + 100; port++) {
        try {
            return await new Promise<number>((resolve, reject) => {
                const server = net.createServer();
                server.unref();
                server.on("error", reject);
                server.listen(port, () => {
                    server.close(() => resolve(port));
                });
            });
        } catch {
            continue;
        }
    }
    throw new Error(`No available port found in range ${startPort}-${startPort + 99}`);
};

describe("plebbit.settings.challenges over RPC", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let RPC_URL: string;

    beforeAll(async () => {
        // Create a server plebbit with custom challenges
        serverPKC = await mockRpcServerPKC({
            dataPath: path.join(process.cwd(), ".plebbit-rpc-settings-challenges-test")
        });
        serverPKC.settings.challenges = {
            "sky-color": customSkyChallenge
        };

        // Dynamically allocate a port to avoid EADDRINUSE in parallel test runs
        const rpcPort = await getAvailablePort();
        RPC_URL = `ws://localhost:${rpcPort}`;

        // Spin up the RPC server — pass plebbitOptions to avoid creating a heavyweight default PKC
        rpcServer = await PKCWsServer.PKCWsServer({
            port: rpcPort,
            authKey: RPC_AUTH_KEY,
            plebbitOptions: {
                kuboRpcClientsOptions: ["http://localhost:15001/api/v0"],
                httpRoutersOptions: [],
                dataPath: serverPKC.dataPath
            }
        });
        // Replace the factory-created plebbit with our mock that has custom challenges
        const server = rpcServer as any;
        server._initPKC(serverPKC);
        server._createPKCInstanceFromSetSettings = async (newOptions: any) => {
            const newPKC = await mockRpcServerPKC({
                dataPath: path.join(process.cwd(), ".plebbit-rpc-settings-challenges-test"),
                ...newOptions
            });
            // Preserve the custom challenges on re-created plebbit
            newPKC.settings.challenges = serverPKC.settings.challenges;
            return newPKC;
        };
        mockRpcServerForTests(rpcServer);
    });

    afterAll(async () => {
        if (rpcServer) await rpcServer.destroy();
    });

    it(`RPC client receives custom challenge metadata from server via settingschange`, async () => {
        const clientPKC = await PKC({
            pkcRpcClientsOptions: [RPC_URL],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        clientPKC.on("error", () => {}); // Prevent uncaught errors from WebSocket reconnection

        const rpcClient = clientPKC.clients.plebbitRpcClients[RPC_URL];

        // Wait for initial settingschange if settings haven't arrived yet
        await resolveWhenConditionIsTrue({
            toUpdate: rpcClient,
            predicate: async () => Boolean(rpcClient.settings?.challenges),
            eventName: "settingschange"
        });

        const settings = rpcClient.settings!;
        expect(settings).to.be.ok;

        // Verify the custom "sky-color" challenge is in the serialized settings
        expect(settings.challenges).to.be.an("object");
        expect(settings.challenges["sky-color"]).to.be.an("object");
        expect(settings.challenges["sky-color"].type).to.equal("text/plain");
        expect(settings.challenges["sky-color"].description).to.equal("A custom challenge asking about the sky color.");
        expect(settings.challenges["sky-color"].challenge).to.equal("What color is the sky?");
        // getChallenge should NOT be serialized
        expect(settings.challenges["sky-color"]).to.not.have.property("getChallenge");

        await clientPKC.destroy();
    });

    it(`RPC client sees built-in challenges alongside custom challenges`, async () => {
        const clientPKC = await PKC({
            pkcRpcClientsOptions: [RPC_URL],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        clientPKC.on("error", () => {}); // Prevent uncaught errors from WebSocket reconnection

        const rpcClient = clientPKC.clients.plebbitRpcClients[RPC_URL];

        await resolveWhenConditionIsTrue({
            toUpdate: rpcClient,
            predicate: async () => Boolean(rpcClient.settings?.challenges),
            eventName: "settingschange"
        });

        const challenges = rpcClient.settings!.challenges;

        // Built-in challenges should still be present
        expect(challenges["text-math"]).to.be.an("object");
        expect(challenges["question"]).to.be.an("object");

        // Custom challenge should also be present
        expect(challenges["sky-color"]).to.be.an("object");

        await clientPKC.destroy();
    });

    it(`user-defined challenge shadows built-in challenge with same name in RPC serialization`, async () => {
        // Add an override for "question" on the server side
        serverPKC.settings.challenges = {
            ...serverPKC.settings.challenges,
            question: overriddenQuestionChallenge
        };

        // Re-serialize by creating a new client that receives fresh settings
        const clientPKC = await PKC({
            pkcRpcClientsOptions: [RPC_URL],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        clientPKC.on("error", () => {}); // Prevent uncaught errors from WebSocket reconnection

        const rpcClient = clientPKC.clients.plebbitRpcClients[RPC_URL];

        await resolveWhenConditionIsTrue({
            toUpdate: rpcClient,
            predicate: async () => Boolean(rpcClient.settings?.challenges),
            eventName: "settingschange"
        });

        const challenges = rpcClient.settings!.challenges;

        // The "question" challenge should now reflect the overridden version
        expect(challenges["question"].description).to.equal("Overridden question challenge via settings.");
        expect(challenges["question"].challenge).to.equal("What is the answer to life?");

        // Custom "sky-color" should still be present
        expect(challenges["sky-color"]).to.be.an("object");

        await clientPKC.destroy();
    });

    it(`settingschange event on plebbit instance includes correct plebbitOptions`, async () => {
        const clientPKC = await PKC({
            pkcRpcClientsOptions: [RPC_URL],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        clientPKC.on("error", () => {}); // Prevent uncaught errors from WebSocket reconnection

        // Wait for the plebbit instance to initialize and receive settingschange
        const settingsPromise = new Promise<any>((resolve) => clientPKC.once("settingschange", resolve));

        // The settingschange should fire during init with plebbitOptions
        const plebbitOptions = await settingsPromise;

        expect(plebbitOptions).to.be.an("object");
        // plebbitOptions should have typical plebbit config fields
        expect(plebbitOptions).to.have.property("dataPath");

        await clientPKC.destroy();
    });

    it(`modifying server plebbit.settings.challenges at runtime is reflected to new RPC clients`, async () => {
        // Add a brand new challenge at runtime on the server
        serverPKC.settings.challenges = {
            ...serverPKC.settings.challenges,
            "runtime-added": customSkyChallenge
        };

        // Connect a new client — it should see the new challenge
        const clientPKC = await PKC({
            pkcRpcClientsOptions: [RPC_URL],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        clientPKC.on("error", () => {}); // Prevent uncaught errors from WebSocket reconnection

        const rpcClient = clientPKC.clients.plebbitRpcClients[RPC_URL];

        await resolveWhenConditionIsTrue({
            toUpdate: clientPKC,
            predicate: async () => Boolean(rpcClient.settings?.challenges),
            eventName: "settingschange"
        });

        const challenges = rpcClient.settings!.challenges;

        expect(challenges["runtime-added"]).to.be.an("object");
        expect(challenges["runtime-added"].description).to.equal("A custom challenge asking about the sky color.");

        await clientPKC.destroy();
    });

    it(`RPC client can create a subplebbit with custom challenge and publish to it`, async () => {
        // Reset server challenges to only have sky-color (remove any overrides from prior tests)
        serverPKC.settings.challenges = {
            "sky-color": customSkyChallenge
        };

        const clientPKC = await PKC({
            pkcRpcClientsOptions: [RPC_URL],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        clientPKC.on("error", () => {}); // Prevent uncaught errors from WebSocket reconnection

        // Create subplebbit via RPC
        const subplebbit = (await clientPKC.createCommunity({})) as RpcLocalCommunity;
        expect(subplebbit.address).to.be.a("string");

        // Set challenges to the custom "sky-color" challenge registered on the server
        await subplebbit.edit({ settings: { challenges: [{ name: "sky-color" }] } });
        expect(subplebbit.settings!.challenges).to.deep.equal([{ name: "sky-color" }]);

        // Start the subplebbit
        await subplebbit.start();
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () => typeof subplebbit.updatedAt === "number"
        });

        // Verify the custom challenge metadata is active on the subplebbit
        expect(subplebbit.challenges).to.have.length(1);
        expect(subplebbit.challenges![0].type).to.equal("text/plain");
        expect(subplebbit.challenges![0].description).to.equal("A custom challenge asking about the sky color.");
        expect(subplebbit.challenges![0].challenge).to.equal("What color is the sky?");

        // Publish with correct pre-answer — should succeed
        const correctPost = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: clientPKC,
            postProps: {
                challengeRequest: { challengeAnswers: ["blue"] }
            }
        });
        await publishWithExpectedResult({ publication: correctPost, expectedChallengeSuccess: true });

        // Publish with wrong pre-answer — should fail
        const wrongPost = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: clientPKC,
            postProps: {
                challengeRequest: { challengeAnswers: ["red"] }
            }
        });
        await publishWithExpectedResult({ publication: wrongPost, expectedChallengeSuccess: false });

        await subplebbit.delete();
        await clientPKC.destroy();
    });
});
