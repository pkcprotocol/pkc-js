import { beforeAll, afterAll, describe, it } from "vitest";
import Plebbit from "../../../dist/node/index.js";
import signers from "../../fixtures/signers.js";
import {
    mockRemotePlebbit,
    itIfRpc,
    describeIfRpc,
    mockPlebbitNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    mockRpcRemotePlebbit
} from "../../../dist/node/test/test-util.js";
import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type { SignerType } from "../../../dist/node/signer/types.js";
import type { PlebbitError } from "../../../dist/node/plebbit-error.js";

const fixtureSigner = signers[0];

let defaultIpfsGatewayUrls: string[];

describe("Plebbit options", async () => {
    beforeAll(async () => {
        const plebbit = await Plebbit({ httpRoutersOptions: [] });
        defaultIpfsGatewayUrls = plebbit.ipfsGatewayUrls;
        plebbit.destroy().catch((err) => console.error("failed to destroy plebbit", err));
    });
    it("Plebbit() uses correct default plebbit options", async () => {
        const defaultPlebbit = await Plebbit({ httpRoutersOptions: [] });
        expect(Object.keys(defaultPlebbit.clients.ipfsGateways).sort()).to.deep.equal(defaultIpfsGatewayUrls.sort());
        expect(Object.keys(defaultPlebbit.clients.pubsubKuboRpcClients).sort()).to.deep.equal(
            ["https://pubsubprovider.xyz/api/v0", "https://plebpubsub.xyz/api/v0"].sort()
        );
        expect((defaultPlebbit.pubsubKuboRpcClientsOptions[0] as { headers?: { authorization?: string } })?.headers?.authorization).to.be
            .undefined;

        // no dataPath in browser
        if (typeof window === "undefined") {
            expect(defaultPlebbit.dataPath).to.match(/\.plebbit$/);
        } else {
            expect(defaultPlebbit.dataPath).to.equal(undefined);
        }
        JSON.stringify(defaultPlebbit); // Will throw an error if circular json
        await defaultPlebbit.destroy();
    });

    it("Plebbit Options is set up correctly when only kuboRpcClientsOptions is provided", async () => {
        // RPC exception
        const url = "http://localhost:15018/api/v0"; // offline API
        const options = { kuboRpcClientsOptions: [url], httpRoutersOptions: [] as string[], dataPath: undefined as undefined };
        const testPlebbit = await Plebbit(options);
        expect(testPlebbit.clients.kuboRpcClients[url]).to.exist;
        expect(testPlebbit.clients.pubsubKuboRpcClients[url]).to.exist;
        expect(Object.keys(testPlebbit.clients.ipfsGateways).sort()).to.deep.equal(defaultIpfsGatewayUrls.sort());
        expect(Object.keys(testPlebbit.clients.kuboRpcClients)).to.deep.equal([url]);

        expect(Object.keys(testPlebbit.clients.pubsubKuboRpcClients)).to.deep.equal([url]);
        JSON.stringify(testPlebbit); // Will throw an error if circular json
        await testPlebbit.destroy();
    });

    it(`Plebbit({kuboRpcClientsOptions}) uses specified node even if ipfs node is down`, async () => {
        // RPC exception
        const url = "http://localhost:12323/api/v0"; // Should be offline
        const plebbit = await Plebbit({ kuboRpcClientsOptions: [url], httpRoutersOptions: [] });

        expect(Object.keys(plebbit.clients.ipfsGateways).sort()).to.deep.equal(defaultIpfsGatewayUrls.sort());
        expect(Object.keys(plebbit.clients.pubsubKuboRpcClients)).to.deep.equal([url]);
        expect(Object.keys(plebbit.clients.kuboRpcClients)).to.deep.equal([url]);

        expect(plebbit.pubsubKuboRpcClientsOptions).to.deep.equal([{ url }]);
        expect(plebbit.kuboRpcClientsOptions).to.deep.equal([{ url }]);
        JSON.stringify(plebbit); // Will throw an error if circular json
        await plebbit.destroy();
    });

    itIfRpc(`Plebbit({plebbitRpcClientsOptions}) sets up correctly`, async () => {
        const rpcUrl = "ws://localhost:39652";
        const plebbit = await Plebbit({ plebbitRpcClientsOptions: [rpcUrl], httpRoutersOptions: [] });
        plebbit.on("error", () => {}); // so it doesn't throw when we destroy
        expect(plebbit.plebbitRpcClientsOptions).to.deep.equal([rpcUrl]);
        expect(Object.keys(plebbit.clients.plebbitRpcClients)).to.deep.equal([rpcUrl]);
        expect(plebbit.pubsubKuboRpcClientsOptions).to.be.undefined;
        expect(plebbit.nameResolvers).to.be.undefined;
        expect(plebbit.clients.kuboRpcClients).to.deep.equal({});
        expect(plebbit.clients.pubsubKuboRpcClients).to.deep.equal({});
        expect(plebbit.clients.libp2pJsClients).to.deep.equal({});
        expect(plebbit.clients.ipfsGateways).to.deep.equal({});
        JSON.stringify(plebbit); // Will throw an error if circular json
        await plebbit.destroy();
    });

    it(`Plebbit({dataPath: undefined}) sets plebbit.dataPath to undefined`, async () => {
        const plebbit = await Plebbit({ dataPath: undefined, httpRoutersOptions: [] });
        expect(plebbit.dataPath).to.be.undefined;
        await plebbit.destroy();
    });

    itIfRpc("Error is thrown if RPC is down", async () => {
        const plebbit = await mockRpcRemotePlebbit({ plebbitOptions: { plebbitRpcClientsOptions: ["ws://localhost:39650"] } }); // Already has RPC config
        // plebbit.subplebbits will take 20s to timeout and throw this error
        try {
            await plebbit.fetchCid({ cid: "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f" }); // random cid
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as PlebbitError).code).to.equal("ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC"); // Use the rpc so it would detect it's not loading
        }
        await plebbit.destroy();
    });

    it(`Plebbit({ipfsGateways: undefined}) uses default gateways`, async () => {
        const plebbit = await Plebbit({ ipfsGatewayUrls: undefined, httpRoutersOptions: [] });
        expect(Object.keys(plebbit.clients.ipfsGateways).sort()).to.deep.equal(defaultIpfsGatewayUrls.sort());
        expect(plebbit.ipfsGatewayUrls.sort()).to.deep.equal(defaultIpfsGatewayUrls.sort());
        JSON.stringify(plebbit); // Will throw an error if circular json
        await plebbit.destroy();
    });

    it(`Plebbit({ipfsGateways: []}) sets plebbit instance to not use gateways`, async () => {
        const plebbit = await Plebbit({ ipfsGatewayUrls: [], httpRoutersOptions: [] });
        expect(plebbit.clients.ipfsGateways).to.deep.equal({});
        expect(plebbit.ipfsGatewayUrls).to.be.undefined;
        JSON.stringify(plebbit); // Will throw an error if circular json
        await plebbit.destroy();
    });

    it(`Plebbit({pubsubKuboRpcClientsOptions: []}) sets plebbit instance to not use pubsub providers`, async () => {
        const plebbit = await Plebbit({ pubsubKuboRpcClientsOptions: [], httpRoutersOptions: [] });
        expect(Object.keys(plebbit.clients.pubsubKuboRpcClients)).to.deep.equal([]);
        expect(plebbit.pubsubKuboRpcClientsOptions).to.deep.equal([]);
        JSON.stringify(plebbit); // Will throw an error if circular json
        await plebbit.destroy();
    });

    it(`Plebbit({pubsubKuboRpcClientsOptions: undefined}) sets Plebbit instance to use default pubsub providers`, async () => {
        const plebbit = await Plebbit({ httpRoutersOptions: [] });
        const defaultPubsubKuboRpcClientsOptions = ["https://pubsubprovider.xyz/api/v0", "https://plebpubsub.xyz/api/v0"];
        expect(Object.keys(plebbit.clients.pubsubKuboRpcClients).sort()).to.deep.equal(defaultPubsubKuboRpcClientsOptions.sort());
        JSON.stringify(plebbit); // Will throw an error if circular json
        await plebbit.destroy();
    });

    it(`Plebbit({kuboRpcClientsOptions: []}) sets plebbit instance to not use kubo providers`, async () => {
        const plebbit = await Plebbit({ kuboRpcClientsOptions: [], httpRoutersOptions: [] });
        expect(plebbit.clients.kuboRpcClients).to.deep.equal({});
        expect(plebbit.kuboRpcClientsOptions).to.deep.equal([]);
        JSON.stringify(plebbit); // Will throw an error if circular json
        await plebbit.destroy();
    });

    it(`Plebbit({libp2pJsClientsOptions: [{key}], pubsubKuboRpcClientsOptions: []}) sets plebbit instance to use default libp2pjs options`, async () => {
        const plebbit = await Plebbit({
            libp2pJsClientsOptions: [{ key: "random" }],
            httpRoutersOptions: ["https://notexist.com"],
            dataPath: undefined,
            pubsubKuboRpcClientsOptions: []
        });
        expect(Object.keys(plebbit.clients.libp2pJsClients).sort()).to.deep.equal(["random"]);
        expect(Object.keys(plebbit.clients.plebbitRpcClients)).to.deep.equal([]);
        expect(plebbit.clients.kuboRpcClients).to.deep.equal({});
        expect(plebbit.clients.pubsubKuboRpcClients).to.deep.equal({});
        JSON.stringify(plebbit); // Will throw an error if circular json
        await plebbit.destroy();
    });

    it(`Plebbit({libp2pJsClientsOptions: [{key}]}) sets plebbit instance to use default libp2pjs options`, async () => {
        const plebbit = await Plebbit({
            libp2pJsClientsOptions: [{ key: "random" }],
            httpRoutersOptions: ["https://notexist.com"],
            dataPath: undefined
        });
        expect(Object.keys(plebbit.clients.libp2pJsClients).sort()).to.deep.equal(["random"]);
        expect(Object.keys(plebbit.clients.plebbitRpcClients)).to.deep.equal([]);
        expect(plebbit.clients.kuboRpcClients).to.deep.equal({});
        expect(plebbit.clients.pubsubKuboRpcClients).to.deep.equal({});
        JSON.stringify(plebbit); // Will throw an error if circular json
        await plebbit.destroy();
    });

    it(`Plebbit({nameResolvers: [...]}) sets plebbit.nameResolvers correctly`, async () => {
        const mockResolver = {
            key: "test-resolver",
            resolve: async (): Promise<{ publicKey: string; [key: string]: string } | undefined> => undefined,
            canResolve: (): boolean => true,
            provider: "test-provider"
        };
        const plebbit = await Plebbit({
            nameResolvers: [mockResolver],
            httpRoutersOptions: []
        });
        expect(plebbit.nameResolvers).to.have.lengthOf(1);
        expect(plebbit.nameResolvers![0].key).to.equal("test-resolver");
        await plebbit.destroy();
    });
});

