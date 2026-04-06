import { beforeAll, afterAll } from "vitest";
import signers from "../../fixtures/signers.js";
import {
    createMockNameResolver,
    mockRemotePKC,
    describeSkipIfRpc,
    resolveWhenConditionIsTrue,
    mockPKCV2
} from "../../../dist/node/test/test-util.js";
import { messages } from "../../../dist/node/errors.js";
import { verifyCommunity, signCommunity, cleanUpBeforePublishing, _signJson } from "../../../dist/node/signer/signatures.js";
import * as remeda from "remeda";
import validCommunityFixture from "../../fixtures/signatures/community/valid_subplebbit_ipfs.json" with { type: "json" };
import newFormatFixture from "../../fixtures/signatures/community/valid_subplebbit_ipfs_new_format.json" with { type: "json" };
import newFormatWithNameFixture from "../../fixtures/signatures/community/valid_subplebbit_ipfs_new_format_with_name.json" with { type: "json" };
import { removeUndefinedValuesRecursively } from "../../../dist/node/util.js";
import Logger from "@pkc/pkc-logger";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { CommunityIpfsType } from "../../../dist/node/community/types.js";
const log = Logger("pkc-js:test:signatures:community");

// Clients of RPC will trust the response of RPC and won't validate
describeSkipIfRpc.concurrent("Sign community", async () => {
    let pkc: PKCType;
    beforeAll(async () => {
        pkc = await mockRemotePKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`Can sign and validate fixture community correctly`, async () => {
        const subFixture = remeda.clone(validCommunityFixture) as CommunityIpfsType;
        const subFixtureClone = remeda.clone(subFixture) as Record<string, unknown>;
        delete subFixtureClone["signature"];
        const signature = await signCommunity({
            subplebbit: subFixtureClone as Omit<CommunityIpfsType, "signature">,
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
    it(`Can sign and validate live community correctly`, async () => {
        const community = await pkc.getCommunity({ address: signers[0].address });
        const subjsonIpfs = community.raw.subplebbitIpfs!;
        const subplebbitToSign: Record<string, unknown> = {
            ...cleanUpBeforePublishing(subjsonIpfs),
            posts: removeUndefinedValuesRecursively(subjsonIpfs.posts)
        };
        delete subplebbitToSign["signature"];
        subplebbitToSign.signature = await signCommunity({
            subplebbit: subplebbitToSign as Omit<CommunityIpfsType, "signature">,
            signer: signers[0]
        });
        expect(subplebbitToSign.signature).to.deep.equal(community.signature);

        const verification = await verifyCommunity({
            subplebbit: subplebbitToSign as CommunityIpfsType,
            subplebbitIpnsName: signers[0].address,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager,
            validatePages: true,
            cacheIfValid: false
        });
        expect(verification).to.deep.equal({ valid: true });
    });

    it(`Can sign new-format record without address`, async () => {
        const subFixture = remeda.clone(newFormatFixture) as CommunityIpfsType;
        const subFixtureClone = remeda.clone(subFixture) as Record<string, unknown>;
        delete subFixtureClone["signature"];
        const signature = await signCommunity({
            subplebbit: subFixtureClone as Omit<CommunityIpfsType, "signature">,
            signer: signers[0]
        });
        expect(signature.signature).to.equal(subFixture.signature.signature);
        expect(signature.signedPropertyNames).to.not.include("address");
    });

    it(`Can sign new-format record with name`, async () => {
        const subFixture = remeda.clone(newFormatWithNameFixture) as CommunityIpfsType;
        const subFixtureClone = remeda.clone(subFixture) as Record<string, unknown>;
        delete subFixtureClone["signature"];
        const signature = await signCommunity({
            subplebbit: subFixtureClone as Omit<CommunityIpfsType, "signature">,
            signer: signers[0]
        });
        expect(signature.signature).to.equal(subFixture.signature.signature);
        expect(signature.signedPropertyNames).to.include("name");
        expect(signature.signedPropertyNames).to.not.include("address");
    });
});

// Clients of RPC will trust the response of RPC and won't validate
describeSkipIfRpc.concurrent("Verify community", async () => {
    let pkc: PKCType;

    beforeAll(async () => {
        pkc = await mockRemotePKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`Can validate live community`, async () => {
        const loadedCommunity = await pkc.createCommunity({ address: signers[0].address });
        await loadedCommunity.update();
        await resolveWhenConditionIsTrue({
            toUpdate: loadedCommunity,
            predicate: async () => typeof loadedCommunity.updatedAt === "number"
        });

        expect(
            await verifyCommunity({
                subplebbit: loadedCommunity.raw.subplebbitIpfs!,
                subplebbitIpnsName: signers[0].address,
                resolveAuthorNames: pkc.resolveAuthorNames,
                clientsManager: pkc._clientsManager,
                validatePages: true,
                cacheIfValid: false
            })
        ).to.deep.equal({ valid: true });
    });
    it(`Valid community fixture is validated correctly`, async () => {
        const sub = remeda.clone(validCommunityFixture) as CommunityIpfsType;
        expect(
            await verifyCommunity({
                subplebbit: sub,
                subplebbitIpnsName: signers[0].address,
                resolveAuthorNames: pkc.resolveAuthorNames,
                clientsManager: pkc._clientsManager,
                validatePages: true,
                cacheIfValid: false
            })
        ).to.deep.equal({ valid: true });
    });

    it(`Old-format fixture with address in signedPropertyNames still verifies`, async () => {
        const sub = remeda.clone(validCommunityFixture) as CommunityIpfsType;
        expect(sub.signature.signedPropertyNames).to.include("address");
        expect(
            await verifyCommunity({
                subplebbit: sub,
                subplebbitIpnsName: signers[0].address,
                resolveAuthorNames: pkc.resolveAuthorNames,
                clientsManager: pkc._clientsManager,
                validatePages: true,
                cacheIfValid: false
            })
        ).to.deep.equal({ valid: true });
    });

    it(`New-format fixture without address verifies`, async () => {
        const sub = remeda.clone(newFormatFixture) as CommunityIpfsType;
        expect(sub.signature.signedPropertyNames).to.not.include("address");
        expect((sub as Record<string, unknown>).address).to.be.undefined;
        expect(
            await verifyCommunity({
                subplebbit: sub,
                subplebbitIpnsName: signers[0].address,
                resolveAuthorNames: pkc.resolveAuthorNames,
                clientsManager: pkc._clientsManager,
                validatePages: false,
                cacheIfValid: false
            })
        ).to.deep.equal({ valid: true });
    });

    it(`New-format fixture with name verifies`, async () => {
        const sub = remeda.clone(newFormatWithNameFixture) as CommunityIpfsType;
        expect(sub.signature.signedPropertyNames).to.include("name");
        expect(sub.signature.signedPropertyNames).to.not.include("address");
        expect(sub.name).to.equal("test-sub.eth");
        expect(
            await verifyCommunity({
                subplebbit: sub,
                subplebbitIpnsName: signers[0].address,
                resolveAuthorNames: pkc.resolveAuthorNames,
                clientsManager: pkc._clientsManager,
                validatePages: false,
                cacheIfValid: false
            })
        ).to.deep.equal({ valid: true });
    });

    it(`Community with domain that does not match public key will get invalidated`, async () => {
        // plebbit.eth -> signers[3], so we will intentionally set it to a different address
        const tempPKC = await mockPKCV2({
            stubStorage: false,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: { "plebbit.eth": signers[4].address } })]
            }
        });
        const sub = await pkc.createCommunity({ address: "plebbit.bso" });
        await sub.update();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        const verification = await verifyCommunity({
            subplebbit: sub.raw.subplebbitIpfs!,
            subplebbitIpnsName: signers[4].address,
            resolveAuthorNames: tempPKC.resolveAuthorNames,
            clientsManager: tempPKC._clientsManager,
            validatePages: true,
            cacheIfValid: false
        });
        // Community posts will be invalid because the resolved address of sub will be used to validate posts
        expect(verification.valid).to.be.false;
        await tempPKC.destroy();
    });

    it(`community signature is invalid if community.posts has an invalid comment signature `, async () => {
        const loadedCommunity = await pkc.createCommunity({ address: signers[0].address });
        await loadedCommunity.update();
        await resolveWhenConditionIsTrue({
            toUpdate: loadedCommunity,
            predicate: async () => typeof loadedCommunity.updatedAt === "number"
        });

        await loadedCommunity.stop();
        const subJson = remeda.clone(loadedCommunity.raw.subplebbitIpfs!);
        expect(
            await verifyCommunity({
                subplebbit: subJson,
                subplebbitIpnsName: signers[0].address,
                resolveAuthorNames: pkc.resolveAuthorNames,
                clientsManager: pkc._clientsManager,
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
                resolveAuthorNames: pkc.resolveAuthorNames,
                clientsManager: pkc._clientsManager,
                validatePages: false
            })
        ).to.deep.equal({
            valid: false,
            reason: messages.ERR_COMMUNITY_SIGNATURE_IS_INVALID
        });
    });

    it(`community signature is valid if community.posts has a comment.author.address who resolves to an invalid address`, async () => {
        // Publish a comment with ENS domain here

        const subIpfs = remeda.clone(validCommunityFixture) as CommunityIpfsType; // This json has only one comment with plebbit.eth
        const commentWithEnsCid = subIpfs.posts.pages.hot.comments.find(
            (commentPage) => commentPage.comment.author.address === "plebbit.eth"
        )!.commentUpdate.cid;
        expect(commentWithEnsCid).to.be.a("string");

        const getLatestComment = () => subIpfs.posts.pages.hot.comments.find((comment) => comment.commentUpdate.cid === commentWithEnsCid)!;

        const tempPKC = await mockRemotePKC({
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
                resolveAuthorNames: tempPKC.resolveAuthorNames,
                clientsManager: tempPKC._clientsManager,
                validatePages: true
            })
        ).to.deep.equal({
            valid: true
        });

        // author.address is immutable — it stays as the domain even when resolution fails
        expect(getLatestComment().comment.author.address).to.equal("plebbit.eth");
        await tempPKC.destroy();
    });

    it(`A community record is rejected if it includes a field not in signature.signedPropertyNames`, async () => {
        const tempPKC: PKCType = await mockRemotePKC();

        // Use new-format fixture (no address) to avoid signature mismatch due to format change
        const subFixture = remeda.clone(newFormatFixture) as CommunityIpfsType;
        const subFixtureClone = remeda.clone(subFixture) as CommunityIpfsType & { extraProp?: string };
        subFixtureClone.extraProp = "1234";
        const signature = await signCommunity({
            subplebbit: subFixtureClone as Omit<CommunityIpfsType, "signature">,
            signer: signers[0]
        });
        expect(signature.signature).to.equal(subFixture.signature.signature);
        expect(signature.publicKey).to.equal(subFixture.signature.publicKey);
        expect(signature.type).to.equal(subFixture.signature.type);

        expect(signature.signedPropertyNames).to.not.include("extraProp");

        const validation = await verifyCommunity({
            subplebbit: subFixtureClone as CommunityIpfsType,
            subplebbitIpnsName: signers[0].address,
            resolveAuthorNames: tempPKC.resolveAuthorNames,
            clientsManager: tempPKC._clientsManager,
            validatePages: false
        });
        expect(validation).to.deep.equal({
            valid: false,
            reason: messages.ERR_COMMUNITY_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES
        });
        await tempPKC.destroy();
    });

    it(`A community record is accepted if it includes an extra prop as long as it's in signature.signedPropertyNames`, async () => {
        const tempPKC: PKCType = await mockRemotePKC();

        const subFixture = remeda.clone(validCommunityFixture) as CommunityIpfsType;
        const subFixtureClone = remeda.clone(subFixture) as CommunityIpfsType & { extraProp?: string };
        subFixtureClone.extraProp = "1234";
        const signature = await _signJson([...subFixture.signature.signedPropertyNames, "extraProp"], subFixtureClone, signers[0], log);
        expect(signature.signedPropertyNames).to.include("extraProp");

        (subFixtureClone as Record<string, unknown>).signature = signature;

        const validation = await verifyCommunity({
            subplebbit: subFixtureClone as CommunityIpfsType,
            subplebbitIpnsName: signers[0].address,
            resolveAuthorNames: tempPKC.resolveAuthorNames,
            clientsManager: tempPKC._clientsManager,
            validatePages: true
        });
        expect(validation).to.deep.equal({
            valid: true
        });
        await tempPKC.destroy();
    });

    it(`A community record is rejected if it includes runtime-only nameResolved even when signed`, async () => {
        const tempPKC: PKCType = await mockRemotePKC();

        const subFixture = remeda.clone(newFormatFixture) as CommunityIpfsType;
        const subFixtureClone = remeda.clone(subFixture) as CommunityIpfsType & { nameResolved?: boolean };
        subFixtureClone.nameResolved = true;
        const signature = await _signJson([...subFixture.signature.signedPropertyNames, "nameResolved"], subFixtureClone, signers[0], log);

        (subFixtureClone as Record<string, unknown>).signature = signature;

        const validation = await verifyCommunity({
            subplebbit: subFixtureClone as CommunityIpfsType,
            subplebbitIpnsName: signers[0].address,
            resolveAuthorNames: tempPKC.resolveAuthorNames,
            clientsManager: tempPKC._clientsManager,
            validatePages: false
        });
        expect(validation).to.deep.equal({
            valid: false,
            reason: messages.ERR_COMMUNITY_RECORD_INCLUDES_RESERVED_FIELD
        });
        await tempPKC.destroy();
    });
});
