import { describe, it, beforeAll, afterAll, expect } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";

import { createSubWithNoChallenge, publishRandomPost, mockPKC, mockPKCV2 } from "../../dist/node/test/test-util.js";
import type { PKC } from "../../dist/node/pkc/pkc.js";
import type { Comment } from "../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../dist/node/runtime/node/community/local-community.js";

// Companion of cold-comment-load-bench.test.ts for issue #562, for a kubo RPC client: does a COLD
// kubo node (fresh repo, no peers, never saw the community) load a comment by CID when no router
// lists the comment CID, and does the community connect that pkc-js runs next to the fetch change
// that? NOT part of any CI glob; run manually against the local test server:
//
//   node test/run-test-config.js --pkc-config local-kubo-rpc --vitest-timeout 3600000 test/benchmarks/cold-comment-load-kubo-bench.test.ts
//
// Every round starts its own kubo daemon on ports 15101/18181/24101 with a fresh repo under
// .tmp/cold-kubo, configured the way setupKuboHttpRouters configures a node, pointing at a router
// that only knows the community. Variants without a community identity run no community connect,
// so they are the "connect off" arm of the same build.
//
// Env knobs: BENCH_ROUNDS (default 3), BENCH_LIMIT_MS (default 25000), BENCH_LABEL (default "run").
// A directory run such as `npm run test:node` collects every *.test.ts under test/, this file
// included, so the benchmark only runs when it is named on the command line.
// run-test-config.js puts the paths it was given into VITEST_INCLUDE_GLOBS.
const NAMED_ON_COMMAND_LINE = (JSON.parse(process.env.VITEST_INCLUDE_GLOBS ?? "[]") as string[]).some((glob) =>
    glob.endsWith(path.basename(import.meta.filename))
);
const ROUNDS = Number(process.env.BENCH_ROUNDS) > 0 ? Number(process.env.BENCH_ROUNDS) : 3;
const LIMIT_MS = Number(process.env.BENCH_LIMIT_MS) > 0 ? Number(process.env.BENCH_LIMIT_MS) : 25_000;
const LABEL = process.env.BENCH_LABEL ?? "run";
const TEST_SERVER_HTTP_ROUTER_URL = "http://localhost:20001";
const API_PORT = 15101;
const GATEWAY_PORT = 18181;
const SWARM_PORT = 24101;
const COLD_KUBO_API_URL = `http://127.0.0.1:${API_PORT}/api/v0`;
const IPFS_BIN = path.resolve("node_modules/.bin/ipfs");
const REPOS_DIR = path.resolve(".tmp/cold-kubo");

const VARIANTS = ["getComment-cid", "getComment-cid+key", "update-cid", "update-cid+key"] as const;
type VariantKey = (typeof VARIANTS)[number];
type RoundResult = {
    variant: VariantKey;
    round: number;
    loaded: boolean;
    elapsedMs: number;
    firstGetCommunityCallMs?: number;
    peersAtEnd: number;
};

let publisherPkc: PKC;
let community: LocalCommunity;
let publishedPost: Comment;
let proxyServer: http.Server;
let proxyUrl: string;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
    publisherPkc = await mockPKC();
    community = (await createSubWithNoChallenge({}, publisherPkc)) as LocalCommunity;
    await community.start();
    await new Promise<void>((resolve) => community.once("update", () => resolve()));
    publishedPost = await publishRandomPost({ communityAddress: community.address, pkc: publisherPkc });
    const topicCid = community.ipnsPubsubTopicRoutingCid!;
    expect(topicCid).to.be.a("string");

    proxyServer = http.createServer(async (req, res) => {
        const requestUrl = req.url ?? "";
        if (req.method === "GET" && requestUrl.includes(topicCid)) {
            try {
                const upstream = await fetch(`${TEST_SERVER_HTTP_ROUTER_URL}${requestUrl}`, { headers: { Accept: "application/json" } });
                res.writeHead(upstream.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
                res.end(await upstream.text());
            } catch (error) {
                res.writeHead(502);
                res.end(String(error));
            }
            return;
        }
        if (req.method === "GET") {
            res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ Providers: null }));
            return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", () => resolve()));
    proxyUrl = `http://127.0.0.1:${(proxyServer.address() as AddressInfo).port}`;
    fs.rmSync(REPOS_DIR, { recursive: true, force: true });
    fs.mkdirSync(REPOS_DIR, { recursive: true });
}, 180_000);

