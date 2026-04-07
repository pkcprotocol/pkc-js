import { beforeAll, afterAll } from "vitest";
import {
    createMockNameResolver,
    getAvailablePKCConfigsToTestAgainst,
    resolveWhenConditionIsTrue,
    describeSkipIfRpc
} from "../../../../dist/node/test/test-util.js";
import signers from "../../../fixtures/signers.js";
import { ipnsNameToIpnsOverPubsubTopic, pubsubTopicToDhtKey } from "../../../../dist/node/util.js";

import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../../dist/node/pkc-error.js";
import type { RemoteCommunity } from "../../../../dist/node/community/remote-community.js";

const ipnsB58 = signers[0].address;
const expectedIpnsPubsubTopic = "/record/L2lwbnMvACQIARIgtkPPciAVI7kfzmSHjazd0ekx8z9bCt9RlE5RnEpFRGo";
const expectedIpnsPubsubTopicRoutingCid = "bafkreiftvi7wgbdhbxnenslhu5sytlid73siolkd2syhdnjhnvn3mksggi";
const expectedPubsubTopicRoutingCid = "bafkreidwoelrflsx5dgll7s6jfkhsj6ffkfplde2j5dyino6t7m4ijutem";

function setMockResolverRecords(pkc: PKCType, records: Map<string, string | undefined>) {
    pkc.nameResolvers = [createMockNameResolver({ includeDefaultRecords: true, records })];
}

