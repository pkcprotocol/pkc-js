// What N started, idle communities cost one pkc-js process and its Kubo (issue #576). NOT part of any CI glob;
// run manually with dist/ freshly built. It starts its own isolated Kubo (no bootstrap, no HTTP routers), so the
// test server is not needed:
//
//   node --expose-gc test/benchmarks/idle-communities-bench.mjs profile 100 400 1600
//   node --expose-gc test/benchmarks/idle-communities-bench.mjs board 100 400
//
// "profile" is the BSIP-14 author profile (challenge exchange off, owner-only posting, one preloaded "new" sort);
// "board" is createCommunity({ anchor, title }) with defaults. Every community is created, has its anchor record
// published and is started; nothing is ever posted. After BENCH_SETTLE_S the process is measured over BENCH_WINDOW_S.
//
// Per count it prints one JSON line:
//   nodeCpuPct           process.cpuUsage() (user + system, all threads) as a percentage of one core
//   nodeCpuPctPerCommunity  the same divided by the count: the number that must not rise with N
//   mainThreadBusyPct    event-loop utilization of the main thread
//   loopDelayMs          event-loop delay percentiles (p50 / p99 / max)
//   nodeRssMb, heapUsedMb, kuboRssMb, kuboCpuPct
//
// Env:
//   BENCH_SETTLE_S (45)      seconds to wait after the last start() before measuring
//   BENCH_WINDOW_S (120)     measurement window
//   BENCH_CPU_PROFILE (unset) set to 1 to write a V8 .cpuprofile of the window at the largest count, under
//                            .tmp/idle-communities-bench/, readable by cpuprofile-summary.mjs
//   BENCH_START_CONCURRENCY (4) communities created and started at a time
//   BENCH_API_PORT (5301), BENCH_SWARM_PORT (4301), BENCH_GATEWAY_PORT (8380)
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import inspector from "node:inspector/promises";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { path as kuboBinaryPath } from "kubo";
import PKC from "../../dist/node/index.js";
import { createAnchorIpnsRecord, createSigner } from "../../dist/node/signer/index.js";

const [mode, ...counts] = process.argv.slice(2);
const targets = counts.map(Number);
if (!["profile", "board"].includes(mode) || targets.length === 0 || targets.some((n) => !Number.isInteger(n) || n <= 0)) {
    console.error("Usage: node --expose-gc test/benchmarks/idle-communities-bench.mjs <profile|board> <count> [count...]");
    process.exit(1);
}
const envNumber = (name, fallback) => (process.env[name] ? Number(process.env[name]) : fallback);
const settleS = envNumber("BENCH_SETTLE_S", 45);
const windowS = envNumber("BENCH_WINDOW_S", 120);
const startConcurrency = envNumber("BENCH_START_CONCURRENCY", 4);
const apiPort = envNumber("BENCH_API_PORT", 5301);
const swarmPort = envNumber("BENCH_SWARM_PORT", 4301);
const gatewayPort = envNumber("BENCH_GATEWAY_PORT", 8380);
const cpuProfile = process.env.BENCH_CPU_PROFILE === "1";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(repoRoot, ".tmp", "idle-communities-bench");
const runDir = path.join(outDir, `run-${mode}`);
rmSync(runDir, { recursive: true, force: true });
const kuboDir = path.join(runDir, "kubo");
mkdirSync(kuboDir, { recursive: true });

const ipfs = kuboBinaryPath();
const kuboEnv = { ...process.env, IPFS_PATH: kuboDir, IPFS_TELEMETRY: "off" };
execFileSync(ipfs, ["init"], { env: kuboEnv, stdio: "pipe" });
const kuboConfigPath = path.join(kuboDir, "config");
const kuboConfig = JSON.parse(readFileSync(kuboConfigPath, "utf8"));
kuboConfig.Addresses = {
    ...kuboConfig.Addresses,
    API: `/ip4/127.0.0.1/tcp/${apiPort}`,
    Gateway: `/ip4/127.0.0.1/tcp/${gatewayPort}`,
    Swarm: [`/ip4/127.0.0.1/tcp/${swarmPort}`]
};
kuboConfig.Bootstrap = [];
kuboConfig.Routing = { Type: "dht", AcceleratedDHTClient: false };
kuboConfig.Discovery = { MDNS: { Enabled: false } };
kuboConfig.AutoConf = { Enabled: false };
kuboConfig.DNS = { ...(kuboConfig.DNS ?? {}), Resolvers: {} };
kuboConfig.Ipns = { ...(kuboConfig.Ipns ?? {}), DelegatedPublishers: [] };
writeFileSync(kuboConfigPath, JSON.stringify(kuboConfig, null, 2));

const daemon = spawn(ipfs, ["daemon", "--enable-pubsub-experiment", "--enable-namesys-pubsub"], {
    env: kuboEnv,
    stdio: ["ignore", "pipe", "pipe"]
});
let daemonReady = false;
let daemonExited = false;
daemon.stdout.on("data", (chunk) => {
    if (chunk.toString().includes("Daemon is ready")) daemonReady = true;
});
daemon.stderr.on("data", () => {});
daemon.on("exit", () => (daemonExited = true));
while (!daemonReady) {
    if (daemonExited) throw new Error("The Kubo daemon exited before it was ready (are the BENCH_*_PORT ports free?)");
    await delay(100);
}

