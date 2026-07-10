import signers from "../../fixtures/signers.js";

import { getAvailablePKCConfigsToTestAgainst, createMockedCommunityIpns } from "../../../dist/node/test/test-util.js";
import { convertBase58IpnsNameToBase36Cid } from "../../../dist/node/signer/util.js";
import { describe, it, expect, vi } from "vitest";

import type { PKCError } from "../../../dist/node/pkc-error.js";

// Regression test for a race in the key-migration flow (observed in CI on the firefox
// remote-ipfs-gateway job, update.community.test.ts "community.update() performs key migration
// when name resolves to different public key"):
//
// 1. A community created as {address: domain, publicKey: oldKey} starts its update loop, which
//    fires a gateway fetch for the OLD key's IPNS.
// 2. Background name resolution detects the key migration (domain now resolves to a new key),
//    clears the community state via _clearDataForKeyMigration and aborts the stop controller.
// 3. The abort does not stop a gateway response whose body has already been received:
//    _fetchWithGateway never re-checks the abort signal after reading the body, and updateOnce
//    applies whatever record comes back because the migration just cleared raw.communityIpfs,
//    so the "is newer" check compares against 0.
// 4. The stale old-key record is applied, reverting community.publicKey to the old key and
//    resurrecting the cleared state.
//
// This test reproduces the race deterministically by intercepting fetch: the gateway response
// for the old key's IPNS is fetched immediately (ignoring the abort signal, like a response
// that had already been received) but only handed back to the client after the migration has
// fired. Fetches for the new key's IPNS are held for the duration of the observation window so
// the stale old-key record is the only record that could possibly be applied.
//
// The stale record slips past the identity validation in _findErrorInCommunityRecord in either
// of two ways, both funneling into the same missing staleness guard in updateOnce:
// a. validation completes before the migration flips community.publicKey (the CI timing), or
// b. the record carries the community's name, so addressMatchesInstance accepts it regardless
//    of when validation runs. Real pre-migration records of a domain community do carry their
//    name, so this test publishes the old record with name: "migrating.bso" to hit the window
//    deterministically.
//
// Only meaningful for the gateway config: the interception point is globalThis.fetch, which only
// the gateway fetching path goes through (kubo/helia/RPC fetch IPNS through other channels).
getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) => {
    describe(`stale gateway fetch after key migration - ${config.name}`, () => {
        it(`gateway response for the old public key that lands after key migration must not revert community state`, async () => {
            // The old-key record carries name: "migrating.bso", like real pre-migration records of a
            // domain community do. That name lets the stale record pass the identity validation in
            // _findErrorInCommunityRecord (addressMatchesInstance) even after the migration has
            // switched community.publicKey to the new key.
            const { communityRecord: oldRecord, communityAddress: oldPublicKey } = await createMockedCommunityIpns({
                name: "migrating.bso"
            });
            const newPublicKey = signers[0].address; // "migrating.bso" resolves to signers[0] in defaultMockResolverRecords

            // Gateways address IPNS by the base36 CID form of the key, in both path style
            // (/ipns/k51...) and subdomain style (k51....ipns.gateway), so match on the CID alone
            const oldKeyIpnsCid = convertBase58IpnsNameToBase36Cid(oldPublicKey);
            const newKeyIpnsCid = convertBase58IpnsNameToBase36Cid(newPublicKey);

            const deferred = (): { promise: Promise<void>; resolve: () => void } => {
                let resolveFn!: () => void;
                const promise = new Promise<void>((resolve) => {
                    resolveFn = resolve;
                });
                return { promise, resolve: resolveFn };
            };
            const migrationDetected = deferred();
            const releaseNewKeyFetches = deferred();

            type FetchInput = Parameters<typeof fetch>[0];
            const urlOfFetchInput = (input: FetchInput): string =>
                typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

            const realFetch = globalThis.fetch.bind(globalThis);
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: FetchInput, init?: RequestInit) => {
                const url = urlOfFetchInput(input);
                if (url.includes(oldKeyIpnsCid)) {
                    // Simulate the race window: the gateway response for the OLD key has already
                    // been received when the migration abort lands (so the abort can't cancel it),
                    // but it is consumed by the client only after the migration has fired
                    const res = await realFetch(url, { ...init, signal: undefined });
                    const body = await res.arrayBuffer();
                    await migrationDetected.promise;
                    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
                }
                if (url.includes(newKeyIpnsCid)) {
                    // Hold fetches of the NEW key's record so the stale old-key record is the only
                    // record that can possibly be applied during the observation window
                    await releaseNewKeyFetches.promise;
                }
                return realFetch(input, init);
            });

            const testPKC = await config.pkcInstancePromise();
            try {
                const community = await testPKC.createCommunity({ address: "migrating.bso", publicKey: oldPublicKey });

                community.on("error", (err) => {
                    if ((err as PKCError).code === "ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY") migrationDetected.resolve();
                });

                // Resolves when the migration has cleared the state and moved the community to the new key
                const migrationCleared = new Promise<void>((resolve) => {
                    community.on("update", () => {
                        if (community.publicKey === newPublicKey && community.updatedAt === undefined) resolve();
                    });
                });

                // Resolves if the stale old-key record gets (incorrectly) applied after the migration
                const staleRecordApplied = new Promise<void>((resolve) => {
                    community.on("update", () => {
                        if (community.updatedAt === oldRecord.updatedAt || community.publicKey === oldPublicKey) resolve();
                    });
                });

                await community.update();

                await migrationDetected.promise;
                await migrationCleared;
                expect(community.publicKey).to.equal(newPublicKey);
                expect(community.updatedAt).to.equal(undefined);

                // The held old-key response was released when the migration fired. Give the client
                // a bounded window to (incorrectly) consume it. With the bug, the stale record gets
                // applied here: updatedAt becomes a number again and publicKey reverts to the old key
                await Promise.race([staleRecordApplied, new Promise((resolve) => setTimeout(resolve, 4000))]);

                expect(community.publicKey).to.equal(newPublicKey);
                expect(community.updatedAt).to.not.equal(oldRecord.updatedAt); // the stale old-key record must not be applied
                expect(community.address).to.equal("migrating.bso");

                await community.stop();
            } finally {
                releaseNewKeyFetches.resolve();
                migrationDetected.resolve(); // in case the migration never fired, don't leave held fetches dangling
                fetchSpy.mockRestore();
                await testPKC.destroy();
            }
        });
    });
});
