import { expect, it } from "vitest";
import { readFreshCachedIpnsRecordFromPubsubLocalStore } from "../../../dist/node/helia/util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { createIPNSRecord, marshalIPNSRecord, multihashToIPNSRoutingKey } from "ipns";
import { CID } from "multiformats/cid";
import type { IpnsPubsubLocalStore } from "../../../dist/node/helia/util.js";

// Repro suite for issue #307: on a directory-style app all N community records are fetched
// together at cold start, carry the same ttl, and are never individually refreshed while the
// publishers are idle, so all N cache entries expire in the same instant. Every name then misses
// the cache in the same update-loop tick and launches its multi-peer fetch race simultaneously:
// N=64 produces 250-320 near-simultaneous /libp2p/fetch streams against a 64-stream outbound cap,
// once per ttl window.
//
// The fix jitters the EFFECTIVE ttl per name: the cache gate serves a cached record for
// ttl * factor(name) where factor is deterministic per routing key and uniform-ish in
// [0.75, 1.0). Names cached in the same instant then stop expiring in the same instant, while a
// record is never served beyond its own ttl (the factor only ever shortens the window) and never
// expired before 75% of it.
//
// Expected on master: the lockstep test FAILS (every name is served until exactly ttl, so at 85%
// of ttl age all names are still uniformly fresh); the floor/ceiling/determinism pins pass and
// must stay green after the fix.
describeSkipIfRpc("IPNS cache ttl jitter (issue #307)", () => {
    const VALUE_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    const TTL_MS = 120_000;
    const LIFETIME_MS = 24 * 60 * 60 * 1000; // far away, so record EOL never interferes with ttl

    // A marshalled record for a fresh key plus a localStore stub that serves it as cached at
    // `ageMs` ago. The stub implements the same structural IpnsPubsubLocalStore contract src
    // reads through, so readFreshCachedIpnsRecordFromPubsubLocalStore exercises its real
    // freshness logic against a fully controlled clock.
    const makeCachedName = async (ageMs: number) => {
        const privateKey = await generateKeyPair("Ed25519");
        const routingKey = multihashToIPNSRoutingKey(peerIdFromPrivateKey(privateKey).toMultihash());
        const recordBytes = marshalIPNSRecord(
            await createIPNSRecord(privateKey, CID.parse(VALUE_CID), 1n, LIFETIME_MS, { ttlNs: BigInt(TTL_MS) * 1_000_000n })
        );
        const created = new Date(Date.now() - ageMs);
        const localStore: IpnsPubsubLocalStore = {
            has: async () => true,
            get: async () => ({ record: recordBytes, created }),
            put: async () => undefined
        };
        return { routingKey, localStore };
    };

    const isServedFromCache = async (name: Awaited<ReturnType<typeof makeCachedName>>): Promise<boolean> =>
        (await readFreshCachedIpnsRecordFromPubsubLocalStore({ localStore: name.localStore, routingKey: name.routingKey })) !== undefined;

    // The lockstep pin. 48 names cached in the same instant, all probed at 85% of their shared
    // ttl: with a per-name effective ttl in [0.75, 1.0) * ttl, some names must already have
    // expired (factor < 0.85) and some must still be fresh (factor > 0.85). On master the
    // effective ttl is exactly ttl for every name, so all 48 are still fresh and the expired
    // count is 0, which is precisely why they later all miss the cache in the same tick.
    it("names cached in the same instant stop expiring in the same instant (issue #307)", async () => {
        const names = await Promise.all(Array.from({ length: 48 }, () => makeCachedName(TTL_MS * 0.85)));
        const served = await Promise.all(names.map(isServedFromCache));
        const servedCount = served.filter(Boolean).length;
        expect(servedCount, "some names must still be served at 85% of ttl (jitter floor is 75%)").to.be.greaterThan(0);
        expect(servedCount, "some names must already have expired at 85% of ttl, or expiries stay in lockstep").to.be.lessThan(
            names.length
        );
    });

    // Floor pin: jitter may only shorten the serve window down to 75% of ttl, never below, or
    // the cache gate would refetch mid-window and reintroduce churn the cache exists to stop.
    it("every name is still served from cache below 75% of its ttl", async () => {
        const names = await Promise.all(Array.from({ length: 24 }, () => makeCachedName(TTL_MS * 0.7)));
        const served = await Promise.all(names.map(isServedFromCache));
        expect(served.every(Boolean), "no name may expire before 75% of its ttl").to.equal(true);
    });

    // Ceiling pin: jitter must never EXTEND the window; at or beyond the record's own ttl the
    // cache must not serve, matching IPNS ttl semantics.
    it("no name is served from cache at or beyond its full ttl", async () => {
        const names = await Promise.all(Array.from({ length: 24 }, () => makeCachedName(TTL_MS)));
        const served = await Promise.all(names.map(isServedFromCache));
        expect(served.some(Boolean), "a record must never be served from cache beyond its own ttl").to.equal(false);
    });

    // Determinism pin: the per-name factor must be a pure function of the name. A re-rolled
    // random factor per read would make expiry flappy (a read can flip a name back and forth
    // between fresh and expired), biasing effective ttl toward the floor as reads accumulate.
    it("a name's effective ttl is deterministic across repeated reads", async () => {
        const names = await Promise.all(Array.from({ length: 20 }, () => makeCachedName(TTL_MS * 0.85)));
        const first = await Promise.all(names.map(isServedFromCache));
        const second = await Promise.all(names.map(isServedFromCache));
        expect(second, "repeated reads of the same cached name must agree on freshness").to.deep.equal(first);
    });
});
