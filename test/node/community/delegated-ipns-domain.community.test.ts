import { beforeAll, afterAll, it, expect } from "vitest";
import {
    createDelegatedCommunityIpns,
    createMockNameResolver,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { getPKCAddressFromPublicKeySync } from "../../../dist/node/signer/util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";

// A delegated community whose user-facing address is a DOMAIN (e.g. .bso) that resolves to the anchor
// IPNS name, then anchor -> minter -> /ipfs/cid. Exercises the domain + delegation interaction:
// _findErrorInCommunityRecord skips the "content signer == terminal" check for domain addresses, so
// verification of a delegated record must still succeed end-to-end. See docs/protocol/delegated-ipns.md.
//
// Node + non-RPC only: the name resolver is mocked on the client, which is impossible over an RPC
// client (resolution happens server-side). The domain/delegation interaction is mechanism-independent,
// so covering it once over the P2P (kubo) path is sufficient.
describeSkipIfRpc("Delegated IPNS loading with a domain address", () => {
    const domain = "delegated-domain-test.bso";
    let pkc: PKC;
    let anchorName: string;
    let terminalName: string;

    beforeAll(async () => {
        // The record must declare the domain in its `name` field: a domain load matches the record's
        // name (not merely its signature key, which is the minter). See community-client-manager.ts
        // _findErrorInCommunityRecord and docs/protocol/delegated-ipns.md.
        ({ anchorName, terminalName } = await createDelegatedCommunityIpns({ name: domain }));
        pkc = await mockPKCNoDataPathWithOnlyKuboClient({
            mockResolve: false,
            pkcOptions: {
                httpRoutersOptions: [],
                // resolve the community domain to the ANCHOR's public key (== anchor IPNS name)
                nameResolvers: [createMockNameResolver({ records: { [domain]: anchorName } })]
            }
        });
    });
    afterAll(async () => {
        if (pkc) await pkc.destroy();
    });

    it("loads a delegated community whose address is a domain resolving to the anchor", async () => {
        const community = (await pkc.createCommunity({ address: domain })) as RemoteCommunity;
        const updatePromise = new Promise<void>((resolve) => community.once("update", () => resolve()));
        await community.update();
        await updatePromise;
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        try {
            expect(community.updatedAt).to.be.a("number");
            // identity stays the DOMAIN (immutable address); the domain resolves to the anchor and the
            // content is signed by the minter (terminal) key.
            expect(community.address).to.equal(domain);
            expect(community.name).to.equal(domain);
            // the domain resolved to the anchor public key, and the chain is anchor -> minter
            expect(community.publicKey).to.equal(anchorName);
            expect(community.ipnsHops).to.deep.equal([anchorName, terminalName]);
            const recordSignatureAddress = getPKCAddressFromPublicKeySync(community.raw.communityIpfs!.signature.publicKey);
            expect(recordSignatureAddress).to.equal(terminalName);
            expect(recordSignatureAddress).to.not.equal(anchorName);
        } finally {
            await community.stop();
        }
    });
});
