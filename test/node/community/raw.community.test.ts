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
    let community: LocalCommunity | RpcLocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = await createSubWithNoChallenge({}, pkc);
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it(`raw.localCommunity is defined before first IPNS update`, async () => {
        // After createSubWithNoChallenge (which calls .edit()), the community is in before-first-update state
        expect(community.raw.localCommunity).to.not.be.undefined;
        const record = community.raw.localCommunity as RpcInternalCommunityRecordBeforeFirstUpdateType;
        expect(record.localCommunity).to.not.be.undefined;
        expect(record.localCommunity.address).to.equal(community.address);
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
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        await community.stop();

        expect(community.raw.localCommunity).to.not.be.undefined;
        const record = community.raw.localCommunity as RpcInternalCommunityRecordAfterFirstUpdateType;
        // after-first-update shape: has community and runtimeFields
        expect(record.community).to.not.be.undefined;
        expect(record.community.updatedAt).to.be.a("number");
        expect(record.community.signature).to.not.be.undefined;
        expect(record.localCommunity).to.not.be.undefined;
        expect(record.localCommunity.address).to.equal(community.address);
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
    let community: LocalCommunity | RpcLocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = await createSubWithNoChallenge({}, pkc);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        await community.stop();
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it(`createCommunity with spread instance creates a new instance`, async () => {
        const community2 = (await pkc.createCommunity({ ...community })) as LocalCommunity | RpcLocalCommunity;
        expect(community2).to.not.equal(community);
        expect(community2.address).to.equal(community.address);
    });

    it(`createCommunity with JSON'd instance restores settings and signer`, async () => {
        const jsonified = JSON.parse(JSON.stringify(community)) as LocalCommunity | RpcLocalCommunity;
        const community2 = (await pkc.createCommunity(jsonified)) as LocalCommunity | RpcLocalCommunity;
        expect(community2).to.not.equal(community);
        expect(community2.address).to.equal(community.address);
        // For RPC subs, check that raw.localCommunity was used to restore settings
        if (community2.settings) {
            expect(community2.settings).to.deep.equal(community.settings);
        }
        if (community2.signer) {
            expect(community2.signer.publicKey).to.equal(community.signer!.publicKey);
            // LocalCommunity loads full signer from DB (including privateKey); only RPC subs should omit it
            if (!("_dbHandler" in community2)) {
                expect((community2.signer as any).privateKey).to.be.undefined;
            }
        }
    });

    it(`createCommunity with actual instance creates a new instance`, async () => {
        const community2 = (await pkc.createCommunity(community)) as LocalCommunity | RpcLocalCommunity;
        expect(community2).to.not.equal(community);
        expect(community2.address).to.equal(community.address);
    });
});
