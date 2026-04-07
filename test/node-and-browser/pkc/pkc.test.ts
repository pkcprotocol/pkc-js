import { beforeAll, afterAll, describe, it } from "vitest";
import PKC from "../../../dist/node/index.js";
import signers from "../../fixtures/signers.js";
import {
    mockRemotePKC,
    itIfRpc,
    describeIfRpc,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    mockRpcRemotePKC
} from "../../../dist/node/test/test-util.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { SignerType } from "../../../dist/node/signer/types.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

const fixtureSigner = signers[0];

let defaultIpfsGatewayUrls: string[];

describe("PKC options", async () => {
    beforeAll(async () => {
        const pkc = await PKC({ httpRoutersOptions: [] });
        defaultIpfsGatewayUrls = pkc.ipfsGatewayUrls;
        pkc.destroy().catch((err) => console.error("failed to destroy pkc", err));
    });
    it("PKC() uses correct default pkc options", async () => {
        const defaultPKC = await PKC({ httpRoutersOptions: [] });
        expect(Object.keys(defaultPKC.clients.ipfsGateways).sort()).to.deep.equal(defaultIpfsGatewayUrls.sort());
        expect(Object.keys(defaultPKC.clients.pubsubKuboRpcClients).sort()).to.deep.equal(
            ["https://pubsubprovider.xyz/api/v0", "https://plebpubsub.xyz/api/v0"].sort()
        );
        expect((defaultPKC.pubsubKuboRpcClientsOptions[0] as { headers?: { authorization?: string } })?.headers?.authorization).to.be
            .undefined;

        // no dataPath in browser
        if (typeof window === "undefined") {
            expect(defaultPKC.dataPath).to.match(/\.plebbit$/);
        } else {
            expect(defaultPKC.dataPath).to.equal(undefined);
        }
        JSON.stringify(defaultPKC); // Will throw an error if circular json
        await defaultPKC.destroy();
    });

    it("PKC Options is set up correctly when only kuboRpcClientsOptions is provided", async () => {
        // RPC exception
        const url = "http://localhost:15018/api/v0"; // offline API
        const options = { kuboRpcClientsOptions: [url], httpRoutersOptions: [] as string[], dataPath: undefined as undefined };
        const testPKC = await PKC(options);
        expect(testPKC.clients.kuboRpcClients[url]).to.exist;
        expect(testPKC.clients.pubsubKuboRpcClients[url]).to.exist;
        expect(Object.keys(testPKC.clients.ipfsGateways).sort()).to.deep.equal(defaultIpfsGatewayUrls.sort());
        expect(Object.keys(testPKC.clients.kuboRpcClients)).to.deep.equal([url]);

        expect(Object.keys(testPKC.clients.pubsubKuboRpcClients)).to.deep.equal([url]);
        JSON.stringify(testPKC); // Will throw an error if circular json
        await testPKC.destroy();
    });

    it(`PKC({kuboRpcClientsOptions}) uses specified node even if ipfs node is down`, async () => {
        // RPC exception
        const url = "http://localhost:12323/api/v0"; // Should be offline
        const pkc = await PKC({ kuboRpcClientsOptions: [url], httpRoutersOptions: [] });

        expect(Object.keys(pkc.clients.ipfsGateways).sort()).to.deep.equal(defaultIpfsGatewayUrls.sort());
        expect(Object.keys(pkc.clients.pubsubKuboRpcClients)).to.deep.equal([url]);
        expect(Object.keys(pkc.clients.kuboRpcClients)).to.deep.equal([url]);

        expect(pkc.pubsubKuboRpcClientsOptions).to.deep.equal([{ url }]);
        expect(pkc.kuboRpcClientsOptions).to.deep.equal([{ url }]);
        JSON.stringify(pkc); // Will throw an error if circular json
        await pkc.destroy();
    });

    itIfRpc(`PKC({pkcRpcClientsOptions}) sets up correctly`, async () => {
        const rpcUrl = "ws://localhost:39652";
        const pkc = await PKC({ pkcRpcClientsOptions: [rpcUrl], httpRoutersOptions: [] });
        pkc.on("error", () => {}); // so it doesn't throw when we destroy
        expect(pkc.pkcRpcClientsOptions).to.deep.equal([rpcUrl]);
        expect(Object.keys(pkc.clients.pkcRpcClients)).to.deep.equal([rpcUrl]);
        expect(pkc.pubsubKuboRpcClientsOptions).to.be.undefined;
        expect(pkc.nameResolvers).to.be.undefined;
        expect(pkc.clients.kuboRpcClients).to.deep.equal({});
        expect(pkc.clients.pubsubKuboRpcClients).to.deep.equal({});
        expect(pkc.clients.libp2pJsClients).to.deep.equal({});
        expect(pkc.clients.ipfsGateways).to.deep.equal({});
        JSON.stringify(pkc); // Will throw an error if circular json
        await pkc.destroy();
    });

    it(`PKC({dataPath: undefined}) sets pkc.dataPath to undefined`, async () => {
        const pkc = await PKC({ dataPath: undefined, httpRoutersOptions: [] });
        expect(pkc.dataPath).to.be.undefined;
        await pkc.destroy();
    });

    itIfRpc("Error is thrown if RPC is down", async () => {
        const pkc = await mockRpcRemotePKC({ pkcOptions: { pkcRpcClientsOptions: ["ws://localhost:39650"] } }); // Already has RPC config
        // pkc.communities will take 20s to timeout and throw this error
        try {
            await pkc.fetchCid({ cid: "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f" }); // random cid
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as PKCError).code).to.equal("ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC"); // Use the rpc so it would detect it's not loading
        }
        await pkc.destroy();
    });

    it(`PKC({ipfsGateways: undefined}) uses default gateways`, async () => {
        const pkc = await PKC({ ipfsGatewayUrls: undefined, httpRoutersOptions: [] });
        expect(Object.keys(pkc.clients.ipfsGateways).sort()).to.deep.equal(defaultIpfsGatewayUrls.sort());
        expect(pkc.ipfsGatewayUrls.sort()).to.deep.equal(defaultIpfsGatewayUrls.sort());
        JSON.stringify(pkc); // Will throw an error if circular json
        await pkc.destroy();
    });

    it(`PKC({ipfsGateways: []}) sets pkc instance to not use gateways`, async () => {
        const pkc = await PKC({ ipfsGatewayUrls: [], httpRoutersOptions: [] });
        expect(pkc.clients.ipfsGateways).to.deep.equal({});
        expect(pkc.ipfsGatewayUrls).to.be.undefined;
        JSON.stringify(pkc); // Will throw an error if circular json
        await pkc.destroy();
    });

    it(`PKC({pubsubKuboRpcClientsOptions: []}) sets pkc instance to not use pubsub providers`, async () => {
        const pkc = await PKC({ pubsubKuboRpcClientsOptions: [], httpRoutersOptions: [] });
        expect(Object.keys(pkc.clients.pubsubKuboRpcClients)).to.deep.equal([]);
        expect(pkc.pubsubKuboRpcClientsOptions).to.deep.equal([]);
        JSON.stringify(pkc); // Will throw an error if circular json
        await pkc.destroy();
    });

    it(`PKC({pubsubKuboRpcClientsOptions: undefined}) sets PKC instance to use default pubsub providers`, async () => {
        const pkc = await PKC({ httpRoutersOptions: [] });
        const defaultPubsubKuboRpcClientsOptions = ["https://pubsubprovider.xyz/api/v0", "https://plebpubsub.xyz/api/v0"];
        expect(Object.keys(pkc.clients.pubsubKuboRpcClients).sort()).to.deep.equal(defaultPubsubKuboRpcClientsOptions.sort());
        JSON.stringify(pkc); // Will throw an error if circular json
        await pkc.destroy();
    });

    it(`PKC({kuboRpcClientsOptions: []}) sets pkc instance to not use kubo providers`, async () => {
        const pkc = await PKC({ kuboRpcClientsOptions: [], httpRoutersOptions: [] });
        expect(pkc.clients.kuboRpcClients).to.deep.equal({});
        expect(pkc.kuboRpcClientsOptions).to.deep.equal([]);
        JSON.stringify(pkc); // Will throw an error if circular json
        await pkc.destroy();
    });

    it(`PKC({libp2pJsClientsOptions: [{key}], pubsubKuboRpcClientsOptions: []}) sets pkc instance to use default libp2pjs options`, async () => {
        const pkc = await PKC({
            libp2pJsClientsOptions: [{ key: "random" }],
            httpRoutersOptions: ["https://notexist.com"],
            dataPath: undefined,
            pubsubKuboRpcClientsOptions: []
        });
        expect(Object.keys(pkc.clients.libp2pJsClients).sort()).to.deep.equal(["random"]);
        expect(Object.keys(pkc.clients.pkcRpcClients)).to.deep.equal([]);
        expect(pkc.clients.kuboRpcClients).to.deep.equal({});
        expect(pkc.clients.pubsubKuboRpcClients).to.deep.equal({});
        JSON.stringify(pkc); // Will throw an error if circular json
        await pkc.destroy();
    });

    it(`PKC({libp2pJsClientsOptions: [{key}]}) sets pkc instance to use default libp2pjs options`, async () => {
        const pkc = await PKC({
            libp2pJsClientsOptions: [{ key: "random" }],
            httpRoutersOptions: ["https://notexist.com"],
            dataPath: undefined
        });
        expect(Object.keys(pkc.clients.libp2pJsClients).sort()).to.deep.equal(["random"]);
        expect(Object.keys(pkc.clients.pkcRpcClients)).to.deep.equal([]);
        expect(pkc.clients.kuboRpcClients).to.deep.equal({});
        expect(pkc.clients.pubsubKuboRpcClients).to.deep.equal({});
        JSON.stringify(pkc); // Will throw an error if circular json
        await pkc.destroy();
    });

    it(`PKC({nameResolvers: [...]}) sets pkc.nameResolvers correctly`, async () => {
        const mockResolver = {
            key: "test-resolver",
            resolve: async (): Promise<{ publicKey: string; [key: string]: string } | undefined> => undefined,
            canResolve: (): boolean => true,
            provider: "test-provider"
        };
        const pkc = await PKC({
            nameResolvers: [mockResolver],
            httpRoutersOptions: []
        });
        expect(pkc.nameResolvers).to.have.lengthOf(1);
        expect(pkc.nameResolvers![0].key).to.equal("test-resolver");
        await pkc.destroy();
    });
});

