import { describe, it, beforeAll, afterAll, expect } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { createSubWithNoChallenge, publishRandomPost, mockPKC, mockPKCWithHeliaConfig } from "../../dist/node/test/test-util.js";
import type { PKC } from "../../dist/node/pkc/pkc.js";
import type { Comment } from "../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../dist/node/runtime/node/community/local-community.js";

// Measurement harness for issue #562: how long a COLD libp2p-js client takes to load a comment by
// CID when no HTTP router lists the comment CID (kubo's provide queue has not reached it yet) but
// the community itself is findable. NOT part of any CI glob; run manually against the local test
// server, once before a change and once after:
//
//   node test/run-test-config.js --pkc-config remote-libp2pjs --vitest-timeout 3600000 test/benchmarks/cold-comment-load-bench.test.ts
//
// The client's only HTTP router is a small proxy started here. It answers "no providers" for every
// CID except the community's IPNS pubsub topic CID, which it forwards to the test server's router
// after BENCH_DIAL_DELAYS_MS. Delaying that one answer delays the moment the client learns the
// community peer's address, which stands in for a slow dial without touching the timing of the
// comment CID lookups.
//
// Variants are the five rows of the issue's table. The two with no community identity cannot
// depend on the delay, so they run at the first delay only.
//
// Env knobs:
//   BENCH_ROUNDS            rounds per variant per delay (default 5)
//   BENCH_LIMIT_MS          per-load limit (default 25000, the issue's limit)
//   BENCH_DIAL_DELAYS_MS    comma separated delays (default "0,2000,4000,6000")
//   BENCH_VARIANTS          comma separated variant keys to run (default all)
//   BENCH_LABEL             label written into the result file name (default "run")
const ROUNDS = Number(process.env.BENCH_ROUNDS) > 0 ? Number(process.env.BENCH_ROUNDS) : 5;
const LIMIT_MS = Number(process.env.BENCH_LIMIT_MS) > 0 ? Number(process.env.BENCH_LIMIT_MS) : 25_000;
const DIAL_DELAYS_MS = (process.env.BENCH_DIAL_DELAYS_MS ?? "0,2000,4000,6000").split(",").map((value) => Number(value.trim()));
const LABEL = process.env.BENCH_LABEL ?? "run";
const TEST_SERVER_HTTP_ROUTER_URL = "http://localhost:20001";

type VariantKey = "getComment-cid" | "getComment-cid+key" | "update-cid" | "update-cid+key" | "getComment-cid+key+callerGetCommunity";
const ALL_VARIANTS: { key: VariantKey; usesCommunity: boolean }[] = [
    { key: "getComment-cid", usesCommunity: false },
    { key: "getComment-cid+key", usesCommunity: true },
    { key: "update-cid", usesCommunity: false },
    { key: "update-cid+key", usesCommunity: true },
    { key: "getComment-cid+key+callerGetCommunity", usesCommunity: true }
];
const VARIANTS = process.env.BENCH_VARIANTS
    ? ALL_VARIANTS.filter((variant) => process.env.BENCH_VARIANTS!.split(",").includes(variant.key))
    : ALL_VARIANTS;

type RoundResult = {
    variant: VariantKey;
    dialDelayMs: number;
    round: number;
    loaded: boolean;
    elapsedMs: number;
    firstGetCommunityCallMs?: number; // when pkc.getCommunity was first called, relative to the load start
    firstPeerConnectMs?: number; // when the client's first libp2p connection opened, relative to the load start
};

