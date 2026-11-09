// Tier 2 of the leak suite (#496): memory growth rate over hundreds of iterations.
//
// The per-PR retention tests (test/node/leaks/) catch an operation that leaves one *object* behind.
// This soak catches what they cannot: a few hundred bytes retained per operation somewhere the graph
// walk does not reach, and native memory (SQLite statements, buffers in malloc) that only RSS shows.
// Each scenario samples heapUsed / external / arrayBuffers / rss after a forced gc every
// SOAK_SAMPLE_EVERY iterations, fits a least-squares slope and fails above the per-iteration budget.
// On a failure it leaves a baseline and a final heap snapshot plus a constructor-count diff in the
// report directory, which the nightly workflow uploads as an artifact.
//
// What the default budgets catch: a leak of a few KB or more per operation (#490 was ~2 MB per
// publish). A 300-iteration run on Node 22 measures 1.4-5.1 KB/iteration with no leak, from bounded
// state still filling up: LRU caches growing toward their max, the mock pubsub's 30 s dedupe timers,
// and Node 22's AbortSignal.any() bookkeeping over the never-aborted pkc destroy signal (~110 B per
// call, fixed in Node 24). Smaller per-object leaks are the per-PR retention tests' job: they count
// objects, not bytes. Each run writes its slopes to soak-report.json, which CI uploads, so trends show.
//
// Tier 3, the long daemon soak, is the same file with SOAK_DURATION_MINUTES set: every scenario runs
// for that long instead of SOAK_ITERATIONS, and `daemon-communities` keeps several communities started
// and publishing like a long-running daemon. The kubo daemon's RSS is sampled alongside.
//
// NOT part of any per-PR CI glob. Run by .github/workflows/CI-leak-soak.yml (nightly: iterations,
// weekly: duration), on demand, and on pull requests labelled `perf`. Locally, with the test server up:
//
//   node test/run-test-config.js --pkc-config local-kubo-rpc test/soak/memory-growth.soak.test.ts
//   SOAK_DURATION_MINUTES=60 SOAK_SCENARIOS=daemon-communities VITEST_TIMEOUT=7200000 \
//     node test/run-test-config.js --pkc-config local-kubo-rpc test/soak/memory-growth.soak.test.ts
//
// Env:
//   SOAK_ITERATIONS (300)          measured iterations per scenario, after warm-up
//   SOAK_WARMUP (30)               warm-up iterations, not measured (caches, JIT, lazily created clients)
//   SOAK_SAMPLE_EVERY (25)         iterations between memory samples
//   SOAK_DURATION_MINUTES          run each scenario for this long instead (tier 3)
//   SOAK_MAX_HEAP_BYTES_PER_ITERATION (8192)   budget for the heapUsed slope
//   SOAK_MAX_RSS_BYTES_PER_ITERATION (49152)   budget for the rss slope (noisier: allocator, JIT, fragmentation)
//   SOAK_MIN_RSS_GATE_SECONDS (60) rss is only gated on runs at least this long: on a short run a single
//                                  allocator step of a few MB dominates the slope; it is still reported
//   SOAK_DAEMON_COMMUNITIES (5)    started communities in the daemon-communities scenario
//   SOAK_SCENARIOS                 comma-separated subset of scenario names, default all
//   SOAK_REPORT_DIR (.tmp/soak)    report JSON, and heap snapshots of failed scenarios
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import PKC from "../../dist/node/index.js";
import {
    createSubWithNoChallenge,
    getAvailablePKCConfigsToTestAgainst,
    mockPKC,
    mockRpcServerPKC,
    publishRandomPost,
    publishStaticCommunityWithPostInPages,
    publishVote,
    resolveWhenConditionIsTrue
} from "../../dist/node/test/test-util.js";
import { measureMemoryGrowth, type MemoryMetric } from "../helpers/leak-detection.js";
import {
    countObjectsByConstructor,
    diffConstructorCounts,
    findRetainerPaths,
    groupNewObjectsByRetainer,
    takeHeapSnapshot
} from "../helpers/heap-snapshot.js";
import { createInProcessRpcServer, uniqueTmpDataPath, type PKCWsServerType } from "../helpers/rpc-server-harness.js";
import signers from "../fixtures/signers.js";
import type { PKC as PKCType } from "../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../dist/node/runtime/node/community/local-community.js";

const envNumber = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
};
const ITERATIONS = envNumber("SOAK_ITERATIONS", 300);
const WARMUP = envNumber("SOAK_WARMUP", 30);
const SAMPLE_EVERY = envNumber("SOAK_SAMPLE_EVERY", 25);
const BUDGETS: Partial<Record<MemoryMetric, number>> = {
    heapUsed: envNumber("SOAK_MAX_HEAP_BYTES_PER_ITERATION", 8192),
    rss: envNumber("SOAK_MAX_RSS_BYTES_PER_ITERATION", 49152)
};
const DURATION_MS = process.env.SOAK_DURATION_MINUTES ? envNumber("SOAK_DURATION_MINUTES", 60) * 60_000 : undefined;
const DAEMON_COMMUNITIES = envNumber("SOAK_DAEMON_COMMUNITIES", 5);
const MIN_RSS_GATE_MS = envNumber("SOAK_MIN_RSS_GATE_SECONDS", 60) * 1000;

