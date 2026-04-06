import { beforeAll, afterAll } from "vitest";
import signers from "../../fixtures/signers.js";
import {
    createMockNameResolver,
    mockRemotePlebbit,
    describeSkipIfRpc,
    resolveWhenConditionIsTrue,
    mockPlebbitV2
} from "../../../dist/node/test/test-util.js";
import { messages } from "../../../dist/node/errors.js";
import { verifyCommunity, signCommunity, cleanUpBeforePublishing, _signJson } from "../../../dist/node/signer/signatures.js";
import * as remeda from "remeda";
import validSubplebbitFixture from "../../fixtures/signatures/subplebbit/valid_subplebbit_ipfs.json" with { type: "json" };
import newFormatFixture from "../../fixtures/signatures/subplebbit/valid_subplebbit_ipfs_new_format.json" with { type: "json" };
import newFormatWithNameFixture from "../../fixtures/signatures/subplebbit/valid_subplebbit_ipfs_new_format_with_name.json" with { type: "json" };
import { removeUndefinedValuesRecursively } from "../../../dist/node/util.js";
import Logger from "@pkc/pkc-logger";

import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type { SubplebbitIpfsType } from "../../../dist/node/subplebbit/types.js";
const log = Logger("pkc-js:test:signatures:community");

// Clients of RPC will trust the response of RPC and won't validate
describeSkipIfRpc.concurrent("Sign subplebbit", async () => {
    let plebbit: PlebbitType;
    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`Can sign and validate fixture subplebbit correctly`, async () => {
        const subFixture = remeda.clone(validSubplebbitFixture) as SubplebbitIpfsType;
        const subFixtureClone = remeda.clone(subFixture) as Record<string, unknown>;
        delete subFixtureClone["signature"];
        const signature = await signCommunity({
            subplebbit: subFixtureClone as Omit<SubplebbitIpfsType, "signature">,
            signer: signers[0]
        });
        // Old fixture was signed with address in signedPropertyNames; new signing omits address.
        // The signatures differ because different fields are signed, but both are valid.
        expect(signature.publicKey).to.equal(subFixture.signature.publicKey);
        expect(signature.type).to.equal(subFixture.signature.type);
        // New signature excludes 'address' from signedPropertyNames
        expect(signature.signedPropertyNames).to.not.include("address");
        expect(subFixture.signature.signedPropertyNames).to.include("address");
    });
    it(`Can sign and validate live subplebbit correctly`, async () => {
        const subplebbit = await plebbit.getSubplebbit({ address: signers[0].address });
        const subjsonIpfs = subplebbit.raw.subplebbitIpfs!;
        const subplebbitToSign: Record<string, unknown> = {
            ...cleanUpBeforePublishing(subjsonIpfs),
            posts: removeUndefinedValuesRecursively(subjsonIpfs.posts)
        };
        delete subplebbitToSign["signature"];
        subplebbitToSign.signature = await signCommunity({
            subplebbit: subplebbitToSign as Omit<SubplebbitIpfsType, "signature">,
            signer: signers[0]
        });
        expect(subplebbitToSign.signature).to.deep.equal(subplebbit.signature);

        const verification = await verifyCommunity({
            subplebbit: subplebbitToSign as SubplebbitIpfsType,
            subplebbitIpnsName: signers[0].address,
            resolveAuthorNames: plebbit.resolveAuthorNames,
            clientsManager: plebbit._clientsManager,
            validatePages: true,
            cacheIfValid: false
        });
        expect(verification).to.deep.equal({ valid: true });
    });

    it(`Can sign new-format record without address`, async () => {
        const subFixture = remeda.clone(newFormatFixture) as SubplebbitIpfsType;
        const subFixtureClone = remeda.clone(subFixture) as Record<string, unknown>;
        delete subFixtureClone["signature"];
        const signature = await signCommunity({
            subplebbit: subFixtureClone as Omit<SubplebbitIpfsType, "signature">,
            signer: signers[0]
        });
        expect(signature.signature).to.equal(subFixture.signature.signature);
        expect(signature.signedPropertyNames).to.not.include("address");
    });

    it(`Can sign new-format record with name`, async () => {
        const subFixture = remeda.clone(newFormatWithNameFixture) as SubplebbitIpfsType;
        const subFixtureClone = remeda.clone(subFixture) as Record<string, unknown>;
        delete subFixtureClone["signature"];
        const signature = await signCommunity({
            subplebbit: subFixtureClone as Omit<SubplebbitIpfsType, "signature">,
            signer: signers[0]
        });
        expect(signature.signature).to.equal(subFixture.signature.signature);
        expect(signature.signedPropertyNames).to.include("name");
        expect(signature.signedPropertyNames).to.not.include("address");
    });
});

