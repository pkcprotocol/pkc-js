import { describe, beforeAll, afterAll, expect } from "vitest";
import path from "path";
import net from "node:net";
import Plebbit from "../../../dist/node/index.js";
import PlebbitWsServer from "../../../dist/node/rpc/src/index.js";
import {
    createMockedSubplebbitIpns,
    createMockNameResolver,
    itIfRpc,
    mockRpcServerForTests,
    mockRpcServerPlebbit
} from "../../../dist/node/test/test-util.js";
import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type { InputPlebbitOptions } from "../../../dist/node/types.js";

type PlebbitWsServerType = Awaited<ReturnType<typeof PlebbitWsServer.PlebbitWsServer>>;

const RPC_AUTH_KEY = "test-getsubplebbit-publickey-fallback";

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

describe("plebbit.getSubplebbit publicKey fallback over RPC", () => {
    let rpcServer: PlebbitWsServerType;
    let serverPlebbit: PlebbitType;
    let rpcUrl: string;
    let dataPath: string;

    beforeAll(async () => {
        dataPath = path.join(
            process.cwd(),
            `.plebbit-rpc-getsubplebbit-publickey-fallback-test-${Date.now()}-${Math.floor(Math.random() * 100000)}`
        );
        serverPlebbit = await mockRpcServerPlebbit({
            dataPath,
            nameResolvers: createResolverLimitedNameResolvers()
        });

        const rpcPort = await getAvailablePort();
        rpcUrl = `ws://localhost:${rpcPort}`;

        rpcServer = await PlebbitWsServer.PlebbitWsServer({
            port: rpcPort,
            authKey: RPC_AUTH_KEY,
            plebbitOptions: {
                kuboRpcClientsOptions: ["http://localhost:15001/api/v0"],
                httpRoutersOptions: [],
                dataPath: serverPlebbit.dataPath
            }
        });

        const server = rpcServer as unknown as Record<string, Function>;
        server._initPlebbit(serverPlebbit);
        server._createPlebbitInstanceFromSetSettings = async (newOptions: InputPlebbitOptions) =>
            mockRpcServerPlebbit({
                dataPath,
                ...newOptions,
                nameResolvers: createResolverLimitedNameResolvers()
            });
        mockRpcServerForTests(rpcServer);
    });

    afterAll(async () => {
        if (rpcServer) await rpcServer.destroy();
        if (serverPlebbit && !serverPlebbit.destroyed) await serverPlebbit.destroy();
    });

    itIfRpc(`getSubplebbit({ name, publicKey }) loads via publicKey when .sol cannot be resolved`, async () => {
        const clientPlebbit = await Plebbit({
            plebbitRpcClientsOptions: [rpcUrl],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        clientPlebbit.on("error", () => {});

        try {
            const { communityAddress: subplebbitAddress } = await createMockedSubplebbitIpns({});
            const sub = await clientPlebbit.getSubplebbit({ name: "test.sol", publicKey: subplebbitAddress });

            expect(sub.address).to.equal("test.sol");
            expect(sub.publicKey).to.equal(subplebbitAddress);
            expect(sub.updatedAt).to.be.a("number");
            expect(sub.nameResolved).to.equal(false);
            expect(sub.state).to.equal("stopped");
        } finally {
            await clientPlebbit.destroy();
        }
    });

    itIfRpc(`getSubplebbit({}) fails validation`, async () => {
        const clientPlebbit = await Plebbit({
            plebbitRpcClientsOptions: [rpcUrl],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        clientPlebbit.on("error", () => {});

        try {
            await expect(clientPlebbit.getSubplebbit({})).rejects.toThrow("At least one of address, name, or publicKey must be provided");
        } finally {
            await clientPlebbit.destroy();
        }
    });
});
