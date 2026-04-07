import { mockPKC, createSubWithNoChallenge, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type {
    RpcInternalCommunityRecordAfterFirstUpdateType,
    RpcInternalCommunityRecordBeforeFirstUpdateType
} from "../../../dist/node/community/types.js";

describe(`raw.localCommunity is populated`, async () => {
    let pkc: PKC;
    let sub: LocalCommunity | RpcLocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        sub = await createSubWithNoChallenge({}, pkc);
    });

    afterAll(async () => {
        await sub.delete();
        await pkc.destroy();
    });

    it(`raw.localCommunity is defined before first IPNS update`, async () => {
        // After createSubWithNoChallenge (which calls .edit()), the sub is in before-first-update state
        expect(sub.raw.localCommunity).to.not.be.undefined;
        const record = sub.raw.localCommunity as RpcInternalCommunityRecordBeforeFirstUpdateType;
        expect(record.localCommunity).to.not.be.undefined;
        expect(record.localCommunity.address).to.equal(sub.address);
        expect(record.localCommunity.settings).to.not.be.undefined;
        expect(record.localCommunity._usingDefaultChallenge).to.equal(false); // set to no challenge via edit
        expect(record.localCommunity.signer).to.not.be.undefined;
        expect(record.localCommunity.signer.publicKey).to.be.a("string").that.is.not.empty;
        // signer must NOT have privateKey
        expect((record.localCommunity.signer as any).privateKey).to.be.undefined;
        // no communityIpfs key
        expect((record as any).communityIpfs).to.be.undefined;
    });

    it(`raw.localCommunity is updated after first IPNS update`, async () => {
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        await sub.stop();

        expect(sub.raw.localCommunity).to.not.be.undefined;
        const record = sub.raw.localCommunity as RpcInternalCommunityRecordAfterFirstUpdateType;
        // after-first-update shape: has community and runtimeFields
        expect(record.community).to.not.be.undefined;
        expect(record.community.updatedAt).to.be.a("number");
        expect(record.community.signature).to.not.be.undefined;
        expect(record.localCommunity).to.not.be.undefined;
        expect(record.localCommunity.address).to.equal(sub.address);
        expect(record.localCommunity.settings).to.not.be.undefined;
        expect(record.localCommunity.signer.publicKey).to.be.a("string").that.is.not.empty;
        // signer must NOT have privateKey
        expect((record.localCommunity.signer as any).privateKey).to.be.undefined;
        expect(record.runtimeFields).to.not.be.undefined;
        expect(record.runtimeFields.updateCid).to.be.a("string").that.is.not.empty;
    });
});

describe(`createCommunity reconstructs from raw.localCommunity`, async () => {
    let pkc: PKC;
    let sub: LocalCommunity | RpcLocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        sub = await createSubWithNoChallenge({}, pkc);
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        await sub.stop();
    });

    afterAll(async () => {
        await sub.delete();
        await pkc.destroy();
    });

    it(`createCommunity with spread instance creates a new instance`, async () => {
        const sub2 = (await pkc.createCommunity({ ...sub })) as LocalCommunity | RpcLocalCommunity;
        expect(sub2).to.not.equal(sub);
        expect(sub2.address).to.equal(sub.address);
    });

    it(`createCommunity with JSON'd instance restores settings and signer`, async () => {
        const jsonified = JSON.parse(JSON.stringify(sub)) as LocalCommunity | RpcLocalCommunity;
        const sub2 = (await pkc.createCommunity(jsonified)) as LocalCommunity | RpcLocalCommunity;
        expect(sub2).to.not.equal(sub);
        expect(sub2.address).to.equal(sub.address);
        // For RPC subs, check that raw.localCommunity was used to restore settings
        if (sub2.settings) {
            expect(sub2.settings).to.deep.equal(sub.settings);
        }
        if (sub2.signer) {
            expect(sub2.signer.publicKey).to.equal(sub.signer!.publicKey);
            // LocalCommunity loads full signer from DB (including privateKey); only RPC subs should omit it
            if (!("_dbHandler" in sub2)) {
                expect((sub2.signer as any).privateKey).to.be.undefined;
            }
        }
    });

    it(`createCommunity with actual instance creates a new instance`, async () => {
        const sub2 = (await pkc.createCommunity(sub)) as LocalCommunity | RpcLocalCommunity;
        expect(sub2).to.not.equal(sub);
        expect(sub2.address).to.equal(sub.address);
    });
});