describe("pkc.createSigner", async () => {
    let pkc: PKCType;
    let signer: SignerType;
    const isBase64 = (testString: string): boolean => /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}))?$/gm.test(testString);
    beforeAll(async () => {
        pkc = await mockRemotePKC();
        signer = await pkc.createSigner();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it("without private key argument", async () => {
        expect(signer).not.to.equal(undefined);
        expect(isBase64(signer.privateKey)).to.be.true;
        expect(isBase64(signer.publicKey)).to.be.true;
        expect(signer.address).to.match(/^12D3KooW/);
        expect(signer.type).to.equal("ed25519");
    });

    it("with private key argument", async () => {
        const signer = await pkc.createSigner({ privateKey: fixtureSigner.privateKey, type: "ed25519" });
        expect(signer).not.to.equal(undefined);
        expect(signer.privateKey).to.equal(fixtureSigner.privateKey);
        expect(signer.publicKey).to.equal(fixtureSigner.publicKey);
        expect(signer.address).to.equal(fixtureSigner.address);
        expect(signer.type).to.equal("ed25519");
    });

    it("generate same signer twice", async () => {
        const signer2 = await pkc.createSigner({ privateKey: signer.privateKey, type: signer.type });
        expect(signer.privateKey).to.equal(signer2.privateKey);
        expect(signer.publicKey).to.equal(signer2.publicKey);
        expect(signer.address).to.equal(signer2.address);
        expect(signer.type).to.equal(signer2.type);
    });
});

