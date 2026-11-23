// What it costs to get post CommentUpdates into a postUpdates bucket in MFS, by bucket size and by how many
// posts changed (issues #471, #556). Measures the way pkc-js writes them (writePostUpdatesToBucket: the bucket's
// directory patched in node, one CAR import, swapped in with cp/rm/mv, checked with a stat) against the two
// ways it used to:
//
//   swap         writePostUpdatesToBucket, from dist/
//   write        one `files write` (flush:false) per post in batches of 50 and one flush per batch: every cycle
//                below 200 changed posts per bucket, up to 0.0.146
//   write+read   the same, with every file read back after the flush: the workaround for ipfs/kubo#11494
//   rebuild      the whole bucket listed and rebuilt in node, then swapped in: 200 changed posts and more, up to
//                0.0.146. Only measured when BENCH_OLD_DIST points at a dist/node that still has
//                rebuildPostUpdatesBucket (a checkout of 0.0.146 or older, built).
//
// NOT part of any CI glob. Needs a kubo daemon (the test server's is fine) and dist/ freshly built:
//
//   npm run build && node test/benchmarks/post-updates-bucket-bench.mjs
//
// Env: BENCH_KUBO_URL (default http://localhost:15001/api/v0), BENCH_BUCKET_SIZES (default 100,1000,5000,18000),
// BENCH_CHANGED (posts changed per measured write, default 1,50,2000), BENCH_ROUNDS (default 5, the median is
// reported), BENCH_FILE_BYTES (size of one CommentUpdate file, default 2000), BENCH_OLD_DIST, BENCH_OUT (JSON
// result file, default .tmp/bench/post-updates-bucket.json). Every directory it makes in MFS is removed again;
// the blocks stay until the daemon's next gc.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { create as createKuboRpcClient } from "kubo-rpc-client";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { writePostUpdatesToBucket } from "../../dist/node/runtime/node/community/local-community/post-updates-bucket.js";

const kuboUrl = process.env.BENCH_KUBO_URL || "http://localhost:15001/api/v0";
const bucketSizes = (process.env.BENCH_BUCKET_SIZES || "100,1000,5000,18000").split(",").map(Number);
const changedCounts = (process.env.BENCH_CHANGED || "1,50,2000").split(",").map(Number);
const rounds = Number(process.env.BENCH_ROUNDS || 5);
const fileBytes = Number(process.env.BENCH_FILE_BYTES || 2000);
const outPath = process.env.BENCH_OUT || ".tmp/bench/post-updates-bucket.json";

const kubo = createKuboRpcClient({ url: kuboUrl });
const benchRoot = `/post-updates-bucket-bench-${Date.now()}`;
// What the bucket code needs of a LocalCommunity
const community = {
    address: benchRoot.slice(1),
    _clientsManager: { getDefaultKuboRpcClient: () => ({ _client: kubo, url: kuboUrl }) },
    _dbHandler: { commentExistsInDb: () => true }
};

const rebuildPostUpdatesBucket = process.env.BENCH_OLD_DIST
    ? (
          await import(
              pathToFileURL(path.resolve(process.env.BENCH_OLD_DIST, "runtime/node/community/local-community/post-updates-bucket.js")).href
          )
      ).rebuildPostUpdatesBucket
    : undefined;

const textEncoder = new TextEncoder();
const postCid = async (index) => CID.createV0(await sha256.digest(textEncoder.encode(`bench post ${index}`))).toString();
let generation = 0;
const updateFile = (cid) => {
    const head = JSON.stringify({ cid, updatedAt: ++generation });
    return textEncoder.encode(head.padEnd(fileBytes, " "));
};
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const timed = async (fn) => {
    const start = performance.now();
    await fn();
    return performance.now() - start;
};

const strategies = {
    swap: async ({ bucketPath, posts }) => writePostUpdatesToBucket({ community, bucketPath, posts }),
    write: async ({ bucketPath, posts }) => writeOneByOne({ bucketPath, posts, readBack: false }),
    "write+read": async ({ bucketPath, posts }) => writeOneByOne({ bucketPath, posts, readBack: true }),
    ...(rebuildPostUpdatesBucket
        ? { rebuild: async ({ bucketPath, posts }) => rebuildPostUpdatesBucket({ community, bucketPath, posts }) }
        : {})
};

async function writeOneByOne({ bucketPath, posts, readBack }) {
    for (let index = 0; index < posts.length; index += 50) {
        const batch = posts.slice(index, index + 50);
        await Promise.all(
            batch.map((post) =>
                kubo.files.write(`${bucketPath}/${post.postCid}/update`, post.updateFileBytes, {
                    create: true,
                    truncate: true,
                    parents: true,
                    flush: false
                })
            )
        );
        await kubo.files.flush(benchRoot);
        if (readBack)
            await Promise.all(
                batch.map(async (post) => {
                    for await (const chunk of kubo.files.read(`${bucketPath}/${post.postCid}/update`)) void chunk;
                })
            );
    }
}

const results = [];
try {
    for (const bucketSize of bucketSizes) {
        const cids = await Promise.all(Array.from({ length: bucketSize }, (_, index) => postCid(index)));
        for (const [name, write] of Object.entries(strategies)) {
            // Every strategy gets its own bucket, built the same way
            const bucketPath = `${benchRoot}/${name.replace("+", "-")}-${bucketSize}/postUpdates/86400`;
            const fresh = cids.map((cid) => ({ postCid: cid, updateFileBytes: updateFile(cid) }));
            const createMs =
                name === "swap" || name === "rebuild"
                    ? await timed(() => write({ bucketPath, posts: fresh }))
                    : (await writePostUpdatesToBucket({ community, bucketPath, posts: fresh }), undefined);
            if (createMs !== undefined) results.push({ bucketSize, strategy: name, changed: "all (new bucket)", ms: Math.round(createMs) });

            for (const changed of changedCounts) {
                if (changed > bucketSize) continue;
                const samples = [];
                for (let round = 0; round < rounds; round++) {
                    // Different posts every round, spread over the bucket
                    const posts = Array.from({ length: changed }, (_, index) => {
                        const cid = cids[(round * 7919 + index * Math.max(1, Math.floor(bucketSize / changed))) % bucketSize];
                        return { postCid: cid, updateFileBytes: updateFile(cid) };
                    });
                    samples.push(await timed(() => write({ bucketPath, posts })));
                }
                const row = {
                    bucketSize,
                    strategy: name,
                    changed,
                    ms: Number(median(samples).toFixed(1)),
                    min: Number(Math.min(...samples).toFixed(1)),
                    max: Number(Math.max(...samples).toFixed(1))
                };
                results.push(row);
                console.log(JSON.stringify(row));
            }
        }
    }
} finally {
    await kubo.files.rm(benchRoot, { recursive: true }).catch(() => undefined);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ kuboUrl, fileBytes, rounds, results }, null, 2));
console.table(results);
console.log(`Results written to ${outPath}`);
