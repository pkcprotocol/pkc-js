import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { setupKuboHttpRouters } from "../../dist/node/runtime/node/setup-kubo-http-routers.js";
import { describeSkipIfRpc } from "../helpers/conditional-tests.js";
import type { PKC } from "../../dist/node/pkc/pkc.js";

// setupKuboHttpRouters writes kubo's Routing config, then Provide.DHT.SweepEnabled, then POSTs
// /shutdown so kubo restarts with the new routers. It used to decide the shutdown from a diff between
// the config it read at the start of each attempt and the merged value. When the Routing write landed
// but a later request of the same attempt failed, the retry read the already-merged config, saw no
// difference, skipped /shutdown and reported success: kubo kept running its old routers, so provide
// and find-providers never reached the configured HTTP routers until someone restarted it by hand.
//
// A fake kubo RPC API on a local port stands in for the node (no kubo, no test server). A request it
// "drops" has its socket destroyed, which makes fetch() throw like a transient network error. To refuse
// a /shutdown it stops listening before answering the request before it, so the /shutdown fails with
// ECONNREFUSED without reaching it; it listens again on the next config read, as a kubo whose API came
// back before the retry. Other failures that happen before a connection exists (an unreachable host or
// network, a failed DNS lookup, a connect timeout) are injected into the first /shutdown's fetch() with the
// error shape undici gives them.
type KuboRoutingConfig = { Routers?: Record<string, { Parameters?: { Endpoint?: string } }> };