describe("plebbit.createSigner", async () => {
    let plebbit: PlebbitType;
    let signer: SignerType;
    const isBase64 = (testString: string): boolean => /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}))?$/gm.test(testString);
    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
        signer = await plebbit.createSigner();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it("without private key argument", async () => {
        expect(signer).not.to.equal(undefined);
        expect(isBase64(signer.privateKey)).to.be.true;
        expect(isBase64(signer.publicKey)).to.be.true;
        expect(signer.address).to.match(/^12D3KooW/);
        expect(signer.type).to.equal("ed25519");
    });

    it("with private key argument", async () => {
        const signer = await plebbit.createSigner({ privateKey: fixtureSigner.privateKey, type: "ed25519" });
        expect(signer).not.to.equal(undefined);
        expect(signer.privateKey).to.equal(fixtureSigner.privateKey);
        expect(signer.publicKey).to.equal(fixtureSigner.publicKey);
        expect(signer.address).to.equal(fixtureSigner.address);
        expect(signer.type).to.equal("ed25519");
    });

    it("generate same signer twice", async () => {
        const signer2 = await plebbit.createSigner({ privateKey: signer.privateKey, type: signer.type });
        expect(signer.privateKey).to.equal(signer2.privateKey);
        expect(signer.publicKey).to.equal(signer2.publicKey);
        expect(signer.address).to.equal(signer2.address);
        expect(signer.type).to.equal(signer2.type);
    });
});

