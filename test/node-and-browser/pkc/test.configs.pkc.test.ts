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

        if (isRpcFlagOn()) expectedCodes.push("remote-pkc-rpc");

        const actualCodes = configs.map((config) => config.testConfigCode).sort();
        expect(actualCodes).to.deep.equal(expectedCodes.sort());
    });

    configs.forEach((config) => {
        describe(`${config.name} (${config.testConfigCode})`, () => {
            let pkc: PKC;

            beforeAll(async () => {
                pkc = await config.pkcInstancePromise();
            });

            afterAll(async () => {
                await pkc.destroy();
            });

            it("creates a pkc instance with the expected client options", () => {
                switch (config.testConfigCode) {
                    case "local-kubo-rpc": {
                        expect(pkc.pkcRpcClientsOptions).to.be.undefined;
                        expect(pkc.kuboRpcClientsOptions).to.deep.equal([{ url: DEFAULT_LOCAL_KUBO_RPC_URL }]);
                        expect(pkc.pubsubKuboRpcClientsOptions).to.deep.equal([{ url: DEFAULT_LOCAL_KUBO_RPC_URL }]);
                        expect(pkc.ipfsGatewayUrls).to.deep.equal(DEFAULT_IPFS_GATEWAYS);
                        expect(pkc.libp2pJsClientsOptions).to.be.undefined;
                        expect(pkc.dataPath).to.be.a("string");
                        expect(pkc.dataPath).to.match(/\.plebbit$/);

                        expect(Object.keys(pkc.clients.pkcRpcClients)).to.deep.equal([]);
                        expect(Object.keys(pkc.clients.kuboRpcClients)).to.deep.equal([DEFAULT_LOCAL_KUBO_RPC_URL]);
                        expect(Object.keys(pkc.clients.pubsubKuboRpcClients)).to.have.members([DEFAULT_LOCAL_KUBO_RPC_URL]);
                        expect(Object.keys(pkc.clients.libp2pJsClients)).to.deep.equal([]);
                        expect(Object.keys(pkc.clients.ipfsGateways)).to.have.members(DEFAULT_IPFS_GATEWAYS);
                        break;
                    }
                    case "remote-kubo-rpc": {
                        expect(pkc.pkcRpcClientsOptions).to.be.undefined;
                        expect(pkc.kuboRpcClientsOptions).to.deep.equal([{ url: DEFAULT_LOCAL_KUBO_RPC_URL }]);
                        if (isRpcFlagOn()) {
                            expect(pkc.pubsubKuboRpcClientsOptions).to.deep.equal([{ url: DEFAULT_LOCAL_KUBO_RPC_URL }]);
                            expect(Object.keys(pkc.clients.pubsubKuboRpcClients)).to.deep.equal([DEFAULT_LOCAL_KUBO_RPC_URL]);
                        } else {
                            expect(pkc.pubsubKuboRpcClientsOptions).to.deep.equal(DEFAULT_LOCAL_PUBSUB_URLS.map((url) => ({ url })));
                            expect(Object.keys(pkc.clients.pubsubKuboRpcClients)).to.have.members(DEFAULT_LOCAL_PUBSUB_URLS);
                        }
                        expect(pkc.ipfsGatewayUrls).to.deep.equal(DEFAULT_IPFS_GATEWAYS);
                        expect(pkc.libp2pJsClientsOptions).to.be.undefined;
                        expect(pkc.dataPath).to.be.undefined;

                        expect(Object.keys(pkc.clients.pkcRpcClients)).to.deep.equal([]);
                        expect(Object.keys(pkc.clients.kuboRpcClients)).to.deep.equal([DEFAULT_LOCAL_KUBO_RPC_URL]);
                        if (!isRpcFlagOn())
                            expect(Object.keys(pkc.clients.pubsubKuboRpcClients)).to.have.members(DEFAULT_LOCAL_PUBSUB_URLS);
                        expect(Object.keys(pkc.clients.libp2pJsClients)).to.deep.equal([]);
                        expect(Object.keys(pkc.clients.ipfsGateways)).to.have.members(DEFAULT_IPFS_GATEWAYS);
                        break;
                    }
                    case "remote-libp2pjs": {
                        expect(pkc.pkcRpcClientsOptions).to.be.undefined;
                        expect(pkc.kuboRpcClientsOptions).to.deep.equal([]);
                        expect(pkc.pubsubKuboRpcClientsOptions).to.deep.equal([]);
                        expect(pkc.ipfsGatewayUrls).to.deep.equal(DEFAULT_IPFS_GATEWAYS);
                        expect(pkc.dataPath).to.be.undefined;

                        expect(pkc.libp2pJsClientsOptions).to.have.lengthOf(1);
                        expect(pkc.libp2pJsClientsOptions[0].key.startsWith(HELIA_KEY_PREFIX)).to.be.true;

                        const libp2pClientKeys = Object.keys(pkc.clients.libp2pJsClients);
                        expect(libp2pClientKeys).to.have.lengthOf(1);
                        expect(libp2pClientKeys[0].startsWith(HELIA_KEY_PREFIX)).to.be.true;

                        expect(Object.keys(pkc.clients.pkcRpcClients)).to.deep.equal([]);
                        expect(Object.keys(pkc.clients.kuboRpcClients)).to.deep.equal([]);
                        expect(Object.keys(pkc.clients.pubsubKuboRpcClients)).to.deep.equal([]);
                        expect(Object.keys(pkc.clients.ipfsGateways)).to.have.members(DEFAULT_IPFS_GATEWAYS);
                        break;
                    }
                    case "remote-ipfs-gateway": {
                        expect(pkc.pkcRpcClientsOptions).to.be.undefined;
                        expect(pkc.kuboRpcClientsOptions).to.be.undefined;
                        expect(pkc.pubsubKuboRpcClientsOptions).to.deep.equal(DEFAULT_REMOTE_PUBSUB_URLS.map((url) => ({ url })));
                        expect(pkc.ipfsGatewayUrls).to.deep.equal(["http://localhost:18080"]);
                        expect(pkc.libp2pJsClientsOptions).to.be.undefined;
                        expect(pkc.dataPath).to.be.undefined;

                        expect(Object.keys(pkc.clients.pkcRpcClients)).to.deep.equal([]);
                        expect(Object.keys(pkc.clients.kuboRpcClients)).to.deep.equal([]);
                        expect(Object.keys(pkc.clients.pubsubKuboRpcClients)).to.have.members(DEFAULT_REMOTE_PUBSUB_URLS);
                        expect(Object.keys(pkc.clients.libp2pJsClients)).to.deep.equal([]);
                        expect(Object.keys(pkc.clients.ipfsGateways)).to.deep.equal(["http://localhost:18080"]);
                        break;
                    }
                    case "remote-pkc-rpc": {
                        expect(isRpcFlagOn()).to.be.true;
                        expect(pkc.pkcRpcClientsOptions).to.deep.equal(["ws://localhost:39653"]);
                        expect(pkc.kuboRpcClientsOptions).to.be.undefined;
                        expect(pkc.pubsubKuboRpcClientsOptions).to.be.undefined;
                        expect(pkc.ipfsGatewayUrls).to.be.undefined;
                        expect(pkc.libp2pJsClientsOptions).to.be.undefined;
                        expect(pkc.dataPath).to.be.undefined;

                        expect(Object.keys(pkc.clients.pkcRpcClients)).to.deep.equal(["ws://localhost:39653"]);
                        expect(Object.keys(pkc.clients.kuboRpcClients)).to.deep.equal([]);
                        expect(Object.keys(pkc.clients.pubsubKuboRpcClients)).to.deep.equal([]);
                        expect(Object.keys(pkc.clients.libp2pJsClients)).to.deep.equal([]);
                        expect(Object.keys(pkc.clients.ipfsGateways)).to.deep.equal([]);
                        break;
                    }
                    default: {
                        expect.fail(`Unhandled config code ${config.testConfigCode}`);
                    }
                }
            });

            if (config.testConfigCode === "local-kubo-rpc") {
                itIfRpc("keeps kubo clients configured when USE_RPC flag is on", () => {
                    expect(pkc.kuboRpcClientsOptions).to.deep.equal([{ url: DEFAULT_LOCAL_KUBO_RPC_URL }]);
                    expect(pkc.pubsubKuboRpcClientsOptions).to.deep.equal([{ url: DEFAULT_LOCAL_KUBO_RPC_URL }]);
                    expect(pkc.ipfsGatewayUrls).to.deep.equal(DEFAULT_IPFS_GATEWAYS);

                    expect(Object.keys(pkc.clients.kuboRpcClients)).to.deep.equal([DEFAULT_LOCAL_KUBO_RPC_URL]);
                    expect(Object.keys(pkc.clients.pubsubKuboRpcClients)).to.have.members([DEFAULT_LOCAL_KUBO_RPC_URL]);
                });
            }
        });
    });
});
