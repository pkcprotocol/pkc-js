import { messages } from "../../../dist/node/errors.js";

import {
    createMockedSubplebbitIpns,
    getAvailablePlebbitConfigsToTestAgainst,
    isPlebbitFetchingUsingGateways,
    publishSubplebbitRecordWithExtraProp,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { _signJson } from "../../../dist/node/signer/signatures.js";
import Logger from "@pkc/pkc-logger";
import { describe, it, afterAll, beforeAll } from "vitest";

import type { PlebbitError } from "../../../dist/node/plebbit-error.js";
import type { SubplebbitIpfsType } from "../../../dist/node/subplebbit/types.js";
import type { Plebbit } from "../../../dist/node/plebbit/plebbit.js";

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe.concurrent(`plebbit.createSubplebbit - Backward Compatiblity - ${config.name}`, async () => {
        it(`Can create a subplebbit instance with subplebbit record with extra props`, async () => {
            const opts = { includeExtraPropInSignedPropertyNames: true, extraProps: { extraProp: "1234" } };
            const publishedSub = await publishSubplebbitRecordWithExtraProp(opts);

            const remotePlebbit = await config.plebbitInstancePromise();

            const sub = await remotePlebbit.createSubplebbit(publishedSub.subplebbitRecord);

            expect((sub.raw.subplebbitIpfs! as Record<string, unknown>).extraProp).to.equal(publishedSub.subplebbitRecord.extraProp);
            expect(sub.raw.subplebbitIpfs!).to.deep.equal(publishedSub.subplebbitRecord);
            expect((sub as unknown as Record<string, unknown>)["extraProp"]).to.equal(publishedSub.subplebbitRecord.extraProp);

            const recreatedSubFromInstance = await remotePlebbit.createSubplebbit(sub);
            expect(recreatedSubFromInstance.raw.subplebbitIpfs!).to.deep.equal(publishedSub.subplebbitRecord);
            expect(JSON.parse(JSON.stringify(recreatedSubFromInstance)).extraProp).to.equal(opts.extraProps.extraProp);
            expect((recreatedSubFromInstance as unknown as Record<string, unknown>)["extraProp"]).to.equal(
                publishedSub.subplebbitRecord.extraProp
            );

            const recreatedSubFromJson = await remotePlebbit.createSubplebbit(JSON.parse(JSON.stringify(sub)));
            expect(JSON.parse(JSON.stringify(recreatedSubFromJson)).extraProp).to.equal(publishedSub.subplebbitRecord.extraProp);
            expect((recreatedSubFromJson as unknown as Record<string, unknown>)["extraProp"]).to.equal(
                publishedSub.subplebbitRecord.extraProp
            );

            await remotePlebbit.destroy();
        });
    });

    describe.concurrent(`subplebbit.update() and backward compatibility - ${config.name}`, async () => {
        it(`subplebbit.update() should have no problem with extra props, as long as they're in subplebbit.signature.signedPropertyNames`, async () => {
            const opts = { includeExtraPropInSignedPropertyNames: true, extraProps: { extraProp: "1234" } };
            const publishedSub = await publishSubplebbitRecordWithExtraProp(opts);

            const remotePlebbit = await config.plebbitInstancePromise();

            const sub = await remotePlebbit.createSubplebbit({ address: publishedSub.ipnsObj.signer.address });

            await sub.update();

            await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });

            expect((sub.raw.subplebbitIpfs! as Record<string, unknown>).extraProp).to.equal(opts.extraProps.extraProp);

            // Verify subplebbitIpfs does not contain address or subplebbitAddress (those are runtime-only)
            expect((sub.raw.subplebbitIpfs! as Record<string, unknown>).address).to.be.undefined;
            expect((sub.raw.subplebbitIpfs! as Record<string, unknown>).subplebbitAddress).to.be.undefined;

            expect(sub.raw.subplebbitIpfs!).to.deep.equal(publishedSub.subplebbitRecord);

            expect(JSON.parse(JSON.stringify(sub)).extraProp).to.equal(opts.extraProps.extraProp);

            expect((sub as unknown as Record<string, unknown>)["extraProp"]).to.equal(opts.extraProps.extraProp);

            await sub.stop();
            await remotePlebbit.destroy();
        });

        it(`subplebbit.update() emit an error if there are unknown props not included in signature.signedPropertyNames`, async () => {
            const opts = { includeExtraPropInSignedPropertyNames: false, extraProps: { extraProp: "1234" } };

            const publishedSub = await publishSubplebbitRecordWithExtraProp(opts);

            const remotePlebbit = await config.plebbitInstancePromise();

            const sub = await remotePlebbit.createSubplebbit({ address: publishedSub.ipnsObj.signer.address });

            const errorPromise = new Promise<PlebbitError>((resolve) => sub.once("error", resolve as (err: Error) => void));

            await sub.update();

            const error = await errorPromise;

            if (isPlebbitFetchingUsingGateways(remotePlebbit)) {
                expect(error.code).to.equal("ERR_FAILED_TO_FETCH_SUBPLEBBIT_FROM_GATEWAYS");
                const gatewayError = error.details.gatewayToError[remotePlebbit.ipfsGatewayUrls[0]] as PlebbitError;
                expect(gatewayError.code).to.equal("ERR_SUBPLEBBIT_SIGNATURE_IS_INVALID");
                expect(gatewayError.details.signatureValidity.valid).to.be.false;
                expect(gatewayError.details.signatureValidity.reason).to.equal(
                    messages.ERR_SUBPLEBBIT_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES
                );
            } else {
                expect(error.code).to.equal("ERR_SUBPLEBBIT_SIGNATURE_IS_INVALID");
                expect(error.details.signatureValidity.valid).to.be.false;
                expect(error.details.signatureValidity.reason).to.equal(
                    messages.ERR_SUBPLEBBIT_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES
                );
            }

            expect(sub.updatedAt).to.be.undefined; // should not accept update

            await sub.stop();
            await remotePlebbit.destroy();
        });
    });

    describe.concurrent(`Subplebbit with extra props in nested objects - ${config.name}`, async () => {
        // Type for subplebbit with unknown nested props
        type SubplebbitWithNestedExtraProps = SubplebbitIpfsType & {
            features?: SubplebbitIpfsType["features"] & { extraFeature?: boolean };
            suggested?: SubplebbitIpfsType["suggested"] & { extraSuggested?: string };
            encryption?: SubplebbitIpfsType["encryption"] & { extraEncryption?: string };
            roles?: Record<string, { role: string; extraRoleProp?: string }>;
        };

        it(`features.extraProp is preserved through createSubplebbit and update()`, async () => {
            const extraFeatures = { noVideos: true, extraFeature: true };
            const { subplebbitRecord, communityAddress: subplebbitAddress } = await createMockedSubplebbitIpns({
                features: extraFeatures
            });

            const remotePlebbit = await config.plebbitInstancePromise();

            // Test createSubplebbit with record directly
            const sub = await remotePlebbit.createSubplebbit(subplebbitRecord);
            const subJson = sub.raw.subplebbitIpfs! as SubplebbitWithNestedExtraProps;
            expect(subJson.features?.extraFeature).to.equal(true);
            expect(subJson.features?.noVideos).to.equal(true);

            // Test recreation from instance
            const recreatedSub = await remotePlebbit.createSubplebbit(sub);
            const recreatedJson = recreatedSub.raw.subplebbitIpfs! as SubplebbitWithNestedExtraProps;
            expect(recreatedJson.features?.extraFeature).to.equal(true);

            // Test recreation from JSON
            const recreatedFromJson = await remotePlebbit.createSubplebbit(JSON.parse(JSON.stringify(sub)));
            const recreatedFromJsonJson = recreatedFromJson.raw.subplebbitIpfs! as SubplebbitWithNestedExtraProps;
            expect(recreatedFromJsonJson.features?.extraFeature).to.equal(true);

            // Test update() flow
            const subToUpdate = await remotePlebbit.createSubplebbit({ address: subplebbitAddress });
            await subToUpdate.update();
            await resolveWhenConditionIsTrue({ toUpdate: subToUpdate, predicate: async () => typeof subToUpdate.updatedAt === "number" });

            const updatedJson = subToUpdate.raw.subplebbitIpfs! as SubplebbitWithNestedExtraProps;
            expect(updatedJson.features?.extraFeature).to.equal(true);
            expect(updatedJson.features?.noVideos).to.equal(true);

            await subToUpdate.stop();
            await remotePlebbit.destroy();
        });

        it(`suggested.extraProp is preserved through createSubplebbit and update()`, async () => {
            const extraSuggested = { primaryColor: "#ff0000", extraSuggested: "customValue" };
            const { subplebbitRecord, communityAddress: subplebbitAddress } = await createMockedSubplebbitIpns({
                suggested: extraSuggested
            });

            const remotePlebbit = await config.plebbitInstancePromise();

            // Test createSubplebbit with record directly
            const sub = await remotePlebbit.createSubplebbit(subplebbitRecord);
            const subJson = sub.raw.subplebbitIpfs! as SubplebbitWithNestedExtraProps;
            expect(subJson.suggested?.extraSuggested).to.equal("customValue");
            expect(subJson.suggested?.primaryColor).to.equal("#ff0000");

            // Test update() flow
            const subToUpdate = await remotePlebbit.createSubplebbit({ address: subplebbitAddress });
            await subToUpdate.update();
            await resolveWhenConditionIsTrue({ toUpdate: subToUpdate, predicate: async () => typeof subToUpdate.updatedAt === "number" });

            const updatedJson = subToUpdate.raw.subplebbitIpfs! as SubplebbitWithNestedExtraProps;
            expect(updatedJson.suggested?.extraSuggested).to.equal("customValue");
            expect(updatedJson.suggested?.primaryColor).to.equal("#ff0000");

            await subToUpdate.stop();
            await remotePlebbit.destroy();
        });

        it(`encryption.extraProp is preserved through createSubplebbit and update()`, async () => {
            // We need to preserve the existing encryption fields (type, publicKey) while adding extra
            const { subplebbitRecord } = await createMockedSubplebbitIpns({});
            // Manually add extra prop to encryption after getting the base record
            const recordWithExtraEncryption = {
                ...subplebbitRecord,
                encryption: { ...subplebbitRecord.encryption, extraEncryption: "extraData" }
            };

            const remotePlebbit = await config.plebbitInstancePromise();

            // Test createSubplebbit with modified record
            const sub = await remotePlebbit.createSubplebbit(recordWithExtraEncryption);
            const subJson = sub.raw.subplebbitIpfs! as SubplebbitWithNestedExtraProps;
            expect(subJson.encryption?.extraEncryption).to.equal("extraData");
            expect(subJson.encryption?.type).to.equal(subplebbitRecord.encryption.type);

            // Test recreation from JSON
            const recreatedFromJson = await remotePlebbit.createSubplebbit(JSON.parse(JSON.stringify(sub)));
            const recreatedJson = recreatedFromJson.raw.subplebbitIpfs! as SubplebbitWithNestedExtraProps;
            expect(recreatedJson.encryption?.extraEncryption).to.equal("extraData");

            await remotePlebbit.destroy();
        });

        it(`roles[address].extraProp is preserved through createSubplebbit and update()`, async () => {
            const testAddress = "12D3KooWTestAddress1234567890abcdefghij";
            const rolesWithExtra = {
                [testAddress]: { role: "moderator", extraRoleProp: "customRoleData" }
            };
            const { subplebbitRecord, communityAddress: subplebbitAddress } = await createMockedSubplebbitIpns({
                roles: rolesWithExtra
            });

            const remotePlebbit = await config.plebbitInstancePromise();

            // Test createSubplebbit with record directly
            const sub = await remotePlebbit.createSubplebbit(subplebbitRecord);
            const subJson = sub.raw.subplebbitIpfs! as SubplebbitWithNestedExtraProps;
            expect(subJson.roles?.[testAddress]?.extraRoleProp).to.equal("customRoleData");
            expect(subJson.roles?.[testAddress]?.role).to.equal("moderator");

            // Test update() flow
            const subToUpdate = await remotePlebbit.createSubplebbit({ address: subplebbitAddress });
            await subToUpdate.update();
            await resolveWhenConditionIsTrue({ toUpdate: subToUpdate, predicate: async () => typeof subToUpdate.updatedAt === "number" });

            const updatedJson = subToUpdate.raw.subplebbitIpfs! as SubplebbitWithNestedExtraProps;
            expect(updatedJson.roles?.[testAddress]?.extraRoleProp).to.equal("customRoleData");
            expect(updatedJson.roles?.[testAddress]?.role).to.equal("moderator");

            await subToUpdate.stop();
            await remotePlebbit.destroy();
        });

        it(`Multiple nested objects with extra props are all preserved`, async () => {
            const testAddress = "12D3KooWTestAddress1234567890abcdefghij";
            const { subplebbitRecord, communityAddress: subplebbitAddress } = await createMockedSubplebbitIpns({
                features: { noVideos: true, extraFeature: true },
                suggested: { primaryColor: "#00ff00", extraSuggested: "suggestedValue" },
                roles: { [testAddress]: { role: "admin", extraRoleProp: "roleValue" } }
            });

            const remotePlebbit = await config.plebbitInstancePromise();

            const sub = await remotePlebbit.createSubplebbit(subplebbitRecord);
            const subJson = sub.raw.subplebbitIpfs! as SubplebbitWithNestedExtraProps;

            // Verify all nested extra props
            expect(subJson.features?.extraFeature).to.equal(true);
            expect(subJson.suggested?.extraSuggested).to.equal("suggestedValue");
            expect(subJson.roles?.[testAddress]?.extraRoleProp).to.equal("roleValue");

            // Test update() flow
            const subToUpdate = await remotePlebbit.createSubplebbit({ address: subplebbitAddress });
            await subToUpdate.update();
            await resolveWhenConditionIsTrue({ toUpdate: subToUpdate, predicate: async () => typeof subToUpdate.updatedAt === "number" });

            const updatedJson = subToUpdate.raw.subplebbitIpfs! as SubplebbitWithNestedExtraProps;
            expect(updatedJson.features?.extraFeature).to.equal(true);
            expect(updatedJson.suggested?.extraSuggested).to.equal("suggestedValue");
            expect(updatedJson.roles?.[testAddress]?.extraRoleProp).to.equal("roleValue");

            await subToUpdate.stop();
            await remotePlebbit.destroy();
        });
    });

    describe.sequential(`SubplebbitIpfs with nameResolved reserved field is rejected - ${config.name}`, async () => {
        let publishedSub: Awaited<ReturnType<typeof publishSubplebbitRecordWithExtraProp>>;

        beforeAll(async () => {
            // Create a valid subplebbit record, then re-publish with nameResolved injected
            publishedSub = await publishSubplebbitRecordWithExtraProp();
            const record = JSON.parse(JSON.stringify(publishedSub.subplebbitRecord));
            record.nameResolved = true;
            const signedPropertyNames = [...record.signature.signedPropertyNames, "nameResolved"];
            record.signature = await _signJson(
                signedPropertyNames,
                record,
                publishedSub.ipnsObj.signer,
                Logger("plebbit-js:test:subplebbit-nameResolved-reserved")
            );
            await publishedSub.ipnsObj.publishToIpns(JSON.stringify(record));
        });

        afterAll(async () => {
            await publishedSub.ipnsObj.plebbit.destroy();
        });

        it(`subplebbit.update() rejects SubplebbitIpfs with nameResolved reserved field`, async () => {
            const remotePlebbit = await config.plebbitInstancePromise();

            const sub = await remotePlebbit.createSubplebbit({ address: publishedSub.ipnsObj.signer.address });
            const errorPromise = new Promise<PlebbitError>((resolve) => sub.once("error", resolve as (err: Error) => void));

            await sub.update();
            const error = await errorPromise;

            if (isPlebbitFetchingUsingGateways(remotePlebbit)) {
                expect(error.code).to.equal("ERR_FAILED_TO_FETCH_SUBPLEBBIT_FROM_GATEWAYS");
                const gatewayError = Object.values(error.details.gatewayToError)[0] as PlebbitError;
                expect(gatewayError.code).to.equal("ERR_SUBPLEBBIT_SIGNATURE_IS_INVALID");
                expect(gatewayError.details.signatureValidity.reason).to.equal(messages.ERR_SUBPLEBBIT_RECORD_INCLUDES_RESERVED_FIELD);
            } else {
                expect(error.code).to.equal("ERR_SUBPLEBBIT_SIGNATURE_IS_INVALID");
                expect(error.details.signatureValidity.reason).to.equal(messages.ERR_SUBPLEBBIT_RECORD_INCLUDES_RESERVED_FIELD);
            }

            expect(sub.updatedAt).to.be.undefined;
            await sub.stop();
            await remotePlebbit.destroy();
        });

        it(`getSubplebbit() throws when SubplebbitIpfs has nameResolved reserved field`, async () => {
            const remotePlebbit = await config.plebbitInstancePromise();

            try {
                await remotePlebbit.getSubplebbit({ address: publishedSub.ipnsObj.signer.address });
                expect.fail("Should have thrown");
            } catch (e) {
                const error = e as PlebbitError;
                if (isPlebbitFetchingUsingGateways(remotePlebbit)) {
                    expect(error.code).to.equal("ERR_FAILED_TO_FETCH_SUBPLEBBIT_FROM_GATEWAYS");
                    const gatewayError = Object.values(error.details.gatewayToError)[0] as PlebbitError;
                    expect(gatewayError.code).to.equal("ERR_SUBPLEBBIT_SIGNATURE_IS_INVALID");
                    expect(gatewayError.details.signatureValidity.reason).to.equal(messages.ERR_SUBPLEBBIT_RECORD_INCLUDES_RESERVED_FIELD);
                } else {
                    expect(error.code).to.equal("ERR_SUBPLEBBIT_SIGNATURE_IS_INVALID");
                    expect(error.details.signatureValidity.reason).to.equal(messages.ERR_SUBPLEBBIT_RECORD_INCLUDES_RESERVED_FIELD);
                }
            }

            await remotePlebbit.destroy();
        });
    });
});
