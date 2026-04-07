import { beforeAll, afterAll, describe, it } from "vitest";
import PKCWsServer from "../../../../dist/node/rpc/src/index.js";
import { describeSkipIfRpc, mockPKC } from "../../../../dist/node/test/test-util.js";
import tempy from "tempy";

import os from "os";
import PKC from "../../../../dist/node/index.js";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { CreatePKCWsServerOptions } from "../../../../dist/node/rpc/src/types.js";
import { PKCError } from "../../../../dist/node/pkc-error.js";

type PKCWsServerType = Awaited<ReturnType<typeof PKCWsServer.PKCWsServer>>;

// Standalone interface for accessing private members via unknown casting
// Using a separate interface avoids TypeScript's intersection-with-private-members issue
interface PKCWsServerPrivateAccess {
    _getIpFromConnectionRequest: () => string;
}

const getLanIpV4Address = (): string | undefined => {
    const allInterfaces = os.networkInterfaces();
    for (const k in allInterfaces) {
        const specificInterfaceInfos = allInterfaces[k];
        if (!specificInterfaceInfos) continue;

        const lanAddress = specificInterfaceInfos.filter((info) => info.family === "IPv4" && !info.internal)[0]?.address;
        if (lanAddress) return lanAddress;
    }
    return undefined;
};

