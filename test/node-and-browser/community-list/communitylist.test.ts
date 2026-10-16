// CommunityList lifecycle (docs/protocol/community-lists.md): an immutable, signed IPFS file
// addressed by CID. publish() = sign + IPFS add; update() = fetch + verify with retries, emit
// `update`, then auto-stop once there is nothing left to settle.
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { clone } from "remeda";
import signers from "../../fixtures/signers.js";
import { getAvailablePKCConfigsToTestAgainst, mockRemotePKC, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { messages } from "../../../dist/node/errors.js";
import { PKCError } from "../../../dist/node/pkc-error.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { CommunityList } from "../../../dist/node/community-list/community-list.js";
import type { CommunityListIpfsType } from "../../../dist/node/community-list/types.js";
import { addCommunityListRecordToIpfs, buildSignedCommunityListRecord, mockCommunityListEntries } from "./communitylist-test-util.js";

const expectPKCErrorCode = (err: unknown, code: keyof typeof messages) => {
    expect(err).to.be.instanceOf(PKCError);
    expect((<PKCError>err).code).to.equal(code);
};

const waitUntilStoppedByItself = (list: CommunityList) =>
    resolveWhenConditionIsTrue({ toUpdate: list, predicate: async () => list.state === "stopped", eventName: "statechange" });

const updateAndAwaitError = async (list: CommunityList): Promise<PKCError> => {
    const errPromise = new Promise<PKCError>((resolve) => list.once("error", (e) => resolve(<PKCError>e)));
    await list.update();
    const err = await errPromise;
    await waitUntilStoppedByItself(list); // deterministic record errors stop the instance on their own
    return err;
};

// publish() needs a node that can `ipfs add`: a kubo-rpc client or a pkc RPC server
getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-pkc-rpc", "local-kubo-rpc"] }).map((config) =>
    describe(`communitylist publish - ${config.name}`, () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });
        afterAll(async () => {
            await pkc.destroy();
        });

        it("publishes a CommunityList, sets cid, and derives runtime conveniences", async () => {
            const signer = await pkc.createSigner();
            const list = await pkc.createCommunityList({
                signer,
                title: "My default feed",
                description: "Curated communities",
                communities: mockCommunityListEntries
            });
            const cid = await list.publish();
            expect(cid).to.be.a("string");
            expect(list.cid).to.equal(cid);
            expect(list.shortCid).to.be.a("string").and.not.equal(cid);
            expect(list.state).to.equal("stopped");
            expect(list.title).to.equal("My default feed");
            expect(list.timestamp).to.be.a("number");
            expect(list.protocolVersion).to.be.a("string");
            expect(list.signature?.publicKey).to.equal(signer.publicKey);

            // entry identity follows the publication convention: address = name || publicKey
            expect(list.communities?.[0].address).to.equal(mockCommunityListEntries[0].publicKey);
            expect(list.communities?.[1].address).to.equal(mockCommunityListEntries[1].name);
            expect(list.communities?.[0].shortAddress).to.be.a("string");

            // the wire record carries no runtime fields
            expect(list.raw.communityList).to.not.have.property("cid");
            expect(list.raw.communityList?.communities[0]).to.not.have.property("address");
            expect(list.raw.communityList?.communities[0]).to.not.have.property("shortAddress");
        });

        it("a published list loads back identically with getCommunityList", async () => {
            const signer = await pkc.createSigner();
            const list = await pkc.createCommunityList({ signer, communities: mockCommunityListEntries });
            const cid = await list.publish();

            const loaded = await pkc.getCommunityList({ cid });
            expect(loaded.raw.communityList).to.deep.equal(list.raw.communityList);
            expect(loaded.cid).to.equal(cid);
            expect(loaded.state).to.equal("stopped");
        });

        it("author identity derives from the signature, and author runtime fields never reach the wire", async () => {
            const signer = await pkc.createSigner();
            const list = await pkc.createCommunityList({
                signer,
                communities: mockCommunityListEntries,
                // runtime fields passed by mistake must be stripped before signing
                author: <never>{ displayName: "Curator", nameResolved: true, shortAddress: "12D3KooShort", community: { postScore: 1 } }
            });
            await list.publish();
            expect(list.raw.communityList?.author).to.deep.equal({ displayName: "Curator" });
            expect(list.author?.displayName).to.equal("Curator");
            expect(list.author?.address).to.equal(signer.address);
            expect(list.author?.publicKey).to.equal(signer.address);
            expect(list.author?.shortAddress).to.be.a("string");
            expect(list.author?.nameResolved).to.be.undefined;
            expect(list.author).to.not.have.property("community");
        });

        it("createCommunityList throws on a duplicate entry publicKey", async () => {
            const signer = await pkc.createSigner();
            const entry = mockCommunityListEntries[0];
            try {
                await pkc.createCommunityList({ signer, communities: [entry, clone(entry)] });
                expect.fail("should have thrown");
            } catch (e) {
                expectPKCErrorCode(e, "ERR_INVALID_CREATE_COMMUNITY_LIST_OPTIONS_SCHEMA");
            }
        });

        it("publish throws when the serialized record is over 2mb", async () => {
            const signer = await pkc.createSigner();
            const hugeTags = new Array(3).fill(undefined).map((_, i) => `${i}`.repeat(1024 * 1024)); // ~3mb
            const list = await pkc.createCommunityList({
                signer,
                communities: [{ ...mockCommunityListEntries[0], tags: hugeTags }]
            });
            try {
                await list.publish();
                expect.fail("should have thrown");
            } catch (e) {
                expectPKCErrorCode(e, "ERR_COMMUNITY_LIST_OVER_ALLOWED_SIZE");
            }
            expect(list.state).to.equal("stopped");
        });

        it("update() after publish() emits update with the already-loaded record and stops itself", async () => {
            const signer = await pkc.createSigner();
            const list = await pkc.createCommunityList({ signer, communities: mockCommunityListEntries });
            await list.publish();
            let updateEvents = 0;
            list.on("update", () => updateEvents++);
            await list.update();
            await waitUntilStoppedByItself(list);
            expect(updateEvents).to.equal(1);
        });
    })
);

