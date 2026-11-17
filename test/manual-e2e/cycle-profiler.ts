// Per-step timing of a LocalCommunity's publish cycle, for the large-board e2e (issue #386). Nothing in src/
// is changed: the steps are read by wrapping the instance methods and kubo RPC methods the cycle calls, and
// the cycle's edges come from `startedstatechange`. What a cycle is split into, in order:
//
//   commentUpdatesMs   publishing-ipns -> _calculateLatestUpdateTrigger: every CommentUpdate the cycle owes,
//                      flag query (flagQueryMs), calculation (calcMs), reply pages embedded in each update
//                      (replyPagesMs), DB upserts (upsertMs), the posts' postUpdates files (kubo dag.import and the files.cp/rm/mv of the bucket swap)
//   recordPrepMs       -> generateCommunityPosts: postUpdates root cids (postUpdatesRootMs), mod queue pages
//                      (modQueuePagesMs), the stats file
//   postsPagesMs       generateCommunityPosts: every posts sort generated and added to kubo
//   signPublishMs      -> succeeded: record validation and signing (validateRecordMs), the record add, IPNS
//                      publish (kubo name.publish), unpinning the previous cycle's pages (pin.rm, block.rm)
//
// The kubo table is per method over the cycle, ms summed over calls (calls overlap, so the sum can exceed the
// cycle) with kuboWallMs the time at least one call was in flight. replyPagesMs is summed the same way: reply
// pages are generated for a slice of comments concurrently, so it too can exceed the phase it belongs to. repo.gc runs after `succeeded`, once an
// hour per daemon, and is reported as its own event.
import { readFileSync } from "node:fs";
import type { LocalCommunity } from "../../dist/node/runtime/node/community/local-community.js";

const MB = 1024 * 1024;

export type KuboMethodCost = { ms: number; calls: number; mb: number };

export type CycleProfile = {
    cycle: number;
    outcome: "succeeded" | "failed" | "no-record";
    cycleMs: number;
    commentsUpdated: number;
    commentUpdatesMs: number;
    flagQueryMs: number;
    calcMs: number;
    replyPagesMs: number;
    upsertMs: number;
    recordPrepMs?: number;
    postUpdatesRootMs: number;
    modQueuePagesMs: number;
    postsPagesMs?: number;
    signPublishMs?: number;
    validateRecordMs: number;
    kuboWallMs: number;
    kubo: Record<string, KuboMethodCost>;
    heapPeakMB: number;
    rssPeakMB: number;
    kuboRssPeakMB?: number;
    repoSizeMBBefore?: number;
    repoSizeMBAfter?: number;
};

export type RepoGcProfile = { ms: number; afterCycle: number; repoSizeMBAfter?: number };

type Wrapped = (ms: number, args: unknown[]) => void;

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
    typeof value === "object" && value !== null && typeof (<{ then?: unknown }>value).then === "function";
const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
    typeof value === "object" && value !== null && Symbol.asyncIterator in value;

// Replaces target[key] with a version that reports how long the call took: over the returned promise when
// it returns one, over the full consumption when it returns an async iterable (pin.rm, repo.gc), else the
// call itself.
function wrapMethod<T extends object, K extends keyof T>(target: T, key: K, onDone: Wrapped): void {
    const original = target[key];
    if (typeof original !== "function") throw new Error(`cannot time ${String(key)}: not a function`);
    const fn = <(...args: unknown[]) => unknown>(<unknown>original);
    const wrapped = (...args: unknown[]): unknown => {
        const start = performance.now();
        let result: unknown;
        try {
            result = fn.apply(target, args);
        } catch (e) {
            onDone(performance.now() - start, args);
            throw e;
        }
        if (isPromiseLike(result))
            return Promise.resolve(result).then(
                (value) => {
                    onDone(performance.now() - start, args);
                    return value;
                },
                (error: unknown) => {
                    onDone(performance.now() - start, args);
                    throw error;
                }
            );
        if (isAsyncIterable(result)) {
            const iterable = result;
            return (async function* () {
                try {
                    yield* iterable;
                } finally {
                    onDone(performance.now() - start, args);
                }
            })();
        }
        onDone(performance.now() - start, args);
        return result;
    };
    target[key] = <T[K]>(<unknown>wrapped);
}

// Wrapped by explicit path, as the pipeline bench does: a kubo-rpc-client carries frozen module namespaces
// among its properties and a blind walk trips over them. Anything unlisted does not show up in the table.
const KUBO_METHODS = [
    "add",
    "cat",
    "block.rm",
    "block.stat",
    "block.get",
    "dag.import",
    "files.mv",
    "files.flush",
    "files.rm",
    "files.stat",
    "files.mkdir",
    "files.cp",
    "files.ls",
    "name.publish",
    "name.resolve",
    "pin.add",
    "pin.rm",
    "pin.ls",
    "repo.gc",
    "repo.stat",
    "routing.provide"
];