describeSkipIfRpc(`Setting up rpc server`, async () => {
    let pkc: PKCType;

    const lanAddress = getLanIpV4Address(); // LAN address (non-internal)
    beforeAll(async () => {
        pkc = await mockPKC();
        expect(pkc.dataPath).to.be.a("string");
        expect(lanAddress).to.be.a("string");
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`Rpc server emits an error is rpc port is already taken`, async () => {
        const rpcServerPort = 19138;
        const options: CreatePKCWsServerOptions = {
            port: rpcServerPort,
            pkcOptions: {
                kuboRpcClientsOptions: pkc.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                httpRoutersOptions: pkc.httpRoutersOptions,
                dataPath: pkc.dataPath
            }
        };
        const rpcServer = await PKCWsServer.PKCWsServer(options); // was able to create an rpc server

        const rpcServer2 = await PKCWsServer.PKCWsServer(options);
        const e = await new Promise<NodeJS.ErrnoException>((resolve) => rpcServer2.once("error", resolve));

        expect(e.code).to.equal("EADDRINUSE");

        await rpcServer.destroy();
        await rpcServer2.destroy();
    });

    it(`Can connect to rpc server locally with ws://localhost:port`, async () => {
        const rpcServerPort = 9139;
        const authKey = "dwadwa";
        const options: CreatePKCWsServerOptions = {
            port: rpcServerPort,
            authKey,
            pkcOptions: {
                kuboRpcClientsOptions: pkc.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                httpRoutersOptions: pkc.httpRoutersOptions,
                dataPath: pkc.dataPath
            }
        };
        const rpcServer = await PKCWsServer.PKCWsServer(options); // was able to create an rpc server

        const rpcUrl = `ws://localhost:${rpcServerPort}`;
        const clientPKC = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

        const community = (await clientPKC.createCommunity({})) as RpcLocalCommunity;
        expect(community.address).to.exist; // should be able to create a community successfully over RPC
        expect(clientPKC.communities).to.include(community.address);

        await clientPKC.destroy();
        await rpcServer.destroy();
    });

    it(`Can connect to rpc server locally with ws://127.0.0.1:port`, async () => {
        const rpcServerPort = 9139;
        const authKey = "dwadwa";
        const options: CreatePKCWsServerOptions = {
            port: rpcServerPort,
            authKey,
            pkcOptions: {
                kuboRpcClientsOptions: pkc.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                httpRoutersOptions: pkc.httpRoutersOptions,
                dataPath: pkc.dataPath
            }
        };
        const rpcServer = await PKCWsServer.PKCWsServer(options); // was able to create an rpc server

        const rpcUrl = `ws://127.0.0.1:${rpcServerPort}`;
        const clientPKC = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

        const community = (await clientPKC.createCommunity({})) as RpcLocalCommunity;
        expect(community.address).to.exist; // should be able to create a community successfully over RPC
        expect(clientPKC.communities).to.include(community.address);

        await clientPKC.destroy();
        await rpcServer.destroy();
    });

    it(`Can connect to rpc server locally with ws://localhost:port/authkey`, async () => {
        const rpcServerPort = 9139;
        const authKey = "dwadwa";
        const options: CreatePKCWsServerOptions = {
            port: rpcServerPort,
            authKey,
            pkcOptions: {
                kuboRpcClientsOptions: pkc.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                httpRoutersOptions: pkc.httpRoutersOptions,
                dataPath: pkc.dataPath
            }
        };
        const rpcServer = await PKCWsServer.PKCWsServer(options); // was able to create an rpc server

        const rpcUrl = `ws://localhost:${rpcServerPort}/${authKey}`;
        const clientPKC = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

        const community = (await clientPKC.createCommunity({})) as RpcLocalCommunity;
        expect(community.address).to.exist; // should be able to create a community successfully over RPC
        expect(clientPKC.communities).to.include(community.address);

        await clientPKC.destroy();
        await rpcServer.destroy();
    });

    it(`Can connect to rpc server locally with ws://127.0.0.1:port/authkey`, async () => {
        const rpcServerPort = 9139;
        const authKey = "dwadwa";
        const options: CreatePKCWsServerOptions = {
            port: rpcServerPort,
            authKey,
            pkcOptions: {
                kuboRpcClientsOptions: pkc.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                httpRoutersOptions: pkc.httpRoutersOptions,
                dataPath: pkc.dataPath
            }
        };
        const rpcServer = await PKCWsServer.PKCWsServer(options); // was able to create an rpc server

        const rpcUrl = `ws://127.0.0.1:${rpcServerPort}/${authKey}`;
        const clientPKC = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

        const community = (await clientPKC.createCommunity({})) as RpcLocalCommunity;
        expect(community.address).to.exist; // should be able to create a community successfully over RPC
        expect(clientPKC.communities).to.include(community.address);

        await clientPKC.destroy();
        await rpcServer.destroy();
    });

    it(`Fails to connect to rpc server with remote device with no auth key`, async () => {
        const rpcServerPort = 9139;
        const authKey = "dwadwa";
        const options: CreatePKCWsServerOptions = {
            port: rpcServerPort,
            authKey,
            pkcOptions: {
                kuboRpcClientsOptions: pkc.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                httpRoutersOptions: pkc.httpRoutersOptions,
                dataPath: pkc.dataPath
            }
        };
        const rpcServer = await PKCWsServer.PKCWsServer(options); // was able to create an rpc server

        (rpcServer as unknown as PKCWsServerPrivateAccess)._getIpFromConnectionRequest = () => "::ffff:192.168.1.80"; // random ip address, trying to emulate a remote device

        const rpcUrl = `ws://${lanAddress}:${rpcServerPort}`;
        const clientPKC = await PKC({ pkcRpcClientsOptions: [rpcUrl], httpRoutersOptions: [] });
        const emittedErrors: (PKCError | Error)[] = [];
        clientPKC.on("error", (err) => emittedErrors.push(err));

        try {
            await clientPKC.createCommunity({});
            expect.fail("Should throw an error");
        } catch (e) {
            expect((e as { code: string }).code).to.equal("ERR_RPC_AUTH_REQUIRED");
            expect(emittedErrors.some((err) => err instanceof PKCError && err.code === "ERR_RPC_AUTH_REQUIRED")).to.be.true;
        } finally {
            await clientPKC.destroy();
            await rpcServer.destroy();
        }
    });

    it(`Fails to connect to rpc server from remote device with wrong auth key`, async () => {
        const rpcServerPort = 9139;
        const authKey = "correct-key";
        const options: CreatePKCWsServerOptions = {
            port: rpcServerPort,
            authKey,
            pkcOptions: {
                kuboRpcClientsOptions: pkc.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                httpRoutersOptions: pkc.httpRoutersOptions,
                dataPath: pkc.dataPath
            }
        };
        const rpcServer = await PKCWsServer.PKCWsServer(options);

        (rpcServer as unknown as PKCWsServerPrivateAccess)._getIpFromConnectionRequest = () => "::ffff:192.168.1.80";

        const rpcUrl = `ws://${lanAddress}:${rpcServerPort}/wrong-key`;
        const clientPKC = await PKC({ pkcRpcClientsOptions: [rpcUrl], httpRoutersOptions: [] });
        const emittedErrors: (PKCError | Error)[] = [];
        clientPKC.on("error", (err) => emittedErrors.push(err));

        try {
            await clientPKC.createCommunity({});
            expect.fail("Should throw an error");
        } catch (e) {
            expect((e as { code: string }).code).to.equal("ERR_RPC_AUTH_REQUIRED");
            expect(emittedErrors.some((err) => err instanceof PKCError && err.code === "ERR_RPC_AUTH_REQUIRED")).to.be.true;
        } finally {
            await clientPKC.destroy();
            await rpcServer.destroy();
        }
    });

    it(`Succeeds in connecting to rpc server from remote device with auth key`, async () => {
        const rpcServerPort = 9139;
        const authKey = "dwadwa";
        const options: CreatePKCWsServerOptions = {
            port: rpcServerPort,
            authKey,
            pkcOptions: {
                kuboRpcClientsOptions: pkc.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                httpRoutersOptions: pkc.httpRoutersOptions,
                dataPath: pkc.dataPath
            }
        };
        const rpcServer = await PKCWsServer.PKCWsServer(options); // was able to create an rpc server

        (rpcServer as unknown as PKCWsServerPrivateAccess)._getIpFromConnectionRequest = () => "::ffff:192.168.1.80"; // random ip address, trying to emulate a remote device

        const rpcUrl = `ws://${lanAddress}:${rpcServerPort}/${authKey}`;
        const clientPKC = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

        const community = (await clientPKC.createCommunity({})) as RpcLocalCommunity;
        expect(community.address).to.exist; // should be able to create a community successfully over RPC
        expect(clientPKC.communities).to.include(community.address);

        await clientPKC.destroy();
        await rpcServer.destroy();
    });

    it(`Can connect to rpc server if from local device and used remote address (no auth key)`, async () => {
        const rpcServerPort = 9139;
        const authKey = "dwadwa";
        const options: CreatePKCWsServerOptions = {
            port: rpcServerPort,
            authKey,
            pkcOptions: {
                kuboRpcClientsOptions: pkc.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                httpRoutersOptions: pkc.httpRoutersOptions,
                dataPath: pkc.dataPath
            }
        };
        const rpcServer = await PKCWsServer.PKCWsServer(options); // was able to create an rpc server

        const rpcUrl = `ws://${lanAddress}:${rpcServerPort}`;
        const clientPKC = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

        const community = (await clientPKC.createCommunity({})) as RpcLocalCommunity;
        expect(community.address).to.exist; // should be able to create a community successfully over RPC
        expect(clientPKC.communities).to.include(community.address);

        await clientPKC.destroy();
        await rpcServer.destroy();
    });

    it(`Can connect to rpc server if from local device but used remote address (with auth key)`, async () => {
        const rpcServerPort = 9139;
        const authKey = "dwadwa";
        const options: CreatePKCWsServerOptions = {
            port: rpcServerPort,
            authKey,
            pkcOptions: {
                kuboRpcClientsOptions: pkc.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                httpRoutersOptions: pkc.httpRoutersOptions,
                dataPath: pkc.dataPath
            }
        };
        const rpcServer = await PKCWsServer.PKCWsServer(options); // was able to create an rpc server

        const rpcUrl = `ws://${lanAddress}:${rpcServerPort}/${authKey}`;
        const clientPKC = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

        const community = (await clientPKC.createCommunity({})) as RpcLocalCommunity;
        expect(community.address).to.exist; // should be able to create a community successfully over RPC
        expect(clientPKC.communities).to.include(community.address);

        await clientPKC.destroy();
        await rpcServer.destroy();
    });

    describe(`RPC server community edit error handling`, () => {
        it(`Returns domain mismatch errors to RPC clients without crashing the server`, async () => {
            const rpcServerPort = 19145;
            const options: CreatePKCWsServerOptions = {
                port: rpcServerPort,
                pkcOptions: {
                    kuboRpcClientsOptions: pkc.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: pkc.httpRoutersOptions,
                    dataPath: tempy.directory()
                }
            };
            const rpcServer = await PKCWsServer.PKCWsServer(options);

            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            let clientPKC: PKCType | undefined;
            clientPKC = await PKC({
                pkcRpcClientsOptions: [rpcUrl],
                dataPath: undefined,
                httpRoutersOptions: []
            });

            const rpcCommunity = (await clientPKC.createCommunity({})) as RpcLocalCommunity;
            const mismatchedDomain = "my-sub.bso";

            await rpcCommunity.edit({ address: mismatchedDomain });
            await new Promise((resolve) => setTimeout(resolve, 7000));

            // should not crash hopefully

            if (rpcCommunity) {
                try {
                    await rpcCommunity.delete();
                } catch {}
            }
            if (clientPKC) {
                try {
                    await clientPKC.destroy();
                } catch {}
            }
            try {
                await rpcServer.destroy();
            } catch {}
        });
    });
});