describe(`pkc.destroy`, async () => {
    it("Should succeed if we have a comment and a community already updating", async () => {
        const pkc = await mockPKCNoDataPathWithOnlyKuboClient();
        const community = await pkc.getCommunity({ address: fixtureSigner.address });
        const commentCid = community.posts.pages.hot.comments[0].cid;

        const comment = await pkc.createComment({ cid: commentCid });
        await comment.update();
        await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });
        expect(pkc._updatingComments[commentCid]).to.exist;

        await pkc.destroy(); // should not fail
        expect(pkc._updatingComments[commentCid]).to.not.exist;
        expect(pkc._updatingCommunities[comment.communityAddress]).to.not.exist;
        expect(comment.state).to.equal("stopped");
    });

    it(`pkc.destroy() should not fail if you stop reply and immedietly destroy pkc after`, async () => {
        const pkc = await mockPKCNoDataPathWithOnlyKuboClient();
        const community = await pkc.getCommunity({ address: fixtureSigner.address });
        const replyCid = community.posts.pages.hot.comments.find((post) => post.replies?.pages?.best?.comments?.length > 0).replies.pages
            .best.comments[0].cid;

        const reply = await pkc.createComment({ cid: replyCid });
        await reply.update();
        await resolveWhenConditionIsTrue({ toUpdate: reply, predicate: async () => typeof reply.updatedAt === "number" });
        expect(pkc._updatingComments[replyCid]).to.exist;

        await reply.stop();
        await pkc.destroy(); // should not fail
        expect(pkc._updatingComments[replyCid]).to.not.exist;
    });

    it(`after destroying pkc, nobody can use any function of pkc`, async () => {
        const pkc = await mockPKCNoDataPathWithOnlyKuboClient();
        await pkc.destroy();
        try {
            await pkc.fetchCid({ cid: "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f" });
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as PKCError).code).to.equal("ERR_PKC_IS_DESTROYED");
        }
    });

    it(`pkc.destroy() should not throw if _updatingCommunities contains a community with state "stopped"`, async () => {
        // Reproduces a race condition where a community is stored in _updatingCommunities
        // but hasn't transitioned to "updating" state yet (e.g. during fetchLatestSubOrSubscribeToEvent)
        const pkc = await mockPKCNoDataPathWithOnlyKuboClient();
        const sub = await pkc.createCommunity({ address: fixtureSigner.address });
        expect(sub.state).to.equal("stopped");
        // Simulate the race: sub is in the map but still in "stopped" state
        pkc._updatingCommunities[sub.address] = sub;
        await pkc.destroy(); // should not throw
        expect(sub.state).to.equal("stopped");
    });
});