afterAll(async () => {
    try {
        await community?.stop();
    } catch {
        // already stopped
    }
    await publisherPkc?.destroy();
    proxyServer?.closeAllConnections();
    await new Promise<void>((resolve) => (proxyServer ? proxyServer.close(() => resolve()) : resolve()));
    fs.rmSync(REPOS_DIR, { recursive: true, force: true });
}, 120_000);

async function startColdKubo(repoDir: string): Promise<ChildProcess> {
    const env = { ...process.env, IPFS_PATH: repoDir };
    execFileSync(IPFS_BIN, ["init"], { env, stdio: "ignore" });
    execFileSync(IPFS_BIN, ["bootstrap", "rm", "--all"], { env, stdio: "ignore" });
    const configPath = path.join(repoDir, "config");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.Addresses.API = `/ip4/127.0.0.1/tcp/${API_PORT}`;
    config.Addresses.Gateway = `/ip4/127.0.0.1/tcp/${GATEWAY_PORT}`;
    config.Addresses.Swarm = [`/ip4/127.0.0.1/tcp/${SWARM_PORT}/ws`];
    config.Discovery.MDNS.Enabled = false;
    // Same shape setupKuboHttpRouters writes
    config.Routing = {
        Type: "custom",
        Methods: {
            "find-providers": { RouterName: "HttpRoutersParallel" },
            provide: { RouterName: "HttpRoutersParallel" },
            "find-peers": { RouterName: "HttpRouterNotSupported" },
            "get-ipns": { RouterName: "HttpRouterNotSupported" },
            "put-ipns": { RouterName: "HttpRouterNotSupported" }
        },
        Routers: {
            HttpRoutersParallel: {
                Type: "parallel",
                Parameters: { Routers: [{ RouterName: "HttpRouter1", IgnoreErrors: true, Timeout: "10s" }] }
            },
            HttpRouterNotSupported: { Type: "http", Parameters: { Endpoint: "http://kubohttprouternotsupported" } },
            HttpRouter1: { Type: "http", Parameters: { Endpoint: proxyUrl } }
        }
    };
    fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
    const daemon = spawn(IPFS_BIN, ["daemon", "--enable-namesys-pubsub", "--enable-pubsub-experiment"], { env, stdio: "ignore" });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        try {
            if ((await fetch(`${COLD_KUBO_API_URL}/id`, { method: "POST" })).ok) return daemon;
        } catch {
            // not listening yet
        }
        await sleep(200);
    }
    daemon.kill("SIGKILL");
    throw new Error("cold kubo daemon did not start within 60s");
}

async function stopColdKubo(daemon: ChildProcess, repoDir: string) {
    const exited = new Promise<void>((resolve) => daemon.once("exit", () => resolve()));
    daemon.kill("SIGTERM");
    const forceKill = sleep(15_000).then((): void => {
        if (daemon.exitCode === null) daemon.kill("SIGKILL");
    });
    await Promise.race([exited, forceKill]);
    await exited;
    fs.rmSync(repoDir, { recursive: true, force: true });
}

