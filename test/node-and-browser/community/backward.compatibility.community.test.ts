import { messages } from "../../../dist/node/errors.js";

import {
    createMockedCommunityIpns,
    getAvailablePKCConfigsToTestAgainst,
    isPKCFetchingUsingGateways,
    publishCommunityRecordWithExtraProp,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { _signJson } from "../../../dist/node/signer/signatures.js";
import Logger from "@pkc/pkc-logger";
import { describe, it, afterAll, beforeAll } from "vitest";

import type { PKCError } from "../../../dist/node/pkc-error.js";
import type { CommunityIpfsType } from "../../../dist/node/community/types.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`pkc.createCommunity - Backward Compatiblity - ${config.name}`, async () => {
        it(`Can create a community instance with community record with extra props`, async () => {
            const opts = { includeExtraPropInSignedPropertyNames: true, extraProps: { extraProp: "1234" } };
            const publishedSub = await publishCommunityRecordWithExtraProp(opts);

            const remotePKC = await config.plebbitInstancePromise();

            const sub = await remotePKC.createCommunity(publishedSub.subplebbitRecord);

            expect((sub.raw.subplebbitIpfs! as Record<string, unknown>).extraProp).to.equal(publishedSub.subplebbitRecord.extraProp);
            expect(sub.raw.subplebbitIpfs!).to.deep.equal(publishedSub.subplebbitRecord);
            expect((sub as unknown as Record<string, unknown>)["extraProp"]).to.equal(publishedSub.subplebbitRecord.extraProp);

            const recreatedSubFromInstance = await remotePKC.createCommunity(sub);
            expect(recreatedSubFromInstance.raw.subplebbitIpfs!).to.deep.equal(publishedSub.subplebbitRecord);
            expect(JSON.parse(JSON.stringify(recreatedSubFromInstance)).extraProp).to.equal(opts.extraProps.extraProp);
            expect((recreatedSubFromInstance as unknown as Record<string, unknown>)["extraProp"]).to.equal(
                publishedSub.subplebbitRecord.extraProp
            );

            const recreatedSubFromJson = await remotePKC.createCommunity(JSON.parse(JSON.stringify(sub)));
            expect(JSON.parse(JSON.stringify(recreatedSubFromJson)).extraProp).to.equal(publishedSub.subplebbitRecord.extraProp);
            expect((recreatedSubFromJson as unknown as Record<string, unknown>)["extraProp"]).to.equal(
                publishedSub.subplebbitRecord.extraProp
            );

            await remotePKC.destroy();
        });
    });

    describe.concurrent(`community.update() and backward compatibility - ${config.name}`, async () => {
        it(`community.update() should have no problem with extra props, as long as they're in community.signature.signedPropertyNames`, async () => {
            const opts = { includeExtraPropInSignedPropertyNames: true, extraProps: { extraProp: "1234" } };
            const publishedSub = await publishCommunityRecordWithExtraProp(opts);

            const remotePKC = await config.plebbitInstancePromise();

            const sub = await remotePKC.createCommunity({ address: publishedSub.ipnsObj.signer.address });

            await sub.update();

            await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });

            expect((sub.raw.subplebbitIpfs! as Record<string, unknown>).extraProp).to.equal(opts.extraProps.extraProp);

            // Verify subplebbitIpfs does not contain address or communityAddress (those are runtime-only)
            expect((sub.raw.subplebbitIpfs! as Record<string, unknown>).address).to.be.undefined;
            expect((sub.raw.subplebbitIpfs! as Record<string, unknown>).communityAddress).to.be.undefined;

            expect(sub.raw.subplebbitIpfs!).to.deep.equal(publishedSub.subplebbitRecord);

            expect(JSON.parse(JSON.stringify(sub)).extraProp).to.equal(opts.extraProps.extraProp);

            expect((sub as unknown as Record<string, unknown>)["extraProp"]).to.equal(opts.extraProps.extraProp);

            await sub.stop();
            await remotePKC.destroy();
        });

        it(`community.update() emit an error if there are unknown props not included in signature.signedPropertyNames`, async () => {
            const opts = { includeExtraPropInSignedPropertyNames: false, extraProps: { extraProp: "1234" } };

            const publishedSub = await publishCommunityRecordWithExtraProp(opts);

            const remotePKC = await config.plebbitInstancePromise();

            const sub = await remotePKC.createCommunity({ address: publishedSub.ipnsObj.signer.address });

            const errorPromise = new Promise<PKCError>((resolve) => sub.once("error", resolve as (err: Error) => void));

            await sub.update();

            const error = await errorPromise;

            if (isPKCFetchingUsingGateways(remotePKC)) {
                expect(error.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
                const gatewayError = error.details.gatewayToError[remotePKC.ipfsGatewayUrls[0]] as PKCError;
                expect(gatewayError.code).to.equal("ERR_COMMUNITY_SIGNATURE_IS_INVALID");
                expect(gatewayError.details.signatureValidity.valid).to.be.false;
                expect(gatewayError.details.signatureValidity.reason).to.equal(
                    messages.ERR_COMMUNITY_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES
                );
            } else {
                expect(error.code).to.equal("ERR_COMMUNITY_SIGNATURE_IS_INVALID");
                expect(error.details.signatureValidity.valid).to.be.false;
                expect(error.details.signatureValidity.reason).to.equal(
                    messages.ERR_COMMUNITY_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES
                );
            }

            expect(sub.updatedAt).to.be.undefined; // should not accept update

            await sub.stop();
            await remotePKC.destroy();
        });
    });

    describe.concurrent(`Community with extra props in nested objects - ${config.name}`, async () => {
        // Type for community with unknown nested props
        type CommunityWithNestedExtraProps = CommunityIpfsType & {
            features?: CommunityIpfsType["features"] & { extraFeature?: boolean };
            suggested?: CommunityIpfsType["suggested"] & { extraSuggested?: string };
            encryption?: CommunityIpfsType["encryption"] & { extraEncryption?: string };
            roles?: Record<string, { role: string; extraRoleProp?: string }>;
        };

        it(`features.extraProp is preserved through createCommunity and update()`, async () => {
            const extraFeatures = { noVideos: true, extraFeature: true };
            const { subplebbitRecord, communityAddress: communityAddress } = await createMockedCommunityIpns({
                features: extraFeatures
            });

            const remotePKC = await config.plebbitInstancePromise();

            // Test createCommunity with record directly
            const sub = await remotePKC.createCommunity(subplebbitRecord);
            const subJson = sub.raw.subplebbitIpfs! as CommunityWithNestedExtraProps;
            expect(subJson.features?.extraFeature).to.equal(true);
            expect(subJson.features?.noVideos).to.equal(true);

            // Test recreation from instance
            const recreatedSub = await remotePKC.createCommunity(sub);
            const recreatedJson = recreatedSub.raw.subplebbitIpfs! as CommunityWithNestedExtraProps;
            expect(recreatedJson.features?.extraFeature).to.equal(true);

            // Test recreation from JSON
            const recreatedFromJson = await remotePKC.createCommunity(JSON.parse(JSON.stringify(sub)));
            const recreatedFromJsonJson = recreatedFromJson.raw.subplebbitIpfs! as CommunityWithNestedExtraProps;
            expect(recreatedFromJsonJson.features?.extraFeature).to.equal(true);

            // Test update() flow
            const subToUpdate = await remotePKC.createCommunity({ address: communityAddress });
            await subToUpdate.update();
            await resolveWhenConditionIsTrue({ toUpdate: subToUpdate, predicate: async () => typeof subToUpdate.updatedAt === "number" });

            const updatedJson = subToUpdate.raw.subplebbitIpfs! as CommunityWithNestedExtraProps;
            expect(updatedJson.features?.extraFeature).to.equal(true);
            expect(updatedJson.features?.noVideos).to.equal(true);

            await subToUpdate.stop();
            await remotePKC.destroy();
        });

        it(`suggested.extraProp is preserved through createCommunity and update()`, async () => {
            const extraSuggested = { primaryColor: "#ff0000", extraSuggested: "customValue" };
            const { subplebbitRecord, communityAddress: communityAddress } = await createMockedCommunityIpns({
                suggested: extraSuggested
            });

            const remotePKC = await config.plebbitInstancePromise();

            // Test createCommunity with record directly
            const sub = await remotePKC.createCommunity(subplebbitRecord);
            const subJson = sub.raw.subplebbitIpfs! as CommunityWithNestedExtraProps;
            expect(subJson.suggested?.extraSuggested).to.equal("customValue");
            expect(subJson.suggested?.primaryColor).to.equal("#ff0000");

            // Test update() flow
            const subToUpdate = await remotePKC.createCommunity({ address: communityAddress });
            await subToUpdate.update();
            await resolveWhenConditionIsTrue({ toUpdate: subToUpdate, predicate: async () => typeof subToUpdate.updatedAt === "number" });

            const updatedJson = subToUpdate.raw.subplebbitIpfs! as CommunityWithNestedExtraProps;
            expect(updatedJson.suggested?.extraSuggested).to.equal("customValue");
            expect(updatedJson.suggested?.primaryColor).to.equal("#ff0000");

            await subToUpdate.stop();
            await remotePKC.destroy();
        });

        it(`encryption.extraProp is preserved through createCommunity and update()`, async () => {
            // We need to preserve the existing encryption fields (type, publicKey) while adding extra
            const { subplebbitRecord } = await createMockedCommunityIpns({});
            // Manually add extra prop to encryption after getting the base record
            const recordWithExtraEncryption = {
                ...subplebbitRecord,
                encryption: { ...subplebbitRecord.encryption, extraEncryption: "extraData" }
            };

            const remotePKC = await config.plebbitInstancePromise();

            // Test createCommunity with modified record
            const sub = await remotePKC.createCommunity(recordWithExtraEncryption);
            const subJson = sub.raw.subplebbitIpfs! as CommunityWithNestedExtraProps;
            expect(subJson.encryption?.extraEncryption).to.equal("extraData");
            expect(subJson.encryption?.type).to.equal(subplebbitRecord.encryption.type);

            // Test recreation from JSON
            const recreatedFromJson = await remotePKC.createCommunity(JSON.parse(JSON.stringify(sub)));
            const recreatedJson = recreatedFromJson.raw.subplebbitIpfs! as CommunityWithNestedExtraProps;
            expect(recreatedJson.encryption?.extraEncryption).to.equal("extraData");

            await remotePKC.destroy();
        });

        it(`roles[address].extraProp is preserved through createCommunity and update()`, async () => {
            const testAddress = "12D3KooWTestAddress1234567890abcdefghij";
            const rolesWithExtra = {
                [testAddress]: { role: "moderator", extraRoleProp: "customRoleData" }
            };
            const { subplebbitRecord, communityAddress: communityAddress } = await createMockedCommunityIpns({
                roles: rolesWithExtra
            });

            const remotePKC = await config.plebbitInstancePromise();

            // Test createCommunity with record directly
            const sub = await remotePKC.createCommunity(subplebbitRecord);
            const subJson = sub.raw.subplebbitIpfs! as CommunityWithNestedExtraProps;
            expect(subJson.roles?.[testAddress]?.extraRoleProp).to.equal("customRoleData");
            expect(subJson.roles?.[testAddress]?.role).to.equal("moderator");

            // Test update() flow
            const subToUpdate = await remotePKC.createCommunity({ address: communityAddress });
            await subToUpdate.update();
            await resolveWhenConditionIsTrue({ toUpdate: subToUpdate, predicate: async () => typeof subToUpdate.updatedAt === "number" });

            const updatedJson = subToUpdate.raw.subplebbitIpfs! as CommunityWithNestedExtraProps;
            expect(updatedJson.roles?.[testAddress]?.extraRoleProp).to.equal("customRoleData");
            expect(updatedJson.roles?.[testAddress]?.role).to.equal("moderator");

            await subToUpdate.stop();
            await remotePKC.destroy();
        });

        it(`Multiple nested objects with extra props are all preserved`, async () => {
            const testAddress = "12D3KooWTestAddress1234567890abcdefghij";
            const { subplebbitRecord, communityAddress: communityAddress } = await createMockedCommunityIpns({
                features: { noVideos: true, extraFeature: true },
                suggested: { primaryColor: "#00ff00", extraSuggested: "suggestedValue" },
                roles: { [testAddress]: { role: "admin", extraRoleProp: "roleValue" } }
            });

            const remotePKC = await config.plebbitInstancePromise();

            const sub = await remotePKC.createCommunity(subplebbitRecord);
            const subJson = sub.raw.subplebbitIpfs! as CommunityWithNestedExtraProps;

            // Verify all nested extra props
            expect(subJson.features?.extraFeature).to.equal(true);
            expect(subJson.suggested?.extraSuggested).to.equal("suggestedValue");
            expect(subJson.roles?.[testAddress]?.extraRoleProp).to.equal("roleValue");

            // Test update() flow
            const subToUpdate = await remotePKC.createCommunity({ address: communityAddress });
            await subToUpdate.update();
            await resolveWhenConditionIsTrue({ toUpdate: subToUpdate, predicate: async () => typeof subToUpdate.updatedAt === "number" });

            const updatedJson = subToUpdate.raw.subplebbitIpfs! as CommunityWithNestedExtraProps;
            expect(updatedJson.features?.extraFeature).to.equal(true);
            expect(updatedJson.suggested?.extraSuggested).to.equal("suggestedValue");
            expect(updatedJson.roles?.[testAddress]?.extraRoleProp).to.equal("roleValue");

            await subToUpdate.stop();
            await remotePKC.destroy();
        });
    });

    describe.sequential(`CommunityIpfs with nameResolved reserved field is rejected - ${config.name}`, async () => {
        let publishedSub: Awaited<ReturnType<typeof publishCommunityRecordWithExtraProp>>;

        beforeAll(async () => {
            // Create a valid community record, then re-publish with nameResolved injected
            publishedSub = await publishCommunityRecordWithExtraProp();
            const record = JSON.parse(JSON.stringify(publishedSub.subplebbitRecord));
            record.nameResolved = true;
            const signedPropertyNames = [...record.signature.signedPropertyNames, "nameResolved"];
            record.signature = await _signJson(
                signedPropertyNames,
                record,
                publishedSub.ipnsObj.signer,
                Logger("pkc-js:test:community-nameResolved-reserved")
            );
            await publishedSub.ipnsObj.publishToIpns(JSON.stringify(record));
        });

        afterAll(async () => {
            await publishedSub.ipnsObj.plebbit.destroy();
        });

        it(`community.update() rejects CommunityIpfs with nameResolved reserved field`, async () => {
            const remotePKC = await config.plebbitInstancePromise();

            const sub = await remotePKC.createCommunity({ address: publishedSub.ipnsObj.signer.address });
            const errorPromise = new Promise<PKCError>((resolve) => sub.once("error", resolve as (err: Error) => void));

            await sub.update();
            const error = await errorPromise;

            if (isPKCFetchingUsingGateways(remotePKC)) {
                expect(error.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
                const gatewayError = Object.values(error.details.gatewayToError)[0] as PKCError;
                expect(gatewayError.code).to.equal("ERR_COMMUNITY_SIGNATURE_IS_INVALID");
                expect(gatewayError.details.signatureValidity.reason).to.equal(messages.ERR_COMMUNITY_RECORD_INCLUDES_RESERVED_FIELD);
            } else {
                expect(error.code).to.equal("ERR_COMMUNITY_SIGNATURE_IS_INVALID");
                expect(error.details.signatureValidity.reason).to.equal(messages.ERR_COMMUNITY_RECORD_INCLUDES_RESERVED_FIELD);
            }

            expect(sub.updatedAt).to.be.undefined;
            await sub.stop();
            await remotePKC.destroy();
        });

        it(`getCommunity() throws when CommunityIpfs has nameResolved reserved field`, async () => {
            const remotePKC = await config.plebbitInstancePromise();

            try {
                await remotePKC.getCommunity({ address: publishedSub.ipnsObj.signer.address });
                expect.fail("Should have thrown");
            } catch (e) {
                const error = e as PKCError;
                if (isPKCFetchingUsingGateways(remotePKC)) {
                    expect(error.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
                    const gatewayError = Object.values(error.details.gatewayToError)[0] as PKCError;
                    expect(gatewayError.code).to.equal("ERR_COMMUNITY_SIGNATURE_IS_INVALID");
                    expect(gatewayError.details.signatureValidity.reason).to.equal(messages.ERR_COMMUNITY_RECORD_INCLUDES_RESERVED_FIELD);
                } else {
                    expect(error.code).to.equal("ERR_COMMUNITY_SIGNATURE_IS_INVALID");
                    expect(error.details.signatureValidity.reason).to.equal(messages.ERR_COMMUNITY_RECORD_INCLUDES_RESERVED_FIELD);
                }
            }

            await remotePKC.destroy();
        });
    });
});
