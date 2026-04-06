import { describe, it, beforeAll, afterAll } from "vitest";
import { getAvailablePKCConfigsToTestAgainst, isRpcFlagOn, isRunningInBrowser, itIfRpc } from "../../../dist/node/test/test-util.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";

const DEFAULT_IPFS_GATEWAYS = ["https://ipfsgateway.xyz", "https://gateway.plebpubsub.xyz", "https://gateway.forumindex.com"];
const DEFAULT_LOCAL_KUBO_RPC_URL = "http://localhost:15001/api/v0";
const DEFAULT_LOCAL_PUBSUB_URLS = ["http://localhost:15002/api/v0", "http://localhost:42234/api/v0", "http://localhost:42254/api/v0"];
const DEFAULT_REMOTE_PUBSUB_URLS = ["https://pubsubprovider.xyz/api/v0", "https://plebpubsub.xyz/api/v0"];
const HELIA_KEY_PREFIX = "Helia config default for testing(remote)";

const configs = getAvailablePKCConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true });

describe.concurrent("getAvailablePKCConfigsToTestAgainst", () => {
    it("returns the expected config codes for the current runtime", () => {
        // NOTE: "remote-libp2pjs" is temporarily disabled due to stability issues
        const expectedCodes = isRunningInBrowser()
            ? ["remote-kubo-rpc", "remote-ipfs-gateway"]
            : ["local-kubo-rpc", "remote-kubo-rpc", "remote-ipfs-gateway"];

        if (isRpcFlagOn()) expectedCodes.push("remote-plebbit-rpc");

        const actualCodes = configs.map((config) => config.testConfigCode).sort();
        expect(actualCodes).to.deep.equal(expectedCodes.sort());
    });

    configs.forEach((config) => {
        describe(`${config.name} (${config.testConfigCode})`, () => {
            let plebbit: PKC;

            beforeAll(async () => {
                plebbit = await config.plebbitInstancePromise();
            });

            afterAll(async () => {
                await plebbit.destroy();
            });

            it("creates a plebbit instance with the expected client options", () => {
                switch (config.testConfigCode) {
                    case "local-kubo-rpc": {
                        expect(plebbit.pkcRpcClientsOptions).to.be.undefined;
                        expect(plebbit.kuboRpcClientsOptions).to.deep.equal([{ url: DEFAULT_LOCAL_KUBO_RPC_URL }]);
                        expect(plebbit.pubsubKuboRpcClientsOptions).to.deep.equal([{ url: DEFAULT_LOCAL_KUBO_RPC_URL }]);
                        expect(plebbit.ipfsGatewayUrls).to.deep.equal(DEFAULT_IPFS_GATEWAYS);
                        expect(plebbit.libp2pJsClientsOptions).to.be.undefined;
                        expect(plebbit.dataPath).to.be.a("string");
                        expect(plebbit.dataPath).to.match(/\.plebbit$/);

                        expect(Object.keys(plebbit.clients.plebbitRpcClients)).to.deep.equal([]);
                        expect(Object.keys(plebbit.clients.kuboRpcClients)).to.deep.equal([DEFAULT_LOCAL_KUBO_RPC_URL]);
                        expect(Object.keys(plebbit.clients.pubsubKuboRpcClients)).to.have.members([DEFAULT_LOCAL_KUBO_RPC_URL]);
                        expect(Object.keys(plebbit.clients.libp2pJsClients)).to.deep.equal([]);
                        expect(Object.keys(plebbit.clients.ipfsGateways)).to.have.members(DEFAULT_IPFS_GATEWAYS);
                        break;
                    }
                    case "remote-kubo-rpc": {
                        expect(plebbit.pkcRpcClientsOptions).to.be.undefined;
                        expect(plebbit.kuboRpcClientsOptions).to.deep.equal([{ url: DEFAULT_LOCAL_KUBO_RPC_URL }]);
                        if (isRpcFlagOn()) {
                            expect(plebbit.pubsubKuboRpcClientsOptions).to.deep.equal([{ url: DEFAULT_LOCAL_KUBO_RPC_URL }]);
                            expect(Object.keys(plebbit.clients.pubsubKuboRpcClients)).to.deep.equal([DEFAULT_LOCAL_KUBO_RPC_URL]);
                        } else {
                            expect(plebbit.pubsubKuboRpcClientsOptions).to.deep.equal(DEFAULT_LOCAL_PUBSUB_URLS.map((url) => ({ url })));
                            expect(Object.keys(plebbit.clients.pubsubKuboRpcClients)).to.have.members(DEFAULT_LOCAL_PUBSUB_URLS);
                        }
                        expect(plebbit.ipfsGatewayUrls).to.deep.equal(DEFAULT_IPFS_GATEWAYS);
                        expect(plebbit.libp2pJsClientsOptions).to.be.undefined;
                        expect(plebbit.dataPath).to.be.undefined;

                        expect(Object.keys(plebbit.clients.plebbitRpcClients)).to.deep.equal([]);
                        expect(Object.keys(plebbit.clients.kuboRpcClients)).to.deep.equal([DEFAULT_LOCAL_KUBO_RPC_URL]);
                        if (!isRpcFlagOn())
                            expect(Object.keys(plebbit.clients.pubsubKuboRpcClients)).to.have.members(DEFAULT_LOCAL_PUBSUB_URLS);
                        expect(Object.keys(plebbit.clients.libp2pJsClients)).to.deep.equal([]);
                        expect(Object.keys(plebbit.clients.ipfsGateways)).to.have.members(DEFAULT_IPFS_GATEWAYS);
                        break;
                    }
                    case "remote-libp2pjs": {
                        expect(plebbit.pkcRpcClientsOptions).to.be.undefined;
                        expect(plebbit.kuboRpcClientsOptions).to.deep.equal([]);
                        expect(plebbit.pubsubKuboRpcClientsOptions).to.deep.equal([]);
                        expect(plebbit.ipfsGatewayUrls).to.deep.equal(DEFAULT_IPFS_GATEWAYS);
                        expect(plebbit.dataPath).to.be.undefined;

                        expect(plebbit.libp2pJsClientsOptions).to.have.lengthOf(1);
                        expect(plebbit.libp2pJsClientsOptions[0].key.startsWith(HELIA_KEY_PREFIX)).to.be.true;

                        const libp2pClientKeys = Object.keys(plebbit.clients.libp2pJsClients);
                        expect(libp2pClientKeys).to.have.lengthOf(1);
                        expect(libp2pClientKeys[0].startsWith(HELIA_KEY_PREFIX)).to.be.true;

                        expect(Object.keys(plebbit.clients.plebbitRpcClients)).to.deep.equal([]);
                        expect(Object.keys(plebbit.clients.kuboRpcClients)).to.deep.equal([]);
                        expect(Object.keys(plebbit.clients.pubsubKuboRpcClients)).to.deep.equal([]);
                        expect(Object.keys(plebbit.clients.ipfsGateways)).to.have.members(DEFAULT_IPFS_GATEWAYS);
                        break;
                    }
                    case "remote-ipfs-gateway": {
                        expect(plebbit.pkcRpcClientsOptions).to.be.undefined;
                        expect(plebbit.kuboRpcClientsOptions).to.be.undefined;
                        expect(plebbit.pubsubKuboRpcClientsOptions).to.deep.equal(DEFAULT_REMOTE_PUBSUB_URLS.map((url) => ({ url })));
                        expect(plebbit.ipfsGatewayUrls).to.deep.equal(["http://localhost:18080"]);
                        expect(plebbit.libp2pJsClientsOptions).to.be.undefined;
                        expect(plebbit.dataPath).to.be.undefined;

                        expect(Object.keys(plebbit.clients.plebbitRpcClients)).to.deep.equal([]);
                        expect(Object.keys(plebbit.clients.kuboRpcClients)).to.deep.equal([]);
                        expect(Object.keys(plebbit.clients.pubsubKuboRpcClients)).to.have.members(DEFAULT_REMOTE_PUBSUB_URLS);
                        expect(Object.keys(plebbit.clients.libp2pJsClients)).to.deep.equal([]);
                        expect(Object.keys(plebbit.clients.ipfsGateways)).to.deep.equal(["http://localhost:18080"]);
                        break;
                    }
                    case "remote-plebbit-rpc": {
                        expect(isRpcFlagOn()).to.be.true;
                        expect(plebbit.pkcRpcClientsOptions).to.deep.equal(["ws://localhost:39653"]);
                        expect(plebbit.kuboRpcClientsOptions).to.be.undefined;
                        expect(plebbit.pubsubKuboRpcClientsOptions).to.be.undefined;
                        expect(plebbit.ipfsGatewayUrls).to.be.undefined;
                        expect(plebbit.libp2pJsClientsOptions).to.be.undefined;
                        expect(plebbit.dataPath).to.be.undefined;

                        expect(Object.keys(plebbit.clients.plebbitRpcClients)).to.deep.equal(["ws://localhost:39653"]);
                        expect(Object.keys(plebbit.clients.kuboRpcClients)).to.deep.equal([]);
                        expect(Object.keys(plebbit.clients.pubsubKuboRpcClients)).to.deep.equal([]);
                        expect(Object.keys(plebbit.clients.libp2pJsClients)).to.deep.equal([]);
                        expect(Object.keys(plebbit.clients.ipfsGateways)).to.deep.equal([]);
                        break;
                    }
                    default: {
                        expect.fail(`Unhandled config code ${config.testConfigCode}`);
                    }
                }
            });

            if (config.testConfigCode === "local-kubo-rpc") {
                itIfRpc("keeps kubo clients configured when USE_RPC flag is on", () => {
                    expect(plebbit.kuboRpcClientsOptions).to.deep.equal([{ url: DEFAULT_LOCAL_KUBO_RPC_URL }]);
                    expect(plebbit.pubsubKuboRpcClientsOptions).to.deep.equal([{ url: DEFAULT_LOCAL_KUBO_RPC_URL }]);
                    expect(plebbit.ipfsGatewayUrls).to.deep.equal(DEFAULT_IPFS_GATEWAYS);

                    expect(Object.keys(plebbit.clients.kuboRpcClients)).to.deep.equal([DEFAULT_LOCAL_KUBO_RPC_URL]);
                    expect(Object.keys(plebbit.clients.pubsubKuboRpcClients)).to.have.members([DEFAULT_LOCAL_KUBO_RPC_URL]);
                });
            }
        });
    });
});
