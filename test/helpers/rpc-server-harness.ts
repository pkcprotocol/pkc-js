// Shared harness for tests that run a PKCWsServer in-process against a Node-side PKC instance
// (#315, #316). Replaces the per-file copies of getAvailablePort + PKCWsServer + _initPKC:
//
// - Binds the server with port 0 so the OS assigns the port atomically: the old
//   reserve-a-port-then-close-then-rebind helper could lose the port to another process between
//   the probe and the real listen (EADDRINUSE in beforeAll).
// - Injects the caller's PKC instance via the setPKCJs hook, so the PKCWsServer factory never
//   constructs the throwaway PKC from pkcOptions that _initPKC(serverPKC) used to orphan (its
//   handles leaked for the rest of the worker lifetime).
//
// Typical use:
//
//   serverPKC = await mockRpcServerPKC({ dataPath });
//   ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: "my-test" }));
//   // wrap rpcServer internals as needed, then point a client PKC at rpcUrl
//
// Teardown stays with the test: `await rpcServer.destroy()` then `await serverPKC.destroy()`.
import type { Server as HTTPServer } from "node:http";
import PKCWsServer from "../../dist/node/rpc/src/index.js";
import { restorePKCJs, setPKCJs } from "../../dist/node/rpc/src/lib/pkc-js/index.js";
import type { PKC as PKCType } from "../../dist/node/pkc/pkc.js";

export type PKCWsServerType = Awaited<ReturnType<typeof PKCWsServer.PKCWsServer>>;

export async function createInProcessRpcServer(opts: { serverPKC: PKCType; authKey: string }): Promise<{
    rpcServer: PKCWsServerType;
    rpcUrl: string;
    port: number;
}> {
    setPKCJs(async () => opts.serverPKC);
    let rpcServer: PKCWsServerType;
    try {
        rpcServer = await PKCWsServer.PKCWsServer({ port: 0, authKey: opts.authKey });
    } finally {
        // The injected factory has been consumed by now; never leak it to other suites in the worker
        restorePKCJs();
    }

    const httpServer = (rpcServer as unknown as { _httpServer: HTTPServer })._httpServer;
    const port = await new Promise<number>((resolve, reject) => {
        const resolveFromAddress = () => {
            const address = httpServer.address();
            if (address && typeof address === "object") resolve(address.port);
            else reject(new Error("PKCWsServer's http server has no bound address after listening"));
        };
        if (httpServer.listening) resolveFromAddress();
        else {
            httpServer.once("listening", resolveFromAddress);
            httpServer.once("error", reject);
        }
    });

    return { rpcServer, rpcUrl: `ws://localhost:${port}`, port };
}