describeIfRpc(`pkc.clients.pkcRpcClients`, async () => {
    it(`pkc.clients.pkcRpcClients.state`, async () => {
        const pkc = await mockRpcRemotePKC();
        const rpcClient = pkc.clients.pkcRpcClients[Object.keys(pkc.clients.pkcRpcClients)[0]];

        const rpcStates: string[] = [];

        rpcClient.on("statechange", (newState) => rpcStates.push(newState));

        if (rpcClient.state !== "connected")
            await new Promise<void>((resolve) => rpcClient.once("statechange", (newState) => newState === "connected" && resolve()));

        expect(rpcStates).to.deep.equal(["connected"]);

        await pkc.destroy();
    });
    it(`pkc.clients.pkcRpcClients.rpcCall`);
    it(`pkc.clients.pkcRpcClients.setSettings`, async () => {
        const pkc = await mockRpcRemotePKC();
        const rpcClient = pkc.clients.pkcRpcClients[Object.keys(pkc.clients.pkcRpcClients)[0]];
        const settingsPromise = new Promise((resolve) => rpcClient.once("settingschange", resolve));
        const allSettings: unknown[] = [];
        rpcClient.on("settingschange", (newSettings) => allSettings.push(newSettings));

        if (!rpcClient.settings) await settingsPromise;

        // change settings here, and await for a new settingschange to be emitted
        const newSettings = {
            ...rpcClient.settings,
            pkcOptions: { ...rpcClient.settings!.pkcOptions, userAgent: "test-agent" + Date.now() }
        };
        const editedSettingsPromise = new Promise((resolve) => rpcClient.once("settingschange", resolve));
        await rpcClient.setSettings(newSettings as unknown as Parameters<typeof rpcClient.setSettings>[0]);
        await editedSettingsPromise;
        expect(rpcClient.settings).to.deep.equal(newSettings);
        expect(allSettings[allSettings.length - 1]).to.deep.equal(newSettings);
        await pkc.destroy();
    });
    it(`pkc.clients.pkcRpcClients.settings is defined after awaiting settingschange`, async () => {
        const pkc = await mockRpcRemotePKC();
        const rpcClient = pkc.clients.pkcRpcClients[Object.keys(pkc.clients.pkcRpcClients)[0]];
        if (!rpcClient.settings) await new Promise((resolve) => rpcClient.once("settingschange", resolve));
        expect(rpcClient.settings.pkcOptions).to.be.a("object");
        expect(rpcClient.settings.challenges).to.be.a("object");
        await pkc.destroy();
    });
});

// Skip for firefox since we can't disable CORS on Firefox
if (!globalThis["navigator"]?.userAgent?.includes("Firefox"))
    describe("Authentication in kuboRpcClientsOptions and pubsubKuboRpcClientsOptions", async () => {
        it(`Authorization credentials are generated correctly`, async () => {
            // RPC exception
            const pkc = await PKC({
                kuboRpcClientsOptions: ["http://user:password@localhost:15001/api/v0"],
                pubsubKuboRpcClientsOptions: ["http://user:password@localhost:15002/api/v0"],
                httpRoutersOptions: [],
                dataPath: undefined
            });

            expect(Object.keys(pkc.clients.kuboRpcClients)).to.deep.equal(["http://localhost:15001/api/v0"]);
            expect(Object.keys(pkc.clients.pubsubKuboRpcClients)).to.deep.equal(["http://localhost:15002/api/v0"]);

            const expectedCred = "Basic dXNlcjpwYXNzd29yZA==";
            const ipfsCalcOptions = pkc.clients.kuboRpcClients["http://localhost:15001/api/v0"]._clientOptions;
            const pubsubCalcOptions = pkc.clients.pubsubKuboRpcClients["http://localhost:15002/api/v0"]._clientOptions;

            expect(ipfsCalcOptions.url).to.equal("http://localhost:15001/api/v0");
            expect(pubsubCalcOptions.url).to.equal("http://localhost:15002/api/v0");

            expect((ipfsCalcOptions.headers as Record<string, string>).authorization).to.equal(expectedCred);
            expect((pubsubCalcOptions.headers as Record<string, string>).authorization).to.equal(expectedCred);

            await pkc.destroy();
        });
    });