async function runRound(variant: VariantKey, round: number): Promise<RoundResult> {
    const repoDir = path.join(REPOS_DIR, `${variant}-${round}`);
    const daemon = await startColdKubo(repoDir);
    const result: RoundResult = { variant, round, loaded: false, elapsedMs: LIMIT_MS, peersAtEnd: 0 };
    let pkc: PKC | undefined;
    let updatingComment: Comment | undefined;
    try {
        pkc = await mockPKCV2({
            forceMockPubsub: false,
            remotePKC: true,
            pkcOptions: {
                kuboRpcClientsOptions: [COLD_KUBO_API_URL],
                pubsubKuboRpcClientsOptions: [COLD_KUBO_API_URL],
                pkcRpcClientsOptions: undefined,
                httpRoutersOptions: []
            }
        });
        pkc._timeouts["comment-ipfs"] = LIMIT_MS;
        const cid = publishedPost.cid!;
        const communityPublicKey = community.publicKey;
        const originalGetCommunity = pkc.getCommunity.bind(pkc);
        let startedAt = 0;
        pkc.getCommunity = (args) => {
            if (result.firstGetCommunityCallMs === undefined) result.firstGetCommunityCallMs = Date.now() - startedAt;
            return originalGetCommunity(args);
        };
        startedAt = Date.now();
        if (variant.startsWith("getComment")) {
            try {
                await pkc.getComment(variant === "getComment-cid" ? { cid } : { cid, communityPublicKey });
                result.loaded = true;
            } catch {
                result.loaded = false;
            }
        } else {
            updatingComment = await pkc.createComment(variant === "update-cid" ? { cid } : { cid, communityPublicKey });
            const comment = updatingComment;
            comment.on("error", () => {});
            await comment.update();
            while (!comment.raw.comment && Date.now() - startedAt < LIMIT_MS) await sleep(20);
            result.loaded = Boolean(comment.raw.comment);
        }
        result.elapsedMs = Date.now() - startedAt;
        const peersRes = await fetch(`${COLD_KUBO_API_URL}/swarm/peers`, { method: "POST" });
        result.peersAtEnd = ((await peersRes.json()) as { Peers: unknown[] | null }).Peers?.length ?? 0;
    } finally {
        try {
            await updatingComment?.stop();
        } catch {
            // already stopped
        }
        await pkc?.destroy();
        await stopColdKubo(daemon, repoDir);
    }
    return result;
}

describe.skipIf(!NAMED_ON_COMMAND_LINE)(
    "cold kubo client: comment load by CID with no provider record for the comment (issue #562)",
    () => {
        it(`${VARIANTS.length} variants x ${ROUNDS} rounds`, async () => {
            const results: RoundResult[] = [];
            for (const variant of VARIANTS)
                for (let round = 1; round <= ROUNDS; round++) {
                    const roundResult = await runRound(variant, round);
                    results.push(roundResult);
                    console.log("[bench-562-kubo]", JSON.stringify(roundResult));
                }
            const seconds = (ms: number) => (ms / 1000).toFixed(1);
            const lines = [
                "| Variant | Loaded | Load time (s) | getCommunity called at (s) | Swarm peers at end |",
                "|---|---|---|---|---|"
            ];
            for (const variant of VARIANTS) {
                const rows = results.filter((row) => row.variant === variant);
                const loadedRows = rows.filter((row) => row.loaded);
                const calls = rows.map((row) => row.firstGetCommunityCallMs).filter((value): value is number => value !== undefined);
                lines.push(
                    `| ${variant} | ${loadedRows.length} of ${rows.length} | ${
                        loadedRows.length
                            ? `${seconds(Math.min(...loadedRows.map((row) => row.elapsedMs)))}-${seconds(Math.max(...loadedRows.map((row) => row.elapsedMs)))}`
                            : `timeout at ${seconds(LIMIT_MS)}`
                    } | ${calls.length ? `${seconds(Math.min(...calls))}-${seconds(Math.max(...calls))}` : "-"} | ${rows.map((row) => row.peersAtEnd).join(", ")} |`
                );
            }
            const table = lines.join("\n");
            console.log(`\n[bench-562-kubo] summary (${LABEL})\n${table}\n`);
            fs.mkdirSync(path.resolve(".tmp"), { recursive: true });
            fs.writeFileSync(path.resolve(".tmp", `bench-562-kubo-${LABEL}.md`), table + "\n");
            fs.writeFileSync(
                path.resolve(".tmp", `bench-562-kubo-${LABEL}.json`),
                JSON.stringify({ label: LABEL, limitMs: LIMIT_MS, results }, null, 2)
            );
        });
    }
);
