// Active-scenario benchmark for issue #328: a community publishing a new record generation
// every ~minute (jittered so the publish cadence cannot phase-lock with the reader's poll),
// read by one gateway-backed client at the production updateInterval. Measures, over the
// window: wire bytes both directions (TCP proxy in front of the gateway, so aborted partial
// bodies count as sent), HTTP request count and status mix, client process CPU (NOTE: includes
// the in-process publisher - signing and kubo add - identical work on both sides), and
// per-generation delivery latency (publishToIpns return -> "update" event carrying it).
//
//   node test/benchmarks/gateway-active-cost-bench.mjs <repoRoot> <windowSeconds> <recordPadBytes> [publishEverySeconds]

import net from "node:net";

const [repoRoot, windowSecondsArg, recordPadBytesArg, publishEverySecondsArg] = process.argv.slice(2);
if (!repoRoot) throw new Error("usage: node bench-gateway-active-cost.mjs <repoRoot> <windowSeconds> <recordPadBytes> [publishEverySeconds]");
const windowSeconds = Number(windowSecondsArg ?? 300);
const recordPadBytes = Number(recordPadBytesArg ?? 100_000);
const publishEverySeconds = Number(publishEverySecondsArg ?? 60);

let stage = "imports";
setTimeout(() => {
    console.error("bench HARD EXIT: stage never completed:", stage);
    process.exit(2);
}, (windowSeconds + 300) * 1000);

const { mockGatewayPKC, publishCommunityRecordWithExtraProp } = await import(`${repoRoot}/dist/node/test/test-util.js`);
const { _signJson } = await import(`${repoRoot}/dist/node/signer/signatures.js`);
const { timestamp } = await import(`${repoRoot}/dist/node/util.js`);
const signLog = { error: (...args) => console.error("signJson error:", ...args) };

