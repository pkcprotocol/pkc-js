import { beforeAll, afterAll } from "vitest";
import {
    getAvailablePlebbitConfigsToTestAgainst,
    resolveWhenConditionIsTrue,
    mockCacheOfTextRecord,
    describeSkipIfRpc
} from "../../../../dist/node/test/test-util.js";
import signers from "../../../fixtures/signers.js";
import { ipnsNameToIpnsOverPubsubTopic, pubsubTopicToDhtKey } from "../../../../dist/node/util.js";

import type { Plebbit as PlebbitType } from "../../../../dist/node/plebbit/plebbit.js";
import type { PlebbitError } from "../../../../dist/node/plebbit-error.js";
import type { RemoteSubplebbit } from "../../../../dist/node/subplebbit/remote-subplebbit.js";

const ipnsB58 = signers[0].address;
const expectedIpnsPubsubTopic = "/record/L2lwbnMvACQIARIgtkPPciAVI7kfzmSHjazd0ekx8z9bCt9RlE5RnEpFRGo";
const expectedIpnsPubsubTopicRoutingCid = "bafkreiftvi7wgbdhbxnenslhu5sytlid73siolkd2syhdnjhnvn3mksggi";
const expectedPubsubTopicRoutingCid = "bafkreidwoelrflsx5dgll7s6jfkhsj6ffkfplde2j5dyino6t7m4ijutem";