describe(`plebbit.destroy`, async () => {
    it("Should succeed if we have a comment and a subplebbit already updating", async () => {
        const plebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
        const subplebbit = await plebbit.getSubplebbit({ address: fixtureSigner.address });
        const commentCid = subplebbit.posts.pages.hot.comments[0].cid;

        const comment = await plebbit.createComment({ cid: commentCid });
        await comment.update();
        await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });
        expect(plebbit._updatingComments[commentCid]).to.exist;

        await plebbit.destroy(); // should not fail
        expect(plebbit._updatingComments[commentCid]).to.not.exist;
        expect(plebbit._updatingSubplebbits[comment.communityAddress]).to.not.exist;
        expect(comment.state).to.equal("stopped");
    });

    it(`plebbit.destroy() should not fail if you stop reply and immedietly destroy plebbit after`, async () => {
        const plebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
        const subplebbit = await plebbit.getSubplebbit({ address: fixtureSigner.address });
        const replyCid = subplebbit.posts.pages.hot.comments.find((post) => post.replies?.pages?.best?.comments?.length > 0).replies.pages
            .best.comments[0].cid;

        const reply = await plebbit.createComment({ cid: replyCid });
        await reply.update();
        await resolveWhenConditionIsTrue({ toUpdate: reply, predicate: async () => typeof reply.updatedAt === "number" });
        expect(plebbit._updatingComments[replyCid]).to.exist;

        await reply.stop();
        await plebbit.destroy(); // should not fail
        expect(plebbit._updatingComments[replyCid]).to.not.exist;
    });

    it(`after destroying plebbit, nobody can use any function of plebbit`, async () => {
        const plebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
        await plebbit.destroy();
        try {
            await plebbit.fetchCid({ cid: "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f" });
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as PlebbitError).code).to.equal("ERR_PLEBBIT_IS_DESTROYED");
        }
    });

    it(`plebbit.destroy() should not throw if _updatingSubplebbits contains a subplebbit with state "stopped"`, async () => {
        // Reproduces a race condition where a subplebbit is stored in _updatingSubplebbits
        // but hasn't transitioned to "updating" state yet (e.g. during fetchLatestSubOrSubscribeToEvent)
        const plebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
        const sub = await plebbit.createSubplebbit({ address: fixtureSigner.address });
        expect(sub.state).to.equal("stopped");
        // Simulate the race: sub is in the map but still in "stopped" state
        plebbit._updatingSubplebbits[sub.address] = sub;
        await plebbit.destroy(); // should not throw
        expect(sub.state).to.equal("stopped");
    });
});

