// CommunityList author.nameResolved (docs/protocol/community-lists.md, issue #342).
//
// A list's author identity derives from signature.publicKey; a domain in author.name is only a
// claim. update() keeps driving the background resolution until the verdict is DEFINITIVE
// (resolves to the signer = true; resolves to a different key = false; no resolver for the TLD =
// false), emits `update` again with author.nameResolved set, then stops itself. Transient resolver
// failures retry until the caller's own stop(). The one-shot getCommunityList never waits for the
// verdict; it only warms the pkc-wide cache.
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import signers from "../../fixtures/signers.js";
import {
    createMockNameResolver,
    getAvailablePKCConfigsToTestAgainst,
    mockRemotePKC,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { CommunityList } from "../../../dist/node/community-list/community-list.js";
import type { SignerWithPublicKeyAddress } from "../../../dist/node/signer/index.js";
import { addCommunityListRecordToIpfs, buildSignedCommunityListRecord } from "./communitylist-test-util.js";

// The default mock resolver maps plebbit.bso -> signers[3]
const DOMAIN = "plebbit.bso";
const DOMAIN_SIGNER = signers[3];

const waitUntilStoppedByItself = (list: CommunityList) =>
    resolveWhenConditionIsTrue({ toUpdate: list, predicate: async () => list.state === "stopped", eventName: "statechange" });

const publishListWithAuthorName = async (pkc: PKC, signer?: SignerWithPublicKeyAddress) => {
    const finalSigner = signer ?? (await pkc.createSigner());
    const { record } = await buildSignedCommunityListRecord({ pkc, signer: finalSigner, author: { name: DOMAIN } });
    const cid = await addCommunityListRecordToIpfs(record);
    return { cid, record, signer: finalSigner };
};

getAvailablePKCConfigsToTestAgainst().map((config) =>
    describe(`communitylist author.nameResolved - ${config.name}`, () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });
        afterAll(async () => {
            await pkc.destroy();
        });

        it("resolves to true when the author domain points at the signer, then the instance stops itself", async () => {
            const domainSigner = await pkc.createSigner({ privateKey: DOMAIN_SIGNER.privateKey, type: "ed25519" });
            const { cid } = await publishListWithAuthorName(pkc, domainSigner);
            const list = await pkc.createCommunityList({ cid });
            let updateEvents = 0;
            list.on("update", () => updateEvents++);
            await list.update();
            await resolveWhenConditionIsTrue({ toUpdate: list, predicate: async () => list.author?.nameResolved === true });
            expect(list.author?.name).to.equal(DOMAIN);
            expect(list.author?.address).to.equal(DOMAIN); // address = name || publicKey, never overridden
            expect(updateEvents).to.equal(2); // one for the record, one for the verdict
            await waitUntilStoppedByItself(list);
        });

        it("resolves to false when the author domain points at a different key (impersonation), then stops itself", async () => {
            // signed by a fresh key the domain does not point at
            const { cid } = await publishListWithAuthorName(pkc);
            const list = await pkc.createCommunityList({ cid });
            await list.update();
            await resolveWhenConditionIsTrue({ toUpdate: list, predicate: async () => list.author?.nameResolved === false });
            expect(list.author?.name).to.equal(DOMAIN);
            await waitUntilStoppedByItself(list);
        });

        it("the wire record never carries nameResolved or any other runtime author field", async () => {
            const domainSigner = await pkc.createSigner({ privateKey: DOMAIN_SIGNER.privateKey, type: "ed25519" });
            const { cid } = await publishListWithAuthorName(pkc, domainSigner);
            const list = await pkc.createCommunityList({ cid });
            await list.update();
            await resolveWhenConditionIsTrue({ toUpdate: list, predicate: async () => typeof list.author?.nameResolved === "boolean" });
            for (const runtimeField of ["nameResolved", "address", "publicKey", "shortAddress", "community"])
                expect(list.raw.communityList?.author).to.not.have.property(runtimeField);
            await waitUntilStoppedByItself(list);
        });

        it("getCommunityList does not wait for the verdict, but warms the cache for evented instances", async () => {
            const domainSigner = await pkc.createSigner({ privateKey: DOMAIN_SIGNER.privateKey, type: "ed25519" });
            const { cid } = await publishListWithAuthorName(pkc, domainSigner);
            const oneShot = await pkc.getCommunityList({ cid });
            // the one-shot instance is stopped on return and never updated afterwards
            expect(oneShot.state).to.equal("stopped");

            // the background kick lands the verdict in the pkc-wide cache, so an evented instance settles
            const evented = await pkc.createCommunityList({ cid });
            await evented.update();
            await resolveWhenConditionIsTrue({ toUpdate: evented, predicate: async () => evented.author?.nameResolved === true });
            await waitUntilStoppedByItself(evented);
        });
    })
);