// ---- byte/request counting TCP proxy in front of the gateway ----
// Requests and statuses are counted on HTTP/1.1 message framing, not per TCP chunk: a chunk can
// carry several messages or split a request/status line, so each direction keeps a per-socket
// line buffer and only counts complete lines. Bodies are JSON/protobuf and never start a line
// with "GET /" or "HTTP/1.", so scanning every complete line is safe here.
const counters = { toGatewayBytes: 0, fromGatewayBytes: 0, requests: 0, statuses: {} };
const REQUEST_LINE = /^(?:GET|HEAD|POST|OPTIONS) \S+ HTTP\/1\.[01]$/;
const STATUS_LINE = /^HTTP\/1\.[01] (\d{3})\b/;
const MAX_PENDING_LINE_BYTES = 64 * 1024; // request/status lines are short; drop a longer partial (a body run)
const lineCounter = (onLine) => {
    let pending = "";
    return (chunk) => {
        pending += chunk.toString("latin1");
        const lines = pending.split("\r\n");
        pending = lines.pop();
        if (pending.length > MAX_PENDING_LINE_BYTES) pending = "";
        for (const line of lines) onLine(line);
    };
};
const proxy = net.createServer((clientSocket) => {
    const gatewaySocket = net.connect(18080, "127.0.0.1");
    const countRequestLines = lineCounter((line) => {
        if (REQUEST_LINE.test(line)) counters.requests += 1;
    });
    const countStatusLines = lineCounter((line) => {
        const statusMatch = line.match(STATUS_LINE);
        if (statusMatch) counters.statuses[statusMatch[1]] = (counters.statuses[statusMatch[1]] || 0) + 1;
    });
    clientSocket.on("data", (chunk) => {
        counters.toGatewayBytes += chunk.length;
        countRequestLines(chunk);
        gatewaySocket.write(chunk);
    });
    gatewaySocket.on("data", (chunk) => {
        counters.fromGatewayBytes += chunk.length;
        countStatusLines(chunk);
        clientSocket.write(chunk);
    });
    const closeBoth = () => {
        clientSocket.destroy();
        gatewaySocket.destroy();
    };
    clientSocket.on("close", closeBoth);
    gatewaySocket.on("close", closeBoth);
    clientSocket.on("error", closeBoth);
    gatewaySocket.on("error", closeBoth);
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyPort = proxy.address().port;

// ---- reader + community, consume two generations before the window (realistic steady state) ----
const pkc = await mockGatewayPKC({ pkcOptions: { updateInterval: 60_000, ipfsGatewayUrls: [`http://localhost:${proxyPort}`] } });
// See the idle bench's note: the pad must ride extraProp WITH
// includeExtraPropInSignedPropertyNames - any other field is unsigned under the helper's
// template signedPropertyNames and fails verification silently.
stage = "publish-record";
const staticRecord = await publishCommunityRecordWithExtraProp(
    recordPadBytes > 0 ? { extraProps: { extraProp: "x".repeat(recordPadBytes) }, includeExtraPropInSignedPropertyNames: true } : undefined
);
console.error("bench: record published, size", Buffer.byteLength(JSON.stringify(staticRecord.communityRecord)));
const recordSizeBytes = Buffer.byteLength(JSON.stringify(staticRecord.communityRecord));
const community = await pkc.createCommunity({ address: staticRecord.ipnsObj.signer.address });
const firstUpdate = new Promise((resolve) => community.once("update", resolve));
stage = "first-update";
await community.update();
await firstUpdate;
console.error("bench: first update consumed");

let latestRecord = staticRecord.communityRecord;
const nextGeneration = async () => {
    const next = JSON.parse(JSON.stringify(latestRecord));
    next.updatedAt = Math.max(latestRecord.updatedAt + 1, timestamp());
    // reuse the stored signedPropertyNames so the padded extraProp stays signed
    next.signature = await _signJson(latestRecord.signature.signedPropertyNames, next, staticRecord.ipnsObj.signer, signLog);
    await staticRecord.ipnsObj.publishToIpns(JSON.stringify(next));
    latestRecord = next;
    return next;
};

const consumeGeneration = (generation) =>
    new Promise((resolve) => {
        const onUpdate = () => {
            if (community.updatedAt >= generation.updatedAt) {
                community.removeListener("update", onUpdate);
                resolve();
            }
        };
        community.on("update", onUpdate);
        if (community.updatedAt >= generation.updatedAt) {
            community.removeListener("update", onUpdate);
            resolve();
        }
    });
stage = "second-generation";
await consumeGeneration(await nextGeneration()); // second generation consumed pre-window
console.error("bench: second generation consumed, window starts");
stage = "window";

// ---- window: publish every ~publishEverySeconds (jittered +-10%), track delivery ----
counters.toGatewayBytes = 0;
counters.fromGatewayBytes = 0;
counters.requests = 0;
counters.statuses = {};
const cpuBaseline = process.cpuUsage();
const windowStart = Date.now();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const generations = []; // { updatedAt, publishedAt, deliveredAt? }
const deliveryWatch = (generation) => {
    const onUpdate = () => {
        if (community.updatedAt === generation.updatedAt) {
            community.removeListener("update", onUpdate);
            generation.deliveredAt = Date.now();
        }
    };
    community.on("update", onUpdate);
};

while (Date.now() - windowStart < windowSeconds * 1000) {
    const jitteredMs = publishEverySeconds * 1000 * (0.9 + Math.random() * 0.2);
    const remainingMs = windowSeconds * 1000 - (Date.now() - windowStart);
    if (remainingMs < jitteredMs) {
        await sleep(remainingMs);
        break;
    }
    await sleep(jitteredMs);
    const record = await nextGeneration();
    console.error("bench: published generation", generations.length + 1, "updatedAt", record.updatedAt);
    const generation = { updatedAt: record.updatedAt, publishedAt: Date.now() };
    generations.push(generation);
    deliveryWatch(generation);
}

// snapshot cost metrics before the grace period: the reader keeps polling during grace, but
// that publish-free traffic is not part of the active window being measured
const cpu = process.cpuUsage(cpuBaseline);
const measuredSeconds = (Date.now() - windowStart) / 1000;
const windowCounters = { ...counters, statuses: { ...counters.statuses } };

// grace: let the last generation(s) arrive (pre-fix needs up to a full 60s poll + cache),
// used only to collect delivery latencies
const graceMs = 90_000;
const graceStart = Date.now();
while (generations.some((g) => !g.deliveredAt) && Date.now() - graceStart < graceMs) await sleep(1000);

await community.stop();
await staticRecord.ipnsObj.pkc.destroy();
await pkc.destroy();
proxy.close();

const delivered = generations.filter((g) => g.deliveredAt);
const latencies = delivered.map((g) => g.deliveredAt - g.publishedAt).sort((a, b) => a - b);
const median = (xs) => (xs.length === 0 ? null : xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2);
console.log(
    JSON.stringify({
        repoRoot,
        windowSeconds,
        measuredSeconds: Math.round(measuredSeconds),
        recordSizeBytes,
        publishEverySeconds,
        generationsPublished: generations.length,
        generationsDelivered: delivered.length,
        deliveryLatenciesMs: latencies,
        medianDeliveryMs: median(latencies),
        requests: windowCounters.requests,
        statuses: windowCounters.statuses,
        toGatewayBytes: windowCounters.toGatewayBytes,
        fromGatewayBytes: windowCounters.fromGatewayBytes,
        totalBytes: windowCounters.toGatewayBytes + windowCounters.fromGatewayBytes,
        cpuUserMs: Math.round(cpu.user / 1000),
        cpuSystemMs: Math.round(cpu.system / 1000),
        perHour: {
            requests: Math.round((windowCounters.requests / measuredSeconds) * 3600),
            totalMB: Number((((windowCounters.toGatewayBytes + windowCounters.fromGatewayBytes) / measuredSeconds) * 3600 / 1e6).toFixed(2)),
            cpuMs: Math.round(((cpu.user + cpu.system) / 1000 / measuredSeconds) * 3600)
        }
    })
);
process.exit(0);
