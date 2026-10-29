import { describe, it, expect, vi, afterEach } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import signers from "../../fixtures/signers.js";
import { addStringToIpfs, mockPKCNoDataPathWithOnlyKuboClient } from "../../../dist/node/test/test-util.js";
import { iterateOverPageCidsToFindAllCids } from "../../../dist/node/pages/util.js";
import { RpcCommunityPageParamSchema } from "../../../dist/node/clients/rpc-client/schema.js";

import type { BaseClientsManager } from "../../../dist/node/clients/base-client-manager.js";
import type { PageIpfs } from "../../../dist/node/pages/types.js";

// Issue #360 / PR #458 review: a reader allows each nextCid page twice the size of the page before it. With pages capped
// at 32 MiB a large sort has dozens of pages (~69 for 2 GiB), and an uncapped doubling breaks deep in the chain:
// - an RPC client's page request carries the allowance, and the server's `pageMaxSize: z.number().int()` rejects it
//   from page 33 (2^53 bytes, past Number.MAX_SAFE_INTEGER);
// - the community's own walk over its published pages passes it to kubo's cat as `length`, which kubo rejects from
//   page 43 (2^63 bytes overflows int64).
// The allowance stops growing at the largest page a community publishes, 32 MiB.

const MiB = 1024 * 1024;
const MAX_PAGE_ALLOWANCE = 32 * MiB;

const expectAllowancesToReachButNeverPassTheCeiling = (allowances: number[]) => {
    for (const allowance of allowances) expect(allowance).to.be.at.most(MAX_PAGE_ALLOWANCE);
    // Still doubles up to the ceiling, so every page a community publishes stays loadable
    expect(allowances[allowances.length - 1]).to.equal(MAX_PAGE_ALLOWANCE);
};

describe("a reader's page size allowance on a deep page chain (#360)", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("the community's walk over a 50-page sort on kubo finds every page", async () => {
        const pkc = await mockPKCNoDataPathWithOnlyKuboClient({});
        try {
            // A real chain on the test kubo, last page first so each page names the next
            const pageCids: string[] = [];
            let nextCid: string | undefined;
            for (let i = 49; i >= 0; i--) {
                const page: PageIpfs = { comments: [] };
                if (nextCid) page.nextCid = nextCid;
                nextCid = (await addStringToIpfs(JSON.stringify(page) + " ".repeat(i))).toString(); // padding keeps every cid distinct
                pageCids.unshift(nextCid);
            }
            const clientManager = pkc._clientsManager as unknown as BaseClientsManager;
            const fetchSpy = vi.spyOn(clientManager, "_fetchCidP2P");

            const found = await iterateOverPageCidsToFindAllCids({ pages: { pageCids: { new: pageCids[0] } }, clientManager });

            expect(found).to.deep.equal(pageCids);
            const allowances = fetchSpy.mock.calls.map(([, opts]) => opts.maxFileSizeBytes);
            expect(allowances).to.have.length(pageCids.length);
            expectAllowancesToReachButNeverPassTheCeiling(allowances);
        } finally {
            await pkc.destroy();
        }
    });

    it("an RPC client paging through a 60-page sort sends page params the RPC server accepts", async () => {
        const pkc = await mockPKCNoDataPathWithOnlyKuboClient({});
        try {
            const community = await pkc.createCommunity({ address: signers[0].address });
            const pageCids = await Promise.all(
                Array.from({ length: 60 }, async (_, i) =>
                    CID.createV0(await sha256.digest(new TextEncoder().encode(`page-${i}`))).toString()
                )
            );
            const allowances: number[] = [];
            const clientsManager = community.posts._clientsManager as unknown as {
                _fetchPageWithKuboOrHeliaP2P: (opts: { pageCid: string; pageMaxSize: number }) => Promise<PageIpfs>;
            };
            // Stands in for the RPC transport: the server validates the params with this schema before fetching
            vi.spyOn(clientsManager, "_fetchPageWithKuboOrHeliaP2P").mockImplementation(async ({ pageCid, pageMaxSize }) => {
                RpcCommunityPageParamSchema.parse({ cid: pageCid, type: "posts", pageMaxSize });
                allowances.push(pageMaxSize);
                const index = pageCids.indexOf(pageCid);
                const page: PageIpfs = { comments: [] };
                if (index < pageCids.length - 1) page.nextCid = pageCids[index + 1];
                return page;
            });

            for (const pageCid of pageCids) await community.posts._clientsManager.fetchPage({ pageCid });

            expect(allowances).to.have.length(pageCids.length);
            expectAllowancesToReachButNeverPassTheCeiling(allowances);
        } finally {
            await pkc.destroy();
        }
    });
});
