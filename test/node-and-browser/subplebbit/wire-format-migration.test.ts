import { beforeAll, afterAll } from "vitest";
import signers from "../../fixtures/signers.js";
import { mockRemotePlebbit, describeSkipIfRpc } from "../../../dist/node/test/test-util.js";
import * as remeda from "remeda";
import validSubplebbitFixture from "../../fixtures/signatures/subplebbit/valid_subplebbit_ipfs.json" with { type: "json" };
import newFormatFixture from "../../fixtures/signatures/subplebbit/valid_subplebbit_ipfs_new_format.json" with { type: "json" };
import newFormatWithNameFixture from "../../fixtures/signatures/subplebbit/valid_subplebbit_ipfs_new_format_with_name.json" with { type: "json" };
import { parseSubplebbitIpfsSchemaPassthroughWithPlebbitErrorIfItFails } from "../../../dist/node/schema/schema-util.js";
import {
    omitRuntimeSubplebbitFields,
    cleanWireSubplebbit,
    getSubplebbitNameFromWire,
    buildRuntimeSubplebbit
} from "../../../dist/node/subplebbit/subplebbit-wire.js";

import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type { SubplebbitIpfsType } from "../../../dist/node/subplebbit/types.js";

describeSkipIfRpc.concurrent("Wire format migration — runtime field computation", async () => {
    let plebbit: PlebbitType;

    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`address is computed as name || publicKey when loading new-format record with name`, async () => {
        const sub = await plebbit.createSubplebbit({ address: signers[0].address });
        sub.initSubplebbitIpfsPropsNoMerge(remeda.clone(newFormatWithNameFixture) as SubplebbitIpfsType);
        expect(sub.name).to.equal("test-sub.eth");
        expect(sub.address).to.equal("test-sub.eth"); // name takes priority
    });

    it(`address falls back to publicKey when no name is present`, async () => {
        const sub = await plebbit.createSubplebbit({ address: signers[0].address });
        sub.initSubplebbitIpfsPropsNoMerge(remeda.clone(newFormatFixture) as SubplebbitIpfsType);
        // No name, so address should be the IPNS key derived from signature.publicKey
        expect(sub.address).to.equal(signers[0].address);
    });

    it(`address is computed correctly when loading old-format record with IPNS address`, async () => {
        const sub = await plebbit.createSubplebbit({ address: signers[0].address });
        // Old fixture has address = signers[0].address (IPNS key)
        sub.initSubplebbitIpfsPropsNoMerge(remeda.clone(validSubplebbitFixture) as SubplebbitIpfsType);
        expect(sub.address).to.equal(signers[0].address);
    });

    it(`publicKey is derived from signature.publicKey`, async () => {
        const sub = await plebbit.createSubplebbit({ address: signers[0].address });
        sub.initSubplebbitIpfsPropsNoMerge(remeda.clone(newFormatFixture) as SubplebbitIpfsType);
        expect(sub.publicKey).to.equal(signers[0].address);
    });

    it(`address and publicKey appear in JSON.stringify output`, async () => {
        const sub = await plebbit.createSubplebbit({ address: signers[0].address });
        sub.initSubplebbitIpfsPropsNoMerge(remeda.clone(newFormatFixture) as SubplebbitIpfsType);
        const json = JSON.parse(JSON.stringify(sub));
        expect(json.address).to.be.a("string");
        expect(json.publicKey).to.be.a("string");
    });
});

describeSkipIfRpc.concurrent("Wire format migration — helper functions", async () => {
    it(`buildRuntimeSubplebbit computes address from name`, () => {
        const result = buildRuntimeSubplebbit({
            subplebbitRecord: { name: "memes.eth" } as Record<string, unknown>,
            signaturePublicKey: signers[0].publicKey
        });
        expect(result.address).to.equal("memes.eth");
        expect(result.name).to.equal("memes.eth");
        expect(result.publicKey).to.equal(signers[0].address);
    });

    it(`buildRuntimeSubplebbit falls back to publicKey when no name`, () => {
        const result = buildRuntimeSubplebbit({
            subplebbitRecord: {} as Record<string, unknown>,
            signaturePublicKey: signers[0].publicKey
        });
        expect(result.address).to.equal(signers[0].address);
        expect(result.name).to.be.undefined;
        expect(result.publicKey).to.equal(signers[0].address);
    });

    it(`getSubplebbitNameFromWire returns name from new-format record`, () => {
        expect(getSubplebbitNameFromWire({ name: "memes.eth" })).to.equal("memes.eth");
    });

    it(`getSubplebbitNameFromWire falls back to address if it's a domain (old format)`, () => {
        expect(getSubplebbitNameFromWire({ address: "memes.eth" })).to.equal("memes.eth");
    });

    it(`getSubplebbitNameFromWire returns undefined for IPNS address (old format)`, () => {
        expect(getSubplebbitNameFromWire({ address: signers[0].address })).to.be.undefined;
    });

    it(`omitRuntimeSubplebbitFields strips address, publicKey, shortAddress, nameResolved`, () => {
        const input = {
            name: "test.eth",
            address: "test.eth",
            publicKey: "abc",
            shortAddress: "te..th",
            nameResolved: true,
            encryption: { type: "ed25519-aes-gcm", publicKey: "xyz" }
        };
        const result = omitRuntimeSubplebbitFields(input);
        expect(result).to.not.have.property("address");
        expect(result).to.not.have.property("publicKey");
        expect(result).to.not.have.property("shortAddress");
        expect(result).to.not.have.property("nameResolved");
        expect(result).to.have.property("name", "test.eth");
        expect(result).to.have.property("encryption");
    });

    it(`cleanWireSubplebbit returns undefined for empty input`, () => {
        expect(cleanWireSubplebbit(undefined)).to.be.undefined;
    });
});