describe("communitylist load", () => {
    let fixture: { record: CommunityListIpfsType; cid: string };

    beforeAll(async () => {
        const helperPkc = await mockRemotePKC();
        const { record } = await buildSignedCommunityListRecord({ pkc: helperPkc });
        const cid = await addCommunityListRecordToIpfs(record);
        fixture = { record, cid };
        await helperPkc.destroy();
    });

    getAvailablePKCConfigsToTestAgainst().map((config) =>
        describe(`communitylist load - ${config.name}`, () => {
            let pkc: PKC;
            beforeAll(async () => {
                pkc = await config.pkcInstancePromise();
            });
            afterAll(async () => {
                await pkc.destroy();
            });

            it("one-shot getCommunityList fetches and verifies the record", async () => {
                const list = await pkc.getCommunityList({ cid: fixture.cid });
                expect(list.raw.communityList).to.deep.equal(fixture.record);
                expect(list.title).to.equal(fixture.record.title);
                expect(list.timestamp).to.equal(fixture.record.timestamp);
                expect(list.communities?.length).to.equal(fixture.record.communities.length);
                expect(list.communities?.[1].address).to.equal(fixture.record.communities[1].name);
                expect(list.author?.address).to.be.a("string");
                expect(list.state).to.equal("stopped");
                expect(list.toJSON().cid).to.equal(fixture.cid);
            });

            it("createCommunityList({cid}) + update() emits update and stops itself when there is nothing to settle", async () => {
                const list = await pkc.createCommunityList({ cid: fixture.cid });
                expect(list.cid).to.equal(fixture.cid);
                expect(list.state).to.equal("stopped");
                await list.update();
                await resolveWhenConditionIsTrue({ toUpdate: list, predicate: async () => typeof list.title === "string" });
                expect(list.raw.communityList).to.deep.equal(fixture.record);
                // the record is immutable and this fixture's author has no domain: nothing to watch,
                // so the instance must stop on its own without a manual stop() call
                await waitUntilStoppedByItself(list);
            });

            it("update() emits an error and stops itself when the signature is invalid", async () => {
                const invalidRecord = clone(fixture.record);
                invalidRecord.signature.signature = invalidRecord.signature.signature.slice(0, -4) + "AAAA";
                const invalidCid = await addCommunityListRecordToIpfs(invalidRecord);
                const list = await pkc.createCommunityList({ cid: invalidCid });
                const err = await updateAndAwaitError(list);
                expect(err.code).to.equal("ERR_COMMUNITY_LIST_SIGNATURE_IS_INVALID");
            });

            it("update() emits a schema error and stops itself on duplicate entry publicKeys", async () => {
                const helperPkc = await mockRemotePKC();
                const dupEntry = mockCommunityListEntries[0];
                const { record } = await buildSignedCommunityListRecord({
                    pkc: helperPkc,
                    communities: [dupEntry, clone(dupEntry)]
                });
                await helperPkc.destroy();
                const dupCid = await addCommunityListRecordToIpfs(record);
                const list = await pkc.createCommunityList({ cid: dupCid });
                const err = await updateAndAwaitError(list);
                expect(err.code).to.equal("ERR_INVALID_COMMUNITY_LIST_SCHEMA");
            });

            it("update() emits an error and stops itself when the record includes a reserved field", async () => {
                // a wire record must never smuggle in runtime-only names; `cid` is added after signing
                // so it hits the reserved-field check, not the unsigned-signable-field check
                const recordWithReserved = { ...clone(fixture.record), cid: fixture.cid };
                const reservedCid = await addCommunityListRecordToIpfs(recordWithReserved);
                const list = await pkc.createCommunityList({ cid: reservedCid });
                const err = await updateAndAwaitError(list);
                expect(err.code).to.equal("ERR_COMMUNITY_LIST_SIGNATURE_IS_INVALID");
                expect((<{ validity?: { reason?: string } }>err.details).validity?.reason).to.equal(
                    messages.ERR_COMMUNITY_LIST_RECORD_INCLUDES_RESERVED_FIELD
                );
            });
        })
    );

    // Gateways report an oversize download through an aggregated gateway error rather than
    // ERR_OVER_DOWNLOAD_LIMIT, so the deterministic-rejection assertion is P2P/RPC-only
    getAvailablePKCConfigsToTestAgainst({
        includeOnlyTheseTests: ["remote-kubo-rpc", "remote-pkc-rpc", "local-kubo-rpc", "remote-libp2pjs"]
    }).map((config) =>
        describe(`communitylist load rejects oversize records - ${config.name}`, () => {
            let pkc: PKC;
            beforeAll(async () => {
                pkc = await config.pkcInstancePromise();
            });
            afterAll(async () => {
                await pkc.destroy();
            });

            it("update() rejects a record over 2mb before parsing it", async () => {
                const helperPkc = await mockRemotePKC();
                const hugeTags = new Array(3).fill(undefined).map((_, i) => `${i}`.repeat(1024 * 1024)); // ~3mb
                const { record } = await buildSignedCommunityListRecord({
                    pkc: helperPkc,
                    communities: [{ ...mockCommunityListEntries[0], tags: hugeTags }]
                });
                await helperPkc.destroy();
                const oversizeCid = await addCommunityListRecordToIpfs(record);
                const list = await pkc.createCommunityList({ cid: oversizeCid });
                const err = await updateAndAwaitError(list);
                expect(err.code).to.equal("ERR_OVER_DOWNLOAD_LIMIT");
            });
        })
    );
});