// RSS of the kubo daemon serving :15001 (the process listening on the port). Linux only; undefined
// elsewhere. A daemon-side leak shows here even when the pkc-js process is flat.
const kuboDaemonRssBytes = (): number | undefined => {
    try {
        const out = execSync("ss -ltnpH 'sport = :15001'", { encoding: "utf8" });
        const pid = /pid=(\d+)/.exec(out)?.[1];
        if (!pid) return undefined;
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        const kb = /VmRSS:\s+(\d+) kB/.exec(status)?.[1];
        return kb ? Number(kb) * 1024 : undefined;
    } catch {
        return undefined;
    }
};
const REPORT_DIR = path.resolve(process.env.SOAK_REPORT_DIR ?? ".tmp/soak");
const SELECTED = process.env.SOAK_SCENARIOS?.split(",").map((s) => s.trim()).filter(Boolean);

interface Scenario {
    name: string;
    setup: () => Promise<{ iteration: (i: number) => Promise<unknown>; teardown: () => Promise<void>; suspectConstructors: string[] }>;
}

const remoteKuboConfig = () => getAvailablePKCConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true }).find((c) => c.testConfigCode === "remote-kubo-rpc")!;

const scenarios: Scenario[] = [
    {
        name: "remote-community-update-stop",
        setup: async () => {
            const fixture = await publishStaticCommunityWithPostInPages();
            const pkc = await remoteKuboConfig().pkcInstancePromise();
            return {
                suspectConstructors: ["RemoteCommunity"],
                iteration: async () => {
                    const community = await pkc.createCommunity({ address: fixture.communityAddress });
                    await community.update();
                    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
                    await community.stop();
                },
                teardown: async () => {
                    await pkc.destroy();
                    await fixture.ipnsObj.pkc.destroy();
                }
            };
        }
    },
    {
        name: "comment-update-stop",
        setup: async () => {
            const fixture = await publishStaticCommunityWithPostInPages();
            const pkc = await remoteKuboConfig().pkcInstancePromise();
            return {
                suspectConstructors: ["Comment"],
                iteration: async () => {
                    const comment = await pkc.createComment({ cid: fixture.commentCid });
                    await comment.update();
                    await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });
                    await comment.stop();
                },
                teardown: async () => {
                    await pkc.destroy();
                    await fixture.ipnsObj.pkc.destroy();
                }
            };
        }
    },
    {
        name: "publish-remote-kubo",
        setup: async () => {
            // No updating instance of the community here: it mirrors a shared board that every suite
            // publishes to, so its pages grow with the board and read as retention. The per-PR test in
            // test/node/leaks/publishing.leak.test.ts covers publishing next to an updating instance (#490).
            const pkc = await remoteKuboConfig().pkcInstancePromise();
            return {
                suspectConstructors: ["Comment"],
                iteration: async () => {
                    const post = await publishRandomPost({ communityAddress: signers[0].address, pkc });
                    await post.stop();
                },
                teardown: async () => {
                    await pkc.destroy();
                }
            };
        }
    },
    {
        name: "local-community-cycles",
        setup: async () => {
            // One vote per iteration on a fixed post, from a fresh author: a full cycle (CommentUpdate,
            // pages, IPNS) that does not add a page entry, so the community's own data stays the same size
            const pkc = await mockPKC();
            const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
            await community.start();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            const post = await publishRandomPost({ communityAddress: community.address, pkc });
            const postCid = post.cid!;
            await post.stop();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.lastPostCid === postCid });
            return {
                suspectConstructors: ["Vote", "Statement"],
                iteration: async () => {
                    const updatedAtBeforeVote = community.updatedAt!;
                    const vote = await publishVote({ commentCid: postCid, communityAddress: community.address, vote: 1, pkc });
                    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.updatedAt! > updatedAtBeforeVote });
                    await vote.stop();
                },
                teardown: async () => {
                    await community.delete();
                    await pkc.destroy();
                }
            };
        }
    },
    {
        name: "daemon-communities",
        setup: async () => {
            // Several started communities in one PKC, like a daemon hosting boards; each iteration votes on
            // the next community's fixed post and waits for its cycle
            const pkc = await mockPKC();
            const boards: { community: LocalCommunity; postCid: string }[] = [];
            for (let i = 0; i < DAEMON_COMMUNITIES; i++) {
                const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
                await community.start();
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
                const post = await publishRandomPost({ communityAddress: community.address, pkc });
                const postCid = post.cid!;
                await post.stop();
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.lastPostCid === postCid });
                boards.push({ community, postCid });
            }
            return {
                suspectConstructors: ["Vote", "LocalCommunity"],
                iteration: async (i) => {
                    const { community, postCid } = boards[Math.abs(i) % boards.length];
                    const updatedAtBeforeVote = community.updatedAt!;
                    const vote = await publishVote({ commentCid: postCid, communityAddress: community.address, vote: 1, pkc });
                    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.updatedAt! > updatedAtBeforeVote });
                    await vote.stop();
                },
                teardown: async () => {
                    for (const { community } of boards) await community.delete();
                    await pkc.destroy();
                }
            };
        }
    },
    {
        name: "rpc-get-community",
        setup: async () => {
            const serverPKC = await mockRpcServerPKC({ dataPath: uniqueTmpDataPath("pkc-soak-rpc") });
            const { rpcServer, rpcUrl }: { rpcServer: PKCWsServerType; rpcUrl: string } = await createInProcessRpcServer({
                serverPKC,
                authKey: "soak-rpc-get-community"
            });
            const serverCommunity = (await serverPKC.createCommunity({})) as LocalCommunity;
            const client: PKCType = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
            client.on("error", () => {});
            return {
                suspectConstructors: ["RpcLocalCommunity", "PagesPKCRpcStateClient"],
                iteration: async () => {
                    const community = await client.getCommunity({ address: serverCommunity.address });
                    await community.stop();
                },
                teardown: async () => {
                    await client.destroy();
                    await rpcServer.destroy();
                    // rpcServer.destroy() destroys the PKC it was handed
                    if (!serverPKC.destroyed) await serverPKC.destroy();
                }
            };
        }
    }
];

