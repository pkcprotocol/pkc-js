// The RPC half of delegation setup (issue #234).
//
// The implementation lives on LocalCommunity and is forwarded by RpcLocalCommunity, mirroring
// startCommunity/stopCommunity, so an in-process self-hosted node needs no RPC at all. RPC params
// follow the existing community-scoped shape {name?, publicKey?}, where publicKey is the anchor.
// The in-process flow is test/node/community/delegation-setup.test.ts.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { multihashToIPNSRoutingKey } from "ipns";
import { ipnsValidator } from "ipns/validator";
import { peerIdFromString } from "@libp2p/peer-id";
import { mockPKC, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { describeIfRpc } from "../../helpers/conditional-tests.js";
import { messages } from "../../../dist/node/errors.js";
import { createAnchorIpnsRecord } from "../../../dist/node/signer/index.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { PublishAnchorRecordRpcParam } from "../../../dist/node/clients/rpc-client/types.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { SignerType } from "../../../dist/node/signer/types.js";

describeIfRpc.sequential("delegation setup over RPC", () => {
    let pkc: PKC;
    let anchorSigner: SignerType; // As never leaves this process
    let community: RpcLocalCommunity;
    let minterName: string;
    let sentPayloads: string[];

    beforeAll(async () => {
        pkc = await mockPKC();
        anchorSigner = await pkc.createSigner();

        // Record everything this client puts on the wire, so "As never crosses" is asserted against
        // what was actually sent rather than against the shape we believe we send.
        sentPayloads = [];
        // _webSocketClient is private on PKCRpcClient; a narrow structural cast keeps the tap typed
        // without reaching for any.
        type WireTap = { _webSocketClient: { call: (method: string, params: unknown, ...rest: unknown[]) => Promise<unknown> } };
        const rpcClient = <WireTap>(<unknown>pkc._pkcRpcClient!);
        const originalCall = rpcClient._webSocketClient.call.bind(rpcClient._webSocketClient);
        rpcClient._webSocketClient.call = (method: string, params: unknown, ...rest: unknown[]) => {
            sentPayloads.push(JSON.stringify({ method, params }));
            return originalCall(method, params, ...rest);
        };

        community = <RpcLocalCommunity>await pkc.createCommunity({ anchor: { publicKey: anchorSigner.address } });
        minterName = community.signer.address;
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    describe("createCommunity over RPC accepts an anchor publicKey", () => {
        it("keys the community by the anchor and returns the node's own minter", () => {
            expect(community.address).to.equal(anchorSigner.address);
            expect(community.publicKey).to.equal(anchorSigner.address);
            expect(community.anchor).to.deep.equal({ publicKey: anchorSigner.address });
            expect(minterName).to.not.equal(anchorSigner.address);
        });

        // After #229 a client can no longer derive or guess the topic, and before the first mint there
        // is no record to read it from, so the create response has to carry both.
        it("returns the bootstrap pubsubTopic and encryption", () => {
            expect(community.pubsubTopic).to.equal(minterName);
            expect(community.encryption.publicKey).to.be.a("string");
        });

        it("reports no anchor record yet, which tells the client to sign sequence 0", () => {
            expect(community.anchorRecordSequence).to.be.undefined;
        });
    });

    describe("both methods are addressable as {name?, publicKey?}", () => {
        it("prepareAnchorPublish surfaces server-side PKC errors with their code, not a bare RPC failure", async () => {
            // Nothing anywhere knows a sequence for this fresh anchor, so the server refuses to guess.
            await expect(community.prepareAnchorPublish()).rejects.toThrow(messages.ERR_UNABLE_TO_DETERMINE_ANCHOR_SEQUENCE);
        });

        it("publishAnchorRecord rejects a record the server cannot verify rather than re-signing anything", async () => {
            const impostor = await pkc.createSigner();
            const bytes = await createAnchorIpnsRecord({ anchorSigner: impostor, minterIpnsName: minterName, sequence: 0 });
            await expect(community.publishAnchorRecord(bytes)).rejects.toThrow(messages.ERR_ANCHOR_IPNS_RECORD_IS_INVALID);
        });

        it("publishAnchorRecord accepts a record signed by the anchor and pointing at the node's minter", async () => {
            const bytes = await createAnchorIpnsRecord({ anchorSigner, minterIpnsName: minterName, sequence: 0 });
            // The bytes must survive the base64 round trip intact: they are signed.
            await ipnsValidator(multihashToIPNSRoutingKey(peerIdFromString(anchorSigner.address).toMultihash()), bytes);

            const published = await community.publishAnchorRecord(bytes);
            expect(published.sequence).to.equal("0");
            expect(published.value).to.equal(`/ipns/${minterName}`);
            expect(published.anchorPublicKey).to.equal(anchorSigner.address);
            expect(community.anchorRecordSequence).to.equal("0");
        });

        it("anti-rollback is enforced server-side", async () => {
            const replay = await createAnchorIpnsRecord({ anchorSigner, minterIpnsName: minterName, sequence: 0 });
            await expect(community.publishAnchorRecord(replay)).rejects.toThrow(messages.ERR_ANCHOR_IPNS_RECORD_SEQUENCE_IS_NOT_GREATER);
        });

        it("prepareAnchorPublish answers once the server has history", async () => {
            const prepared = await community.prepareAnchorPublish();
            expect(prepared.hasPersistedAnchorRecord).to.be.true;
            expect(BigInt(prepared.nextSequence) > 0n).to.be.true;
        });
    });

    describe("the server never sees the anchor private key", () => {
        it("no RPC param carries As", () => {
            expect(sentPayloads.length).to.be.greaterThan(0);
            const anchorPublishCalls = sentPayloads.filter((p) => p.includes("AnchorPublish") || p.includes("AnchorRecord"));
            expect(anchorPublishCalls.length).to.be.greaterThan(0);
            for (const payload of sentPayloads) expect(payload).to.not.include(anchorSigner.privateKey);
        });

        it("the community the client holds knows the anchor's public key only", () => {
            expect(JSON.stringify(community.anchor)).to.not.include(anchorSigner.privateKey);
        });
    });

    describe("a client that cannot stay online", () => {
        it("the community starts once its anchor record exists, and keeps running without the client", async () => {
            await community.start();
            expect(community.started).to.be.true;
            await community.stop();
        });

        // Half-created rather than broken: publishing the record later completes it with no re-create.
        it("a community whose anchor record never arrived refuses to start", async () => {
            const otherAnchor = await pkc.createSigner();
            const halfCreated = <RpcLocalCommunity>await pkc.createCommunity({ anchor: { publicKey: otherAnchor.address } });
            try {
                await expect(halfCreated.start()).rejects.toThrow(messages.ERR_DELEGATED_COMMUNITY_HAS_NO_ANCHOR_RECORD);
                expect(halfCreated.anchorRecordSequence).to.be.undefined;

                const bytes = await createAnchorIpnsRecord({
                    anchorSigner: otherAnchor,
                    minterIpnsName: halfCreated.signer.address,
                    sequence: 0
                });
                await halfCreated.publishAnchorRecord(bytes);
                await halfCreated.start();
                expect(halfCreated.started).to.be.true;
                // Wait for an update from the server before asserting the sequence. publishAnchorRecord
                // sets anchorRecordSequence client-side from its own result, so asserting straight after
                // start() would pass on that local copy even if the server had cleared its own. Only a
                // value that came back over the wire tests the server, and the server sends the one
                // start() left on its instance: the internal record deliberately omits
                // anchorRecordSequence, so failing to re-derive it from its own keyv slot sends
                // undefined here. See updateInstanceStateWithDbState.
                await resolveWhenConditionIsTrue({
                    toUpdate: halfCreated,
                    predicate: async () => typeof halfCreated.updatedAt === "number"
                });
                expect(halfCreated.anchorRecordSequence).to.equal("0");
                await halfCreated.stop();
            } finally {
                await halfCreated.delete();
            }
        });
    });

    // The client re-derives a community's identity from every internal record the server sends, and the
    // record it sends AFTER the first mint carries signature.publicKey, which is the minter. The create
    // assertions above only cover the record sent before it. Without the anchor being replayed into
    // ipnsHops on this second path the client's community silently becomes addressed by the key that
    // merely signs for it, and every publication the client then addresses to it is rejected for a
    // communityPublicKey that does not match what the node accepts.
    describe("identity once the first update arrives over the wire", () => {
        it("is still the anchor after the community has published a record", async () => {
            await community.start();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            expect(community.updateCid, "the client must have received a post-first-update record").to.be.a("string");

            expect(community.publicKey).to.equal(anchorSigner.address);
            expect(community.address).to.equal(anchorSigner.address);
            expect(community.ipnsHops).to.deep.equal([anchorSigner.address, minterName]);
            expect(community.anchor).to.deep.equal({ publicKey: anchorSigner.address });
            expect(community.signer.address, "the minter is what signs the record the client just read").to.equal(minterName);
            expect(community.anchorRecordSequence).to.equal("0");

            await community.stop();
        });
    });

    // The param schema is the one thing both ends share, and it is what stops a malformed call from
    // reaching publishAnchorRecord as an empty record or as a community nobody named. Asserted through
    // the client, which parses with it before anything goes on the wire.
    describe("the shared param schema", () => {
        it("rejects a publishAnchorRecord call with no record rather than sending an empty one", async () => {
            const rpcClient = pkc._pkcRpcClient!;
            await expect(rpcClient.publishAnchorRecord({ publicKey: community.address, recordBase64: "" })).rejects.toThrow();

            const missingRecord = <PublishAnchorRecordRpcParam>(<Partial<PublishAnchorRecordRpcParam>>{ publicKey: community.address });
            await expect(rpcClient.publishAnchorRecord(missingRecord)).rejects.toThrow();
        });

        // Both methods are community-scoped, so a call naming no community must fail on its params
        // rather than resolve to whichever community the node happens to host.
        it("rejects a call that names neither a community name nor a publicKey", async () => {
            const rpcClient = pkc._pkcRpcClient!;
            await expect(rpcClient.prepareAnchorPublish({})).rejects.toThrow();
            await expect(rpcClient.publishAnchorRecord({ recordBase64: "AAAA" })).rejects.toThrow();
        });
    });

    // Neither method edits anything, so the failure to resolve the community must not report itself as
    // an attempted edit. RpcLocalCommunity only ever forwards a community the server does host, so the
    // params go straight at the RPC client, the way a third-party client would send them.
    describe("anchor methods on a community this node does not host", () => {
        it("rejects with the anchor-method error rather than the edit one", async () => {
            const strangerAnchor = await pkc.createSigner();
            const rpcClient = pkc._pkcRpcClient!;

            await expect(rpcClient.prepareAnchorPublish({ publicKey: strangerAnchor.address })).rejects.toThrow(
                messages.ERR_RPC_CLIENT_TRYING_TO_USE_ANCHOR_METHOD_ON_NON_LOCAL_COMMUNITY
            );

            const bytes = await createAnchorIpnsRecord({
                anchorSigner: strangerAnchor,
                minterIpnsName: minterName,
                sequence: 0
            });
            await expect(
                rpcClient.publishAnchorRecord({
                    publicKey: strangerAnchor.address,
                    recordBase64: Buffer.from(bytes).toString("base64")
                })
            ).rejects.toThrow(messages.ERR_RPC_CLIENT_TRYING_TO_USE_ANCHOR_METHOD_ON_NON_LOCAL_COMMUNITY);
        });
    });
});
