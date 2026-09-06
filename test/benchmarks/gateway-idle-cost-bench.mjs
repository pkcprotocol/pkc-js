// Idle-cost benchmark for issue #328: wire bytes + client CPU of a gateway-backed reader
// keeping ONE community updated while nothing changes (the steady-state regime).
//
//   node test/benchmarks/gateway-idle-cost-bench.mjs <repoRoot> <windowSeconds>
//
// A TCP proxy sits between the client and the test gateway (localhost:18080) counting raw
// bytes in both directions - headers, bodies, and the partial body bytes a pre-fix client
// received before its abort landed - plus HTTP request count and response status mix, parsed
// from chunk starts. CPU is process.cpuUsage() over the window (client process only; daemon
// CPU is shared infrastructure and not isolated here).

import net from "node:net";

const [repoRoot, windowSecondsArg, recordPadBytesArg] = process.argv.slice(2);
if (!repoRoot) throw new Error("usage: node bench-gateway-idle-cost.mjs <repoRoot> <windowSeconds> [recordPadBytes]");
const windowSeconds = Number(windowSecondsArg ?? 180);
// Pad the community record to a realistic size: production records carry preloaded post pages
// and run tens to hundreds of KB, while the bare fixture is under 1KB. The pre-fix client's
// idle cost scales with record size (every poll is a 200 whose body hits the wire), the
// post-fix client's does not (every poll is a bodyless 304).
const recordPadBytes = Number(recordPadBytesArg ?? 0);

let stage = "imports";
setTimeout(() => {
    console.error("bench HARD EXIT: stage never completed:", stage);
    process.exit(2);
}, (windowSeconds + 240) * 1000);

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

// ---- one gateway reader at the production updateInterval, one static community ----
const pkc = await mockGatewayPKC({ pkcOptions: { updateInterval: 60_000, ipfsGatewayUrls: [`http://localhost:${proxyPort}`] } });
// Pad via extraProp WITH includeExtraPropInSignedPropertyNames: the helper re-signs with the
// template record's STORED signedPropertyNames (present fields only), so a padded field not
// pushed into that list is unsigned, every fetch fails verification, and the reader retries
// forever without ever emitting "update" (the silent 18h bench hang of 2026-09-04/05).
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

// Consume a SECOND record generation before the window: a community on its first generation
// makes the pre-fix If-None-Match blob accidentally valid (a single quoted CID), which is not
// the realistic steady state - any long-lived community has been through many generations, and
// from the second onward the pre-fix header never matches again.
const secondGeneration = JSON.parse(JSON.stringify(staticRecord.communityRecord));
secondGeneration.updatedAt = Math.max(community.updatedAt + 1, timestamp());
// reuse gen1's STORED signedPropertyNames so the padded extraProp stays signed
secondGeneration.signature = await _signJson(
    staticRecord.communityRecord.signature.signedPropertyNames,
    secondGeneration,
    staticRecord.ipnsObj.signer,
    signLog
);
const secondConsumed = new Promise((resolve) => {
    const onUpdate = () => {
        if (community.updatedAt === secondGeneration.updatedAt) {
            community.removeListener("update", onUpdate);
            resolve();
        }
    };
    community.on("update", onUpdate);
});
stage = "second-generation";
await staticRecord.ipnsObj.publishToIpns(JSON.stringify(secondGeneration));
await secondConsumed;
console.error("bench: second generation consumed, window starts");
stage = "window";

// steady state starts after the second consume; reset counters and CPU baseline
counters.toGatewayBytes = 0;
counters.fromGatewayBytes = 0;
counters.requests = 0;
counters.statuses = {};
const cpuBaseline = process.cpuUsage();
await new Promise((resolve) => setTimeout(resolve, windowSeconds * 1000));
const cpu = process.cpuUsage(cpuBaseline);

await community.stop();
await staticRecord.ipnsObj.pkc.destroy();
await pkc.destroy();
proxy.close();

const perHour = (x) => Math.round((x / windowSeconds) * 3600);
console.log(
    JSON.stringify({
        repoRoot,
        windowSeconds,
        recordSizeBytes,
        requests: counters.requests,
        statuses: counters.statuses,
        toGatewayBytes: counters.toGatewayBytes,
        fromGatewayBytes: counters.fromGatewayBytes,
        totalBytes: counters.toGatewayBytes + counters.fromGatewayBytes,
        cpuUserMs: Math.round(cpu.user / 1000),
        cpuSystemMs: Math.round(cpu.system / 1000),
        perHour: {
            requests: perHour(counters.requests),
            totalBytes: perHour(counters.toGatewayBytes + counters.fromGatewayBytes),
            cpuMs: perHour(Math.round((cpu.user + cpu.system) / 1000))
        }
    })
);
process.exit(0);
