import { it, expect, afterEach } from "vitest";
import { v4 as uuidv4 } from "uuid";
import signers from "../../fixtures/signers.js";
import { createMockNameResolver, mockPKCV2 } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { NameResolver } from "../../../dist/node/types.js";

// These tests exercise the local persistent name-resolution cache and the
// in-memory verification cache. Both live on the PKC instance under test.
// Under USE_RPC=1, the public APIs proxy to a remote PKC RPC server whose
// resolvers and caches we don't control, so the assertions become meaningless.

// Tracks how many times resolve() is called per name. Used to assert cache hits/misses.
function trackingResolver(records: Record<string, string | undefined>, opts?: { failNextN?: number; key?: string; provider?: string }) {
    const calls: string[] = [];
    let failsRemaining = opts?.failNextN ?? 0;
    const resolver: NameResolver = createMockNameResolver({
        key: opts?.key ?? `tracking-resolver-${uuidv4()}`,
        provider: opts?.provider ?? "mock://tracker",
        records,
        resolveFunction: async ({ name }) => {
            calls.push(name);
            if (failsRemaining > 0) {
                failsRemaining--;
                throw new Error("Simulated transient resolver failure");
            }
            const v = records[name];
            return v ? { publicKey: v } : undefined;
        }
    });
    return { resolver, calls };
}

async function makeNoDataPKC(extra: Parameters<typeof mockPKCV2>[0] = {}, resolver?: NameResolver) {
    const pkc = await mockPKCV2({
        stubStorage: true,
        remotePKC: true,
        mockResolve: false,
        ...extra,
        pkcOptions: {
            // noData → LRU storage falls back to in-memory SQLite
            noData: true,
            nameResolvers: resolver ? [resolver] : undefined,
            ...extra.pkcOptions
        }
    });
    return pkc;
}