// Clients of RPC will trust the response of RPC and won't validate
describeSkipIfRpc.concurrent("Verify subplebbit", async () => {
    let plebbit: PlebbitType;

    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`Can validate live subplebbit`, async () => {
        const loadedSubplebbit = await plebbit.createSubplebbit({ address: signers[0].address });
        await loadedSubplebbit.update();
        await resolveWhenConditionIsTrue({
            toUpdate: loadedSubplebbit,
            predicate: async () => typeof loadedSubplebbit.updatedAt === "number"
        });

        expect(
            await verifyCommunity({
                subplebbit: loadedSubplebbit.raw.subplebbitIpfs!,
                subplebbitIpnsName: signers[0].address,
                resolveAuthorNames: plebbit.resolveAuthorNames,
                clientsManager: plebbit._clientsManager,
                validatePages: true,
                cacheIfValid: false
            })
        ).to.deep.equal({ valid: true });
    });
    it(`Valid subplebbit fixture is validated correctly`, async () => {
        const sub = remeda.clone(validSubplebbitFixture) as SubplebbitIpfsType;
        expect(
            await verifyCommunity({
                subplebbit: sub,
                subplebbitIpnsName: signers[0].address,
                resolveAuthorNames: plebbit.resolveAuthorNames,
                clientsManager: plebbit._clientsManager,
                validatePages: true,
                cacheIfValid: false
            })
        ).to.deep.equal({ valid: true });
    });

    it(`Old-format fixture with address in signedPropertyNames still verifies`, async () => {
        const sub = remeda.clone(validSubplebbitFixture) as SubplebbitIpfsType;
        expect(sub.signature.signedPropertyNames).to.include("address");
        expect(
            await verifyCommunity({
                subplebbit: sub,
                subplebbitIpnsName: signers[0].address,
                resolveAuthorNames: plebbit.resolveAuthorNames,
                clientsManager: plebbit._clientsManager,
                validatePages: true,
                cacheIfValid: false
            })
        ).to.deep.equal({ valid: true });
    });

    it(`New-format fixture without address verifies`, async () => {
        const sub = remeda.clone(newFormatFixture) as SubplebbitIpfsType;
        expect(sub.signature.signedPropertyNames).to.not.include("address");
        expect((sub as Record<string, unknown>).address).to.be.undefined;
        expect(
            await verifyCommunity({
                subplebbit: sub,
                subplebbitIpnsName: signers[0].address,
                resolveAuthorNames: plebbit.resolveAuthorNames,
                clientsManager: plebbit._clientsManager,
                validatePages: false,
                cacheIfValid: false
            })
        ).to.deep.equal({ valid: true });
    });

    it(`New-format fixture with name verifies`, async () => {
        const sub = remeda.clone(newFormatWithNameFixture) as SubplebbitIpfsType;
        expect(sub.signature.signedPropertyNames).to.include("name");
        expect(sub.signature.signedPropertyNames).to.not.include("address");
        expect(sub.name).to.equal("test-sub.eth");
        expect(
            await verifyCommunity({
                subplebbit: sub,
                subplebbitIpnsName: signers[0].address,
                resolveAuthorNames: plebbit.resolveAuthorNames,
                clientsManager: plebbit._clientsManager,
                validatePages: false,
                cacheIfValid: false
            })
        ).to.deep.equal({ valid: true });
    });

    it(`Subplebbit with domain that does not match public key will get invalidated`, async () => {
        // plebbit.eth -> signers[3], so we will intentionally set it to a different address
        const tempPlebbit = await mockPlebbitV2({
            stubStorage: false,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: { "plebbit.eth": signers[4].address } })]
            }
        });
        const sub = await plebbit.createSubplebbit({ address: "plebbit.bso" });
        await sub.update();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        const verification = await verifyCommunity({
            subplebbit: sub.raw.subplebbitIpfs!,
            subplebbitIpnsName: signers[4].address,
            resolveAuthorNames: tempPlebbit.resolveAuthorNames,
            clientsManager: tempPlebbit._clientsManager,
            validatePages: true,
            cacheIfValid: false
        });
        // Subplebbit posts will be invalid because the resolved address of sub will be used to validate posts
        expect(verification.valid).to.be.false;
        await tempPlebbit.destroy();
    });

    it(`subplebbit signature is invalid if subplebbit.posts has an invalid comment signature `, async () => {
        const loadedSubplebbit = await plebbit.createSubplebbit({ address: signers[0].address });
        await loadedSubplebbit.update();
        await resolveWhenConditionIsTrue({
            toUpdate: loadedSubplebbit,
            predicate: async () => typeof loadedSubplebbit.updatedAt === "number"
        });

        await loadedSubplebbit.stop();
        const subJson = remeda.clone(loadedSubplebbit.raw.subplebbitIpfs!);
        expect(
            await verifyCommunity({
                subplebbit: subJson,
                subplebbitIpnsName: signers[0].address,
                resolveAuthorNames: plebbit.resolveAuthorNames,
                clientsManager: plebbit._clientsManager,
                validatePages: false
            })
        ).to.deep.equal({
            valid: true
        });

        subJson.posts.pages.hot.comments[0].comment.content += "1234"; // Invalidate signature
        expect(
            await verifyCommunity({
                subplebbit: subJson,
                subplebbitIpnsName: signers[0].address,
                resolveAuthorNames: plebbit.resolveAuthorNames,
                clientsManager: plebbit._clientsManager,
                validatePages: false
            })
        ).to.deep.equal({
            valid: false,
            reason: messages.ERR_COMMUNITY_SIGNATURE_IS_INVALID
        });
    });

    it(`subplebbit signature is valid if subplebbit.posts has a comment.author.address who resolves to an invalid address`, async () => {
        // Publish a comment with ENS domain here

        const subIpfs = remeda.clone(validSubplebbitFixture) as SubplebbitIpfsType; // This json has only one comment with plebbit.eth
        const commentWithEnsCid = subIpfs.posts.pages.hot.comments.find(
            (commentPage) => commentPage.comment.author.address === "plebbit.eth"
        )!.commentUpdate.cid;
        expect(commentWithEnsCid).to.be.a("string");

        const getLatestComment = () => subIpfs.posts.pages.hot.comments.find((comment) => comment.commentUpdate.cid === commentWithEnsCid)!;

        const tempPlebbit = await mockRemotePlebbit({
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [
                    createMockNameResolver({
                        records: new Map([["plebbit.eth", signers[7].address]]),
                        includeDefaultRecords: true
                    })
                ]
            }
        });

        expect(getLatestComment().comment.author.address).to.equal("plebbit.eth");
        expect(
            await verifyCommunity({
                subplebbit: subIpfs,
                subplebbitIpnsName: signers[0].address,
                resolveAuthorNames: tempPlebbit.resolveAuthorNames,
                clientsManager: tempPlebbit._clientsManager,
                validatePages: true
            })
        ).to.deep.equal({
            valid: true
        });

        // author.address is immutable — it stays as the domain even when resolution fails
        expect(getLatestComment().comment.author.address).to.equal("plebbit.eth");
        await tempPlebbit.destroy();
    });

    it(`A subplebbit record is rejected if it includes a field not in signature.signedPropertyNames`, async () => {
        const tempPlebbit: PlebbitType = await mockRemotePlebbit();

        // Use new-format fixture (no address) to avoid signature mismatch due to format change
        const subFixture = remeda.clone(newFormatFixture) as SubplebbitIpfsType;
        const subFixtureClone = remeda.clone(subFixture) as SubplebbitIpfsType & { extraProp?: string };
        subFixtureClone.extraProp = "1234";
        const signature = await signCommunity({
            subplebbit: subFixtureClone as Omit<SubplebbitIpfsType, "signature">,
            signer: signers[0]
        });
        expect(signature.signature).to.equal(subFixture.signature.signature);
        expect(signature.publicKey).to.equal(subFixture.signature.publicKey);
        expect(signature.type).to.equal(subFixture.signature.type);

        expect(signature.signedPropertyNames).to.not.include("extraProp");

        const validation = await verifyCommunity({
            subplebbit: subFixtureClone as SubplebbitIpfsType,
            subplebbitIpnsName: signers[0].address,
            resolveAuthorNames: tempPlebbit.resolveAuthorNames,
            clientsManager: tempPlebbit._clientsManager,
            validatePages: false
        });
        expect(validation).to.deep.equal({
            valid: false,
            reason: messages.ERR_COMMUNITY_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES
        });
        await tempPlebbit.destroy();
    });

    it(`A subplebbit record is accepted if it includes an extra prop as long as it's in signature.signedPropertyNames`, async () => {
        const tempPlebbit: PlebbitType = await mockRemotePlebbit();

        const subFixture = remeda.clone(validSubplebbitFixture) as SubplebbitIpfsType;
        const subFixtureClone = remeda.clone(subFixture) as SubplebbitIpfsType & { extraProp?: string };
        subFixtureClone.extraProp = "1234";
        const signature = await _signJson([...subFixture.signature.signedPropertyNames, "extraProp"], subFixtureClone, signers[0], log);
        expect(signature.signedPropertyNames).to.include("extraProp");

        (subFixtureClone as Record<string, unknown>).signature = signature;

        const validation = await verifyCommunity({
            subplebbit: subFixtureClone as SubplebbitIpfsType,
            subplebbitIpnsName: signers[0].address,
            resolveAuthorNames: tempPlebbit.resolveAuthorNames,
            clientsManager: tempPlebbit._clientsManager,
            validatePages: true
        });
        expect(validation).to.deep.equal({
            valid: true
        });
        await tempPlebbit.destroy();
    });

    it(`A subplebbit record is rejected if it includes runtime-only nameResolved even when signed`, async () => {
        const tempPlebbit: PlebbitType = await mockRemotePlebbit();

        const subFixture = remeda.clone(newFormatFixture) as SubplebbitIpfsType;
        const subFixtureClone = remeda.clone(subFixture) as SubplebbitIpfsType & { nameResolved?: boolean };
        subFixtureClone.nameResolved = true;
        const signature = await _signJson([...subFixture.signature.signedPropertyNames, "nameResolved"], subFixtureClone, signers[0], log);

        (subFixtureClone as Record<string, unknown>).signature = signature;

        const validation = await verifyCommunity({
            subplebbit: subFixtureClone as SubplebbitIpfsType,
            subplebbitIpnsName: signers[0].address,
            resolveAuthorNames: tempPlebbit.resolveAuthorNames,
            clientsManager: tempPlebbit._clientsManager,
            validatePages: false
        });
        expect(validation).to.deep.equal({
            valid: false,
            reason: messages.ERR_COMMUNITY_RECORD_INCLUDES_RESERVED_FIELD
        });
        await tempPlebbit.destroy();
    });
});