// RSS in MB and cumulative CPU seconds of another process. /proc gives clock-tick resolution on Linux; ps is the
// portable fallback with one-second resolution.
const processStats = (pid) => {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
        return { rssMb: rssKb / 1024, cpuS: (Number(fields[11]) + Number(fields[12])) / 100 };
    } catch {
        const [rss, time] = execFileSync("ps", ["-o", "rss=,time=", "-p", String(pid)]).toString().trim().split(/\s+/);
        const [days, clock] = time.includes("-") ? time.split("-") : ["0", time];
        const parts = clock.split(/[:.]/).map(Number);
        while (parts.length < 3) parts.unshift(0);
        return { rssMb: Number(rss) / 1024, cpuS: Number(days) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2] };
    }
};

const kuboUrl = `http://127.0.0.1:${apiPort}/api/v0`;
const pkc = await PKC({
    kuboRpcClientsOptions: [kuboUrl],
    pubsubKuboRpcClientsOptions: [kuboUrl],
    dataPath: path.join(runDir, "pkc"),
    httpRoutersOptions: []
});
pkc.on("error", (error) => console.error("pkc error", error?.message));

const profileOptions = (anchorAddress) => ({
    anchor: { publicKey: anchorAddress },
    roles: { [anchorAddress]: { role: "owner" } },
    suggested: { uiType: "author" },
    settings: {
        disablePubsubChallengeExchange: true,
        challenges: [
            {
                name: "fail",
                options: { error: "Only the owner can post to this profile." },
                publicOptions: ["error"],
                exclude: [{ roles: ["owner"] }]
            }
        ],
        pages: { posts: [{ name: "new", preloaded: true }], replies: [] }
    }
});
const boardOptions = (anchorAddress) => ({ anchor: { publicKey: anchorAddress }, title: "Bench board" });

const started = [];
const addOne = async () => {
    const anchorSigner = await createSigner();
    const options = mode === "profile" ? profileOptions(anchorSigner.address) : boardOptions(anchorSigner.address);
    const community = await pkc.createCommunity(options);
    community.on("error", () => {});
    const record = await createAnchorIpnsRecord({ anchorSigner, minterIpnsName: community.signer.address, sequence: 0 });
    await community.publishAnchorRecord(record);
    await community.start();
    started.push(community);
};

const round = (value, digits = 1) => Number(value.toFixed(digits));
const measure = async ({ count, seconds, profile }) => {
    await delay(settleS * 1000); // let the first publish passes finish
    global.gc?.();
    let session;
    if (profile) {
        session = new inspector.Session();
        session.connect();
        await session.post("Profiler.enable");
        await session.post("Profiler.start");
    }
    const loopDelay = monitorEventLoopDelay({ resolution: 10 });
    loopDelay.enable();
    const loopUtilizationStart = performance.eventLoopUtilization();
    const cpuStart = process.cpuUsage();
    const kuboStart = processStats(daemon.pid);
    const startedAt = Date.now();
    await delay(seconds * 1000);
    const cpu = process.cpuUsage(cpuStart);
    const kuboEnd = processStats(daemon.pid);
    const elapsedS = (Date.now() - startedAt) / 1000;
    const loopUtilization = performance.eventLoopUtilization(loopUtilizationStart);
    loopDelay.disable();
    if (session) {
        const { profile: cpuProfileResult } = await session.post("Profiler.stop");
        const profilePath = path.join(outDir, `${mode}-${count}.cpuprofile`);
        writeFileSync(profilePath, JSON.stringify(cpuProfileResult));
        session.disconnect();
        console.error(`CPU profile written to ${path.relative(repoRoot, profilePath)}`);
    }
    global.gc?.();
    const memory = process.memoryUsage();
    const nodeCpuPct = ((cpu.user + cpu.system) / 1e6 / elapsedS) * 100;
    console.log(
        JSON.stringify({
            mode,
            n: count,
            updated: started.filter((community) => typeof community.updatedAt === "number").length,
            nodeCpuPct: round(nodeCpuPct),
            nodeCpuPctPerCommunity: count > 0 ? round(nodeCpuPct / count, 4) : 0,
            mainThreadBusyPct: round(loopUtilization.utilization * 100),
            loopDelayMs: {
                p50: round(loopDelay.percentile(50) / 1e6),
                p99: round(loopDelay.percentile(99) / 1e6),
                max: round(loopDelay.max / 1e6)
            },
            nodeRssMb: round(memory.rss / 1048576, 0),
            heapUsedMb: round(memory.heapUsed / 1048576, 0),
            kuboRssMb: round(kuboEnd.rssMb, 0),
            kuboCpuPct: round(((kuboEnd.cpuS - kuboStart.cpuS) / elapsedS) * 100)
        })
    );
};

try {
    await measure({ count: 0, seconds: Math.min(windowS, 30), profile: false });
    for (const target of targets) {
        const startTime = Date.now();
        while (started.length < target)
            await Promise.all(Array.from({ length: Math.min(startConcurrency, target - started.length) }, addOne));
        console.error(`${target} started in ${((Date.now() - startTime) / 1000).toFixed(0)}s`);
        await measure({ count: target, seconds: windowS, profile: cpuProfile && target === targets[targets.length - 1] });
    }
} finally {
    await pkc.destroy().catch((error) => console.error("destroy", error?.message));
    daemon.kill("SIGTERM");
}
process.exit(0);
