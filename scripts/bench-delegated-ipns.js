// Timing benchmark (issue #93): measures the wall-clock cost of the extra IPNS hop that a
// delegated community adds, across the three loading mechanisms (kubo RPC, helia/libp2p-js,
// gateway). It is a measurement tool, not a regression gate, so it lives here under scripts/
// rather than in the test suite. Run it with the test server up:
//
//   node scripts/bench-delegated-ipns.js
//
// Tune iterations with BENCH_IPNS_ITERATIONS (default 7).
//
// Requires a prior `npm run build` (it imports the compiled helpers from dist/) and the node
// test server running (it talks to the local kubo node, HTTP router and gateway the server starts).
//
// Assumptions baked into the harness:
//   - No DHT. Helia resolves IPNS via the local HTTP router (localhost:20001); kubo resolves the
//     records straight from its own datastore (they are published with allowOffline); the gateway
//     recurses internally. No DHT walk is involved on any path.
//   - The same peer serves every key. createDelegatedCommunityIpns publishes the anchor record and
//     the minter record to the SAME local kubo node, so both hops are provided by the same peer.
//
// For each mechanism we load the SAME community record two ways:
//   - direct    : load the minter name (Mn -> /ipfs/cid). A normal single-hop load.
//   - delegated : load the anchor name (An -> Mn -> /ipfs/cid). One extra IPNS hop over P2P; over a
//                 gateway it is still a single plain GET (the gateway recurses internally).
// Same CID and content either way, so the wall-clock delta isolates the extra hop's cost. The P2P
// paths re-resolve IPNS on every load (recursive:false + nocache:true), so the hop cost is paid
// each iteration rather than served from a name cache.

import {
    createDelegatedCommunityIpns,
    getAvailablePKCConfigsToTestAgainst,
    resolveWhenConditionIsTrue
} from "../dist/node/test/test-util.js";

const BENCH_ITERATIONS = Number(process.env.BENCH_IPNS_ITERATIONS ?? 7);

// The three loading mechanisms, regardless of any --pkc-config (this runs outside the test runner).
const benchConfigs = getAvailablePKCConfigsToTestAgainst({
    includeAllPossibleConfigOnEnv: true,
    includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs", "remote-ipfs-gateway"]
});

const median = (xs) => {
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Loads a community via createCommunity()+update() (more reliable than getCommunity which does a
// one-shot fetch) and resolves once it has an update.
async function loadCommunityViaUpdate(pkc, address) {
    const community = await pkc.createCommunity({ address });
    const updatePromise = new Promise((resolve) => community.once("update", () => resolve()));
    await community.update();
    await updatePromise;
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    return community;
}

async function benchOneMechanism(config) {
    // forceMockPubsub keeps live-update subscriptions out of the measured path so we time
    // resolution + content fetch, not pubsub warmup churn.
    const pkc = await config.pkcInstancePromise({ forceMockPubsub: true });
    const { anchorName, terminalName } = await createDelegatedCommunityIpns({});

    const timeLoad = async (address) => {
        const start = performance.now();
        const community = await loadCommunityViaUpdate(pkc, address);
        const elapsed = performance.now() - start;
        await community.stop();
        return elapsed;
    };

    try {
        // Warm up both paths so the shared CID content is cached and we measure the steady-state
        // hop cost rather than a first-touch content fetch.
        await timeLoad(terminalName);
        await timeLoad(anchorName);

        const direct = [];
        const delegated = [];
        for (let i = 0; i < BENCH_ITERATIONS; i++) {
            // Alternate order so any residual cache warmth does not systematically favor one path.
            if (i % 2 === 0) {
                direct.push(await timeLoad(terminalName));
                delegated.push(await timeLoad(anchorName));
            } else {
                delegated.push(await timeLoad(anchorName));
                direct.push(await timeLoad(terminalName));
            }
        }

        const directMs = median(direct);
        const delegatedMs = median(delegated);

        console.log(
            `[bench ${config.testConfigCode}] direct(1-hop)=${directMs.toFixed(1)}ms ` +
                `delegated(2-hop)=${delegatedMs.toFixed(1)}ms delta=${(delegatedMs - directMs).toFixed(1)}ms ` +
                `ratio=${(delegatedMs / directMs).toFixed(2)}x ` +
                `(n=${BENCH_ITERATIONS}, direct=[${direct.map((x) => x.toFixed(0)).join(",")}] ` +
                `delegated=[${delegated.map((x) => x.toFixed(0)).join(",")}])`
        );

        return {
            mechanism: config.testConfigCode,
            directMs,
            delegatedMs,
            deltaMs: delegatedMs - directMs,
            ratio: delegatedMs / directMs
        };
    } finally {
        await pkc.destroy();
    }
}

async function main() {
    const benchRows = [];
    for (const config of benchConfigs) {
        benchRows.push(await benchOneMechanism(config));
    }

    // Combined table: direct (1-hop) vs delegated (2-hop over P2P) load times per mechanism.
    // deltaMs is the cleanest signal (constant per-load overhead cancels); ratio is diluted by it.
    console.log(`\nDelegated IPNS load timing (median of ${BENCH_ITERATIONS} runs, ms):`);
    console.table(
        benchRows.map((r) => ({
            mechanism: r.mechanism,
            "direct(1-hop)": Number(r.directMs.toFixed(1)),
            "delegated(2-hop)": Number(r.delegatedMs.toFixed(1)),
            "delta(ms)": Number(r.deltaMs.toFixed(1)),
            ratio: Number(r.ratio.toFixed(2))
        }))
    );
}

main().then(
    () => process.exit(0),
    (e) => {
        console.error(e);
        process.exit(1);
    }
);