// Clients of RPC delegate name resolution to the RPC server, which has its own nameResolvers:
// client-side resolver mocks (canResolve, throwing resolvers, resolveAuthorNames toggles) cannot
// reach it, so these behaviors are only testable against a locally-constructed PKC instance
describeSkipIfRpc("communitylist author.nameResolved - custom resolvers", () => {
    it("resolves to false (definitive) when no resolver handles the author TLD, then stops itself", async () => {
        const pkc = await mockRemotePKC({
            mockResolve: false,
            pkcOptions: { nameResolvers: [createMockNameResolver({ canResolve: () => false })] }
        });
        try {
            const { cid } = await publishListWithAuthorName(pkc);
            const list = await pkc.createCommunityList({ cid });
            await list.update();
            await resolveWhenConditionIsTrue({ toUpdate: list, predicate: async () => list.author?.nameResolved === false });
            await waitUntilStoppedByItself(list);
        } finally {
            await pkc.destroy();
        }
    });

    it("keeps retrying on transient resolver failures: nameResolved stays undefined and the instance keeps updating", async () => {
        let resolveCalls = 0;
        const pkc = await mockRemotePKC({
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [
                    createMockNameResolver({
                        resolveFunction: async () => {
                            resolveCalls++;
                            throw Error("mock transient resolver outage");
                        }
                    })
                ]
            }
        });
        try {
            const { cid } = await publishListWithAuthorName(pkc);
            const list = await pkc.createCommunityList({ cid });
            await list.update();
            await resolveWhenConditionIsTrue({ toUpdate: list, predicate: async () => typeof list.title === "string" });
            const started = Date.now();
            while (resolveCalls < 1 && Date.now() - started < 10_000) await new Promise((resolve) => setTimeout(resolve, 50));
            // give the failed attempt time to settle
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(resolveCalls).to.be.greaterThanOrEqual(1);
            expect(list.author?.nameResolved).to.be.undefined;
            expect(list.state).to.equal("updating"); // no definitive verdict: never stops on its own
            await list.stop();
        } finally {
            await pkc.destroy();
        }
    });

    it("stops itself right after the first update when resolveAuthorNames is off", async () => {
        let resolveCalls = 0;
        const pkc = await mockRemotePKC({
            mockResolve: false,
            pkcOptions: {
                resolveAuthorNames: false,
                nameResolvers: [
                    createMockNameResolver({
                        resolveFunction: async () => {
                            resolveCalls++;
                            return undefined;
                        }
                    })
                ]
            }
        });
        try {
            const { cid } = await publishListWithAuthorName(pkc);
            const list = await pkc.createCommunityList({ cid });
            await list.update();
            await resolveWhenConditionIsTrue({ toUpdate: list, predicate: async () => typeof list.title === "string" });
            await waitUntilStoppedByItself(list);
            expect(list.author?.nameResolved).to.be.undefined;
            expect(resolveCalls).to.equal(0);
        } finally {
            await pkc.destroy();
        }
    });
});
