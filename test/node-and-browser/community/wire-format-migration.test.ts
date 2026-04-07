import { beforeAll, afterAll } from "vitest";
import signers from "../../fixtures/signers.js";
import { getAvailablePKCConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";
import * as remeda from "remeda";
import validCommunityFixture from "../../fixtures/signatures/community/valid_community_ipfs.json" with { type: "json" };
import newFormatFixture from "../../fixtures/signatures/community/valid_community_ipfs_new_format.json" with { type: "json" };
import newFormatWithNameFixture from "../../fixtures/signatures/community/valid_community_ipfs_new_format_with_name.json" with { type: "json" };
import { parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails } from "../../../dist/node/schema/schema-util.js";
import {
    omitRuntimeCommunityFields,
    cleanWireCommunity,
    getCommunityNameFromWire,
    buildRuntimeCommunity
} from "../../../dist/node/community/community-wire.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { CommunityIpfsType } from "../../../dist/node/community/types.js";

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`Wire format migration — runtime field computation - ${config.name}`, async () => {
        let pkc: PKCType;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`address stays immutable when loading new-format record with name`, async () => {
            const sub = await pkc.createCommunity({ address: signers[0].address });
            sub.initCommunityIpfsPropsNoMerge(remeda.clone(newFormatWithNameFixture) as CommunityIpfsType);
            expect(sub.name).to.equal("test-sub.eth");
            expect(sub.address).to.equal(signers[0].address); // address is immutable
        });

        it(`address falls back to publicKey when no name is present`, async () => {
            const sub = await pkc.createCommunity({ address: signers[0].address });
            sub.initCommunityIpfsPropsNoMerge(remeda.clone(newFormatFixture) as CommunityIpfsType);
            // No name, so address should be the IPNS key derived from signature.publicKey
            expect(sub.address).to.equal(signers[0].address);
        });

        it(`address is computed correctly when loading old-format record with IPNS address`, async () => {
            const sub = await pkc.createCommunity({ address: signers[0].address });
            // Old fixture has address = signers[0].address (IPNS key)
            sub.initCommunityIpfsPropsNoMerge(remeda.clone(validCommunityFixture) as CommunityIpfsType);
            expect(sub.address).to.equal(signers[0].address);
        });

        it(`publicKey is derived from signature.publicKey`, async () => {
            const sub = await pkc.createCommunity({ address: signers[0].address });
            sub.initCommunityIpfsPropsNoMerge(remeda.clone(newFormatFixture) as CommunityIpfsType);
            expect(sub.publicKey).to.equal(signers[0].address);
        });

        it(`address and publicKey appear in JSON.stringify output`, async () => {
            const sub = await pkc.createCommunity({ address: signers[0].address });
            sub.initCommunityIpfsPropsNoMerge(remeda.clone(newFormatFixture) as CommunityIpfsType);
            const json = JSON.parse(JSON.stringify(sub));
            expect(json.address).to.be.a("string");
            expect(json.publicKey).to.be.a("string");
        });
    });
});

