import { afterAll, beforeAll, it, expect } from "vitest";
import { createDelegatedCommunityIpns, createNewIpns, mockPKCWithHeliaConfig } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { peerIdFromString } from "@libp2p/peer-id";
import { CID } from "multiformats/cid";
import type { PKC } from "../../../dist/node/pkc/pkc.js";

// The helia/libp2p IPNS resolver (helia-for-pkc.ts) resolves a SINGLE hop per call by iterating
// ipnsNameResolver.routers[].get(routingKey, { validate: false }) and validating the record itself,
// instead of calling ipnsNameResolver.resolve() (which recurses the whole chain). This is required for
// delegated chains + pubsub warmup ordering, and @helia/ipns exposes no public single-hop API.
//
// This test pins down that the router-level single-hop path does NOT change the resolved value vs the
// package's resolve(), and that record caching still happens at the pubsub-router layer even though we
// call router.get directly — backing the claim that no active cache/TTL is bypassed (pkc resolves IPNS
// with nocache:true, which disables the resolver's only cache-read/TTL path anyway).
//
// Note: @helia/ipns 10 reworked resolve() into an async generator that yields each hop's
// IPNSResolveResult (ipfs/helia#1041): resolve() takes a libp2p-key CID and the terminal hop is the
// last yield. That API could let helia-for-pkc.ts drop its manual walk one day, but the walk stays
// for now (warmup ordering per hop); these tests drain the generator and compare terminal values.
//
// Helia/libp2p-specific (the kubo path resolves via kubo, not these routers) and client-side, so it
// runs once under non-RPC: over an RPC client the resolver lives server-side and is unreachable.
describeSkipIfRpc("Helia IPNS single-hop resolution equivalence", () => {
    let heliaPKC: PKC;
    let ipnsName: string;

    // @helia/ipns 10 resolve() yields one IPNSResolveResult per hop; the terminal hop is the last
    // yield and its value is "/ipfs/<cid>". Drain the generator and parse the terminal CID.
    const lastResolvedCid = async (resolveGenerator: AsyncIterable<{ value: string }>): Promise<CID> => {
        let lastValue: string | undefined;
        for await (const result of resolveGenerator) lastValue = result.value;
        if (lastValue === undefined) throw new Error("resolve() yielded no results");
        return CID.parse(lastValue.split("/")[2]);
    };

    beforeAll(async () => {
        // Publish a non-delegated (single-hop) IPNS record: name -> /ipfs/<cid>. createNewIpns publishes
        // to the shared local kubo node, which then serves the record to helia over IPNS pubsub.
        const ipns = await createNewIpns();
        await ipns.publishToIpns("helia ipns resolve equivalence - single hop content");
        ipnsName = ipns.signer.address;
        await ipns.pkc.destroy();

        heliaPKC = await mockPKCWithHeliaConfig();
    });
    afterAll(async () => {
        if (heliaPKC) await heliaPKC.destroy();
    });

    // Regression test for issue #210: the direct-fetch fast path used to return the record without
    // writing it to the pubsub router's local store (handleRecord only caches gossipsub-delivered
    // records and router.get() fetches), so an offline resolve right after a wrapper resolve only
    // succeeded when kubo's gossipsub push happened to race in before it. A fresh IPNS name makes
    // the direct fetch the only possible source of the record at assert time.
    it("a direct-fetched record is cached at the pubsub routing layer before resolve returns (issue #210)", async () => {
        const freshIpns = await createNewIpns();
        await freshIpns.publishToIpns("helia ipns direct-fetch cache - fresh single hop content");
        const freshName = freshIpns.signer.address;
        await freshIpns.pkc.destroy();

        const client = heliaPKC.clients.libp2pJsClients[Object.keys(heliaPKC.clients.libp2pJsClients)[0]];

        const wrapperValues: string[] = [];
        for await (const value of client.heliaWithKuboRpcClientFunctions.name.resolve(freshName, { nocache: true }))
            wrapperValues.push(value as string);
        const wrapperValue = wrapperValues[wrapperValues.length - 1];
        expect(wrapperValue).to.be.a("string");
        const wrapperCid = CID.parse(wrapperValue.split("/")[2]).toV1().toString();

        // Immediately after the wrapper resolve returns, the record must be readable offline: the
        // fast path must persist it itself instead of depending on the gossipsub push racing in.
        const offlineCid = await lastResolvedCid(client._heliaIpnsRouter.resolve(peerIdFromString(freshName).toCID(), { offline: true }));
        expect(offlineCid.toV1().toString()).to.equal(wrapperCid);
    });

    it("wrapper single-hop resolve matches resolver.resolve() and the record is cached at the pubsub layer", async () => {
        const client = heliaPKC.clients.libp2pJsClients[Object.keys(heliaPKC.clients.libp2pJsClients)[0]];
        const ipnsNameAsPeerId = peerIdFromString(ipnsName);

        // 1) Resolve via the wrapper (the router-level single-hop path). This also warms the pubsub topic.
        const wrapperValues: string[] = [];
        for await (const value of client.heliaWithKuboRpcClientFunctions.name.resolve(ipnsName, { nocache: true }))
            wrapperValues.push(value as string);
        const wrapperValue = wrapperValues[wrapperValues.length - 1];
        expect(wrapperValue).to.be.a("string");
        const wrapperCid = CID.parse(wrapperValue.split("/")[2]).toV1().toString();

        // 2) Resolve the same name through @helia/ipns resolve() (full recursion; a single hop here, so it
        //    yields the same terminal CID). The topic is already warmed by step 1.
        const resolvedCid = await lastResolvedCid(client._heliaIpnsRouter.resolve(ipnsNameAsPeerId.toCID(), { nocache: true }));
        expect(resolvedCid.toV1().toString()).to.equal(wrapperCid);

        // 3) An offline resolve never touches the network — it only succeeds if the record is already in
        //    the datastore. The wrapper (step 1) went straight to router.get, NOT through the resolver's
        //    #findIpnsRecord, yet the pubsub router's handleRecord wrote the fetched record to the (shared)
        //    datastore. So this succeeding proves record caching still happens when we bypass resolve().
        const offlineCid = await lastResolvedCid(client._heliaIpnsRouter.resolve(ipnsNameAsPeerId.toCID(), { offline: true }));
        expect(offlineCid.toV1().toString()).to.equal(wrapperCid);
    });

    // @helia/ipns declares ipns:resolve:start/success/error in its ResolveProgressEvents type (the
    // :success event would carry the resolved IPNSRecord), so it's tempting to attach onProgress to
    // resolve() and reconstruct the IPNS hop chain from those events. This empirically proves they are
    // never emitted in 9.2.x: resolve() threads `options` (incl. onProgress) down to the routers, so any
    // emitted event lands in the listener. The only events that fire are routing-level (ipns:pubsub:* /
    // ipns:routing:*), none of which carry a record value or the next-hop name. So progress events cannot
    // drive hop capture, and the per-hop walk in helia-for-pkc.ts stays.
    it("resolve() never emits ipns:resolve:* progress events, so they cannot capture IPNS hops", async () => {
        const client = heliaPKC.clients.libp2pJsClients[Object.keys(heliaPKC.clients.libp2pJsClients)[0]];
        const ipnsNameAsPeerId = peerIdFromString(ipnsName);

        // Warm the topic via the wrapper first so the resolve() below actually fetches over pubsub.
        for await (const _value of client.heliaWithKuboRpcClientFunctions.name.resolve(ipnsName, { nocache: true }));

        const seenEventTypes: string[] = [];
        const resolvedCid = await lastResolvedCid(
            client._heliaIpnsRouter.resolve(ipnsNameAsPeerId.toCID(), {
                nocache: true,
                onProgress: (evt) => seenEventTypes.push(evt.type)
            })
        );
        // Sanity: the resolve actually ran (and thus would have surfaced any resolve:* event if emitted).
        expect(resolvedCid).to.exist;
        // Surface the real event stream for the record (expected: only ipns:pubsub:* / ipns:routing:*).
        console.log("Progress event types emitted during @helia/ipns resolve():", seenEventTypes);

        // The hop-carrying events are declared in the types but never actually emitted, so an onProgress
        // listener can never observe the resolved record per hop.
        expect(seenEventTypes).to.not.include("ipns:resolve:start");
        expect(seenEventTypes).to.not.include("ipns:resolve:success");
        expect(seenEventTypes).to.not.include("ipns:resolve:error");
    });

    // The single-hop case above proves the events aren't emitted for one resolve() invocation. This
    // proves the same across a REAL multi-hop recursion (anchor -> minter -> /ipfs/cid): if a resolve:*
    // event were ever emitted, recursion (which re-enters the same resolve() code path per hop) would
    // surface it. To make resolve() actually complete the chain we must first warm EVERY hop's pubsub
    // topic — otherwise its internal recursion fetches the deeper hop before that topic has subscribers
    // and throws NotFoundError (fetchDelay defaults to 0). This warm-then-recurse is exactly the ordering
    // production drives by hand, one hop per call, which is why the wrapper can't just call resolve().
    it("resolve() recursing a real delegated chain still emits no ipns:resolve:* events (multi-hop)", async () => {
        // Build anchor -> minter -> /ipfs/<cid>, published to the shared kubo node.
        const chain = await createDelegatedCommunityIpns({});
        expect(chain.ipnsHops).to.deep.equal([chain.anchorName, chain.terminalName]); // exactly 2 hops

        const client = heliaPKC.clients.libp2pJsClients[Object.keys(heliaPKC.clients.libp2pJsClients)[0]];

        // Warm every hop's topic first (per-hop, via the wrapper) so the recursive resolve() below can
        // reach the terminal without hitting an unwarmed topic.
        for (const hop of chain.ipnsHops)
            for await (const _value of client.heliaWithKuboRpcClientFunctions.name.resolve(hop, { nocache: true }));

        const seenEventTypes: string[] = [];
        const resolvedCid = await lastResolvedCid(
            client._heliaIpnsRouter.resolve(peerIdFromString(chain.anchorName).toCID(), {
                nocache: true,
                onProgress: (evt) => seenEventTypes.push(evt.type)
            })
        );

        // resolve() genuinely recursed both hops to the terminal CID (anchor -> minter -> /ipfs/cid).
        expect(resolvedCid.toV1().toString()).to.equal(CID.parse(chain.cid).toV1().toString());
        console.log("Progress event types during multi-hop resolve():", seenEventTypes);

        // Even across a real 2-hop recursion, no resolve:* event fires — confirming hops can't be captured.
        expect(seenEventTypes).to.not.include("ipns:resolve:start");
        expect(seenEventTypes).to.not.include("ipns:resolve:success");
        expect(seenEventTypes).to.not.include("ipns:resolve:error");
    });
});
