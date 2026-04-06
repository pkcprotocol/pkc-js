import path from "path";
import url from "url";
import PlebbitWsServer from "../../dist/node/rpc/src/index.js";
import { mockRpcServerPlebbit, mockRpcServerForTests } from "../../dist/node/test/test-util.js";

const startPlebbitWebSocketServers = async ({ rpcPort = 39652, rpcAuthKey = "123456" } = {}) => {
    const plebbitWebSocketServer = await PlebbitWsServer.PlebbitWsServer({ port: rpcPort, authKey: rpcAuthKey });

    plebbitWebSocketServer._initPlebbit(await mockRpcServerPlebbit({ dataPath: path.join(process.cwd(), ".plebbit-rpc-server") }));
    plebbitWebSocketServer._createPlebbitInstanceFromSetSettings = async (newOptions) =>
        mockRpcServerPlebbit({ dataPath: path.join(process.cwd(), ".plebbit-rpc-server"), ...newOptions });
    mockRpcServerForTests(plebbitWebSocketServer);

    const remotePort = rpcPort + 1;
    const plebbitWebSocketRemoteServer = await PlebbitWsServer.PlebbitWsServer({
        port: remotePort,
        authKey: rpcAuthKey
    });
    plebbitWebSocketRemoteServer._initPlebbit(
        await mockRpcServerPlebbit({ dataPath: path.join(process.cwd(), ".plebbit-rpc-server-remote") })
    );
    plebbitWebSocketRemoteServer._createPlebbitInstanceFromSetSettings = async (newOptions) =>
        mockRpcServerPlebbit({ dataPath: path.join(process.cwd(), ".plebbit-rpc-server"), ...newOptions });

    mockRpcServerForTests(plebbitWebSocketRemoteServer);

    console.log(`test server plebbit wss listening on port ${rpcPort} and ${remotePort}`);

    return { plebbitWebSocketServer, plebbitWebSocketRemoteServer };
};

export default startPlebbitWebSocketServers;

// Allow running this file directly: `node test/server/pkc-ws-server.js`
if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
    const envRpcPort = Number(process.env.PLEBBIT_RPC_PORT ?? process.env.RPC_PORT);
    const rpcPort = Number.isFinite(envRpcPort) ? envRpcPort : undefined;
    const rpcAuthKey = process.env.PLEBBIT_RPC_AUTH_KEY || "123456";

    startPlebbitWebSocketServers({ rpcPort, rpcAuthKey }).catch((err) => {
        console.error("Failed to start Plebbit WebSocket servers", err);
        process.exitCode = 1;
    });
}