// Test for domain address that resolves to b58 IPNS but fails to load IPNS record
// The ipnsPubsubTopic and ipnsPubsubTopicRoutingCid should still be set
getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describeSkipIfRpc(
        `subplebbit.{ipnsName, ipnsPubsubTopic, ipnsPubsubTopicRoutingCid} with domain that fails IPNS loading - ${config.name}`,
        async () => {
            it(`Domain resolves to b58 IPNS but IPNS record doesn't exist - should still set ipnsPubsubTopic and ipnsPubsubTopicRoutingCid`, async () => {
                const plebbit = await config.plebbitInstancePromise({ stubStorage: false });
                const testDomain = "test-domain-no-ipns-record.eth";
                const nonExistantIpnsAddress = (await plebbit.createSigner()).address; // a random b58 address that's not loadable
                const expectedIpnsPubsubTopicForNonExistent = ipnsNameToIpnsOverPubsubTopic(nonExistantIpnsAddress);
                const expectedIpnsPubsubTopicRoutingCidForNonExistent = pubsubTopicToDhtKey(expectedIpnsPubsubTopicForNonExistent);
                plebbit._timeouts["subplebbit-ipns"] = 1000;

                // Mock the domain to resolve to the IPNS address
                await mockCacheOfTextRecord({
                    plebbit,
                    domain: testDomain,
                    resolveType: "subplebbit",
                    value: nonExistantIpnsAddress
                });

                const errors: PlebbitError[] = [];

                const subplebbit = await plebbit.createSubplebbit({ address: testDomain });

                subplebbit.on("error", (err: PlebbitError | Error) => {
                    errors.push(err as PlebbitError);
                });

                // At this point, the domain hasn't been resolved yet
                // For a domain address, ipnsName, ipnsPubsubTopic and ipnsPubsubTopicRoutingCid are not set initially
                expect(subplebbit.ipnsName).to.be.undefined;
                expect(subplebbit.ipnsPubsubTopic).to.be.undefined;
                expect(subplebbit.ipnsPubsubTopicRoutingCid).to.be.undefined;

                // Now trigger update which will resolve the domain and try to load IPNS
                // This will fail because the IPNS record doesn't exist, but we should still have the pubsub props set
                await subplebbit.update();

                // Wait for the domain to be resolved and errors to be emitted
                await resolveWhenConditionIsTrue({
                    toUpdate: subplebbit,
                    predicate: async () => errors.length > 0,
                    eventName: "error"
                });

                // After domain resolution, even if IPNS loading fails, we should have:
                // - ipnsName set to the resolved IPNS address
                // - ipnsPubsubTopic and ipnsPubsubTopicRoutingCid set based on the resolved IPNS
                expect(subplebbit.ipnsName).to.equal(nonExistantIpnsAddress);
                expect(subplebbit.ipnsPubsubTopic).to.equal(expectedIpnsPubsubTopicForNonExistent);
                expect(subplebbit.ipnsPubsubTopicRoutingCid).to.equal(expectedIpnsPubsubTopicRoutingCidForNonExistent);

                const error = errors[0];
                if (config.testConfigCode === "remote-ipfs-gateway") {
                    expect(error.code).to.equal("ERR_FAILED_TO_FETCH_SUBPLEBBIT_FROM_GATEWAYS");
                } else {
                    expect(error.code).to.be.oneOf(["ERR_RESOLVED_IPNS_P2P_TO_UNDEFINED", "ERR_IPNS_RESOLUTION_P2P_TIMEOUT"]);
                }

                await subplebbit.stop();
                await plebbit.destroy();
            });
        }
    );
});

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describeSkipIfRpc(`subplebbit.ipns accessors persist after first resolve - ${config.name}`, async () => {
        it(`keeps ipns accessors defined after stop`, async () => {
            const plebbit = await config.plebbitInstancePromise({ stubStorage: false });
            const testDomain = `test-domain-ipns-accessors-${config.testConfigCode}.eth`;
            const nonExistantIpnsAddress = (await plebbit.createSigner()).address; // a random b58 address that's not loadable
            const expectedIpnsPubsubTopicForNonExistent = ipnsNameToIpnsOverPubsubTopic(nonExistantIpnsAddress);
            const expectedIpnsPubsubTopicRoutingCidForNonExistent = pubsubTopicToDhtKey(expectedIpnsPubsubTopicForNonExistent);
            plebbit._timeouts["subplebbit-ipns"] = 1000;

            await mockCacheOfTextRecord({
                plebbit,
                domain: testDomain,
                resolveType: "subplebbit",
                value: nonExistantIpnsAddress
            });

            const subplebbit = await plebbit.createSubplebbit({ address: testDomain });
            const errors: PlebbitError[] = [];
            subplebbit.on("error", (err: PlebbitError | Error) => {
                errors.push(err as PlebbitError);
            });

            await subplebbit.update();
            await resolveWhenConditionIsTrue({
                toUpdate: subplebbit,
                predicate: async () => errors.length > 0,
                eventName: "error"
            });

            expect(subplebbit.ipnsName).to.equal(nonExistantIpnsAddress);
            expect(subplebbit.ipnsPubsubTopic).to.equal(expectedIpnsPubsubTopicForNonExistent);
            expect(subplebbit.ipnsPubsubTopicRoutingCid).to.equal(expectedIpnsPubsubTopicRoutingCidForNonExistent);

            await subplebbit.stop();

            expect(subplebbit.ipnsName).to.equal(nonExistantIpnsAddress);
            expect(subplebbit.ipnsPubsubTopic).to.equal(expectedIpnsPubsubTopicForNonExistent);
            expect(subplebbit.ipnsPubsubTopicRoutingCid).to.equal(expectedIpnsPubsubTopicRoutingCidForNonExistent);

            await plebbit.destroy();
        });
    });
});

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describeSkipIfRpc(`subplebbit.ipns accessors mirror updating subplebbit - ${config.name}`, async () => {
        it(`mirrors ipns accessors when update fails before record is loaded`, async () => {
            const plebbit = await config.plebbitInstancePromise({ stubStorage: false });
            const testDomain = `test-domain-ipns-mirror-${config.testConfigCode}.eth`;
            const nonExistantIpnsAddress = (await plebbit.createSigner()).address; // a random b58 address that's not loadable
            const expectedIpnsPubsubTopicForNonExistent = ipnsNameToIpnsOverPubsubTopic(nonExistantIpnsAddress);
            const expectedIpnsPubsubTopicRoutingCidForNonExistent = pubsubTopicToDhtKey(expectedIpnsPubsubTopicForNonExistent);
            plebbit._timeouts["subplebbit-ipns"] = 1000;

            await mockCacheOfTextRecord({
                plebbit,
                domain: testDomain,
                resolveType: "subplebbit",
                value: nonExistantIpnsAddress
            });

            const subplebbitA = await plebbit.createSubplebbit({ address: testDomain });
            const errorsA: PlebbitError[] = [];
            subplebbitA.on("error", (err: PlebbitError | Error) => {
                errorsA.push(err as PlebbitError);
            });

            await subplebbitA.update();
            await resolveWhenConditionIsTrue({
                toUpdate: subplebbitA,
                predicate: async () => errorsA.length > 0,
                eventName: "error"
            });

            const subplebbitB = await plebbit.createSubplebbit({ address: testDomain });
            await subplebbitB.update();

            expect(subplebbitA.ipnsName).to.equal(nonExistantIpnsAddress);
            expect(subplebbitA.ipnsPubsubTopic).to.equal(expectedIpnsPubsubTopicForNonExistent);
            expect(subplebbitA.ipnsPubsubTopicRoutingCid).to.equal(expectedIpnsPubsubTopicRoutingCidForNonExistent);

            expect(subplebbitB.ipnsName).to.equal(nonExistantIpnsAddress);
            expect(subplebbitB.ipnsPubsubTopic).to.equal(expectedIpnsPubsubTopicForNonExistent);
            expect(subplebbitB.ipnsPubsubTopicRoutingCid).to.equal(expectedIpnsPubsubTopicRoutingCidForNonExistent);

            await subplebbitB.stop();
            await subplebbitA.stop();
            await plebbit.destroy();
        });
    });
});

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe(`subplebbit.ipns accessors persist after successful update - ${config.name}`, async () => {
        it(`keeps ipns accessors defined after stop`, async () => {
            const plebbit = await config.plebbitInstancePromise();
            const subplebbit = await plebbit.createSubplebbit({ address: ipnsB58 });

            expect(subplebbit.ipnsName).to.equal(ipnsB58);
            expect(subplebbit.ipnsPubsubTopic).to.equal(expectedIpnsPubsubTopic);
            expect(subplebbit.ipnsPubsubTopicRoutingCid).to.equal(expectedIpnsPubsubTopicRoutingCid);

            await subplebbit.update();
            await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
            await subplebbit.stop();

            expect(subplebbit.ipnsName).to.equal(ipnsB58);
            expect(subplebbit.ipnsPubsubTopic).to.equal(expectedIpnsPubsubTopic);
            expect(subplebbit.ipnsPubsubTopicRoutingCid).to.equal(expectedIpnsPubsubTopicRoutingCid);

            await plebbit.destroy();
        });
    });
});

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe(`subplebbit.{ipnsName, ipnsPubsubTopic, ipnsPubsubTopicRoutingCid, pubsubTopicRoutingCid} on create`, async () => {
        let plebbit: PlebbitType;
        let subplebbit: RemoteSubplebbit;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            subplebbit = await plebbit.createSubplebbit({ address: ipnsB58 });
            expect(subplebbit.updatedAt).to.be.undefined;
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it("creates ipns fields from ipns b58 without update", async () => {
            expect(subplebbit.ipnsName).to.equal(ipnsB58);
            expect(subplebbit.ipnsPubsubTopic).to.equal(expectedIpnsPubsubTopic);
            expect(subplebbit.ipnsPubsubTopicRoutingCid).to.equal(expectedIpnsPubsubTopicRoutingCid);
        });
    });

    describe(`subplebbit.{ipnsName, ipnsPubsubTopic, ipnsPubsubTopicRoutingCid, pubsubTopicRoutingCid}`, async () => {
        let plebbit: PlebbitType;
        let subplebbit: RemoteSubplebbit;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            subplebbit = await plebbit.createSubplebbit({ address: ipnsB58 });

            await subplebbit.update();
            await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it("subplebbit.ipnsName should be a valid IPNS name", async () => {
            expect(subplebbit.ipnsName).equal(ipnsB58);
        });

        it("subplebbit.ipnsPubsubTopic should be a valid pubsub topic", async () => {
            expect(subplebbit.ipnsPubsubTopic).equal(expectedIpnsPubsubTopic);
        });

        it("subplebbit.ipnsPubsubTopicRoutingCid should be a valid DHT key", async () => {
            expect(subplebbit.ipnsPubsubTopicRoutingCid).equal(expectedIpnsPubsubTopicRoutingCid);
        });

        it("subplebbit.pubsubTopicRoutingCid should be a valid CID", async () => {
            expect(subplebbit.pubsubTopicRoutingCid).equal(expectedPubsubTopicRoutingCid);
        });
    });
});
