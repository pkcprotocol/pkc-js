import { it, expect, afterEach, vi } from "vitest";
import { sha256 } from "js-sha256";
import { v4 as uuidv4 } from "uuid";
import signers from "../../fixtures/signers.js";
import { createMockNameResolver, mockPKCV2 } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { NameResolver } from "../../../dist/node/types.js";

// resolveAuthorNamesInBackground skips an author whose resolve is already in flight (issue #353), so two
// holders of the same author, such as a community's page sweep and an updating Comment on the same
// community update, trigger one resolve between them. The caller that was skipped must still hear about
// the verdict: its onResolved is the only thing that applies it to that caller's objects (Comment
// emits "update" with author.nameResolved from there). And when the attempt it joined was abandoned
// because its owner stopped, nothing was learned, so the caller has to ask on its own behalf.
//
// Under USE_RPC=1 the clients manager and its caches live on the RPC server, so this runs non-RPC only.
describeSkipIfRpc("resolveAuthorNamesInBackground: a caller that joins an in-flight resolve", () => {
    let pkc: PKC;
    afterEach(async () => {
        // A test that destroys its pkc itself leaves it destroyed, and destroy() cannot be called twice
        if (pkc && !pkc.destroyed) await pkc.destroy();
    });

    const author = { authorName: "carol.bso", signaturePublicKey: signers[3].publicKey };
    const cacheKey = sha256(author.authorName + author.signaturePublicKey);

    // A resolver that holds every resolve until released, then answers with carol's key. Each test gets its own key:
    // the persistent name-resolution cache is keyed by resolver, and in browsers it outlives the pkc (localforage), so
    // with a shared key the first test's answer would be served to the later tests without asking the resolver.
    const heldResolver = () => {
        const calls: string[] = [];
        let release = () => {};
        const held = new Promise<void>((resolve) => (release = resolve));
        const resolver: NameResolver = createMockNameResolver({
            key: `held-resolver-${uuidv4()}`,
            provider: "mock://held",
            resolveFunction: async ({ name }) => {
                calls.push(name);
                await held;
                return { publicKey: signers[3].address };
            }
        });
        return { resolver, calls, release: () => release() };
    };

    const makePKC = async (resolver: NameResolver) =>
        mockPKCV2({
            stubStorage: true,
            remotePKC: true,
            mockResolve: false,
            pkcOptions: { noData: true, nameResolvers: [resolver] }
        });

    it("calls the joiner's onResolved when the verdict it waited for lands", async () => {
        const { resolver, calls, release } = heldResolver();
        pkc = await makePKC(resolver);
        // The page sweep's shape: it owns the attempt and re-applies the cache silently
        const community = await pkc.createCommunity({ address: signers[0].address });
        let ownerNotified = 0;
        community._clientsManager.resolveAuthorNamesInBackground({ authors: [author], onResolved: () => ownerNotified++ });
        await vi.waitFor(() => expect(calls.length).to.equal(1));

        // The updating Comment's shape: it asks for the same author while the sweep's resolve is outstanding
        let joinerNotified = 0;
        pkc._clientsManager.resolveAuthorNamesInBackground({ authors: [author], onResolved: () => joinerNotified++ });

        release();
        await vi.waitFor(() => expect(pkc._memCaches.nameResolvedCache.get(cacheKey)).to.equal(true));
        await vi.waitFor(() => expect(ownerNotified).to.equal(1));
        await vi.waitFor(() => expect(joinerNotified, "the joiner never heard about the verdict").to.equal(1), { timeout: 2000 });
        // Still one resolve between the two of them
        expect(calls.length).to.equal(1);
    });

    it("asks again on the joiner's behalf when the owner was stopped before it learned anything", async () => {
        const { resolver, calls, release } = heldResolver();
        pkc = await makePKC(resolver);
        const ownerStop = new AbortController();
        let ownerNotified = 0;
        pkc._clientsManager.resolveAuthorNamesInBackground({
            authors: [author],
            onResolved: () => ownerNotified++,
            abortSignal: ownerStop.signal
        });
        await vi.waitFor(() => expect(calls.length).to.equal(1));

        let joinerNotified = 0;
        pkc._clientsManager.resolveAuthorNamesInBackground({ authors: [author], onResolved: () => joinerNotified++ });

        // The owner stops (a community or comment stop() aborts its stop signal) while the joiner keeps going
        ownerStop.abort();
        await vi.waitFor(() => expect(calls.length, "nobody asked again for the joiner").to.equal(2), { timeout: 2000 });

        release();
        await vi.waitFor(() => expect(joinerNotified).to.equal(1), { timeout: 2000 });
        expect(pkc._memCaches.nameResolvedCache.get(cacheKey)).to.equal(true);
        expect(ownerNotified).to.equal(0);
    });

    it("does not call the onResolved of a joiner that was stopped while it waited", async () => {
        const { resolver, calls, release } = heldResolver();
        pkc = await makePKC(resolver);
        let ownerNotified = 0;
        pkc._clientsManager.resolveAuthorNamesInBackground({ authors: [author], onResolved: () => ownerNotified++ });
        await vi.waitFor(() => expect(calls.length).to.equal(1));
        const joinerStop = new AbortController();
        let joinerNotified = 0;
        pkc._clientsManager.resolveAuthorNamesInBackground({
            authors: [author],
            onResolved: () => joinerNotified++,
            abortSignal: joinerStop.signal
        });

        joinerStop.abort();
        release();
        await vi.waitFor(() => expect(ownerNotified).to.equal(1));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(joinerNotified).to.equal(0);
    });

    it("does not ask again on behalf of a joiner that was stopped too", async () => {
        const { resolver, calls, release } = heldResolver();
        pkc = await makePKC(resolver);
        const ownerStop = new AbortController();
        const joinerStop = new AbortController();
        pkc._clientsManager.resolveAuthorNamesInBackground({ authors: [author], onResolved: () => {}, abortSignal: ownerStop.signal });
        await vi.waitFor(() => expect(calls.length).to.equal(1));
        let joinerNotified = 0;
        pkc._clientsManager.resolveAuthorNamesInBackground({
            authors: [author],
            onResolved: () => joinerNotified++,
            abortSignal: joinerStop.signal
        });

        joinerStop.abort();
        ownerStop.abort();
        release();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(calls.length).to.equal(1);
        expect(joinerNotified).to.equal(0);
        expect(pkc._authorNameResolvesInFlight.size).to.equal(0);
    });

    // pkc.destroy() sets pkc.destroyed, then stops the updating comments and communities, which aborts the resolves
    // they own, and then closes the storage and clears the caches. A joiner without a stop signal that destroy can
    // abort (a just-published Comment, or the comment getComment returned) must not start a new resolve during
    // that teardown.
    it("does not ask again on a joiner's behalf once the pkc is destroyed", async () => {
        const { resolver, calls } = heldResolver();
        pkc = await makePKC(resolver);
        const clientsManager = pkc._clientsManager;
        const failedRecently = pkc._memCaches.nameResolveFailedCache;
        const asks = vi.spyOn(clientsManager, "resolveAuthorNamesInBackground");
        const ownerStop = new AbortController();
        clientsManager.resolveAuthorNamesInBackground({ authors: [author], onResolved: () => {}, abortSignal: ownerStop.signal });
        await vi.waitFor(() => expect(calls.length).to.equal(1));
        let joinerNotified = 0;
        clientsManager.resolveAuthorNamesInBackground({ authors: [author], onResolved: () => joinerNotified++ });

        // The owner is stopped by the teardown, after destroy() has marked the pkc destroyed
        const destroying = pkc.destroy();
        ownerStop.abort();
        await destroying;
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(asks, "a new resolve was started for the joiner during destroy").toHaveBeenCalledTimes(2);
        expect(calls.length).to.equal(1);
        expect(joinerNotified).to.equal(0);
        expect(failedRecently.get(cacheKey)).to.equal(undefined);
    });

    // A Comment or a community asks on every one of its updates, so it asks again while the resolve it is
    // waiting for is still outstanding. It is told once: by the ask that started or joined that resolve.
    it("notifies a caller once however often it asks while its own resolve is outstanding", async () => {
        const { resolver, calls, release } = heldResolver();
        pkc = await makePKC(resolver);
        const stop = new AbortController();
        let notified = 0;
        const ask = () =>
            pkc._clientsManager.resolveAuthorNamesInBackground({
                authors: [author],
                onResolved: () => notified++,
                abortSignal: stop.signal
            });
        ask();
        await vi.waitFor(() => expect(calls.length).to.equal(1));
        ask();
        ask();

        release();
        await vi.waitFor(() => expect(notified).to.equal(1));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(notified, "each ask was notified").to.equal(1);
        expect(calls.length).to.equal(1);
    });

    it("emits one update for a Comment that asks on every update while the resolve it joined is outstanding", async () => {
        const { resolver, calls, release } = heldResolver();
        pkc = await makePKC(resolver);
        const community = await pkc.createCommunity({ address: signers[0].address });
        community._clientsManager.resolveAuthorNamesInBackground({ authors: [author], onResolved: () => {} });
        await vi.waitFor(() => expect(calls.length).to.equal(1));

        const comment = await pkc.createComment({
            signer: signers[3],
            communityAddress: signers[0].address,
            title: "joiner",
            content: "asks on every update",
            author: { name: author.authorName }
        });
        // The stop signal an updating comment has, which is what tells its asks apart from another instance's
        const commentStop = comment._createStopAbortController();
        const addAbortListener = vi.spyOn(commentStop.signal, "addEventListener");
        const removeAbortListener = vi.spyOn(commentStop.signal, "removeEventListener");
        let updates = 0;
        comment.on("update", () => updates++);
        // handleUpdateEventFromCommunity asks on each community update
        comment._resolveAuthorNamesInBackground();
        comment._resolveAuthorNamesInBackground();
        comment._resolveAuthorNamesInBackground();

        release();
        await vi.waitFor(() => expect(comment.author.nameResolved).to.equal(true), { timeout: 2000 });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(updates, "one update per ask").to.equal(1);
        expect(calls.length).to.equal(1);
        // The first ask joined the resolve and the other two found this stop signal already waiting, so the
        // comment waited once rather than once per ask
        const abortListenersAdded = addAbortListener.mock.calls.filter(([type]) => type === "abort");
        expect(abortListenersAdded.length, "the comment waited once per ask").to.equal(1);
        // The wait is over, so it left nothing on the comment's long-lived stop signal
        const added = addAbortListener.mock.calls.map((call) => call[1]);
        const removed = removeAbortListener.mock.calls.map((call) => call[1]);
        expect(added.filter((listener) => !removed.includes(listener))).to.deep.equal([]);
    });

    // An updating Comment that is stopped and updated again gets a new stop signal (comment.stop() aborts the
    // old one, update() creates the next). If it asks under the new one before its stopped resolve has settled,
    // it waits for that resolve as a joiner, and that resolve learns nothing for it, so it has to be asked again.
    it("tells a caller that asks under a new stop signal after the one its own resolve ran under was aborted", async () => {
        const { resolver, calls, release } = heldResolver();
        pkc = await makePKC(resolver);
        let notified = 0;
        const firstStop = new AbortController();
        pkc._clientsManager.resolveAuthorNamesInBackground({
            authors: [author],
            onResolved: () => notified++,
            abortSignal: firstStop.signal
        });
        await vi.waitFor(() => expect(calls.length).to.equal(1));

        // Stopped, then updating again before the stopped resolve has settled
        firstStop.abort();
        expect(pkc._authorNameResolvesInFlight.has(cacheKey)).to.equal(true);
        const secondStop = new AbortController();
        pkc._clientsManager.resolveAuthorNamesInBackground({
            authors: [author],
            onResolved: () => notified++,
            abortSignal: secondStop.signal
        });

        await vi.waitFor(() => expect(calls.length, "nobody asked again for the caller").to.equal(2), { timeout: 2000 });
        release();
        await vi.waitFor(() => expect(notified, "the caller never heard about the verdict").to.equal(1), { timeout: 2000 });
        expect(pkc._memCaches.nameResolvedCache.get(cacheKey)).to.equal(true);
    });

    const dave = { authorName: "dave.bso", signaturePublicKey: signers[4].publicKey };
    const daveCacheKey = sha256(dave.authorName + dave.signaturePublicKey);

    // A resolver that holds carol's and dave's resolves separately, each until its own release
    const heldPerNameResolver = () => {
        const addresses: Record<string, string> = { [author.authorName]: signers[3].address, [dave.authorName]: signers[4].address };
        const calls: string[] = [];
        const releases: Record<string, () => void> = {};
        const resolver: NameResolver = createMockNameResolver({
            key: `held-per-name-resolver-${uuidv4()}`,
            provider: "mock://held",
            resolveFunction: async ({ name }) => {
                calls.push(name);
                await new Promise<void>((resolve) => (releases[name] = resolve));
                return { publicKey: addresses[name] };
            }
        });
        return { resolver, calls, release: (name: string) => releases[name]() };
    };

    // A background resolve has no timeout of its own, so the one a caller joined can stay outstanding for as long
    // as its owner lives. The verdicts of the resolves the caller started itself must not wait for it.
    it("tells a caller about the resolves it started without waiting for one it joined", async () => {
        const { resolver, calls, release } = heldPerNameResolver();
        pkc = await makePKC(resolver);

        // Another caller owns carol's resolve
        let ownerNotified = 0;
        const community = await pkc.createCommunity({ address: signers[0].address });
        community._clientsManager.resolveAuthorNamesInBackground({ authors: [author], onResolved: () => ownerNotified++ });
        await vi.waitFor(() => expect(calls).to.deep.equal([author.authorName]));

        // This caller joins carol's resolve and starts dave's
        let notified = 0;
        pkc._clientsManager.resolveAuthorNamesInBackground({ authors: [author, dave], onResolved: () => notified++ });
        await vi.waitFor(() => expect(calls).to.deep.equal([author.authorName, dave.authorName]));

        release(dave.authorName);
        await vi.waitFor(() => expect(notified, "dave's verdict waited for carol's resolve, which another caller owns").to.equal(1), {
            timeout: 2000
        });
        expect(pkc._memCaches.nameResolvedCache.get(cacheKey)).to.equal(undefined);

        release(author.authorName);
        await vi.waitFor(() => expect(notified, "the caller never heard about the verdict it joined").to.equal(2));
        expect(ownerNotified).to.equal(1);
        expect(calls.length).to.equal(2);
    });

    // The same between two resolves the caller joined: one that hangs must not hold back the other's verdict
    it("tells a caller about each resolve it joined as it lands, without waiting for the others", async () => {
        const { resolver, calls, release } = heldPerNameResolver();
        pkc = await makePKC(resolver);

        // The page sweep's shape: another caller owns both resolves
        const community = await pkc.createCommunity({ address: signers[0].address });
        community._clientsManager.resolveAuthorNamesInBackground({ authors: [author, dave], onResolved: () => {} });
        await vi.waitFor(() => expect(calls.length).to.equal(2));

        let notified = 0;
        pkc._clientsManager.resolveAuthorNamesInBackground({ authors: [author, dave], onResolved: () => notified++ });

        release(dave.authorName);
        await vi.waitFor(() => expect(pkc._memCaches.nameResolvedCache.get(daveCacheKey)).to.equal(true));
        await vi.waitFor(() => expect(notified, "dave's verdict waited for carol's resolve, which is still held").to.equal(1), {
            timeout: 2000
        });
        expect(pkc._memCaches.nameResolvedCache.get(cacheKey)).to.equal(undefined);

        release(author.authorName);
        await vi.waitFor(() => expect(notified).to.equal(2));
        expect(calls.length).to.equal(2);
    });

    // One of a caller's resolves gave a verdict and another is still outstanding when the caller is stopped. The
    // stop aborts the outstanding one, which settles the batch, and the stopped caller must not be notified then:
    // a Comment's onResolved changes what it renders and emits "update".
    it("does not notify a caller that was stopped before its batch settled", async () => {
        const { resolver, calls, release } = heldPerNameResolver();
        pkc = await makePKC(resolver);
        const stop = new AbortController();
        let notified = 0;
        pkc._clientsManager.resolveAuthorNamesInBackground({
            authors: [author, dave],
            onResolved: () => notified++,
            abortSignal: stop.signal
        });
        await vi.waitFor(() => expect(calls.length).to.equal(2));

        release(dave.authorName);
        await vi.waitFor(() => expect(pkc._memCaches.nameResolvedCache.get(daveCacheKey)).to.equal(true));
        expect(notified).to.equal(0); // carol's resolve is still outstanding

        stop.abort();
        await vi.waitFor(() => expect(pkc._authorNameResolvesInFlight.size).to.equal(0));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(notified, "the caller was notified after it was stopped").to.equal(0);
    });

    // A resolve is bounded only by its owner's signal, so the one a stopped Comment or community joined can
    // stay outstanding indefinitely. The stopped joiner must not stay referenced (through its onResolved and
    // stop signal) until then.
    it("ends a stopped joiner's wait before the resolve it joined settles", async () => {
        const { resolver, calls, release } = heldResolver();
        pkc = await makePKC(resolver);
        let ownerNotified = 0;
        pkc._clientsManager.resolveAuthorNamesInBackground({ authors: [author], onResolved: () => ownerNotified++ });
        await vi.waitFor(() => expect(calls.length).to.equal(1));
        const inFlightResolve = pkc._authorNameResolvesInFlight.get(cacheKey)!;
        expect(inFlightResolve.joiners.size).to.equal(0);

        const joinerStop = new AbortController();
        let joinerNotified = 0;
        pkc._clientsManager.resolveAuthorNamesInBackground({
            authors: [author],
            onResolved: () => joinerNotified++,
            abortSignal: joinerStop.signal
        });
        expect(inFlightResolve.joiners.size).to.equal(1);
        expect(inFlightResolve.callers.has(joinerStop.signal)).to.equal(true);

        joinerStop.abort();
        // The resolve is still held, and the joiner is already gone from it
        expect(pkc._authorNameResolvesInFlight.get(cacheKey)).to.equal(inFlightResolve);
        expect(inFlightResolve.joiners.size, "the stopped joiner still waits on the resolve").to.equal(0);
        expect(inFlightResolve.callers.has(joinerStop.signal)).to.equal(false);

        release();
        await vi.waitFor(() => expect(ownerNotified).to.equal(1));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(joinerNotified).to.equal(0);
        expect(calls.length).to.equal(1);
    });
});
