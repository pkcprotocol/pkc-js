import { mockPlebbit, createSubWithNoChallenge, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import type { Plebbit } from "../../../dist/node/pkc/pkc.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalSubplebbit } from "../../../dist/node/community/rpc-local-community.js";
import type {
    RpcInternalSubplebbitRecordAfterFirstUpdateType,
    RpcInternalSubplebbitRecordBeforeFirstUpdateType
} from "../../../dist/node/community/types.js";

describe(`raw.localSubplebbit is populated`, async () => {
    let plebbit: Plebbit;
    let sub: LocalSubplebbit | RpcLocalSubplebbit;

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        sub = await createSubWithNoChallenge({}, plebbit);
    });

    afterAll(async () => {
        await sub.delete();
        await plebbit.destroy();
    });

    it(`raw.localSubplebbit is defined before first IPNS update`, async () => {
        // After createSubWithNoChallenge (which calls .edit()), the sub is in before-first-update state
        expect(sub.raw.localSubplebbit).to.not.be.undefined;
        const record = sub.raw.localSubplebbit as RpcInternalSubplebbitRecordBeforeFirstUpdateType;
        expect(record.localSubplebbit).to.not.be.undefined;
        expect(record.localSubplebbit.address).to.equal(sub.address);
        expect(record.localSubplebbit.settings).to.not.be.undefined;
        expect(record.localSubplebbit._usingDefaultChallenge).to.equal(false); // set to no challenge via edit
        expect(record.localSubplebbit.signer).to.not.be.undefined;
        expect(record.localSubplebbit.signer.publicKey).to.be.a("string").that.is.not.empty;
        // signer must NOT have privateKey
        expect((record.localSubplebbit.signer as any).privateKey).to.be.undefined;
        // no subplebbitIpfs key
        expect((record as any).subplebbitIpfs).to.be.undefined;
    });

    it(`raw.localSubplebbit is updated after first IPNS update`, async () => {
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        await sub.stop();

        expect(sub.raw.localSubplebbit).to.not.be.undefined;
        const record = sub.raw.localSubplebbit as RpcInternalSubplebbitRecordAfterFirstUpdateType;
        // after-first-update shape: has subplebbit and runtimeFields
        expect(record.subplebbit).to.not.be.undefined;
        expect(record.subplebbit.updatedAt).to.be.a("number");
        expect(record.subplebbit.signature).to.not.be.undefined;
        expect(record.localSubplebbit).to.not.be.undefined;
        expect(record.localSubplebbit.address).to.equal(sub.address);
        expect(record.localSubplebbit.settings).to.not.be.undefined;
        expect(record.localSubplebbit.signer.publicKey).to.be.a("string").that.is.not.empty;
        // signer must NOT have privateKey
        expect((record.localSubplebbit.signer as any).privateKey).to.be.undefined;
        expect(record.runtimeFields).to.not.be.undefined;
        expect(record.runtimeFields.updateCid).to.be.a("string").that.is.not.empty;
    });
});

describe(`createSubplebbit reconstructs from raw.localSubplebbit`, async () => {
    let plebbit: Plebbit;
    let sub: LocalSubplebbit | RpcLocalSubplebbit;

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        sub = await createSubWithNoChallenge({}, plebbit);
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        await sub.stop();
    });

    afterAll(async () => {
        await sub.delete();
        await plebbit.destroy();
    });

    it(`createSubplebbit with spread instance creates a new instance`, async () => {
        const sub2 = (await plebbit.createSubplebbit({ ...sub })) as LocalSubplebbit | RpcLocalSubplebbit;
        expect(sub2).to.not.equal(sub);
        expect(sub2.address).to.equal(sub.address);
    });

    it(`createSubplebbit with JSON'd instance restores settings and signer`, async () => {
        const jsonified = JSON.parse(JSON.stringify(sub)) as LocalSubplebbit | RpcLocalSubplebbit;
        const sub2 = (await plebbit.createSubplebbit(jsonified)) as LocalSubplebbit | RpcLocalSubplebbit;
        expect(sub2).to.not.equal(sub);
        expect(sub2.address).to.equal(sub.address);
        // For RPC subs, check that raw.localSubplebbit was used to restore settings
        if (sub2.settings) {
            expect(sub2.settings).to.deep.equal(sub.settings);
        }
        if (sub2.signer) {
            expect(sub2.signer.publicKey).to.equal(sub.signer!.publicKey);
            // LocalSubplebbit loads full signer from DB (including privateKey); only RPC subs should omit it
            if (!("_dbHandler" in sub2)) {
                expect((sub2.signer as any).privateKey).to.be.undefined;
            }
        }
    });

    it(`createSubplebbit with actual instance creates a new instance`, async () => {
        const sub2 = (await plebbit.createSubplebbit(sub)) as LocalSubplebbit | RpcLocalSubplebbit;
        expect(sub2).to.not.equal(sub);
        expect(sub2.address).to.equal(sub.address);
    });
});
