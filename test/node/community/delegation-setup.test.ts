// Delegation setup (issue #234): telling a pkc-js node "run this community for me, I keep the anchor
// key". See docs/protocol/delegated-ipns.md. Kind-blind: serves a delegated community and a delegated
// authorCommunity alike.
//
// An/As = anchor keypair (identity, owner-held, never leaves the client).
// Mn/Ms = minter keypair (generated and held by the node, rotatable).
// The node-side identity split is issue #233, see local-community/delegated-community.test.ts.
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey, peerIdFromString } from "@libp2p/peer-id";
import { createIPNSRecord, marshalIPNSRecord, multihashToIPNSRoutingKey } from "ipns";
import { ipnsValidator } from "ipns/validator";
import { mockPKC, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { messages } from "../../../dist/node/errors.js";
import { createAnchorIpnsRecord, ANCHOR_IPNS_RECORD_LIFETIME_MS } from "../../../dist/node/signer/index.js";
import { ipnsNameToIpnsOverPubsubTopic } from "../../../dist/node/util.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { SignerType } from "../../../dist/node/signer/types.js";

const KUBO_API = "http://localhost:15001/api/v0";

const kuboPost = async (path: string, body?: BodyInit) => {
    const res = await fetch(`${KUBO_API}/${path}`, { method: "POST", body, signal: AbortSignal.timeout(60000) });
    return { ok: res.ok, status: res.status, text: await res.text() };
};

const putRecordThroughKubo = async (ipnsName: string, recordBytes: Uint8Array) => {
    const form = new FormData();
    form.append("file", new Blob([recordBytes as BlobPart]), "record");
    return kuboPost(`routing/put?arg=${encodeURIComponent("/ipns/" + ipnsName)}&allow-offline=true`, form);
};

const resolveOnKubo = (ipnsName: string, recursive = false) =>
    kuboPost(`name/resolve?arg=${encodeURIComponent("/ipns/" + ipnsName)}&recursive=${recursive}&nocache=true`);

const subscribedTopics = async () => {
    const strings = (JSON.parse((await kuboPost("pubsub/ls")).text).Strings || []) as string[];
    return strings.map((topic) => Buffer.from(topic.slice(1), "base64url").toString("utf8"));
};

// This ran FIRST, before any of the API below was written: name.publish cannot publish bytes signed by
// a key the node does not hold, so the anchor record has to go out through routing.put. Had that not
// reached the routers and the ipns-over-pubsub topic, the whole "the node keeps the anchor alive"
// design would have changed shape. Kept as a test so a kubo upgrade that breaks the assumption is
// caught here rather than in production.
//
// Skipped under RPC because every assertion here is a raw HTTP call straight at the local kubo daemon
// (routing/put, name/resolve, pubsub/ls, key/list) rather than a pkc-js call. It is asserting kubo's
// behaviour, not pkc-js's, so there is nothing for the RPC layer to carry: under remote-pkc-rpc the
// daemon these calls reach is not the one the community under test publishes through.
describeSkipIfRpc.sequential("spike: publishing a foreign pre-signed IPNS record through kubo", () => {
    let anchorPriv: Awaited<ReturnType<typeof generateKeyPair>>;
    let anchorName: string;
    let minterName: string;
    let recordBytes: Uint8Array;

    beforeAll(async () => {
        anchorPriv = await generateKeyPair("Ed25519");
        anchorName = peerIdFromPrivateKey(anchorPriv).toString();
        minterName = peerIdFromPrivateKey(await generateKeyPair("Ed25519")).toString();
        recordBytes = marshalIPNSRecord(await createIPNSRecord(anchorPriv, `/ipns/${minterName}`, 0n, ANCHOR_IPNS_RECORD_LIFETIME_MS));
    });

    it("the record is valid and its key is NOT in the node's keystore", async () => {
        await ipnsValidator(multihashToIPNSRoutingKey(peerIdFromPrivateKey(anchorPriv).toMultihash()), recordBytes);
        expect((await kuboPost("key/list?l=true")).text).to.not.include(anchorName);
    });

    it("routing.put accepts a record signed by a key that is not in the node's keystore", async () => {
        const put = await putRecordThroughKubo(anchorName, recordBytes);
        expect(put.ok, put.text).to.be.true;
    });

    it("the node then resolves the name it was never given a key for", async () => {
        const resolved = await resolveOnKubo(anchorName);
        expect(resolved.ok, resolved.text).to.be.true;
        expect(JSON.parse(resolved.text).Path).to.equal(`/ipns/${minterName}`);
    });

    // This is what lets the node serve the binding to peers at all. It is also the thing that does NOT
    // survive a kubo restart, which is why the re-provide runs at start() and not only on a timer.
    it("the put subscribes the node to the anchor's ipns-over-pubsub topic", async () => {
        expect(await subscribedTopics()).to.include(ipnsNameToIpnsOverPubsubTopic(anchorName));
    });

    // kubo answers 200 and keeps the higher record, which is why anti-rollback cannot be delegated to it.
    it("kubo reports success for a lower-sequence put while silently discarding it", async () => {
        const higher = marshalIPNSRecord(await createIPNSRecord(anchorPriv, `/ipns/${minterName}`, 9n, ANCHOR_IPNS_RECORD_LIFETIME_MS));
        expect((await putRecordThroughKubo(anchorName, higher)).ok).to.be.true;

        const rolledBackTarget = peerIdFromPrivateKey(await generateKeyPair("Ed25519")).toString();
        const lower = marshalIPNSRecord(
            await createIPNSRecord(anchorPriv, `/ipns/${rolledBackTarget}`, 1n, ANCHOR_IPNS_RECORD_LIFETIME_MS)
        );
        const lowerPut = await putRecordThroughKubo(anchorName, lower);
        expect(lowerPut.ok, "kubo accepts the request").to.be.true;

        const resolved = await resolveOnKubo(anchorName);
        expect(JSON.parse(resolved.text).Path, "but keeps the higher record").to.equal(`/ipns/${minterName}`);
    });
});

// Skipped under RPC: this drives LocalCommunity directly and inspects the kubo node it publishes
// through. The same flow over the RPC is test/node/rpc/delegation-setup.rpc.test.ts.
describeSkipIfRpc.sequential("delegation setup end to end", () => {
    let pkc: PKC;
    let anchorSigner: SignerType; // As, held by the owner. Never handed to the community.
    let community: LocalCommunity;
    let minterName: string;

    beforeAll(async () => {
        pkc = await mockPKC();
        anchorSigner = await pkc.createSigner();
        community = <LocalCommunity>await pkc.createCommunity({ anchor: { publicKey: anchorSigner.address } });
        await community.edit({ settings: { challenges: [] } });
        minterName = community.signer.address;
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    describe("a community created with an anchor, before its record is published", () => {
        it("returns the minter, pubsubTopic and encryption so the client can bootstrap before the first mint", () => {
            expect(minterName).to.be.a("string");
            expect(minterName).to.not.equal(anchorSigner.address);
            expect(community.pubsubTopic).to.equal(minterName);
            expect(community.encryption.publicKey).to.equal(community.signer.publicKey);
        });

        it("has no anchor record yet, which is how a client knows to sign sequence 0", () => {
            expect(community.anchorRecordSequence).to.be.undefined;
        });

        it("refuses to start: nothing points the anchor at this minter, so it would not be resolvable", async () => {
            await expect(community.start()).rejects.toThrow(messages.ERR_DELEGATED_COMMUNITY_HAS_NO_ANCHOR_RECORD);
        });

        // The node cannot tell "this anchor is brand new" from "the lookup failed", and answering 0 on
        // the second reading produces a correctly signed record that loses forever.
        it("prepareAnchorPublish refuses to guess rather than falling through to 0", async () => {
            await expect(community.prepareAnchorPublish()).rejects.toThrow(messages.ERR_UNABLE_TO_DETERMINE_ANCHOR_SEQUENCE);
        });
    });

    describe("signing the anchor record client-side", () => {
        it("produces a record that passes ipnsValidator against the anchor's routing key", async () => {
            const bytes = await createAnchorIpnsRecord({ anchorSigner, minterIpnsName: minterName, sequence: 0 });
            await ipnsValidator(multihashToIPNSRoutingKey(peerIdFromString(anchorSigner.address).toMultihash()), bytes);
        });

        it("refuses a minterIpnsName that is not an IPNS name, before signing anything", async () => {
            await expect(createAnchorIpnsRecord({ anchorSigner, minterIpnsName: "not-an-ipns-name", sequence: 0 })).rejects.toThrow();
        });
    });

    describe("publishAnchorRecord verification", () => {
        it("rejects malformed record bytes", async () => {
            await expect(community.publishAnchorRecord(new Uint8Array([1, 2, 3]))).rejects.toThrow(
                messages.ERR_ANCHOR_IPNS_RECORD_IS_INVALID
            );
        });

        it("rejects a record signed by any other key", async () => {
            const impostor = await pkc.createSigner();
            const bytes = await createAnchorIpnsRecord({ anchorSigner: impostor, minterIpnsName: minterName, sequence: 0 });
            await expect(community.publishAnchorRecord(bytes)).rejects.toThrow(messages.ERR_ANCHOR_IPNS_RECORD_IS_INVALID);
        });

        it("rejects a record pointing at a different minter", async () => {
            const otherMinter = await pkc.createSigner();
            const bytes = await createAnchorIpnsRecord({ anchorSigner, minterIpnsName: otherMinter.address, sequence: 0 });
            await expect(community.publishAnchorRecord(bytes)).rejects.toThrow(messages.ERR_ANCHOR_IPNS_RECORD_POINTS_TO_DIFFERENT_MINTER);
        });

        it("accepts a record signed by the anchor that points at this node's own minter", async () => {
            const bytes = await createAnchorIpnsRecord({ anchorSigner, minterIpnsName: minterName, sequence: 0 });
            const published = await community.publishAnchorRecord(bytes);
            expect(published.sequence).to.equal("0");
            expect(published.value).to.equal(`/ipns/${minterName}`);
            expect(published.anchorPublicKey).to.equal(anchorSigner.address);
            expect(community.anchorRecordSequence).to.equal("0");
        });

        it("rejects a replay of the record it just accepted", async () => {
            const bytes = await createAnchorIpnsRecord({ anchorSigner, minterIpnsName: minterName, sequence: 0 });
            await expect(community.publishAnchorRecord(bytes)).rejects.toThrow(messages.ERR_ANCHOR_IPNS_RECORD_SEQUENCE_IS_NOT_GREATER);
        });

        // kubo would answer 200 and silently keep the newer record, so this rejection has to be ours.
        it("rejects a rollback to a lower sequence", async () => {
            const higher = await createAnchorIpnsRecord({ anchorSigner, minterIpnsName: minterName, sequence: 20 });
            await community.publishAnchorRecord(higher);
            expect(community.anchorRecordSequence).to.equal("20");

            const lower = await createAnchorIpnsRecord({ anchorSigner, minterIpnsName: minterName, sequence: 7 });
            await expect(community.publishAnchorRecord(lower)).rejects.toThrow(messages.ERR_ANCHOR_IPNS_RECORD_SEQUENCE_IS_NOT_GREATER);
            expect(community.anchorRecordSequence).to.equal("20");
        });
    });

    describe("prepareAnchorPublish once there is history", () => {
        it("clears the highest known sequence by a margin, never equalling it", async () => {
            const prepared = await community.prepareAnchorPublish();
            expect(prepared.hasPersistedAnchorRecord).to.be.true;
            expect(BigInt(prepared.currentAnchorRecordSequence) >= 20n).to.be.true;
            expect(BigInt(prepared.nextSequence) > BigInt(prepared.currentAnchorRecordSequence)).to.be.true;
        });

        it("hands back a sequence the node then accepts", async () => {
            const { nextSequence } = await community.prepareAnchorPublish();
            const bytes = await createAnchorIpnsRecord({ anchorSigner, minterIpnsName: minterName, sequence: BigInt(nextSequence) });
            const published = await community.publishAnchorRecord(bytes);
            expect(published.sequence).to.equal(nextSequence);
        });
    });

    describe("after the anchor record is published", () => {
        it("/ipns/An resolves to /ipns/Mn on the node that published it", async () => {
            const resolved = await resolveOnKubo(anchorSigner.address);
            expect(resolved.ok, resolved.text).to.be.true;
            expect(JSON.parse(resolved.text).Path).to.equal(`/ipns/${minterName}`);
        });

        it("the node subscribes to the anchor's ipns-over-pubsub topic in addition to the minter's", async () => {
            expect(await subscribedTopics()).to.include(ipnsNameToIpnsOverPubsubTopic(anchorSigner.address));
        });

        it("the community now starts, and the anchor resolves through to its published record", async () => {
            const sequenceBeforeStart = community.anchorRecordSequence;
            expect(sequenceBeforeStart).to.be.a("string");
            await community.start();
            // start() reloads internal state, and that record deliberately omits anchorRecordSequence,
            // so it has to be re-derived from the keyv slot publishAnchorRecord owns. Otherwise a
            // community whose record is published reports no sequence at all once started.
            expect(community.anchorRecordSequence, "start() must not clear the anchor sequence").to.equal(sequenceBeforeStart);
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            expect(community.updateCid).to.be.a("string");

            const resolved = await resolveOnKubo(anchorSigner.address, true);
            expect(resolved.ok, resolved.text).to.be.true;
            expect(JSON.parse(resolved.text).Path).to.equal(`/ipfs/${community.updateCid}`);
        });

        // A restarted kubo keeps the record but drops the subscription that serves it, so start() puts
        // again rather than waiting for the publish loop's timer.
        it("start() re-provides the anchor record", () => {
            expect(community._lastAnchorRecordReprovideAt).to.be.a("number");
        });

        it("survives a stop/start cycle with no re-publish by the owner", async () => {
            const sequenceBeforeRestart = community.anchorRecordSequence;
            await community.stop();
            community._lastAnchorRecordReprovideAt = undefined;
            await community.start();
            expect(community._lastAnchorRecordReprovideAt).to.be.a("number");
            expect(community.anchorRecordSequence).to.equal(sequenceBeforeRestart);
            const resolved = await resolveOnKubo(anchorSigner.address);
            expect(JSON.parse(resolved.text).Path).to.equal(`/ipns/${minterName}`);
        });
    });

    // The anti-rollback check reads the high-water mark, then awaits the kubo put and two keyvSets
    // before persisting it. Without serialization two concurrent publishes both clear the check and
    // last-write-wins can persist the LOWER sequence, after which a record in between passes the check
    // and gets silently dropped by kubo while we report success. See anchor-publishing.ts.
    describe("concurrent publishAnchorRecord calls for the same community", () => {
        let concurrentAnchor: SignerType;
        let concurrentCommunity: LocalCommunity;

        const freshDelegatedCommunity = async () => {
            concurrentAnchor = await pkc.createSigner();
            concurrentCommunity = <LocalCommunity>await pkc.createCommunity({ anchor: { publicKey: concurrentAnchor.address } });
            await concurrentCommunity.edit({ settings: { challenges: [] } });
        };

        afterEach(async () => {
            await concurrentCommunity.delete();
        });

        // Deterministic regardless of which call wins the lock: whichever runs second sees its own
        // sequence already persisted, and equal is refused too.
        it("accepts exactly one of two identical-sequence publishes, and persists it", async () => {
            await freshDelegatedCommunity();
            const minter = concurrentCommunity.signer.address;
            const [first, second] = await Promise.all([
                createAnchorIpnsRecord({ anchorSigner: concurrentAnchor, minterIpnsName: minter, sequence: 5 }),
                createAnchorIpnsRecord({ anchorSigner: concurrentAnchor, minterIpnsName: minter, sequence: 5 })
            ]);

            const results = await Promise.allSettled([
                concurrentCommunity.publishAnchorRecord(first),
                concurrentCommunity.publishAnchorRecord(second)
            ]);

            const fulfilled = results.filter((r) => r.status === "fulfilled");
            const rejected = results.filter((r) => r.status === "rejected");
            expect(fulfilled.length, "exactly one publish should win").to.equal(1);
            expect(rejected.length).to.equal(1);
            expect(String((<PromiseRejectedResult>rejected[0]).reason?.message)).to.include(
                messages.ERR_ANCHOR_IPNS_RECORD_SEQUENCE_IS_NOT_GREATER
            );
            expect((<PromiseFulfilledResult<{ sequence: string }>>fulfilled[0]).value.sequence).to.equal("5");
            expect(concurrentCommunity.anchorRecordSequence).to.equal("5");

            // The high-water mark that was actually persisted, not just the in-memory copy: this is the
            // value a later record has to beat, and the one a rollback would have corrupted.
            const reloaded = <LocalCommunity>await pkc.createCommunity({ address: concurrentCommunity.address });
            expect(reloaded.anchorRecordSequence).to.equal("5");
        });

        // Order-independent: the highest sequence attempted always wins, since nothing else can push the
        // mark past it, and the mark ends equal to it whichever order the two calls acquire the lock in.
        it("ends at the highest sequence attempted, whichever call runs first", async () => {
            await freshDelegatedCommunity();
            const minter = concurrentCommunity.signer.address;
            const [lower, higher] = await Promise.all([
                createAnchorIpnsRecord({ anchorSigner: concurrentAnchor, minterIpnsName: minter, sequence: 11 }),
                createAnchorIpnsRecord({ anchorSigner: concurrentAnchor, minterIpnsName: minter, sequence: 12 })
            ]);

            const [lowerResult, higherResult] = await Promise.allSettled([
                concurrentCommunity.publishAnchorRecord(lower),
                concurrentCommunity.publishAnchorRecord(higher)
            ]);

            expect(higherResult.status, "the highest sequence attempted can never lose").to.equal("fulfilled");
            // The lower one only survives if it got the lock first; if it lost the race it must have been
            // refused rather than silently overwriting the mark.
            if (lowerResult.status === "rejected")
                expect(String(lowerResult.reason?.message)).to.include(messages.ERR_ANCHOR_IPNS_RECORD_SEQUENCE_IS_NOT_GREATER);
            expect(concurrentCommunity.anchorRecordSequence).to.equal("12");

            const reloaded = <LocalCommunity>await pkc.createCommunity({ address: concurrentCommunity.address });
            expect(reloaded.anchorRecordSequence).to.equal("12");
        });
    });

    describe("the anchor methods are for delegated communities only", () => {
        it("a non-delegated community has no anchor record to prepare or publish", async () => {
            const plain = <LocalCommunity>await pkc.createCommunity({});
            try {
                await expect(plain.prepareAnchorPublish()).rejects.toThrow(messages.ERR_COMMUNITY_IS_NOT_DELEGATED);
                await expect(plain.publishAnchorRecord(new Uint8Array([1, 2, 3]))).rejects.toThrow(messages.ERR_COMMUNITY_IS_NOT_DELEGATED);
            } finally {
                await plain.delete();
            }
        });
    });
});