describeIfRpc(`plebbit.clients.plebbitRpcClients`, async () => {
    it(`plebbit.clients.plebbitRpcClients.state`, async () => {
        const plebbit = await mockRpcRemotePlebbit();
        const rpcClient = plebbit.clients.plebbitRpcClients[Object.keys(plebbit.clients.plebbitRpcClients)[0]];

        const rpcStates: string[] = [];

        rpcClient.on("statechange", (newState) => rpcStates.push(newState));

        if (rpcClient.state !== "connected")
            await new Promise<void>((resolve) => rpcClient.once("statechange", (newState) => newState === "connected" && resolve()));

        expect(rpcStates).to.deep.equal(["connected"]);

        await plebbit.destroy();
    });
    it(`plebbit.clients.plebbitRpcClients.rpcCall`);
    it(`plebbit.clients.plebbitRpcClients.setSettings`, async () => {
        const plebbit = await mockRpcRemotePlebbit();
        const rpcClient = plebbit.clients.plebbitRpcClients[Object.keys(plebbit.clients.plebbitRpcClients)[0]];
        const settingsPromise = new Promise((resolve) => rpcClient.once("settingschange", resolve));
        const allSettings: unknown[] = [];
        rpcClient.on("settingschange", (newSettings) => allSettings.push(newSettings));

        if (!rpcClient.settings) await settingsPromise;

        // change settings here, and await for a new settingschange to be emitted
        const newSettings = {
            ...rpcClient.settings,
            plebbitOptions: { ...rpcClient.settings!.plebbitOptions, userAgent: "test-agent" + Date.now() }
        };
        const editedSettingsPromise = new Promise((resolve) => rpcClient.once("settingschange", resolve));
        await rpcClient.setSettings(newSettings as unknown as Parameters<typeof rpcClient.setSettings>[0]);
        await editedSettingsPromise;
        expect(rpcClient.settings).to.deep.equal(newSettings);
        expect(allSettings[allSettings.length - 1]).to.deep.equal(newSettings);
        await plebbit.destroy();
    });
    it(`plebbit.clients.plebbitRpcClients.settings is defined after awaiting settingschange`, async () => {
        const plebbit = await mockRpcRemotePlebbit();
        const rpcClient = plebbit.clients.plebbitRpcClients[Object.keys(plebbit.clients.plebbitRpcClients)[0]];
        if (!rpcClient.settings) await new Promise((resolve) => rpcClient.once("settingschange", resolve));
        expect(rpcClient.settings.plebbitOptions).to.be.a("object");
        expect(rpcClient.settings.challenges).to.be.a("object");
        await plebbit.destroy();
    });
});