// Test for domain address that resolves to b58 IPNS but fails to load IPNS record
// The ipnsPubsubTopic and ipnsPubsubTopicRoutingCid should still be set
getAvailablePKCConfigsToTestAgainst().map((config) => {
    describeSkipIfRpc(
        `community.{ipnsName, ipnsPubsubTopic, ipnsPubsubTopicRoutingCid} with domain that fails IPNS loading - ${config.name}`,
        async () => {
            it(`Domain resolves to b58 IPNS but IPNS record doesn't exist - should still set ipnsPubsubTopic and ipnsPubsubTopicRoutingCid`, async () => {
                const pkc = await config.pkcInstancePromise({ stubStorage: false });
                const testDomain = "test-domain-no-ipns-record.eth";
                const nonExistantIpnsAddress = (await pkc.createSigner()).address; // a random b58 address that's not loadable
                const expectedIpnsPubsubTopicForNonExistent = ipnsNameToIpnsOverPubsubTopic(nonExistantIpnsAddress);
                const expectedIpnsPubsubTopicRoutingCidForNonExistent = pubsubTopicToDhtKey(expectedIpnsPubsubTopicForNonExistent);
                pkc._timeouts["community-ipns"] = 1000;

                setMockResolverRecords(pkc, new Map([[testDomain, nonExistantIpnsAddress]]));

                const errors: PKCError[] = [];

                const community = await pkc.createCommunity({ address: testDomain });

                community.on("error", (err: PKCError | Error) => {
                    errors.push(err as PKCError);
                });

                // At this point, the domain hasn't been resolved yet
                // For a domain address, ipnsName, ipnsPubsubTopic and ipnsPubsubTopicRoutingCid are not set initially
                expect(community.ipnsName).to.be.undefined;
                expect(community.ipnsPubsubTopic).to.be.undefined;
                expect(community.ipnsPubsubTopicRoutingCid).to.be.undefined;

                // Now trigger update which will resolve the domain and try to load IPNS
                // This will fail because the IPNS record doesn't exist, but we should still have the pubsub props set
                await community.update();

                // Wait for the domain to be resolved and errors to be emitted
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => errors.length > 0,
                    eventName: "error"
                });

                // After domain resolution, even if IPNS loading fails, we should have:
                // - ipnsName set to the resolved IPNS address
                // - ipnsPubsubTopic and ipnsPubsubTopicRoutingCid set based on the resolved IPNS
                expect(community.ipnsName).to.equal(nonExistantIpnsAddress);
                expect(community.ipnsPubsubTopic).to.equal(expectedIpnsPubsubTopicForNonExistent);
                expect(community.ipnsPubsubTopicRoutingCid).to.equal(expectedIpnsPubsubTopicRoutingCidForNonExistent);

                const error = errors[0];
                if (config.testConfigCode === "remote-ipfs-gateway") {
                    expect(error.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
                } else {
                    expect(error.code).to.be.oneOf(["ERR_RESOLVED_IPNS_P2P_TO_UNDEFINED", "ERR_IPNS_RESOLUTION_P2P_TIMEOUT"]);
                }

                await community.stop();
                await pkc.destroy();
            });
        }
    );
});

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describeSkipIfRpc(`community.ipns accessors persist after first resolve - ${config.name}`, async () => {
        it(`keeps ipns accessors defined after stop`, async () => {
            const pkc = await config.pkcInstancePromise({ stubStorage: false });
            const testDomain = `test-domain-ipns-accessors-${config.testConfigCode}.eth`;
            const nonExistantIpnsAddress = (await pkc.createSigner()).address; // a random b58 address that's not loadable
            const expectedIpnsPubsubTopicForNonExistent = ipnsNameToIpnsOverPubsubTopic(nonExistantIpnsAddress);
            const expectedIpnsPubsubTopicRoutingCidForNonExistent = pubsubTopicToDhtKey(expectedIpnsPubsubTopicForNonExistent);
            pkc._timeouts["community-ipns"] = 1000;

            setMockResolverRecords(pkc, new Map([[testDomain, nonExistantIpnsAddress]]));

            const community = await pkc.createCommunity({ address: testDomain });
            const errors: PKCError[] = [];
            community.on("error", (err: PKCError | Error) => {
                errors.push(err as PKCError);
            });

            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => errors.length > 0,
                eventName: "error"
            });

            expect(community.ipnsName).to.equal(nonExistantIpnsAddress);
            expect(community.ipnsPubsubTopic).to.equal(expectedIpnsPubsubTopicForNonExistent);
            expect(community.ipnsPubsubTopicRoutingCid).to.equal(expectedIpnsPubsubTopicRoutingCidForNonExistent);

            await community.stop();

            expect(community.ipnsName).to.equal(nonExistantIpnsAddress);
            expect(community.ipnsPubsubTopic).to.equal(expectedIpnsPubsubTopicForNonExistent);
            expect(community.ipnsPubsubTopicRoutingCid).to.equal(expectedIpnsPubsubTopicRoutingCidForNonExistent);

            await pkc.destroy();
        });
    });
});

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describeSkipIfRpc(`community.ipns accessors mirror updating community - ${config.name}`, async () => {
        it(`mirrors ipns accessors when update fails before record is loaded`, async () => {
            const pkc = await config.pkcInstancePromise({ stubStorage: false });
            const testDomain = `test-domain-ipns-mirror-${config.testConfigCode}.eth`;
            const nonExistantIpnsAddress = (await pkc.createSigner()).address; // a random b58 address that's not loadable
            const expectedIpnsPubsubTopicForNonExistent = ipnsNameToIpnsOverPubsubTopic(nonExistantIpnsAddress);
            const expectedIpnsPubsubTopicRoutingCidForNonExistent = pubsubTopicToDhtKey(expectedIpnsPubsubTopicForNonExistent);
            pkc._timeouts["community-ipns"] = 1000;

            setMockResolverRecords(pkc, new Map([[testDomain, nonExistantIpnsAddress]]));

            const communityA = await pkc.createCommunity({ address: testDomain });
            const errorsA: PKCError[] = [];
            communityA.on("error", (err: PKCError | Error) => {
                errorsA.push(err as PKCError);
            });

            await communityA.update();
            await resolveWhenConditionIsTrue({
                toUpdate: communityA,
                predicate: async () => errorsA.length > 0,
                eventName: "error"
            });

            const communityB = await pkc.createCommunity({ address: testDomain });
            await communityB.update();

            expect(communityA.ipnsName).to.equal(nonExistantIpnsAddress);
            expect(communityA.ipnsPubsubTopic).to.equal(expectedIpnsPubsubTopicForNonExistent);
            expect(communityA.ipnsPubsubTopicRoutingCid).to.equal(expectedIpnsPubsubTopicRoutingCidForNonExistent);

            expect(communityB.ipnsName).to.equal(nonExistantIpnsAddress);
            expect(communityB.ipnsPubsubTopic).to.equal(expectedIpnsPubsubTopicForNonExistent);
            expect(communityB.ipnsPubsubTopicRoutingCid).to.equal(expectedIpnsPubsubTopicRoutingCidForNonExistent);

            await communityB.stop();
            await communityA.stop();
            await pkc.destroy();
        });
    });
});

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`community.ipns accessors persist after successful update - ${config.name}`, async () => {
        it(`keeps ipns accessors defined after stop`, async () => {
            const pkc = await config.pkcInstancePromise();
            const community = await pkc.createCommunity({ address: ipnsB58 });

            expect(community.ipnsName).to.equal(ipnsB58);
            expect(community.ipnsPubsubTopic).to.equal(expectedIpnsPubsubTopic);
            expect(community.ipnsPubsubTopicRoutingCid).to.equal(expectedIpnsPubsubTopicRoutingCid);

            await community.update();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            await community.stop();

            expect(community.ipnsName).to.equal(ipnsB58);
            expect(community.ipnsPubsubTopic).to.equal(expectedIpnsPubsubTopic);
            expect(community.ipnsPubsubTopicRoutingCid).to.equal(expectedIpnsPubsubTopicRoutingCid);

            await pkc.destroy();
        });
    });
});

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`community.{ipnsName, ipnsPubsubTopic, ipnsPubsubTopicRoutingCid, pubsubTopicRoutingCid} on create`, async () => {
        let pkc: PKCType;
        let community: RemoteCommunity;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            community = await pkc.createCommunity({ address: ipnsB58 });
            expect(community.updatedAt).to.be.undefined;
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it("creates ipns fields from ipns b58 without update", async () => {
            expect(community.ipnsName).to.equal(ipnsB58);
            expect(community.ipnsPubsubTopic).to.equal(expectedIpnsPubsubTopic);
            expect(community.ipnsPubsubTopicRoutingCid).to.equal(expectedIpnsPubsubTopicRoutingCid);
        });
    });

    describe(`community.{ipnsName, ipnsPubsubTopic, ipnsPubsubTopicRoutingCid, pubsubTopicRoutingCid}`, async () => {
        let pkc: PKCType;
        let community: RemoteCommunity;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            community = await pkc.createCommunity({ address: ipnsB58 });

            await community.update();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it("community.ipnsName should be a valid IPNS name", async () => {
            expect(community.ipnsName).equal(ipnsB58);
        });

        it("community.ipnsPubsubTopic should be a valid pubsub topic", async () => {
            expect(community.ipnsPubsubTopic).equal(expectedIpnsPubsubTopic);
        });

        it("community.ipnsPubsubTopicRoutingCid should be a valid DHT key", async () => {
            expect(community.ipnsPubsubTopicRoutingCid).equal(expectedIpnsPubsubTopicRoutingCid);
        });

        it("community.pubsubTopicRoutingCid should be a valid CID", async () => {
            expect(community.pubsubTopicRoutingCid).equal(expectedPubsubTopicRoutingCid);
        });
    });
});
