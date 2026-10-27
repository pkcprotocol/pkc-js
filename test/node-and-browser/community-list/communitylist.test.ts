// CommunityList lifecycle (docs/protocol/community-lists.md): an immutable, signed IPFS file
// addressed by CID. publish() = sign + IPFS add; update() = fetch + verify with retries, emit
// `update`, then auto-stop once there is nothing left to settle.
import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import { clone } from "remeda";
import { CID } from "multiformats/cid";
import signers from "../../fixtures/signers.js";
import { getAvailablePKCConfigsToTestAgainst, mockRemotePKC, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { messages } from "../../../dist/node/errors.js";
import { calculateIpfsCidV0 } from "../../../dist/node/util.js";
import { PKCError } from "../../../dist/node/pkc-error.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import { CommunityList } from "../../../dist/node/community-list/community-list.js";
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

        it("createCommunityList throws on an unknown author key instead of signing it into the record", async () => {
            // docs/protocol/community-lists.md: author is "Strict on create, loose on load". A typo like
            // `displayname` would otherwise be signed into a permanent cid that can never be corrected
            const signer = await pkc.createSigner();
            try {
                await pkc.createCommunityList({ signer, communities: mockCommunityListEntries, author: <never>{ displayname: "Bob" } });
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

        it("publishes a revision from a loaded instance's props, as the spec documents", async () => {
            // docs/protocol/community-lists.md: "Publishing a revision means calling createCommunityList()
            // again with the previous record's props (obtained from a loaded instance)". A loaded
            // instance's entries and author carry runtime fields (address, shortAddress, publicKey...)
            const signer = await pkc.createSigner();
            const original = await pkc.createCommunityList({
                signer,
                title: "v1",
                author: { displayName: "Curator" },
                communities: mockCommunityListEntries
            });
            const cid = await original.publish();
            const loaded = await pkc.getCommunityList({ cid });
            expect(loaded.communities?.[0].address).to.be.a("string"); // runtime fields present on the loaded instance

            const revision = await pkc.createCommunityList({
                signer,
                title: "v2",
                description: loaded.description,
                author: loaded.author,
                communities: [...loaded.communities!, { publicKey: signers[2].address, title: "Added in v2" }]
            });
            const revisionCid = await revision.publish();
            expect(revisionCid).to.not.equal(cid);
            // runtime fields are stripped before signing, so the carried-over entries are byte-identical
            expect(revision.raw.communityList?.communities.slice(0, 2)).to.deep.equal(original.raw.communityList?.communities);
            expect(revision.raw.communityList?.author).to.deep.equal({ displayName: "Curator" });
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

            it("update() rejects a validly signed record whose author.name is not a domain", async () => {
                // address = name || publicKey, so a non-domain name would display another key's address
                // as the list author; nameResolved stays undefined for non-domains, so nothing flags it
                const helperPkc = await mockRemotePKC();
                const { record } = await buildSignedCommunityListRecord({
                    pkc: helperPkc,
                    author: { name: signers[1].address },
                    skipAuthorValidation: true
                });
                await helperPkc.destroy();
                const impersonatingCid = await addCommunityListRecordToIpfs(record);
                const list = await pkc.createCommunityList({ cid: impersonatingCid });
                const outcome = new Promise<"update" | PKCError>((resolve) => {
                    list.once("update", () => resolve("update"));
                    list.once("error", (e) => resolve(<PKCError>e));
                });
                await list.update();
                const result = await outcome;
                await list.stop();
                expect(result, `loaded with author.address ${list.author?.address}`).to.not.equal("update");
                const err = <PKCError>result;
                expect(err.code).to.equal("ERR_COMMUNITY_LIST_SIGNATURE_IS_INVALID");
                expect((<{ validity?: { reason?: string } }>err.details).validity?.reason).to.equal(
                    messages.ERR_AUTHOR_NAME_MUST_BE_A_DOMAIN
                );
            });

            it("rejects a malformed cid with a schema error, not a CID parser exception", async () => {
                for (const load of [() => pkc.createCommunityList({ cid: "notacid" }), () => pkc.getCommunityList({ cid: "notacid" })]) {
                    try {
                        await load();
                        expect.fail("should have thrown");
                    } catch (e) {
                        expectPKCErrorCode(e, "ERR_INVALID_CREATE_COMMUNITY_LIST_OPTIONS_SCHEMA");
                    }
                }
            });

            it("rejects a CIDv1 up front, since every transport's content check recomputes a CIDv0", async () => {
                const cidV1 = CID.parse(fixture.cid).toV1().toString();
                for (const load of [() => pkc.createCommunityList({ cid: cidV1 }), () => pkc.getCommunityList({ cid: cidV1 })]) {
                    try {
                        await load();
                        expect.fail("should have thrown");
                    } catch (e) {
                        expectPKCErrorCode(e, "ERR_INVALID_CREATE_COMMUNITY_LIST_OPTIONS_SCHEMA");
                        expect(JSON.stringify((<PKCError>e).details)).to.include(messages.ERR_COMMUNITY_LIST_CID_MUST_BE_V0);
                    }
                }
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

// Gateways wrap each gateway's error into one ERR_FAILED_TO_FETCH_GENERIC_IPFS_FROM_GATEWAYS, so the
// record errors underneath must still be recognized as final
getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) =>
    describe(`communitylist load stops on records every gateway rejects - ${config.name}`, () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });
        afterAll(async () => {
            await pkc.destroy();
        });

        it("update() stops itself on a record over 2mb instead of retrying forever", async () => {
            const helperPkc = await mockRemotePKC();
            const hugeTags = new Array(3).fill(undefined).map((_, i) => `${i}`.repeat(1024 * 1024)); // ~3mb
            const { record } = await buildSignedCommunityListRecord({
                pkc: helperPkc,
                communities: [{ ...mockCommunityListEntries[0], tags: hugeTags }]
            });
            await helperPkc.destroy();
            const oversizeCid = await addCommunityListRecordToIpfs(record);
            const list = await pkc.createCommunityList({ cid: oversizeCid });
            const errors: PKCError[] = [];
            list.on("error", (e) => errors.push(<PKCError>e));
            await list.update();
            const stopped = await Promise.race([
                waitUntilStoppedByItself(list).then(() => true),
                new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15_000))
            ]);
            const stateAfterWait = list.state;
            await list.stop();
            expect(stopped, `still ${stateAfterWait} after ${errors.length} errors`).to.equal(true);
            expect(errors.at(-1)?.code).to.equal("ERR_FAILED_TO_FETCH_GENERIC_IPFS_FROM_GATEWAYS");
        });
    })
);

// The fetch is stubbed on a local instance so these run deterministically without a live RPC server
// (an RPC fetch takes no abort signal, so a stopped run can still settle after a newer run started)
describe("communitylist load lifecycle", () => {
    let pkc: PKC;
    let record: CommunityListIpfsType;
    let cid: string;

    beforeAll(async () => {
        pkc = await mockRemotePKC();
        record = (await buildSignedCommunityListRecord({ pkc })).record;
        cid = await addCommunityListRecordToIpfs(record);
    });
    afterAll(async () => {
        await pkc.destroy();
    });

    type CommunityListInternals = { _fetchAndVerifyOnce: (cid: string, signal?: AbortSignal) => Promise<CommunityListIpfsType> };

    const deferred = <T>() => {
        let resolve!: (value: T) => void;
        let reject!: (err: Error) => void;
        const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
        return { promise, resolve, reject };
    };

    const waitFor = async (predicate: () => boolean, timeoutMs = 5000) => {
        const started = Date.now();
        while (!predicate()) {
            if (Date.now() - started > timeoutMs) throw Error("waitFor timed out");
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    };

    it("an oversize record returned over RPC is rejected before parsing, same as the direct path", async () => {
        // The RPC server is not trusted with record validity, so the 2mb load cap must hold even when a
        // server skips it. The returned bytes match the cid and carry a valid signature, so only the
        // size check can reject them
        const hugeTags = new Array(3).fill(undefined).map((_, i) => `${i}`.repeat(1024 * 1024)); // ~3mb
        const { record: oversizeRecord } = await buildSignedCommunityListRecord({
            pkc,
            communities: [{ ...mockCommunityListEntries[0], tags: hugeTags }]
        });
        const oversizeRawString = JSON.stringify(oversizeRecord);
        const oversizeCid = await calculateIpfsCidV0(oversizeRawString);
        const fetchCommunityList = vi.fn(async () => ({ communityListRawString: oversizeRawString }));
        // Under USE_RPC this describe's pkc already has a real RPC client, shared with later tests
        const originalRpcClient = pkc._pkcRpcClient;
        pkc._pkcRpcClient = <PKC["_pkcRpcClient"]>(<unknown>{ fetchCommunityList });
        try {
            const list = await pkc.createCommunityList({ cid: oversizeCid });
            // race the error against an update, so accepting the record fails fast instead of timing out
            const outcome = new Promise<{ err?: PKCError; loaded?: true }>((resolve) => {
                list.once("error", (e) => resolve({ err: <PKCError>e }));
                list.once("update", () => resolve({ loaded: true }));
            });
            await list.update();
            const { err, loaded } = await outcome;
            await list.stop();
            expect(loaded, "the oversize record was accepted").to.be.undefined;
            expect(err?.code).to.equal("ERR_OVER_DOWNLOAD_LIMIT");
            expect(list.raw.communityList).to.be.undefined;
            expect(fetchCommunityList).toHaveBeenCalledTimes(1);
        } finally {
            pkc._pkcRpcClient = originalRpcClient;
        }
    });

    it("a stale load finishing after update(); stop(); update() does not cancel the new run's retries", async () => {
        const list = await pkc.createCommunityList({ cid: cid });
        const errors: Error[] = [];
        list.on("error", (e) => errors.push(e));
        const fetches = [deferred<CommunityListIpfsType>(), deferred<CommunityListIpfsType>()];
        let fetchCalls = 0;
        vi.spyOn(<CommunityListInternals>(<unknown>list), "_fetchAndVerifyOnce").mockImplementation(async () => {
            const call = fetchCalls++;
            if (call < fetches.length) return fetches[call].promise;
            return record;
        });

        await list.update();
        await waitFor(() => fetchCalls === 1);
        await list.stop();
        await list.update();
        await waitFor(() => fetchCalls === 2);

        // the first run's fetch resolves late, as an RPC fetch that takes no abort signal does
        fetches[0].resolve(record);
        await new Promise((resolve) => setTimeout(resolve, 50));
        // the second run's attempt fails transiently, so it must schedule a retry (minTimeout 1s)
        fetches[1].reject(new Error("mock transient fetch failure"));

        const updated = await Promise.race([
            new Promise<boolean>((resolve) => list.once("update", () => resolve(true))),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000))
        ]);
        const stateAfterWait = list.state;
        await list.stop();
        expect(updated, `instance hung in state ${stateAfterWait} after ${fetchCalls} fetches`).to.equal(true);
        expect(fetchCalls).to.equal(3);
        expect(errors.map((e) => e.message)).to.deep.equal(["mock transient fetch failure"]);
    });

    it("getCommunityList throws the final record error, not an earlier transient one", async () => {
        // attempt 1 times out (emitted, retried); attempt 2 gets bytes with an invalid signature (final)
        let fetchCalls = 0;
        const spy = vi
            .spyOn(<CommunityListInternals>(<unknown>CommunityList.prototype), "_fetchAndVerifyOnce")
            .mockImplementation(async () => {
                fetchCalls++;
                if (fetchCalls === 1) throw new PKCError("ERR_FETCH_CID_P2P_TIMEOUT", { cid });
                throw new PKCError("ERR_COMMUNITY_LIST_SIGNATURE_IS_INVALID", { cid });
            });
        try {
            await pkc.getCommunityList({ cid });
            expect.fail("should have thrown");
        } catch (e) {
            expect(fetchCalls).to.equal(2);
            expectPKCErrorCode(e, "ERR_COMMUNITY_LIST_SIGNATURE_IS_INVALID");
        } finally {
            spy.mockRestore();
        }
    });

    it("toJSON() of an unpublished list carries every field set on the instance", async () => {
        const signer = await pkc.createSigner();
        const list = await pkc.createCommunityList({
            signer,
            title: "Draft",
            description: "Not published yet",
            communities: mockCommunityListEntries
        });
        const json = JSON.parse(JSON.stringify(list));
        expect(json.title).to.equal("Draft");
        expect(json.description).to.equal("Not published yet");
        expect(json.timestamp).to.equal(list.timestamp);
        expect(json.protocolVersion).to.equal(list.protocolVersion);
        expect(json.communities.length).to.equal(mockCommunityListEntries.length);
        expect(json).to.not.have.property("signer");
    });

    it("a publish() stopped mid-add does not reset the state of a publish() started after it", async () => {
        // Neither the kubo add nor the RPC publishCommunityList call takes an abort signal, so a stopped
        // publish keeps running until its add settles. Gate whichever one this config's publish() uses
        const list = await pkc.createCommunityList({ signer: await pkc.createSigner(), communities: mockCommunityListEntries });
        const addGates = [deferred<void>(), deferred<void>()];
        let addCalls = 0;
        const rpcClient = pkc._pkcRpcClient;
        let addSpy: { mockRestore: () => void };
        if (rpcClient) {
            const originalPublish = rpcClient.publishCommunityList.bind(rpcClient);
            addSpy = vi.spyOn(rpcClient, "publishCommunityList").mockImplementation(async (...args: Parameters<typeof originalPublish>) => {
                await addGates[addCalls++].promise;
                return originalPublish(...args);
            });
        } else {
            const kuboClient = pkc._clientsManager.getDefaultKuboRpcClient()._client;
            const originalAdd = kuboClient.add.bind(kuboClient);
            addSpy = vi.spyOn(kuboClient, "add").mockImplementation(async (...args: Parameters<typeof originalAdd>) => {
                await addGates[addCalls++].promise;
                return originalAdd(...args);
            });
        }
        try {
            const firstPublish = list.publish().then(
                () => "resolved",
                (e: PKCError) => e.code
            );
            await waitFor(() => addCalls === 1);
            await list.stop();
            const secondPublish = list.publish();
            await waitFor(() => addCalls === 2);

            addGates[0].resolve();
            expect(await firstPublish).to.equal("ERR_COMMUNITY_LIST_PUBLISH_ABORTED");
            // the second publish is still waiting on its add, so it still owns the state
            expect(list.state).to.equal("publishing");

            addGates[1].resolve();
            const cid = await secondPublish;
            expect(list.cid).to.equal(cid);
            expect(list.state).to.equal("stopped");
        } finally {
            addSpy.mockRestore();
            addGates.forEach((gate) => gate.resolve());
            await list.stop();
        }
    });

    it("stop() during a retry backoff settles the pending load instead of leaving it hanging", async () => {
        // A load left pending never runs its finally, so its abort listener would stay attached to the
        // caller's signal, which outlives the call (getCommunityList stops the list on timeout this way)
        const list = await pkc.createCommunityList({ cid });
        list.on("error", () => {});
        let fetchCalls = 0;
        vi.spyOn(<CommunityListInternals>(<unknown>list), "_fetchAndVerifyOnce").mockImplementation(async () => {
            fetchCalls++;
            throw new Error("mock transient fetch failure");
        });
        const callerAbortController = new AbortController();
        const settled = list._loadCommunityListIpfsWithRetries(callerAbortController.signal).then(
            () => "resolved",
            () => "rejected"
        );
        await waitFor(() => fetchCalls === 1);
        await new Promise((resolve) => setTimeout(resolve, 50)); // the retry is now waiting out its 1s backoff
        await list.stop();

        const outcome = await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve("pending"), 3000))]);
        expect(outcome).to.equal("rejected");
        expect(fetchCalls).to.equal(1); // stop() cancelled the retry
    });
});
