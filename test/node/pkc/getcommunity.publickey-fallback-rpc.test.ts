import { describe, beforeAll, afterAll, expect } from "vitest";
import path from "path";
import net from "node:net";
import PKC from "../../../dist/node/index.js";
import PKCWsServer from "../../../dist/node/rpc/src/index.js";
import {
    createMockedCommunityIpns,
    createMockNameResolver,
    itIfRpc,
    mockRpcServerForTests,
    mockRpcServerPKC
} from "../../../dist/node/test/test-util.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { InputPKCOptions } from "../../../dist/node/types.js";

type PKCWsServerType = Awaited<ReturnType<typeof PKCWsServer.PKCWsServer>>;

const RPC_AUTH_KEY = "test-getcommunity-publickey-fallback";

const getAvailablePort = async (): Promise<number> =>
    new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on("error", reject);
        server.listen(0, () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                server.close(() => reject(new Error("Failed to allocate a TCP port for the RPC test server")));
                return;
            }
            server.close(() => resolve(address.port));
        });
    });

const createResolverLimitedNameResolvers = () => [
    createMockNameResolver({
        canResolve: ({ name }: { name: string }) => name.endsWith(".eth") || name.endsWith(".bso")
    })
];

describe("pkc.getCommunity publicKey fallback over RPC", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let rpcUrl: string;
    let dataPath: string;

    beforeAll(async () => {
        dataPath = path.join(
            process.cwd(),
            `.pkc-rpc-getcommunity-publickey-fallback-test-${Date.now()}-${Math.floor(Math.random() * 100000)}`
        );
        serverPKC = await mockRpcServerPKC({
            dataPath,
            nameResolvers: createResolverLimitedNameResolvers()
        });

        const rpcPort = await getAvailablePort();
        rpcUrl = `ws://localhost:${rpcPort}`;

        rpcServer = await PKCWsServer.PKCWsServer({
            port: rpcPort,
            authKey: RPC_AUTH_KEY,
            pkcOptions: {
                kuboRpcClientsOptions: ["http://localhost:15001/api/v0"],
                httpRoutersOptions: [],
                dataPath: serverPKC.dataPath
            }
        });

        const server = rpcServer as unknown as Record<string, Function>;
        server._initPKC(serverPKC);
        server._createPKCInstanceFromSetSettings = async (newOptions: InputPKCOptions) =>
            mockRpcServerPKC({
                dataPath,
                ...newOptions,
                nameResolvers: createResolverLimitedNameResolvers()
            });
        mockRpcServerForTests(rpcServer);
    });

    afterAll(async () => {
        if (rpcServer) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
    });

    itIfRpc(`getCommunity({ name, publicKey }) loads via publicKey when .sol cannot be resolved`, async () => {
        const clientPKC = await PKC({
            pkcRpcClientsOptions: [rpcUrl],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        clientPKC.on("error", () => {});

        try {
            const { communityAddress: communityAddress } = await createMockedCommunityIpns({});
            const sub = await clientPKC.getCommunity({ name: "test.sol", publicKey: communityAddress });

            expect(sub.address).to.equal("test.sol");
            expect(sub.publicKey).to.equal(communityAddress);
            expect(sub.updatedAt).to.be.a("number");
            expect(sub.nameResolved).to.equal(false);
            expect(sub.state).to.equal("stopped");
        } finally {
            await clientPKC.destroy();
        }
    });

    itIfRpc(`getCommunity({}) fails validation`, async () => {
        const clientPKC = await PKC({
            pkcRpcClientsOptions: [rpcUrl],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        clientPKC.on("error", () => {});

        try {
            await expect(clientPKC.getCommunity({})).rejects.toThrow("At least one of address, name, or publicKey must be provided");
        } finally {
            await clientPKC.destroy();
        }
    });
});
