// Gateway-reader loading benchmark for issue #328. Standalone on purpose: it takes a repo root
// and imports THAT repo's dist, so the identical measurement can run against the pre-fix build
// (the main checkout) and the fix branch (this worktree). Requires the test server.
//
//   node test/benchmarks/gateway-loading-bench.mjs <repoRoot> [samples]
//
// Metrics, per sample, all through a gateway-only PKC at the production updateInterval (60s):
//   initialLoadMs: createCommunity + update() -> first "update" event (fresh static record)
//   propagationMs: publish a newer record generation -> "update" event delivering it,
//                  clock started after publishToIpns returns (same convention as
//                  test/node-and-browser/community/update-freshness-gateway.test.ts)

const [repoRoot, samplesArg] = process.argv.slice(2);
if (!repoRoot) throw new Error("usage: node bench-gateway-loading.mjs <repoRoot> [samples]");
const samples = Number(samplesArg ?? 3);

const { mockGatewayPKC, publishCommunityRecordWithExtraProp } = await import(`${repoRoot}/dist/node/test/test-util.js`);
const { signCommunity } = await import(`${repoRoot}/dist/node/signer/signatures.js`);
const { timestamp } = await import(`${repoRoot}/dist/node/util.js`);

const initialLoadMs = [];
const propagationMs = [];

for (let i = 0; i < samples; i++) {
    const pkc = await mockGatewayPKC({ pkcOptions: { updateInterval: 60_000 } });
    const staticRecord = await publishCommunityRecordWithExtraProp();

    const community = await pkc.createCommunity({ address: staticRecord.ipnsObj.signer.address });
    let t0 = Date.now();
    const firstUpdate = new Promise((resolve) => community.once("update", resolve));
    await community.update();
    await firstUpdate;
    initialLoadMs.push(Date.now() - t0);

    const next = JSON.parse(JSON.stringify(staticRecord.communityRecord));
    next.updatedAt = Math.max(community.updatedAt + 1, timestamp());
    next.signature = await signCommunity({ community: next, signer: staticRecord.ipnsObj.signer });
    const delivered = new Promise((resolve) => {
        const onUpdate = () => {
            if (community.updatedAt === next.updatedAt) {
                community.removeListener("update", onUpdate);
                resolve();
            }
        };
        community.on("update", onUpdate);
    });
    await staticRecord.ipnsObj.publishToIpns(JSON.stringify(next));
    t0 = Date.now();
    await delivered;
    propagationMs.push(Date.now() - t0);

    await community.stop();
    await staticRecord.ipnsObj.pkc.destroy();
    await pkc.destroy();
    console.error(`sample ${i + 1}/${samples}: initialLoad=${initialLoadMs[i]}ms propagation=${propagationMs[i]}ms`);
}

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
console.log(
    JSON.stringify({
        repoRoot,
        samples,
        initialLoadMs,
        propagationMs,
        medianInitialLoadMs: median(initialLoadMs),
        medianPropagationMs: median(propagationMs)
    })
);
process.exit(0);