const createFakeKubo = async () => {
    const state = {
        persistedRouting: <KuboRoutingConfig>{ Routers: {} },
        routingWrites: 0,
        sweepWrites: 0,
        shutdowns: 0,
        dropNextSweepWrite: false,
        dropNextShutdown: false,
        refuseNextShutdown: false
    };
    let port = 0;
    let listening = false;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const args = url.searchParams.getAll("arg");
        if (url.pathname === "/api/v0/config" && args[0] === "Routing" && args.length === 2) {
            state.persistedRouting = JSON.parse(args[1]);
            state.routingWrites++;
        } else if (url.pathname === "/api/v0/config" && args[0] === "Provide.DHT.SweepEnabled") {
            state.sweepWrites++;
            if (state.dropNextSweepWrite) {
                state.dropNextSweepWrite = false;
                req.socket.destroy();
                return;
            }
            if (state.refuseNextShutdown) {
                // Stop listening before answering, and close this connection after the answer, so the
                // /shutdown that follows has nothing to connect to
                state.refuseNextShutdown = false;
                server.close();
                listening = false;
                res.writeHead(200, { "Content-Type": "application/json", Connection: "close" }).end("{}");
                return;
            }
        } else if (url.pathname === "/api/v0/shutdown") {
            state.shutdowns++;
            if (state.dropNextShutdown) {
                // kubo closing the connection while it goes down
                state.dropNextShutdown = false;
                req.socket.destroy();
                return;
            }
        } else {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
    const listen = () =>
        new Promise<void>((resolve) =>
            server.listen(port, "127.0.0.1", () => {
                port = (<AddressInfo>server.address()).port;
                listening = true;
                resolve();
            })
        );
    await listen();
    const apiUrl = `http://127.0.0.1:${port}/api/v0`;
    const readRouting = async () => {
        if (!listening) await listen();
        return structuredClone(state.persistedRouting);
    };
    const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    return { state, apiUrl, readRouting, close };
};

// Only the PKC members setupKuboHttpRouters reads. config.get answers from the fake node's persisted
// config, as kubo's does.
const createPkcStub = ({ apiUrl, readRouting }: Pick<Awaited<ReturnType<typeof createFakeKubo>>, "apiUrl" | "readRouting">) => {
    const destroyController = new AbortController();
    const pkcStub = {
        destroyed: false,
        kuboRpcClientsOptions: [apiUrl],
        httpRoutersOptions: ["http://127.0.0.1:1/delegated-router"],
        clients: {
            kuboRpcClients: {
                [apiUrl]: {
                    _clientOptions: { url: apiUrl },
                    _client: { config: { get: readRouting } }
                }
            }
        },
        _getDestroyAbortSignal: () => destroyController.signal
    };
    return pkcStub as unknown as PKC;
};

// Config-independent (it never builds a PKC and talks to a fake kubo API), so it runs once under
// non-RPC via describeSkipIfRpc.
describeSkipIfRpc("setupKuboHttpRouters restarts kubo after a router change even when an attempt fails part way", () => {
    let closeFakeKubo: (() => Promise<void>) | undefined;

    afterEach(async () => {
        vi.restoreAllMocks();
        await closeFakeKubo?.();
        closeFakeKubo = undefined;
    });

    it("sends /shutdown on the retry when the attempt that changed Routing failed before shutting kubo down", async () => {
        const fakeKubo = await createFakeKubo();
        closeFakeKubo = fakeKubo.close;
        fakeKubo.state.dropNextSweepWrite = true;

        await setupKuboHttpRouters(createPkcStub(fakeKubo));

        expect(fakeKubo.state.sweepWrites, "the first attempt failed, so setup retried").to.equal(2);
        expect(fakeKubo.state.persistedRouting.Routers?.HttpRouter1?.Parameters?.Endpoint).to.equal("http://127.0.0.1:1/delegated-router");
        expect(fakeKubo.state.shutdowns, "kubo must be restarted to load the routers the first attempt wrote").to.equal(1);
    });

    it("sends /shutdown again on the retry when kubo refused the connection for the first one", async () => {
        const fakeKubo = await createFakeKubo();
        closeFakeKubo = fakeKubo.close;
        fakeKubo.state.refuseNextShutdown = true;

        await setupKuboHttpRouters(createPkcStub(fakeKubo));

        expect(fakeKubo.state.sweepWrites, "the refused /shutdown failed the first attempt, so setup retried").to.equal(2);
        expect(fakeKubo.state.shutdowns, "the refused /shutdown never reached kubo, so the retry must send it").to.equal(1);
    });

    // undici's fetch() rejects with TypeError("fetch failed") and the socket or DNS error as its cause
    const fetchFailed = (cause: Error) => Object.assign(new TypeError("fetch failed"), { cause });
    const systemError = (message: string, props: { code: string; syscall?: string }) => Object.assign(new Error(message), props);
    it.each([
        [
            "EHOSTUNREACH from connect()",
            () => systemError("connect EHOSTUNREACH 192.0.2.1:5001", { code: "EHOSTUNREACH", syscall: "connect" })
        ],
        [
            "ENETUNREACH from connect()",
            () => systemError("connect ENETUNREACH 192.0.2.1:5001", { code: "ENETUNREACH", syscall: "connect" })
        ],
        [
            "ENOTFOUND from the DNS lookup",
            () => systemError("getaddrinfo ENOTFOUND kubo.invalid", { code: "ENOTFOUND", syscall: "getaddrinfo" })
        ],
        [
            "EAI_AGAIN from the DNS lookup",
            () => systemError("getaddrinfo EAI_AGAIN kubo.invalid", { code: "EAI_AGAIN", syscall: "getaddrinfo" })
        ],
        ["undici's connect timeout", () => systemError("Connect Timeout Error", { code: "UND_ERR_CONNECT_TIMEOUT" })]
    ])("sends /shutdown again on the retry when the first one failed before connecting: %s", async (_name, createCause) => {
        const fakeKubo = await createFakeKubo();
        closeFakeKubo = fakeKubo.close;
        const realFetch = globalThis.fetch;
        let failedShutdowns = 0;
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
            if (failedShutdowns === 0 && String(input).endsWith("/shutdown")) {
                failedShutdowns++;
                throw fetchFailed(createCause());
            }
            return realFetch(input, init);
        });

        await setupKuboHttpRouters(createPkcStub(fakeKubo));

        expect(failedShutdowns).to.equal(1);
        expect(fakeKubo.state.sweepWrites, "the failed /shutdown failed the first attempt, so setup retried").to.equal(2);
        expect(fakeKubo.state.shutdowns, "the first /shutdown never reached kubo, so the retry must send it").to.equal(1);
    });

    it("does not restart kubo a second time when kubo closed the connection while shutting down", async () => {
        const fakeKubo = await createFakeKubo();
        closeFakeKubo = fakeKubo.close;
        fakeKubo.state.dropNextShutdown = true;

        await setupKuboHttpRouters(createPkcStub(fakeKubo));

        expect(fakeKubo.state.shutdowns).to.equal(1);
    });

    it("does not restart kubo when the routers are already configured", async () => {
        const fakeKubo = await createFakeKubo();
        closeFakeKubo = fakeKubo.close;

        await setupKuboHttpRouters(createPkcStub(fakeKubo));
        expect(fakeKubo.state.shutdowns).to.equal(1);
        await setupKuboHttpRouters(createPkcStub(fakeKubo));

        expect(fakeKubo.state.routingWrites).to.equal(2);
        expect(fakeKubo.state.shutdowns, "an unchanged config must not restart kubo").to.equal(1);
    });
});