describeSkipIfRpc("NameResolutionCache: cache hit / miss / freshness", () => {
    let pkc: PKC;
    afterEach(async () => {
        if (pkc) await pkc.destroy();
    });

    it("first call hits resolver, second call is served from cache", async () => {
        const { resolver, calls } = trackingResolver({ "alice.bso": signers[3].address });
        pkc = await makeNoDataPKC({}, resolver);

        const r1 = await pkc.resolveAuthorName({ name: "alice.bso" });
        expect(r1.resolvedAuthorName).to.equal(signers[3].address);
        expect(calls).to.deep.equal(["alice.bso"]);

        const r2 = await pkc.resolveAuthorName({ name: "alice.bso" });
        expect(r2.resolvedAuthorName).to.equal(signers[3].address);
        // Resolver not called again — second result came from persistent cache.
        expect(calls).to.deep.equal(["alice.bso"]);
    });

    it("cache: { maxAge: 0 } bypasses cache and forces re-resolution", async () => {
        const { resolver, calls } = trackingResolver({ "alice.bso": signers[3].address });
        pkc = await makeNoDataPKC({}, resolver);

        await pkc._clientsManager.resolveAuthorNameIfNeeded({ authorName: "alice.bso" });
        expect(calls.length).to.equal(1);

        await pkc._clientsManager.resolveAuthorNameIfNeeded({ authorName: "alice.bso", cache: { maxAge: 0 } });
        expect(calls.length).to.equal(2);

        await pkc._clientsManager.resolveAuthorNameIfNeeded({ authorName: "alice.bso", cache: { maxAge: 0 } });
        expect(calls.length).to.equal(3);
    });

    it("cache: { maxAge: N } returns the cached entry when fresh enough", async () => {
        const { resolver, calls } = trackingResolver({ "alice.bso": signers[3].address });
        pkc = await makeNoDataPKC({}, resolver);

        await pkc._clientsManager.resolveAuthorNameIfNeeded({ authorName: "alice.bso" });
        expect(calls.length).to.equal(1);

        // 60s is way more than the time elapsed since the previous call
        await pkc._clientsManager.resolveAuthorNameIfNeeded({ authorName: "alice.bso", cache: { maxAge: 60 } });
        expect(calls.length).to.equal(1);
    });

    it("cache: { maxAge: N } re-resolves when the cached entry is older than N seconds", async () => {
        const { resolver, calls } = trackingResolver({ "alice.bso": signers[3].address });
        pkc = await makeNoDataPKC({}, resolver);

        await pkc._clientsManager.resolveAuthorNameIfNeeded({ authorName: "alice.bso" });
        expect(calls.length).to.equal(1);

        // Sleep just over 1s, then ask for an entry no older than 1s.
        await new Promise((r) => setTimeout(r, 1100));
        await pkc._clientsManager.resolveAuthorNameIfNeeded({ authorName: "alice.bso", cache: { maxAge: 1 } });
        expect(calls.length).to.equal(2);
    });

    it("pkc.resolveAuthorName plumbs cache.maxAge through to the cache (maxAge: 0 forces re-resolution)", async () => {
        const { resolver, calls } = trackingResolver({ "alice.bso": signers[3].address });
        pkc = await makeNoDataPKC({}, resolver);

        const r1 = await pkc.resolveAuthorName({ name: "alice.bso" });
        expect(r1.resolvedAuthorName).to.equal(signers[3].address);
        expect(calls.length).to.equal(1);

        // Without cache option: served from cache.
        const r2 = await pkc.resolveAuthorName({ name: "alice.bso" });
        expect(r2.resolvedAuthorName).to.equal(signers[3].address);
        expect(calls.length).to.equal(1);

        // cache.maxAge: 0 → bypass cache, force re-resolution.
        const r3 = await pkc.resolveAuthorName({ name: "alice.bso", cache: { maxAge: 0 } });
        expect(r3.resolvedAuthorName).to.equal(signers[3].address);
        expect(calls.length).to.equal(2);

        // cache.maxAge: 60 → cache entry is younger than 60s, served from cache.
        const r4 = await pkc.resolveAuthorName({ name: "alice.bso", cache: { maxAge: 60 } });
        expect(r4.resolvedAuthorName).to.equal(signers[3].address);
        expect(calls.length).to.equal(2);
    });

    it("failed resolution is not persisted (next call hits the resolver again)", async () => {
        // Resolver returns undefined for every name → all-resolvers-tried-no-result → null
        const { resolver, calls } = trackingResolver({});
        pkc = await makeNoDataPKC({}, resolver);

        const r1 = await pkc.resolveAuthorName({ name: "missing.bso" });
        expect(r1.resolvedAuthorName).to.be.null;
        expect(calls).to.deep.equal(["missing.bso"]);

        const r2 = await pkc.resolveAuthorName({ name: "missing.bso" });
        expect(r2.resolvedAuthorName).to.be.null;
        // No cache entry was written, so second call hit the network again.
        expect(calls).to.deep.equal(["missing.bso", "missing.bso"]);
    });
});

describeSkipIfRpc("NameResolutionCache: keying by resolver + provider", () => {
    let pkc: PKC;
    afterEach(async () => {
        if (pkc) await pkc.destroy();
    });

    it("two resolvers with different providers cache independently", async () => {
        const { resolver: r1, calls: calls1 } = trackingResolver(
            { "shared.bso": signers[3].address },
            { key: "tracker-a", provider: "mock://provider-a" }
        );
        const { resolver: r2, calls: calls2 } = trackingResolver(
            { "shared.bso": signers[4].address },
            { key: "tracker-b", provider: "mock://provider-b" }
        );

        pkc = await makeNoDataPKC({}, r1);
        // Manually swap in both resolvers (canResolve is true by default).
        pkc.nameResolvers = [r1, r2];

        // First resolver in the lineup wins on success — only r1 is consulted.
        const first = await pkc.resolveAuthorName({ name: "shared.bso" });
        expect(first.resolvedAuthorName).to.equal(signers[3].address);
        expect(calls1.length).to.equal(1);
        expect(calls2.length).to.equal(0);

        // Second call: cached for r1 + provider-a → no network. r2 is never reached because r1 already answers.
        const second = await pkc.resolveAuthorName({ name: "shared.bso" });
        expect(second.resolvedAuthorName).to.equal(signers[3].address);
        expect(calls1.length).to.equal(1);
        expect(calls2.length).to.equal(0);

        // Reorder so r2 is first; its cache entry doesn't exist yet → network call.
        pkc.nameResolvers = [r2, r1];
        const third = await pkc.resolveAuthorName({ name: "shared.bso" });
        expect(third.resolvedAuthorName).to.equal(signers[4].address);
        expect(calls2.length).to.equal(1);
        // r1's cached entry remains untouched (different cache key).
        expect(calls1.length).to.equal(1);
    });
});