// Skip for firefox since we can't disable CORS on Firefox
if (!globalThis["navigator"]?.userAgent?.includes("Firefox"))
    describe("Authentication in kuboRpcClientsOptions and pubsubKuboRpcClientsOptions", async () => {
        it(`Authorization credentials are generated correctly`, async () => {
            // RPC exception
            const plebbit = await Plebbit({
                kuboRpcClientsOptions: ["http://user:password@localhost:15001/api/v0"],
                pubsubKuboRpcClientsOptions: ["http://user:password@localhost:15002/api/v0"],
                httpRoutersOptions: [],
                dataPath: undefined
            });

            expect(Object.keys(plebbit.clients.kuboRpcClients)).to.deep.equal(["http://localhost:15001/api/v0"]);
            expect(Object.keys(plebbit.clients.pubsubKuboRpcClients)).to.deep.equal(["http://localhost:15002/api/v0"]);

            const expectedCred = "Basic dXNlcjpwYXNzd29yZA==";
            const ipfsCalcOptions = plebbit.clients.kuboRpcClients["http://localhost:15001/api/v0"]._clientOptions;
            const pubsubCalcOptions = plebbit.clients.pubsubKuboRpcClients["http://localhost:15002/api/v0"]._clientOptions;

            expect(ipfsCalcOptions.url).to.equal("http://localhost:15001/api/v0");
            expect(pubsubCalcOptions.url).to.equal("http://localhost:15002/api/v0");

            expect((ipfsCalcOptions.headers as Record<string, string>).authorization).to.equal(expectedCred);
            expect((pubsubCalcOptions.headers as Record<string, string>).authorization).to.equal(expectedCred);

            await plebbit.destroy();
        });
    });