const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    node: process.version,
    iterations: ITERATIONS,
    warmup: WARMUP,
    sampleEvery: SAMPLE_EVERY,
    durationMs: DURATION_MS,
    budgets: BUDGETS,
    scenarios: {}
};

describe("memory growth soak (#496)", () => {
    beforeAll(() => {
        mkdirSync(REPORT_DIR, { recursive: true });
    });

    afterAll(() => {
        writeFileSync(path.join(REPORT_DIR, "soak-report.json"), JSON.stringify(report, null, 2));
    });

    for (const scenario of scenarios) {
        const run = !SELECTED || SELECTED.includes(scenario.name);
        it.runIf(run)(`${scenario.name}: retained bytes per iteration stay within budget`, async () => {
            const { iteration, teardown, suspectConstructors } = await scenario.setup();
            const baselineSnapshot = path.join(REPORT_DIR, `${scenario.name}.baseline.heapsnapshot`);
            const finalSnapshot = path.join(REPORT_DIR, `${scenario.name}.final.heapsnapshot`);
            let kuboRssAtStart: number | undefined;
            try {
                const result = await measureMemoryGrowth({
                    iteration,
                    warmupIterations: WARMUP,
                    iterations: ITERATIONS,
                    durationMs: DURATION_MS,
                    sampleEvery: SAMPLE_EVERY,
                    afterWarmup: () => {
                        kuboRssAtStart = kuboDaemonRssBytes();
                        takeHeapSnapshot(baselineSnapshot);
                    }
                });
                const overBudget = (Object.entries(BUDGETS) as [MemoryMetric, number][])
                    .filter(([metric]) => metric !== "rss" || result.durationMs >= MIN_RSS_GATE_MS)
                    .filter(([metric, budget]) => result.slopes[metric] > budget)
                    .map(([metric, budget]) => ({ metric, bytesPerIteration: Math.round(result.slopes[metric]), budget }));
                const entry: Record<string, unknown> = {
                    durationMs: result.durationMs,
                    measuredIterations: result.samples[result.samples.length - 1]?.iteration,
                    rssGated: result.durationMs >= MIN_RSS_GATE_MS,
                    kuboDaemonRssBytes: { start: kuboRssAtStart, end: kuboDaemonRssBytes() },
                    // Steady state (second half of the samples) is what the budget applies to
                    bytesPerIteration: Object.fromEntries(Object.entries(result.slopes).map(([k, v]) => [k, Math.round(v)])),
                    bytesPerIterationFullRun: Object.fromEntries(Object.entries(result.fullRunSlopes).map(([k, v]) => [k, Math.round(v)])),
                    samples: result.samples,
                    overBudget
                };
                if (overBudget.length > 0) {
                    takeHeapSnapshot(finalSnapshot);
                    entry.constructorGrowth = diffConstructorCounts(
                        countObjectsByConstructor(baselineSnapshot),
                        countObjectsByConstructor(finalSnapshot),
                        Math.ceil(ITERATIONS / 2)
                    ).slice(0, 30);
                    entry.newObjectsByRetainer = groupNewObjectsByRetainer(baselineSnapshot, finalSnapshot);
                    entry.retainerPaths = Object.fromEntries(
                        suspectConstructors.map((name) => [name, findRetainerPaths(finalSnapshot, name, { limit: 2 })])
                    );
                } else rmSync(baselineSnapshot, { force: true });
                (report.scenarios as Record<string, unknown>)[scenario.name] = entry;
                expect(overBudget).toEqual([]);
            } finally {
                await teardown();
            }
        });
    }
});
