// The RPC server skips the auth key for connections from its own machine. A web page the user
// visits also connects from the loopback address, since browsers let any page open a WebSocket to
// localhost, so without an Origin check every site could drive a local node (read community
// settings, export communities, publish). These tests pin which origins still connect without the
// auth key over loopback, and that every other web page origin needs it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import PKC from "../../../dist/node/index.js";
import { isOriginTrustedWithoutAuthKey } from "../../../dist/node/rpc/src/utils.js";
import { createInProcessRpcServer, uniqueTmpDataPath, type PKCWsServerType } from "../../helpers/rpc-server-harness.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";

const RPC_AUTH_KEY = "test-rpc-origin-check";

describe("isOriginTrustedWithoutAuthKey", () => {
    it.each([
        [undefined, true], // not a browser: node, CLI
        ["file://", true], // a desktop app's file:// page (Electron)
        ["http://localhost:3000", true],
        ["https://5chan.localhost", true],
        ["http://127.0.0.1:9138", true],
        ["http://127.1.2.3", true],
        ["http://[::1]:5173", true],
        ["https://evil.example", false],
        ["https://localhost.evil.example", false],
        ["https://127.0.0.1.evil.example", false],
        ["null", false], // a sandboxed iframe on any site
        ["chrome-extension://abcdef", false],
        ["not a url", false]
    ])("%s -> %s", (origin, expected) => {
        expect(isOriginTrustedWithoutAuthKey(origin)).toBe(expected);
    });
});

describe("RPC server: web page origins need the auth key on loopback", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let port: number;

    beforeAll(async () => {
        serverPKC = await PKC({ dataPath: uniqueTmpDataPath("pkc-rpc-origin-check"), httpRoutersOptions: [] });
        ({ rpcServer, port } = await createInProcessRpcServer({ serverPKC, authKey: RPC_AUTH_KEY }));
    });

    afterAll(async () => {
        if (rpcServer) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
    });

    // Resolves with 101 when the upgrade succeeds, or the HTTP status the server refused it with
    const connect = (path: string, origin?: string) =>
        new Promise<number>((resolve, reject) => {
            const ws = new WebSocket(`ws://localhost:${port}${path}`, origin === undefined ? {} : { origin });
            ws.once("open", () => {
                ws.close();
                resolve(101);
            });
            ws.once("unexpected-response", (req, res) => {
                res.resume();
                req.destroy();
                resolve(res.statusCode ?? 0);
            });
            ws.once("error", (error) => {
                if (ws.readyState !== WebSocket.CLOSED) reject(error);
            });
        });

    it.each([
        ["no Origin header", undefined],
        ["a desktop app's file:// page", "file://"],
        ["a page on localhost", "http://localhost:3000"],
        ["a page on a .localhost host", "https://5chan.localhost"]
    ])("accepts %s without the auth key", async (_name, origin) => {
        expect(await connect("/", origin)).toBe(101);
    });

    it.each([
        ["a remote web page", "https://evil.example"],
        ["a sandboxed iframe (Origin: null)", "null"]
    ])("refuses %s without the auth key", async (_name, origin) => {
        expect(await connect("/", origin)).toBe(403);
    });

    it("accepts a remote web page that presents the auth key", async () => {
        expect(await connect(`/${RPC_AUTH_KEY}`, "https://evil.example")).toBe(101);
    });
});