function processRssMB(pid: number): number | undefined {
    try {
        const match = readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+) kB/);
        return match ? Math.round(Number(match[1]) / 1024) : undefined;
    } catch {
        return undefined;
    }
}

export function attachCycleProfiler({
    community,
    kuboPid,
    onCycle,
    onRepoGc
}: {
    community: LocalCommunity;
    kuboPid?: number;
    onCycle: (profile: CycleProfile) => void;
    onRepoGc: (profile: RepoGcProfile) => void;
}): { detach: () => void } {
    const kuboClient = community._clientsManager.getDefaultKuboRpcClient()._client;
    // The unwrapped stat, so the profiler's own reads stay out of the table.
    const repoStat = kuboClient.repo.stat.bind(kuboClient.repo);
    const readRepoSizeMB = async (): Promise<number | undefined> => {
        try {
            const stat = await repoStat({ searchParams: new URLSearchParams({ "size-only": "true" }) });
            return Math.round(Number(stat.repoSize) / MB);
        } catch {
            return undefined;
        }
    };

    let cycleCount = 0;
    let current: (CycleProfile & { t0: number; triggerAt?: number; postsPagesStartAt?: number; postsPagesEndAt?: number }) | undefined;
    let repoSizeBefore: Promise<number | undefined> | undefined;
    const kuboWall = { inFlight: 0, since: 0 };

    const newCycle = () => {
        cycleCount++;
        current = {
            cycle: cycleCount,
            outcome: "no-record",
            cycleMs: 0,
            commentsUpdated: 0,
            commentUpdatesMs: 0,
            flagQueryMs: 0,
            calcMs: 0,
            replyPagesMs: 0,
            upsertMs: 0,
            postUpdatesRootMs: 0,
            modQueuePagesMs: 0,
            validateRecordMs: 0,
            kuboWallMs: 0,
            kubo: {},
            heapPeakMB: 0,
            rssPeakMB: 0,
            t0: performance.now()
        };
        kuboWall.inFlight = 0;
        repoSizeBefore = readRepoSizeMB();
        sample();
    };

    const sample = () => {
        if (!current) return;
        const usage = process.memoryUsage();
        current.heapPeakMB = Math.max(current.heapPeakMB, Math.round(usage.heapUsed / MB));
        current.rssPeakMB = Math.max(current.rssPeakMB, Math.round(usage.rss / MB));
        if (kuboPid) {
            const kubo = processRssMB(kuboPid);
            if (kubo !== undefined) current.kuboRssPeakMB = Math.max(current.kuboRssPeakMB ?? 0, kubo);
        }
    };
    const sampler = setInterval(sample, 1000);

    const finish = async (outcome: CycleProfile["outcome"]) => {
        const cycle = current;
        if (!cycle) return;
        sample();
        current = undefined;
        cycle.outcome = outcome;
        cycle.cycleMs = Math.round(performance.now() - cycle.t0);
        if (cycle.triggerAt !== undefined) cycle.commentUpdatesMs = Math.round(cycle.triggerAt - cycle.t0);
        else cycle.commentUpdatesMs = cycle.cycleMs;
        if (cycle.triggerAt !== undefined && cycle.postsPagesStartAt !== undefined)
            cycle.recordPrepMs = Math.round(cycle.postsPagesStartAt - cycle.triggerAt);
        if (cycle.postsPagesStartAt !== undefined && cycle.postsPagesEndAt !== undefined)
            cycle.postsPagesMs = Math.round(cycle.postsPagesEndAt - cycle.postsPagesStartAt);
        if (cycle.postsPagesEndAt !== undefined && outcome === "succeeded")
            cycle.signPublishMs = Math.round(cycle.t0 + cycle.cycleMs - cycle.postsPagesEndAt);
        cycle.repoSizeMBBefore = await repoSizeBefore;
        if (outcome !== "no-record") cycle.repoSizeMBAfter = await readRepoSizeMB();
        for (const entry of Object.values(cycle.kubo)) {
            entry.ms = Math.round(entry.ms);
            entry.mb = Math.round(entry.mb * 10) / 10;
        }
        cycle.kuboWallMs = Math.round(cycle.kuboWallMs);
        for (const field of [
            "flagQueryMs",
            "calcMs",
            "replyPagesMs",
            "upsertMs",
            "postUpdatesRootMs",
            "modQueuePagesMs",
            "validateRecordMs"
        ] as const)
            cycle[field] = Math.round(cycle[field]);
        const { t0: _t0, triggerAt: _a, postsPagesStartAt: _b, postsPagesEndAt: _c, ...profile } = cycle;
        // An idle loop pass (nothing to update, no record) is noise, not a cycle.
        if (outcome === "no-record" && profile.commentsUpdated === 0) return;
        onCycle(profile);
    };

    const onStartedState = (state: string) => {
        if (state === "publishing-ipns") {
            if (current) void finish("no-record");
            newCycle();
        } else if (state === "succeeded") void finish("succeeded");
        else if (state === "failed") void finish("failed");
    };
    community.on("startedstatechange", onStartedState);

    const addTo =
        (field: "flagQueryMs" | "calcMs" | "replyPagesMs" | "upsertMs" | "postUpdatesRootMs" | "modQueuePagesMs" | "validateRecordMs") =>
        (ms: number) => {
            if (current) current[field] += ms;
        };
    wrapMethod(community._dbHandler, "queryCidsToBeUpdatedByDepth", addTo("flagQueryMs"));
    wrapMethod(community._dbHandler, "queryCalculatedCommentUpdates", addTo("calcMs"));
    wrapMethod(community._dbHandler, "upsertCommentUpdates", (ms, args) => {
        if (!current) return;
        current.upsertMs += ms;
        const updates = args[0];
        if (Array.isArray(updates)) current.commentsUpdated += updates.length;
    });
    wrapMethod(community._pageGenerator, "generateReplyPages", addTo("replyPagesMs"));
    wrapMethod(community._pageGenerator, "generatePostPages", addTo("replyPagesMs"));
    wrapMethod(community._pageGenerator, "generateModQueuePages", addTo("modQueuePagesMs"));
    wrapMethod(community, "_calculateNewPostUpdates", addTo("postUpdatesRootMs"));
    wrapMethod(community, "_validateCommunitySizeSchemaAndSignatureBeforePublishing", addTo("validateRecordMs"));
    // Edges: the trigger check is the first thing updateCommunityIpnsIfNeeded does, so its call marks the end of
    // the CommentUpdate phase; posts generation is the record phase's bulk.
    const originalTrigger = community._calculateLatestUpdateTrigger;
    community._calculateLatestUpdateTrigger = function (this: LocalCommunity) {
        if (current && current.triggerAt === undefined) current.triggerAt = performance.now();
        return originalTrigger.call(community);
    };
    const originalGeneratePosts = community._pageGenerator.generateCommunityPosts;
    community._pageGenerator.generateCommunityPosts = function (
        this: LocalCommunity["_pageGenerator"],
        ...args: Parameters<LocalCommunity["_pageGenerator"]["generateCommunityPosts"]>
    ) {
        if (current) current.postsPagesStartAt = performance.now();
        return originalGeneratePosts.apply(community._pageGenerator, args).finally(() => {
            if (current) current.postsPagesEndAt = performance.now();
        });
    };

    let lastFinishedCycle = 0;
    for (const methodPath of KUBO_METHODS) {
        const segments = methodPath.split(".");
        const owner = segments.slice(0, -1).reduce<unknown>((object, segment) => {
            if (typeof object !== "object" || object === null) return undefined;
            return (<Record<string, unknown>>object)[segment];
        }, kuboClient);
        const name = segments[segments.length - 1];
        if (typeof owner !== "object" || owner === null) continue;
        const ownerRecord = <Record<string, unknown>>owner;
        if (typeof ownerRecord[name] !== "function") continue;
        const started = () => {
            if (kuboWall.inFlight++ === 0) kuboWall.since = performance.now();
        };
        wrapMethod(ownerRecord, name, (ms, args) => {
            if (--kuboWall.inFlight === 0 && current) current.kuboWallMs += performance.now() - kuboWall.since;
            if (methodPath === "repo.gc") {
                void readRepoSizeMB().then((repoSizeMBAfter) =>
                    onRepoGc({ ms: Math.round(ms), afterCycle: lastFinishedCycle, repoSizeMBAfter })
                );
                return;
            }
            if (!current) return;
            const entry = (current.kubo[methodPath] ??= { ms: 0, calls: 0, mb: 0 });
            entry.ms += ms;
            entry.calls++;
            const content = methodPath === "add" ? args[0] : methodPath === "files.write" ? args[1] : undefined;
            if (typeof content === "string") entry.mb += Buffer.byteLength(content) / MB;
            else if (content instanceof Uint8Array) entry.mb += content.byteLength / MB;
        });
        // wrapMethod reports at the end; the in-flight count needs the start too.
        const timed = <(...args: unknown[]) => unknown>ownerRecord[name];
        ownerRecord[name] = (...args: unknown[]) => {
            started();
            return timed(...args);
        };
    }
    community.on("startedstatechange", (state) => {
        if (state === "succeeded" || state === "failed") lastFinishedCycle = cycleCount;
    });

    return {
        detach: () => {
            clearInterval(sampler);
            community.removeListener("startedstatechange", onStartedState);
        }
    };
}
