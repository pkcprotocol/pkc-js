import { describe, it, beforeAll, afterAll, expect } from "vitest";
import path from "path";
import net from "node:net";
import PKC from "../../../dist/node/index.js";
import PKCWsServer from "../../../dist/node/rpc/src/index.js";
import {
    mockRpcServerPKC,
    mockRpcServerForTests,
    resolveWhenConditionIsTrue,
    createMockNameResolver
} from "../../../dist/node/test/test-util.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { InputPKCOptions } from "../../../dist/node/types.js";

type PKCWsServerType = Awaited<ReturnType<typeof PKCWsServer.PKCWsServer>>;

const RPC_AUTH_KEY = "test-settings-nameresolvers";

const getAvailablePort = async (startPort = 39760): Promise<number> => {
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

describe("plebbit.settings.nameResolvers over RPC", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let RPC_URL: string;

    beforeAll(async () => {
        // Create server plebbit with two distinct mock nameResolvers
        serverPKC = await mockRpcServerPKC({
            dataPath: path.join(process.cwd(), ".plebbit-rpc-settings-nameresolvers-test"),
            nameResolvers: [
                createMockNameResolver({ key: "test-resolver-a", provider: "provider-a" }),
                createMockNameResolver({ key: "test-resolver-b", provider: "provider-b" })
            ]
        });

        const rpcPort = await getAvailablePort();
        RPC_URL = `ws://localhost:${rpcPort}`;

        rpcServer = await PKCWsServer.PKCWsServer({
            port: rpcPort,
            authKey: RPC_AUTH_KEY,
            plebbitOptions: {
                kuboRpcClientsOptions: ["http://localhost:15001/api/v0"],
                httpRoutersOptions: [],
                dataPath: serverPKC.dataPath
            }
        });

        const server = rpcServer as unknown as Record<string, Function>;
        server._initPKC(serverPKC);
        server._createPKCInstanceFromSetSettings = async (newOptions: InputPKCOptions) => {
            return mockRpcServerPKC({
                dataPath: path.join(process.cwd(), ".plebbit-rpc-settings-nameresolvers-test"),
                ...newOptions
            });
        };
        mockRpcServerForTests(rpcServer);
    });

    afterAll(async () => {
        if (rpcServer) await rpcServer.destroy();
    });

    it(`RPC client receives serialized nameResolver properties from server via settingschange`, async () => {
        const clientPKC = await PKC({
            pkcRpcClientsOptions: [RPC_URL],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        clientPKC.on("error", () => {});

        const rpcClient = clientPKC.clients.plebbitRpcClients[RPC_URL];

        await resolveWhenConditionIsTrue({
            toUpdate: rpcClient,
            predicate: async () => Boolean(rpcClient.settings?.plebbitOptions?.nameResolvers),
            eventName: "settingschange"
        });

        const nameResolvers = rpcClient.settings!.plebbitOptions.nameResolvers!;
        expect(nameResolvers).to.be.an("array");
        expect(nameResolvers).to.have.lengthOf(2);

        // Verify serialized properties are present
        expect(nameResolvers[0].key).to.equal("test-resolver-a");
        expect(nameResolvers[0].provider).to.equal("provider-a");
        expect(nameResolvers[1].key).to.equal("test-resolver-b");
        expect(nameResolvers[1].provider).to.equal("provider-b");

        // Functions should NOT survive JSON serialization (they're non-enumerable on the server)
        for (const resolver of nameResolvers) {
            expect(resolver).to.not.have.property("resolve");
            expect(resolver).to.not.have.property("canResolve");
        }

        await clientPKC.destroy();
    });

    it(`RPC client cannot change nameResolvers on the server via setSettings`, async () => {
        const clientPKC = await PKC({
            pkcRpcClientsOptions: [RPC_URL],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        clientPKC.on("error", () => {});

        const rpcClient = clientPKC.clients.plebbitRpcClients[RPC_URL];

        // Wait for initial settings
        await resolveWhenConditionIsTrue({
            toUpdate: rpcClient,
            predicate: async () => Boolean(rpcClient.settings?.plebbitOptions?.nameResolvers),
            eventName: "settingschange"
        });

        // Attempt to change nameResolvers via setSettings
        // Also change userAgent to avoid the server short-circuiting due to identical serialized options
        const settingschangePromise = new Promise<void>((resolve) => rpcClient.once("settingschange", () => resolve()));
        const currentOptions = rpcClient.settings!.plebbitOptions;
        await rpcClient.setSettings({
            plebbitOptions: {
                resolveAuthorNames: currentOptions.resolveAuthorNames,
                validatePages: currentOptions.validatePages,
                publishInterval: currentOptions.publishInterval,
                updateInterval: currentOptions.updateInterval,
                noData: currentOptions.noData,
                httpRoutersOptions: currentOptions.httpRoutersOptions,
                userAgent: "test-agent-" + Date.now(),
                nameResolvers: [{ key: "attacker-resolver", provider: "evil" }]
            }
        });
        await settingschangePromise;

        // Server should have ignored the client's nameResolvers and kept its own
        const nameResolvers = rpcClient.settings!.plebbitOptions.nameResolvers!;
        expect(nameResolvers).to.have.lengthOf(2);
        expect(nameResolvers[0].key).to.equal("test-resolver-a");
        expect(nameResolvers[0].provider).to.equal("provider-a");
        expect(nameResolvers[1].key).to.equal("test-resolver-b");
        expect(nameResolvers[1].provider).to.equal("provider-b");

        await clientPKC.destroy();
    });

    it(`plebbit.nameResolvers is undefined for RPC client plebbit instances`, async () => {
        const clientPKC = await PKC({
            pkcRpcClientsOptions: [RPC_URL],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        clientPKC.on("error", () => {});

        // nameResolvers can't be used on the client side — only server resolves names
        expect(clientPKC.nameResolvers).to.be.undefined;

        await clientPKC.destroy();
    });
});
