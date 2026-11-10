import { afterEach, expect, it } from "vitest";
import Logger from "@pkcprotocol/pkc-logger";
import { createLibp2pJsClientOrUseExistingOne } from "../../../dist/node/helia/helia-for-pkc.js";
import { cacheIpnsRecordInPubsubLocalStore } from "../../../dist/node/helia/util.js";
import { ipnsNameToIpnsOverPubsubTopic } from "../../../dist/node/util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { createIPNSRecord, marshalIPNSRecord, multihashToIPNSRoutingKey, unmarshalIPNSRecord } from "ipns";
import { CID } from "multiformats/cid";
import type { Libp2pJsClient } from "../../../dist/node/helia/libp2pjsClient.js";
import type { IpnsPubsubLocalStore } from "../../../dist/node/helia/util.js";
import type { IpnsRecordArrival } from "../../../dist/node/helia/types.js";

// Free signer/verify helpers and raw clients take a required log (issue #493); tests use the process-default root
const testLog = Logger({ namespace: "pkc-js:test:ipns-local-store-write-race" });

// Issue #321: writes into the pubsub router's localStore are a non-atomic
// compare-then-write (has, get, compare, put with awaits between), and the localStore.put wrapper
// in helia-for-pkc.ts dispatches an IpnsRecordArrival for whatever was written. Two writers that
// both read the same stale cached record can both pass the newer-only check, so the older record
// can land last and replace the newer one, and listeners are told about it as an "arrival".
// helia's own #handleRecord has the same race, which pkc-js cannot lock from outside, so the fix
// lives in the put wrapper every writer goes through.
//
// The interleaving is forced deterministically by holding localStore.get (the compare read) for
// both writers, then releasing them in order. Nothing else about the write path is stubbed: the
// localStore and its put wrapper are the node's real ones.
//
// Client-side libp2p only and config-independent (never touches Kubo or the PKC RPC server), so
// it runs once under non-RPC via describeSkipIfRpc.
describeSkipIfRpc("IPNS localStore compare-then-write race (issue #321)", () => {
    const clientsToStop: Libp2pJsClient[] = [];
    let keyCounter = 0;

    afterEach(async () => {
        while (clientsToStop.length) await clientsToStop.pop()!.heliaWithKuboRpcClientFunctions.stop();
    });

    const VALUE_CIDS = [
        "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
        "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"
    ];

    const setup = async () => {
        const client = (await createLibp2pJsClientOrUseExistingOne({
            log: testLog,
            key: `ipns-local-store-race-${keyCounter++}`,
            httpRoutersOptions: ["http://localhost:1"],
            libp2pOptions: {},
            heliaOptions: {}
        })) as Libp2pJsClient;
        clientsToStop.push(client);

        // The router instance helia-for-pkc wrapped, so put goes through the arrival wrapper.
        const pubsubRouter = client._heliaIpnsRouter.routers.find((r) => String(r) === "PubSubRouting()") as unknown as
            | { localStore: IpnsPubsubLocalStore; subscriptions: Set<string> }
            | undefined;
        expect(pubsubRouter, "expected the node's PubSubRouting() router").to.exist;
        const localStore = pubsubRouter!.localStore;

        const privateKey = await generateKeyPair("Ed25519");
        const ipnsPeerId = peerIdFromPrivateKey(privateKey);
        const routingKey = multihashToIPNSRoutingKey(ipnsPeerId.toMultihash());
        const pubsubTopic = ipnsNameToIpnsOverPubsubTopic(ipnsPeerId.toString());
        const makeRecord = async (sequence: bigint) =>
            marshalIPNSRecord(await createIPNSRecord(privateKey, CID.parse(VALUE_CIDS[Number(sequence) % 2]), sequence, 60 * 60 * 1000));

        const arrivals: bigint[] = [];
        client.heliaWithKuboRpcClientFunctions.ipnsRecordArrivals.subscribe({
            pubsubTopic,
            listener: (arrival: IpnsRecordArrival) => arrivals.push(arrival.record.sequence)
        });

        // Hold every compare read (localStore.get) AFTER it has read the cache, until released in
        // call order: the writer then compares against what it read, as in a real await window.
        const heldGets: Array<() => void> = [];
        const originalGet = localStore.get.bind(localStore);
        let holdGets = false;
        localStore.get = async (key, options) => {
            const result = await originalGet(key, options);
            if (holdGets) await new Promise<void>((release) => heldGets.push(release));
            return result;
        };
        const waitForHeldGets = async (count: number) => {
            const deadline = Date.now() + 5_000;
            while (heldGets.length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
            expect(heldGets.length, `expected ${count} writers parked on the compare read`).to.equal(count);
        };
        const cachedSequence = async () => unmarshalIPNSRecord((await originalGet(routingKey)).record).sequence;

        // Count completed put calls (through the arrival wrapper), so a test can wait for a writer
        // it cannot await, such as helia's own #handleRecord.
        let completedPuts = 0;
        const wrappedPut = localStore.put.bind(localStore);
        localStore.put = async (key, record, options) => {
            try {
                await wrappedPut(key, record, options);
            } finally {
                completedPuts++;
            }
        };
        const waitForCompletedPuts = async (count: number) => {
            const deadline = Date.now() + 5_000;
            while (completedPuts < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
            expect(completedPuts, `expected ${count} completed localStore.put calls`).to.equal(count);
        };

        return {
            client,
            pubsubRouter: pubsubRouter!,
            pubsubTopic,
            waitForCompletedPuts,
            resetCompletedPuts: () => (completedPuts = 0),
            localStore,
            routingKey,
            makeRecord,
            arrivals,
            heldGets,
            waitForHeldGets,
            cachedSequence,
            setHoldGets: (v: boolean) => (holdGets = v)
        };
    };

    it("keeps the newer cached record and announces only it when an older direct-fetch write lands last", async () => {
        const t = await setup();
        await t.localStore.put(t.routingKey, await t.makeRecord(3n));
        expect(await t.cachedSequence()).to.equal(3n);
        t.arrivals.length = 0;

        const [seq5, seq4] = [await t.makeRecord(5n), await t.makeRecord(4n)];
        t.setHoldGets(true);
        // e.g. a direct fetch returning seq 5 and a slower provider returning seq 4 for the same name.
        // Park the writers one at a time so heldGets[0] is always the seq 5 writer: two writers
        // started together reach the compare read in scheduling order, not call order.
        const writeSeq5 = cacheIpnsRecordInPubsubLocalStore({ localStore: t.localStore, routingKey: t.routingKey, marshalledRecord: seq5 });
        await t.waitForHeldGets(1);
        const writeSeq4 = cacheIpnsRecordInPubsubLocalStore({ localStore: t.localStore, routingKey: t.routingKey, marshalledRecord: seq4 });
        await t.waitForHeldGets(2); // both writers read "has" and are about to compare against seq 3
        t.setHoldGets(false);
        t.heldGets[0]();
        await writeSeq5;
        expect(await t.cachedSequence()).to.equal(5n);
        t.heldGets[1]();
        await writeSeq4;

        expect(t.arrivals, "arrivals dispatched").to.deep.equal([5n]);
        expect(await t.cachedSequence(), "sequence held in the localStore").to.equal(5n);
    });

    it("announces a record once when two writers store the same record concurrently", async () => {
        const t = await setup();
        await t.localStore.put(t.routingKey, await t.makeRecord(3n));
        t.arrivals.length = 0;

        const seq5 = await t.makeRecord(5n);
        t.setHoldGets(true);
        const writeA = cacheIpnsRecordInPubsubLocalStore({ localStore: t.localStore, routingKey: t.routingKey, marshalledRecord: seq5 });
        await t.waitForHeldGets(1);
        const writeB = cacheIpnsRecordInPubsubLocalStore({ localStore: t.localStore, routingKey: t.routingKey, marshalledRecord: seq5 });
        await t.waitForHeldGets(2);
        t.setHoldGets(false);
        t.heldGets[0]();
        await writeA;
        t.heldGets[1]();
        await writeB;

        // The second put is a byte-identical no-op inside helia's localStore, so it must not dispatch.
        expect(t.arrivals, "arrivals dispatched").to.deep.equal([5n]);
    });

    it("keeps the newer record when helia's gossip handler (#handleRecord) writes an older one last", async () => {
        const t = await setup();
        await t.localStore.put(t.routingKey, await t.makeRecord(3n));
        t.arrivals.length = 0;
        t.resetCompletedPuts();

        // The router drops gossip for topics outside its private subscriptions Set; name.resolve
        // adds the topic in production, here it is added directly.
        t.pubsubRouter.subscriptions.add(t.pubsubTopic);
        const gossipFrom = peerIdFromPrivateKey(await generateKeyPair("Ed25519"));
        const deliverGossip = (data: Uint8Array) =>
            t.client._helia.libp2p.services.pubsub.dispatchEvent(
                new CustomEvent("message", { detail: { type: "signed", from: gossipFrom, topic: t.pubsubTopic, data } })
            );

        const [seq5, seq4] = [await t.makeRecord(5n), await t.makeRecord(4n)];
        t.setHoldGets(true);
        // e.g. two mesh peers forwarding different sequence numbers of the same name. helia's
        // #handleRecord runs asynchronously per message, so two messages dispatched back to back
        // reach the compare read in scheduling order (seq 4 first on a slow runner, seen on macOS
        // CI). Park seq 5 before dispatching seq 4 so heldGets[0] is always the seq 5 handler.
        deliverGossip(seq5);
        await t.waitForHeldGets(1);
        deliverGossip(seq4);
        await t.waitForHeldGets(2);
        t.setHoldGets(false);
        t.heldGets[0]();
        await t.waitForCompletedPuts(1);
        expect(await t.cachedSequence()).to.equal(5n);
        t.heldGets[1]();
        await t.waitForCompletedPuts(2);

        expect(t.arrivals, "arrivals dispatched").to.deep.equal([5n]);
        expect(await t.cachedSequence(), "sequence held in the localStore").to.equal(5n);
    });
});
