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
//   mainThreadCpuPct     CPU of the main thread alone (Linux only, from /proc): what limits one process
//   mainThreadBusyPct    event-loop utilization of the main thread. It also counts time the loop is not
//                        parked in its poll but burns no CPU, so read it next to mainThreadCpuPct and loopDelayMs
//   loopDelayMs          event-loop delay percentiles (p50 / p99 / max)
//   nodeRssMb, heapUsedMb, kuboRssMb, kuboCpuPct
//
// Env:
//   BENCH_SETTLE_S (45)      seconds to wait after the last start() before measuring
//   BENCH_WINDOW_S (120)     measurement window
//   BENCH_CPU_PROFILE (unset) set to 1 to write a V8 .cpuprofile of the window at the largest count, under
//                            .tmp/idle-communities-bench/, readable by cpuprofile-summary.mjs
//   BENCH_START_PROFILE (unset) set to 1 to write a V8 .cpuprofile of creating and starting the communities of the
//                            largest count (from the count before it), as <mode>-<count>-start.cpuprofile
//   BENCH_START_CONCURRENCY (4) communities created and started at a time
//   BENCH_REPUBLISH_IN_WINDOW (unset) set to 1 to make every community publish one new record during the window,
//                            spread evenly over it. This is what the 15 minute republish of an unchanged
//                            community costs: at N communities the real rate is N / 900 records a second, and a
//                            window of BENCH_WINDOW_S makes it N / BENCH_WINDOW_S
//   BENCH_API_PORT (5301), BENCH_SWARM_PORT (4301), BENCH_GATEWAY_PORT (8380)
//
// The gate, for CI (.github/workflows/CI-idle-communities-bench.yml). The cost of one community is the node CPU of a
// count minus the node CPU of the empty node, divided by the count. Exits 1 when a limit is passed:
//   BENCH_MAX_COST_RATIO (unset)  largest count's cost per community / smallest count's. Above 1 means a community
//                            costs more the more of them there are, which is how every problem of #576 looked
//   BENCH_MAX_CPU_PCT_PER_COMMUNITY (unset)  the largest count's cost per community, in % of one core
// All results are also written to .tmp/idle-communities-bench/report-<mode>.json.
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
const republishInWindow = process.env.BENCH_REPUBLISH_IN_WINDOW === "1";
const startProfile = process.env.BENCH_START_PROFILE === "1";
const maxCostRatio = process.env.BENCH_MAX_COST_RATIO ? envNumber("BENCH_MAX_COST_RATIO", 0) : undefined;
const maxCpuPctPerCommunity = process.env.BENCH_MAX_CPU_PCT_PER_COMMUNITY ? envNumber("BENCH_MAX_CPU_PCT_PER_COMMUNITY", 0) : undefined;

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
        const [rss, time] = execFileSync("ps", ["-o", "rss=,time=", "-p", String(pid)])
            .toString()
            .trim()
            .split(/\s+/);
        const [days, clock] = time.includes("-") ? time.split("-") : ["0", time];
        const parts = clock.split(/[:.]/).map(Number);
        while (parts.length < 3) parts.unshift(0);
        return { rssMb: Number(rss) / 1024, cpuS: Number(days) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2] };
    }
};

