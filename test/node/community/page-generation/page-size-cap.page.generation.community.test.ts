import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { it } from "vitest";
import { constants as bufferConstants } from "node:buffer";
import { PageGenerator } from "../../../../dist/node/runtime/node/community/page-generator.js";

import type { PageIpfs } from "../../../../dist/node/pages/types.js";

// Issue #360: page n of a sort is capped at 2^(n-1) MiB with no upper bound, and each page is built as one string.
// A sort holding more than ~1.5 GiB of entries needs a page whose string exceeds V8's limit, and generation throws
// `RangeError: Invalid string length`. Every entry here is the same 64 KiB string, so the board is ~1.6 GiB of
// entries while the test holds only one page's join in memory at a time.

type PageComment = PageIpfs["comments"][number];

const ENTRY_BYTES = 64 * 1024;
const ENTRY_COUNT = 26_000; // ~1.6 GiB of entries: past the ~1.5 GiB where the uncapped page 11 crosses the string limit
const ENTRY_JSON = JSON.stringify("x".repeat(ENTRY_BYTES - 2));
const FAKE_CID = "QmXsYKgNH7XoZXdLko5uDvtWSRNE2AXuQ4u8KxVpCacrZx";

// The private surface of PageGenerator this test drives, the same two calls generation makes for a non-preloaded sort
interface PageGeneratorInternals {
    _chunkComments(opts: { comments: PageComment[]; firstPageSizeBytes: number; sizeOf: (entry: PageComment) => number }): PageComment[][];
    _addChunksToIpfs(opts: {
        chunks: PageComment[][];
        sortName: string;
        serialized: { sizeOf: (entry: PageComment) => number; stringsOf: (entries: PageComment[]) => string[] };
        embedFirst: boolean;
        source: { resolve: (entries: PageComment[]) => PageComment[] };
        budget: { acquire: (bytes: number) => Promise<() => void> };
    }): Promise<Record<string, { cids: string[] }>>;
}

// Generation is in-process page building against a stubbed kubo client: there is no RPC server in the path
describeSkipIfRpc("page-generator page size cap (#360)", () => {
    it("generates every page of a sort holding more than 1.5 GiB of entries", async () => {
        const addedPageSizes: number[] = [];
        const pageGenerator = new PageGenerator({
            address: "page-size-cap-test",
            _clientsManager: {
                getDefaultKuboRpcClient: () => ({
                    _client: {
                        add: async (content: string) => {
                            addedPageSizes.push(content.length); // ASCII only, so length is the byte size
                            return { path: FAKE_CID, cid: FAKE_CID, size: content.length };
                        },
                        routing: { provide: async function* () {} }
                    }
                })
            }
        } as unknown as ConstructorParameters<typeof PageGenerator>[0]);
        const internals = pageGenerator as unknown as PageGeneratorInternals;

        const comments = Array.from({ length: ENTRY_COUNT }, () => ({}) as PageComment);
        const sizeOf = () => ENTRY_BYTES;
        const chunks = internals._chunkComments({ comments, firstPageSizeBytes: 1024 * 1024, sizeOf });

        const res = await internals._addChunksToIpfs({
            chunks,
            sortName: "new",
            serialized: { sizeOf, stringsOf: (entries) => entries.map(() => ENTRY_JSON) },
            embedFirst: false,
            source: { resolve: (entries) => entries },
            budget: { acquire: async () => () => {} }
        });

        expect(res.new.cids).to.have.length(chunks.length);
        expect(addedPageSizes).to.have.length(chunks.length);
        for (const size of addedPageSizes) expect(size).to.be.at.most(bufferConstants.MAX_STRING_LENGTH);
    });
});