describeSkipIfRpc.concurrent("Wire format migration — flexible createSubplebbit input", async () => {
    let plebbit: PlebbitType;

    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`createSubplebbit({ address }) still works (backward compat)`, async () => {
        const sub = await plebbit.createSubplebbit({ address: signers[0].address });
        expect(sub.address).to.equal(signers[0].address);
        expect(sub.address).to.be.a("string").that.is.not.empty;
    });

    it(`createSubplebbit({ name }) creates instance with address = name`, async () => {
        const sub = await plebbit.createSubplebbit({ name: "memes.eth" });
        expect(sub.address).to.equal("memes.eth");
        expect(sub.name).to.equal("memes.eth");
        expect(sub.address).to.be.a("string").that.is.not.empty;
    });

    it(`createSubplebbit({ publicKey }) creates instance with address = publicKey`, async () => {
        const sub = await plebbit.createSubplebbit({ publicKey: signers[0].address });
        expect(sub.address).to.equal(signers[0].address);
        expect(sub.address).to.be.a("string").that.is.not.empty;
    });

    it(`createSubplebbit({ name, publicKey }) creates instance with address = name (name takes priority)`, async () => {
        const sub = await plebbit.createSubplebbit({ name: "memes.eth", publicKey: signers[0].address });
        expect(sub.address).to.equal("memes.eth");
        expect(sub.name).to.equal("memes.eth");
        expect(sub.address).to.be.a("string").that.is.not.empty;
    });

    it(`createSubplebbit({ name, publicKey, address }) works with all three`, async () => {
        const sub = await plebbit.createSubplebbit({ name: "memes.eth", publicKey: signers[0].address, address: "memes.eth" });
        expect(sub.address).to.equal("memes.eth");
        expect(sub.address).to.be.a("string").that.is.not.empty;
    });

    it(`instance.address is always defined after creation`, async () => {
        const sub1 = await plebbit.createSubplebbit({ address: signers[0].address });
        const sub2 = await plebbit.createSubplebbit({ name: "test.eth" });
        const sub3 = await plebbit.createSubplebbit({ publicKey: signers[1].address });

        expect(sub1.address).to.be.a("string").that.is.not.empty;
        expect(sub2.address).to.be.a("string").that.is.not.empty;
        expect(sub3.address).to.be.a("string").that.is.not.empty;
    });
});

describeSkipIfRpc.concurrent("Wire format migration — backward compat parsing", async () => {
    it(`parseSubplebbitIpfsSchemaPassthroughWithPlebbitErrorIfItFails accepts old record with address`, () => {
        const result = parseSubplebbitIpfsSchemaPassthroughWithPlebbitErrorIfItFails(
            remeda.clone(validSubplebbitFixture) as SubplebbitIpfsType
        );
        // Old record with address should parse successfully
        expect(result).to.have.property("signature");
        // Address is preserved as a passthrough field
        expect((result as Record<string, unknown>).address).to.equal(signers[0].address);
    });

    it(`parseSubplebbitIpfsSchemaPassthroughWithPlebbitErrorIfItFails accepts new record without address`, () => {
        const result = parseSubplebbitIpfsSchemaPassthroughWithPlebbitErrorIfItFails(remeda.clone(newFormatFixture) as SubplebbitIpfsType);
        expect(result).to.have.property("signature");
        expect((result as Record<string, unknown>).address).to.be.undefined;
    });

    it(`parseSubplebbitIpfsSchemaPassthroughWithPlebbitErrorIfItFails accepts new record with name`, () => {
        const result = parseSubplebbitIpfsSchemaPassthroughWithPlebbitErrorIfItFails(
            remeda.clone(newFormatWithNameFixture) as SubplebbitIpfsType
        );
        expect(result).to.have.property("signature");
        expect(result.name).to.equal("test-sub.eth");
    });
});