// CPU seconds of this process's main thread, whose thread id is the process id. undefined off Linux.
const mainThreadCpuSeconds = () => {
    try {
        const stat = readFileSync(`/proc/self/task/${process.pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return (Number(fields[11]) + Number(fields[12])) / 100;
    } catch {
        return undefined;
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
const startCpuProfile = async () => {
    const session = new inspector.Session();
    session.connect();
    await session.post("Profiler.enable");
    await session.post("Profiler.start");
    return session;
};
const writeCpuProfile = async ({ session, name }) => {
    const { profile: cpuProfileResult } = await session.post("Profiler.stop");
    const profilePath = path.join(outDir, `${name}.cpuprofile`);
    writeFileSync(profilePath, JSON.stringify(cpuProfileResult));
    session.disconnect();
    console.error(`CPU profile written to ${path.relative(repoRoot, profilePath)}`);
};
const measure = async ({ count, seconds, profile, startS }) => {
    await delay(settleS * 1000); // let the first publish passes finish
    global.gc?.();
    const session = profile ? await startCpuProfile() : undefined;
    const loopDelay = monitorEventLoopDelay({ resolution: 10 });
    loopDelay.enable();
    const loopUtilizationStart = performance.eventLoopUtilization();
    const cpuStart = process.cpuUsage();
    const mainThreadCpuStart = mainThreadCpuSeconds();
    const kuboStart = processStats(daemon.pid);
    const startedAt = Date.now();
    let republishTimer;
    if (republishInWindow && count > 0) {
        // the same request the 15 minute rule makes: a record with nothing new in it
        let next = 0;
        republishTimer = setInterval(
            () => {
                const community = started[next++];
                if (community) community._communityUpdateTrigger = true;
                else clearInterval(republishTimer);
            },
            (seconds * 1000 * 0.9) / count
        );
    }
    await delay(seconds * 1000);
    clearInterval(republishTimer);
    const cpu = process.cpuUsage(cpuStart);
    const mainThreadCpuEnd = mainThreadCpuSeconds();
    const kuboEnd = processStats(daemon.pid);
    const elapsedS = (Date.now() - startedAt) / 1000;
    const loopUtilization = performance.eventLoopUtilization(loopUtilizationStart);
    loopDelay.disable();
    if (session) await writeCpuProfile({ session, name: `${mode}-${count}` });
    global.gc?.();
    const memory = process.memoryUsage();
    const nodeCpuPct = ((cpu.user + cpu.system) / 1e6 / elapsedS) * 100;
    const result = {
        mode,
        n: count,
        startS,
        updated: started.filter((community) => typeof community.updatedAt === "number").length,
        republishedInWindow: republishInWindow && count > 0,
        nodeCpuPct: round(nodeCpuPct),
        nodeCpuPctPerCommunity: count > 0 ? round(nodeCpuPct / count, 4) : 0,
        mainThreadCpuPct:
            mainThreadCpuStart === undefined || mainThreadCpuEnd === undefined
                ? undefined
                : round(((mainThreadCpuEnd - mainThreadCpuStart) / elapsedS) * 100),
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
    };
    console.log(JSON.stringify(result));
    return result;
};

// What the gate decides on: see the header.
const gate = ({ empty, results }) => {
    const costPerCommunity = (result) => (result.nodeCpuPct - empty.nodeCpuPct) / result.n;
    const smallest = results[0];
    const largest = results[results.length - 1];
    const failures = [];
    const summary = {
        costPerCommunityPct: Object.fromEntries(results.map((result) => [result.n, round(costPerCommunity(result), 4)])),
        costRatio: results.length > 1 ? round(costPerCommunity(largest) / costPerCommunity(smallest), 2) : undefined
    };
    if (maxCostRatio !== undefined && summary.costRatio !== undefined && !(summary.costRatio <= maxCostRatio))
        failures.push(
            `A community costs ${summary.costRatio}x as much at ${largest.n} communities as at ${smallest.n} (limit ${maxCostRatio}x)`
        );
    if (maxCpuPctPerCommunity !== undefined && !(costPerCommunity(largest) <= maxCpuPctPerCommunity))
        failures.push(
            `A community costs ${summary.costPerCommunityPct[largest.n]}% of a core at ${largest.n} communities (limit ${maxCpuPctPerCommunity}%)`
        );
    return { ...summary, failures };
};

let exitCode = 0;
try {
    const empty = await measure({ count: 0, seconds: Math.min(windowS, 30), profile: false });
    const results = [];
    for (const target of targets) {
        const isLargest = target === targets[targets.length - 1];
        const startSession = startProfile && isLargest ? await startCpuProfile() : undefined;
        const startTime = Date.now();
        while (started.length < target)
            await Promise.all(Array.from({ length: Math.min(startConcurrency, target - started.length) }, addOne));
        const startS = round((Date.now() - startTime) / 1000, 0);
        if (startSession) await writeCpuProfile({ session: startSession, name: `${mode}-${target}-start` });
        console.error(`${target} started in ${startS}s`);
        results.push(await measure({ count: target, seconds: windowS, profile: cpuProfile && isLargest, startS }));
    }
    const verdict = gate({ empty, results });
    writeFileSync(path.join(outDir, `report-${mode}.json`), JSON.stringify({ empty, results, ...verdict }, null, 2));
    console.error(`cost per community (% of a core): ${JSON.stringify(verdict.costPerCommunityPct)}, ratio ${verdict.costRatio}`);
    for (const failure of verdict.failures) console.error(`GATE FAILED: ${failure}`);
    if (verdict.failures.length > 0) exitCode = 1;
} finally {
    await pkc.destroy().catch((error) => console.error("destroy", error?.message));
    daemon.kill("SIGTERM");
}
process.exit(exitCode);
