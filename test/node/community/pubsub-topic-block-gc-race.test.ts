import { describe, it, beforeAll, afterAll } from "vitest";
import { create as createKuboRpcClient, type BlockPutOptions, type KuboRPCClient } from "kubo-rpc-client";
import { retryKuboBlockPutPinAndProvidePubsubTopic, pubsubTopicToDhtKeyCid } from "../../../dist/node/util.js";
import Logger from "../../../dist/node/logger.js";

const KUBO_RPC_URL = "http://localhost:15001/api/v0";
const SIGNAL_TIMEOUT_MS = 20000;

// community.start() stores the pubsub-topic routing block on the kubo node and pins it so a repo gc
// cannot take it away. Storing and pinning are two separate RPC calls, and a repo gc that lands in
// between deletes the freshly stored, still unpinned block. `pin add` on a block the node no longer
// has does not fail: it opens a bitswap session and waits for the network to hand the block back,
// which on a node with no peers never happens, so start() hangs until the test times out. That is
// what wedged three tests in started-communities.test.ts and the republishing beforeAll hook in CI.
//
// The suite forces a repo gc on this shared daemon constantly (over a hundred sweeps in a CI run),
// so the window is hit for real. This test lands a gc in the window deterministically instead of
// waiting for the race to come up.
describe("pubsub topic routing block vs repo gc", () => {
    let kuboRpcClient: KuboRPCClient;
    const pinnedCidsToCleanUp: string[] = [];

    beforeAll(() => {
        kuboRpcClient = createKuboRpcClient({ url: KUBO_RPC_URL });
    });

    afterAll(async () => {
        for (const cid of pinnedCidsToCleanUp) {
            try {
                await kuboRpcClient.pin.rm(cid);
            } catch {
                // the daemon may already have dropped it, nothing to clean up then
            }
        }
    });

    it("keeps the pubsub topic block on the node when a full repo gc runs right after it is stored", async () => {
        const log = Logger("pkc-js:test:pubsub-topic-block-gc-race");
        const pubsubTopic = `/pkc-js-test/gc-race/${Date.now()}-${Math.floor(Math.random() * 100000)}`;
        const expectedCid = pubsubTopicToDhtKeyCid(pubsubTopic);

        // Sweeps the whole repo the moment the block has been stored, which is exactly the window a
        // concurrent community sync's gc hits in CI.
        const clientThatGcsRightAfterStoringTheBlock = {
            block: {
                ...kuboRpcClient.block,
                put: async (bytes: Uint8Array, options?: BlockPutOptions) => {
                    const cid = await kuboRpcClient.block.put(bytes, options);
                    for await (const _gcResult of kuboRpcClient.repo.gc()) {
                        // draining the iterable is what waits for the sweep to finish
                    }
                    return cid;
                }
            },
            pin: kuboRpcClient.pin,
            routing: kuboRpcClient.routing
        };

        const cid = await retryKuboBlockPutPinAndProvidePubsubTopic({
            ipfsClient: clientThatGcsRightAfterStoringTheBlock,
            log,
            pubsubTopic,
            inputNumOfRetries: 0,
            // Without these a call that waits on bitswap does not fail, it hangs forever, and the
            // only signal would be the whole test file timing out.
            blockPutOptions: { signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS) },
            provideOptions: { signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS) }
        });
        pinnedCidsToCleanUp.push(cid.toString());

        expect(cid.toString()).to.equal(expectedCid.toString());

        const blockStat = await kuboRpcClient.block.stat(expectedCid, { signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS) });
        expect(blockStat.size).to.be.greaterThan(0);

        const pinTypes: string[] = [];
        for await (const pin of kuboRpcClient.pin.ls({ paths: expectedCid, signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS) }))
            pinTypes.push(pin.type);
        expect(pinTypes).to.include("recursive");
    });
});