let publisherPkc: PKC;
let community: LocalCommunity;
let publishedPost: Comment;
let proxyServer: http.Server;
let proxyUrl: string;
let topicCidDelayMs = 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
    publisherPkc = await mockPKC();
    community = (await createSubWithNoChallenge({}, publisherPkc)) as LocalCommunity;
    await community.start();
    await new Promise<void>((resolve) => community.once("update", () => resolve()));
    publishedPost = await publishRandomPost({ communityAddress: community.address, pkc: publisherPkc });
    const topicCid = community.ipnsPubsubTopicRoutingCid!;
    expect(topicCid).to.be.a("string");

    const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type,Accept" };
    proxyServer = http.createServer(async (req, res) => {
        const requestUrl = req.url ?? "";
        if (req.method === "GET" && requestUrl.includes(topicCid)) {
            if (topicCidDelayMs > 0) await sleep(topicCidDelayMs);
            try {
                const upstream = await fetch(`${TEST_SERVER_HTTP_ROUTER_URL}${requestUrl}`, { headers: { Accept: "application/json" } });
                const body = await upstream.text();
                res.writeHead(upstream.status, { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" });
                res.end(body);
            } catch (error) {
                res.writeHead(502, corsHeaders);
                res.end(String(error));
            }
            return;
        }
        if (req.method === "GET") {
            res.writeHead(404, { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ Providers: null }));
            return;
        }
        // PUT announcements and OPTIONS preflights: accept and ignore
        res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
        res.end("{}");
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", () => resolve()));
    proxyUrl = `http://127.0.0.1:${(proxyServer.address() as AddressInfo).port}`;
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
}, 120_000);

async function runRound(variant: VariantKey, dialDelayMs: number, round: number): Promise<RoundResult> {
    topicCidDelayMs = dialDelayMs;
    // forceMockPubsub: false gives every round its own helia node (random client key), i.e. a cold
    // client with no connections and an empty blockstore.
    const pkc = await mockPKCWithHeliaConfig({ forceMockPubsub: false, pkcOptions: { httpRoutersOptions: [proxyUrl] } });
    pkc._timeouts["comment-ipfs"] = LIMIT_MS;
    const cid = publishedPost.cid!;
    const communityPublicKey = community.publicKey;
    const result: RoundResult = { variant, dialDelayMs, round, loaded: false, elapsedMs: LIMIT_MS };

    const libp2p = Object.values(pkc.clients.libp2pJsClients)[0]._helia.libp2p;
    const originalGetCommunity = pkc.getCommunity.bind(pkc);
    let startedAt = 0;
    pkc.getCommunity = (args) => {
        if (result.firstGetCommunityCallMs === undefined) result.firstGetCommunityCallMs = Date.now() - startedAt;
        return originalGetCommunity(args);
    };
    const onPeerConnect = () => {
        if (result.firstPeerConnectMs === undefined) result.firstPeerConnectMs = Date.now() - startedAt;
    };
    libp2p.addEventListener("peer:connect", onPeerConnect);

    let updatingComment: Comment | undefined;
    try {
        startedAt = Date.now();
        if (variant.startsWith("getComment")) {
            if (variant === "getComment-cid+key+callerGetCommunity")
                void pkc.getCommunity({ publicKey: communityPublicKey }).catch(() => {});
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
    } finally {
        libp2p.removeEventListener("peer:connect", onPeerConnect);
        try {
            await updatingComment?.stop();
        } catch {
            // already stopped
        }
        await pkc.destroy();
    }
    return result;
}

describe("cold comment load by CID with no provider record for the comment (issue #562)", () => {
    it(`${VARIANTS.length} variants x ${DIAL_DELAYS_MS.length} dial delays x ${ROUNDS} rounds`, async () => {
        const results: RoundResult[] = [];
        for (const dialDelayMs of DIAL_DELAYS_MS) {
            for (const variant of VARIANTS) {
                if (!variant.usesCommunity && dialDelayMs !== DIAL_DELAYS_MS[0]) continue;
                for (let round = 1; round <= ROUNDS; round++) {
                    const roundResult = await runRound(variant.key, dialDelayMs, round);
                    results.push(roundResult);
                    console.log("[bench-562]", JSON.stringify(roundResult));
                }
            }
        }

        const seconds = (ms: number | undefined) => (ms === undefined ? "-" : (ms / 1000).toFixed(1));
        const range = (values: (number | undefined)[]) => {
            const defined = values.filter((value): value is number => value !== undefined);
            if (defined.length === 0) return "-";
            return `${seconds(Math.min(...defined))}-${seconds(Math.max(...defined))}`;
        };
        const lines = [
            "| Variant | Dial delay (s) | Loaded | Load time (s) | getCommunity called at (s) | First peer connected at (s) |",
            "|---|---|---|---|---|---|"
        ];
        for (const dialDelayMs of DIAL_DELAYS_MS)
            for (const variant of VARIANTS) {
                const rows = results.filter((row) => row.variant === variant.key && row.dialDelayMs === dialDelayMs);
                if (rows.length === 0) continue;
                const loadedRows = rows.filter((row) => row.loaded);
                lines.push(
                    `| ${variant.key} | ${seconds(dialDelayMs)} | ${loadedRows.length} of ${rows.length} | ${
                        loadedRows.length ? range(loadedRows.map((row) => row.elapsedMs)) : `timeout at ${seconds(LIMIT_MS)}`
                    } | ${range(rows.map((row) => row.firstGetCommunityCallMs))} | ${range(rows.map((row) => row.firstPeerConnectMs))} |`
                );
            }
        const table = lines.join("\n");
        console.log(`\n[bench-562] summary (${LABEL})\n${table}\n`);

        const outDir = path.resolve(".tmp");
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(
            path.join(outDir, `bench-562-${LABEL}.json`),
            JSON.stringify({ label: LABEL, limitMs: LIMIT_MS, results }, null, 2)
        );
        fs.writeFileSync(path.join(outDir, `bench-562-${LABEL}.md`), table + "\n");
    });
});
