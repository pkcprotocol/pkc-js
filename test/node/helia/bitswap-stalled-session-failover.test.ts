import { afterEach, describe, expect, it, vi } from "vitest";
import { CID } from "multiformats/cid";
import * as rawCodec from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { createLibp2pJsClientOrUseExistingOne } from "../../../dist/node/helia/helia-for-pkc.js";
import { MockHttpRouter } from "../../../dist/node/runtime/node/test/mock-http-router.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { Libp2pJsClient } from "../../../dist/node/helia/libp2pjsClient.js";
import type { HeliaWithLibp2pPubsub } from "../../../dist/node/helia/types.js";

// Regression coverage for issue #218 part 2: @helia/bitswap's session broker sends a targeted
// WANT-BLOCK to the session peer that didn't answer DONT_HAVE and then waits on that single peer
// with no stall timeout. In production a slow sole-HAVE seeder (~3Mbps uplink serving 65 boards'
// blocks over one connection) monopolizes every session: blocks queue 12-20s behind it and board
// loads blow past their timeouts. cat() must fail over: when a session block hasn't arrived within
// the stall window, race a non-session broadcast want (helia.blockstore.get) against the stalled
// session get and return whichever produces the block first.
//
// The slow sole-HAVE peer is modeled deterministically by stubbing the session's get() to never
// deliver (it only ends on abort), while the block is available to the fallback path. On master the
// stalled session hangs cat() until its timeout aborts everything.
//
// Client-side libp2p only and config-independent, so it runs once under non-RPC.
describeSkipIfRpc("Bitswap stalled-session block failover (issue #218)", () => {
    // Lower bound on when the failover may deliver: it must NOT fire immediately (an instant
    // broadcast want per block would reintroduce the per-block want-flood sessions were added to
    // prevent, issue #189). Slightly below the production stall window so timer jitter can't flake.
    const FAILOVER_MUST_NOT_FIRE_BEFORE_MS = 2_000;
    // Upper bound: with the stall window at ~2.5s and the fallback serving the block immediately,
    // cat() must complete well before the 10s cat timeout below.
    const FAILOVER_DEADLINE_MS = 7_000;
    // cat()'s own kubo-style timeout: on master the stalled session hangs cat() until this aborts
    // it, so the missing-failover regression surfaces as ERR_FETCH_CID_P2P_TIMEOUT at 10s.
    const CAT_TIMEOUT = "10s";
    // When the session delivers promptly the failover must not have started; generous CI margin.
    const PROMPT_SESSION_DEADLINE_MS = 2_000;

    type HeliaBlockstore = HeliaWithLibp2pPubsub["blockstore"];
    type SessionBlockstore = ReturnType<HeliaBlockstore["createSession"]>;
    type SessionGetParams = Parameters<SessionBlockstore["get"]>;

    const startedRouters: MockHttpRouter[] = [];
    const clientsToStop: Libp2pJsClient[] = [];
    let keyCounter = 0;

    afterEach(async () => {
        let stopError: unknown;
        while (clientsToStop.length) {
            try {
                await clientsToStop.pop()!.heliaWithKuboRpcClientFunctions.stop();
            } catch (e) {
                stopError ??= e;
            }
        }
        while (startedRouters.length) {
            try {
                await startedRouters.pop()!.destroy();
            } catch {
                // already destroyed
            }
        }
        if (stopError) throw stopError;
    });

    // createLibp2pJsClientOrUseExistingOne requires at least one HTTP router; a started empty mock
    // router keeps the test hermetic (no production routers, no Kubo).
    const createClient = async (): Promise<Libp2pJsClient> => {
        const router = new MockHttpRouter();
        await router.start();
        startedRouters.push(router);
        const client = (await createLibp2pJsClientOrUseExistingOne({
            key: `bitswap-stalled-session-failover-${keyCounter++}`,
            httpRoutersOptions: [router.url],
            libp2pOptions: {},
            heliaOptions: {}
        })) as Libp2pJsClient;
        clientsToStop.push(client);
        return client;
    };

    const makeRawBlock = async (content: string): Promise<{ cid: CID; bytes: Uint8Array }> => {
        const bytes = new TextEncoder().encode(content);
        return { cid: CID.createV1(rawCodec.code, await sha256.digest(bytes)), bytes };
    };

    const abortReasonAsError = (signal: AbortSignal): Error =>
        signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted"));

    // Replace every session's get() with one that never delivers a block and only ends when its
    // signal aborts — the deterministic stand-in for a session pinned on a slow sole-HAVE peer.
    // Returns the signals handed to the stalled gets so the test can assert the failover winner
    // aborted the stalled loser instead of leaking it.
    const stubSessionsToStall = (helia: HeliaWithLibp2pPubsub): { sessionGetSignals: (AbortSignal | undefined)[] } => {
        const sessionGetSignals: (AbortSignal | undefined)[] = [];
        const originalCreateSession = helia.blockstore.createSession.bind(helia.blockstore);
        helia.blockstore.createSession = (root, options) => {
            const session = originalCreateSession(root, options);
            session.get = async function* (_cid: SessionGetParams[0], getOptions?: SessionGetParams[1]) {
                sessionGetSignals.push(getOptions?.signal);
                await new Promise<never>((_resolve, reject) => {
                    const signal = getOptions?.signal;
                    if (signal == null) return; // no signal: stall forever, like a peer that never answers
                    if (signal.aborted) {
                        reject(abortReasonAsError(signal));
                        return;
                    }
                    signal.addEventListener("abort", () => reject(abortReasonAsError(signal)), { once: true });
                });
                yield new Uint8Array(0); // unreachable, satisfies the generator's type
            };
            return session;
        };
        return { sessionGetSignals };
    };

    const catToBuffer = async (client: Libp2pJsClient, ipfsPath: string): Promise<Buffer> => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of client.heliaWithKuboRpcClientFunctions.cat(ipfsPath, { timeout: CAT_TIMEOUT })) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    };

    it("cat() falls back to a broadcast want and still returns the block when the session stalls", async () => {
        const client = await createClient();
        const helia = client._helia;
        const { cid, bytes } = await makeRawBlock("bitswap stalled session failover block (issue #218)");
        // The block is reachable by the fallback path (helia.blockstore.get) but the session never
        // delivers it — the sole-HAVE seeder is "serving" it too slowly to ever arrive.
        await helia.blockstore.put(cid, bytes);
        const { sessionGetSignals } = stubSessionsToStall(helia);

        const startedAt = Date.now();
        const fetched = await catToBuffer(client, cid.toString());
        const elapsedMs = Date.now() - startedAt;

        expect(fetched.equals(Buffer.from(bytes))).to.equal(true);
        // The session was actually consulted and stalled...
        expect(sessionGetSignals.length).to.be.at.least(1);
        // ...the failover waited out the stall window instead of broadcasting instantly...
        expect(elapsedMs).to.be.at.least(FAILOVER_MUST_NOT_FIRE_BEFORE_MS);
        // ...and delivered long before cat()'s timeout would have fired.
        expect(elapsedMs).to.be.lessThan(FAILOVER_DEADLINE_MS);
        // The stalled session get must be aborted once the fallback wins — not left dangling on the
        // slow peer for the rest of the fetch's lifetime.
        await vi.waitFor(() => expect(sessionGetSignals.some((signal) => signal?.aborted)).to.equal(true), { timeout: 3_000 });
    });

    it("does not start the broadcast fallback when the session delivers promptly", async () => {
        const client = await createClient();
        const helia = client._helia;
        const { cid, bytes } = await makeRawBlock("bitswap prompt session block (issue #218)");

        // Session serves the block itself after a short delay; the block is deliberately NOT in the
        // local blockstore, so a stray fallback would have to go to the network (and hang).
        const originalCreateSession = helia.blockstore.createSession.bind(helia.blockstore);
        helia.blockstore.createSession = (root, options) => {
            const session = originalCreateSession(root, options);
            session.get = async function* (_cid: SessionGetParams[0], _getOptions?: SessionGetParams[1]) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                yield bytes;
            };
            return session;
        };
        // Count fallback invocations instead of letting one hang the test: any call is a failure.
        let fallbackGetCalls = 0;
        const originalBlockstoreGet = helia.blockstore.get.bind(helia.blockstore);
        helia.blockstore.get = (getCid, getOptions) => {
            fallbackGetCalls++;
            return originalBlockstoreGet(getCid, getOptions);
        };

        const startedAt = Date.now();
        const fetched = await catToBuffer(client, cid.toString());
        const elapsedMs = Date.now() - startedAt;

        expect(fetched.equals(Buffer.from(bytes))).to.equal(true);
        expect(elapsedMs).to.be.lessThan(PROMPT_SESSION_DEADLINE_MS);
        expect(fallbackGetCalls).to.equal(0);
    });
});