describeSkipIfRpc("nameResolvedCache (verification cache) regression: false-sticks bug", () => {
    let pkc: PKC;
    afterEach(async () => {
        if (pkc) await pkc.destroy();
    });

    it("transient null result does NOT poison the verification cache as false", async () => {
        // Round 1: resolver returns undefined (treated as "no record"); next round it succeeds.
        const records: Record<string, string | undefined> = { "carol.bso": undefined };
        const calls: string[] = [];
        const resolver: NameResolver = createMockNameResolver({
            key: "flaky-resolver",
            provider: "mock://flaky",
            resolveFunction: async ({ name }) => {
                calls.push(name);
                const v = records[name];
                return v ? { publicKey: v } : undefined;
            }
        });
        pkc = await makeNoDataPKC({}, resolver);

        const verificationCache = pkc._memCaches.nameResolvedCache;
        const author = { authorName: "carol.bso", signaturePublicKey: signers[3].publicKey };
        // Round 1: resolution returns null. Verification cache must NOT be set to false.
        await new Promise<void>((resolve) => {
            pkc._clientsManager.resolveAuthorNamesInBackground({
                authors: [author],
                onResolved: () => resolve()
            });
            // resolveAuthorNamesInBackground only fires onResolved when the verification cache is updated.
            // For null results, that never happens — so race a 1s timeout.
            setTimeout(() => resolve(), 1000);
        });
        // Find the cache key the same way the implementation does.
        const { sha256 } = await import("js-sha256");
        const cacheKey = sha256(author.authorName + author.signaturePublicKey);
        expect(verificationCache.get(cacheKey)).to.be.undefined;

        // Round 2: resolver now returns the matching publicKey. Verification cache should turn into true.
        records["carol.bso"] = signers[3].address;
        await new Promise<void>((resolve) => {
            pkc._clientsManager.resolveAuthorNamesInBackground({
                authors: [author],
                onResolved: () => resolve()
            });
            setTimeout(() => resolve(), 5000);
        });
        expect(verificationCache.get(cacheKey)).to.equal(true);
        expect(calls.length).to.be.greaterThanOrEqual(2);
    });

    it("ERR_NO_RESOLVER_FOR_NAME is still treated as definitive false (no resolver handles this TLD)", async () => {
        // Resolver that only handles .bso → .eth queries hit ERR_NO_RESOLVER_FOR_NAME
        const resolver: NameResolver = createMockNameResolver({
            key: "bso-only",
            provider: "mock://bso-only",
            canResolve: ({ name }) => name.endsWith(".bso"),
            records: {}
        });
        pkc = await makeNoDataPKC({}, resolver);

        const verificationCache = pkc._memCaches.nameResolvedCache;
        const author = { authorName: "test.eth", signaturePublicKey: signers[3].publicKey };
        await new Promise<void>((resolve) => {
            pkc._clientsManager.resolveAuthorNamesInBackground({
                authors: [author],
                onResolved: () => resolve()
            });
            setTimeout(() => resolve(), 1000);
        });
        const { sha256 } = await import("js-sha256");
        const cacheKey = sha256(author.authorName + author.signaturePublicKey);
        expect(verificationCache.get(cacheKey)).to.equal(false);
    });
});