describe.concurrent("Wire format migration — helper functions", async () => {
    it(`buildRuntimeCommunity computes address from name`, () => {
        const result = buildRuntimeCommunity({
            communityRecord: { name: "memes.eth" } as Record<string, unknown>,
            signaturePublicKey: signers[0].publicKey
        });
        expect(result.address).to.equal("memes.eth");
        expect(result.name).to.equal("memes.eth");
        expect(result.publicKey).to.equal(signers[0].address);
    });

    it(`buildRuntimeCommunity falls back to publicKey when no name`, () => {
        const result = buildRuntimeCommunity({
            communityRecord: {} as Record<string, unknown>,
            signaturePublicKey: signers[0].publicKey
        });
        expect(result.address).to.equal(signers[0].address);
        expect(result.name).to.be.undefined;
        expect(result.publicKey).to.equal(signers[0].address);
    });

    it(`getCommunityNameFromWire returns name from new-format record`, () => {
        expect(getCommunityNameFromWire({ name: "memes.eth" })).to.equal("memes.eth");
    });

    it(`getCommunityNameFromWire falls back to address if it's a domain (old format)`, () => {
        expect(getCommunityNameFromWire({ address: "memes.eth" })).to.equal("memes.eth");
    });

    it(`getCommunityNameFromWire returns undefined for IPNS address (old format)`, () => {
        expect(getCommunityNameFromWire({ address: signers[0].address })).to.be.undefined;
    });

    it(`omitRuntimeCommunityFields strips address, publicKey, shortAddress, nameResolved`, () => {
        const input = {
            name: "test.eth",
            address: "test.eth",
            publicKey: "abc",
            shortAddress: "te..th",
            nameResolved: true,
            encryption: { type: "ed25519-aes-gcm", publicKey: "xyz" }
        };
        const result = omitRuntimeCommunityFields(input);
        expect(result).to.not.have.property("address");
        expect(result).to.not.have.property("publicKey");
        expect(result).to.not.have.property("shortAddress");
        expect(result).to.not.have.property("nameResolved");
        expect(result).to.have.property("name", "test.eth");
        expect(result).to.have.property("encryption");
    });

    it(`cleanWireCommunity returns undefined for empty input`, () => {
        expect(cleanWireCommunity(undefined)).to.be.undefined;
    });
});

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`Wire format migration — flexible createCommunity input - ${config.name}`, async () => {
        let pkc: PKCType;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`createCommunity({ address }) still works (backward compat)`, async () => {
            const sub = await pkc.createCommunity({ address: signers[0].address });
            expect(sub.address).to.equal(signers[0].address);
            expect(sub.address).to.be.a("string").that.is.not.empty;
        });

        it(`createCommunity({ name }) creates instance with address = name`, async () => {
            const sub = await pkc.createCommunity({ name: "memes.eth" });
            expect(sub.address).to.equal("memes.eth");
            expect(sub.name).to.equal("memes.eth");
            expect(sub.address).to.be.a("string").that.is.not.empty;
        });

        it(`createCommunity({ publicKey }) creates instance with address = publicKey`, async () => {
            const sub = await pkc.createCommunity({ publicKey: signers[0].address });
            expect(sub.address).to.equal(signers[0].address);
            expect(sub.address).to.be.a("string").that.is.not.empty;
        });

        it(`createCommunity({ name, publicKey }) creates instance with address = name (name takes priority)`, async () => {
            const sub = await pkc.createCommunity({ name: "memes.eth", publicKey: signers[0].address });
            expect(sub.address).to.equal("memes.eth");
            expect(sub.name).to.equal("memes.eth");
            expect(sub.address).to.be.a("string").that.is.not.empty;
        });

        it(`createCommunity({ name, publicKey, address }) works with all three`, async () => {
            const sub = await pkc.createCommunity({ name: "memes.eth", publicKey: signers[0].address, address: "memes.eth" });
            expect(sub.address).to.equal("memes.eth");
            expect(sub.address).to.be.a("string").that.is.not.empty;
        });

        it(`instance.address is always defined after creation`, async () => {
            const sub1 = await pkc.createCommunity({ address: signers[0].address });
            const sub2 = await pkc.createCommunity({ name: "test.eth" });
            const sub3 = await pkc.createCommunity({ publicKey: signers[1].address });

            expect(sub1.address).to.be.a("string").that.is.not.empty;
            expect(sub2.address).to.be.a("string").that.is.not.empty;
            expect(sub3.address).to.be.a("string").that.is.not.empty;
        });
    });
});

describe.concurrent("Wire format migration — backward compat parsing", async () => {
    it(`parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails accepts old record with address`, () => {
        const result = parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(remeda.clone(validCommunityFixture) as CommunityIpfsType);
        // Old record with address should parse successfully
        expect(result).to.have.property("signature");
        // Address is preserved as a passthrough field
        expect((result as Record<string, unknown>).address).to.equal(signers[0].address);
    });

    it(`parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails accepts new record without address`, () => {
        const result = parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(remeda.clone(newFormatFixture) as CommunityIpfsType);
        expect(result).to.have.property("signature");
        expect((result as Record<string, unknown>).address).to.be.undefined;
    });

    it(`parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails accepts new record with name`, () => {
        const result = parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(
            remeda.clone(newFormatWithNameFixture) as CommunityIpfsType
        );
        expect(result).to.have.property("signature");
        expect(result.name).to.equal("test-sub.eth");
    });
});
