import path from "path";
import url from "url";
import PKCWsServer from "../../dist/node/rpc/src/index.js";
import { mockRpcServerPKC, mockRpcServerForTests } from "../../dist/node/test/test-util.js";

const startPKCWebSocketServers = async ({ rpcPort = 39652, rpcAuthKey = "123456" } = {}) => {
    const pkcWebSocketServer = await PKCWsServer.PlebbitWsServer({ port: rpcPort, authKey: rpcAuthKey });

    pkcWebSocketServer._initPlebbit(await mockRpcServerPKC({ dataPath: path.join(process.cwd(), ".pkc-rpc-server") }));
    pkcWebSocketServer._createPlebbitInstanceFromSetSettings = async (newOptions) =>
        mockRpcServerPKC({ dataPath: path.join(process.cwd(), ".pkc-rpc-server"), ...newOptions });
    mockRpcServerForTests(pkcWebSocketServer);

    const remotePort = rpcPort + 1;
    const pkcWebSocketRemoteServer = await PKCWsServer.PlebbitWsServer({
        port: remotePort,
        authKey: rpcAuthKey
    });
    pkcWebSocketRemoteServer._initPlebbit(await mockRpcServerPKC({ dataPath: path.join(process.cwd(), ".pkc-rpc-server-remote") }));
    pkcWebSocketRemoteServer._createPlebbitInstanceFromSetSettings = async (newOptions) =>
        mockRpcServerPKC({ dataPath: path.join(process.cwd(), ".pkc-rpc-server"), ...newOptions });

    mockRpcServerForTests(pkcWebSocketRemoteServer);

    console.log(`test server pkc wss listening on port ${rpcPort} and ${remotePort}`);

    return { pkcWebSocketServer, pkcWebSocketRemoteServer };
};

export default startPKCWebSocketServers;

// Allow running this file directly: `node test/server/pkc-ws-server.js`
if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
    const envRpcPort = Number(process.env.PLEBBIT_RPC_PORT ?? process.env.RPC_PORT);
    const rpcPort = Number.isFinite(envRpcPort) ? envRpcPort : undefined;
    const rpcAuthKey = process.env.PLEBBIT_RPC_AUTH_KEY || "123456";

    startPKCWebSocketServers({ rpcPort, rpcAuthKey }).catch((err) => {
        console.error("Failed to start PKC WebSocket servers", err);
        process.exitCode = 1;
    });
}
