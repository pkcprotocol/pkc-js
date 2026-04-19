import { beforeAll, afterAll, beforeEach, expect } from "vitest";
import { addStringToIpfs, getAvailablePKCConfigsToTestAgainst, isPKCFetchingUsingGateways } from "../../../dist/node/test/test-util.js";
import signers from "../../fixtures/signers.js";
import { sha256 } from "js-sha256";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { PageIpfs } from "../../../dist/node/pages/types.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

import validPageFixture from "../../fixtures/valid_page.json" with { type: "json" };

const communityAddress = signers[0].address;

// Helper to create a mock page with specific size
async function createMockPageOfSize(baseSize: number, nextCid: string | null = null): Promise<PageIpfs> {
    // Start with the valid page fixture
    const page: PageIpfs = JSON.parse(JSON.stringify(validPageFixture));

    // Set the nextCid if provided
    if (nextCid) page.nextCid = nextCid;
    else delete page.nextCid;

    // Calculate current size
    const currentSize = new TextEncoder().encode(JSON.stringify(page)).length;

    // If current size is already too large, throw error
    if (currentSize > baseSize) {
        throw new Error(`Initial page size (${currentSize} bytes) already exceeds target size (${baseSize} bytes).`);
    }

    // If we need to increase size, duplicate comments
    if (currentSize < baseSize) {
        // Create a duplicate comment that we'll reuse (without modifying its content)
        const commentCopy = JSON.parse(JSON.stringify(page.comments[0]));

        // Calculate the size of a single comment plus the JSON comma and brackets overhead
        const singleCommentSize =
            new TextEncoder().encode(JSON.stringify([commentCopy])).length - new TextEncoder().encode(JSON.stringify([])).length;

        // Calculate how many comments we need to add, being more conservative
        const bytesNeeded = baseSize - currentSize;
        // Use a larger buffer to ensure we don't exceed the limit (wire format size may vary)
        const safetyBuffer = singleCommentSize * 2;
        const commentsToAdd = Math.floor((bytesNeeded - safetyBuffer) / singleCommentSize);

        // Add the calculated number of comments at once using Array.fill
        page.comments.push(
            ...Array(commentsToAdd)
                .fill(null)
                .map(() => JSON.parse(JSON.stringify(commentCopy)))
        );

        // Final verification
        const finalSize = new TextEncoder().encode(JSON.stringify(page)).length;
        if (finalSize > baseSize) {
            throw new Error(`Generated page exceeds target size: ${finalSize} > ${baseSize} bytes`);
        }

        // We won't be able to hit the exact size without modifying content
        // So we'll accept being under the target size by a small margin
        const underSizeMargin = baseSize - finalSize;
        if (underSizeMargin > singleCommentSize * 4) {
            throw new Error(`Failed to reach close to target size: ${finalSize} < ${baseSize} bytes (gap: ${underSizeMargin} bytes)`);
        }
    }

    return page;
}

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`Page size loading tests - ${config.name}`, async () => {
        let pkc: PKC;
        let mockCommunity: RemoteCommunity;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        beforeEach(async () => {
            // Create a fresh mock community for each test
            mockCommunity = await pkc.createCommunity({
                address: communityAddress
            });
        });

        it("should correctly track page size expectations when loading pages with nextCid", async () => {
            // Create a chain of mock pages with increasing sizes
            const firstPageSize = 1024 * 1024; // 1MB
            const secondPageSize = 2 * 1024 * 1024; // 2MB
            const thirdPageSize = 4 * 1024 * 1024; // 4MB

            // Create pages in reverse order (third, second, first) since we need the CIDs
            const thirdPage = await createMockPageOfSize(thirdPageSize);
            const thirdPageCid = await addStringToIpfs(JSON.stringify(thirdPage));

            const secondPage = await createMockPageOfSize(secondPageSize, thirdPageCid);
            const secondPageCid = await addStringToIpfs(JSON.stringify(secondPage));

            const firstPage = await createMockPageOfSize(firstPageSize, secondPageCid);
            const firstPageCid = await addStringToIpfs(JSON.stringify(firstPage));

            // Set up the community's posts to point to our first page
            mockCommunity.posts.pageCids = { ...mockCommunity.posts.pageCids, hot: firstPageCid };

            // Load the first page
            const loadedFirstPage = await mockCommunity.posts.getPage({ cid: firstPageCid }); // just to set the expectation for second page

            // Verify the size expectation for the second page is set correctly
            expect(mockCommunity._pkc._memCaches.pagesMaxSize.get(sha256(mockCommunity.address + secondPageCid))).to.equal(secondPageSize);

            // Load the second page
            const loadedSecondPage = await mockCommunity.posts.getPage({ cid: secondPageCid });

            // Verify the size expectation for the third page is set correctly
            expect(mockCommunity._pkc._memCaches.pagesMaxSize.get(sha256(mockCommunity.address + thirdPageCid))).to.equal(thirdPageSize);

            // Load the third page
            const loadedThirdPage = await mockCommunity.posts.getPage({ cid: thirdPageCid });

            // Verify the third page has no nextCid
            expect(loadedThirdPage.nextCid).to.be.undefined;
        });

        it("should throw an error when a page exceeds its expected size limit", async () => {
            // Create a chain of pages to establish size expectations
            const firstPageSize = 1024 * 1024; // 1MB
            const secondPageSize = 2 * 1024 * 1024; // 2MB

            // Create a normal first page
            const firstPage = await createMockPageOfSize(firstPageSize);
            const firstPageCid = await addStringToIpfs(JSON.stringify(firstPage));

            // Create an oversized second page (3MB instead of expected 2MB)
            const oversizedSecondPage = await createMockPageOfSize(3 * 1024 * 1024);
            const oversizedSecondPageCid = await addStringToIpfs(JSON.stringify(oversizedSecondPage));

            // Update the first page to point to the oversized second page
            firstPage.nextCid = oversizedSecondPageCid;
            const updatedFirstPageCid = await addStringToIpfs(JSON.stringify(firstPage));

            // Set up the community's posts to point to our first page
            mockCommunity.posts.pageCids = { ...mockCommunity.posts.pageCids, hot: updatedFirstPageCid };

            // Load the first page to establish size expectations
            await mockCommunity.posts.getPage({ cid: updatedFirstPageCid });

            // Verify the size expectation for the second page is set correctly

            expect(mockCommunity._pkc._memCaches.pagesMaxSize.get(sha256(mockCommunity.address + oversizedSecondPageCid))).to.equal(
                secondPageSize
            );

            // Attempt to load the oversized second page - should throw an error
            try {
                await mockCommunity.posts.getPage({ cid: oversizedSecondPageCid });
                expect.fail("Should have thrown an error for oversized page");
            } catch (e) {
                const error = e as PKCError;
                if (isPKCFetchingUsingGateways(pkc)) {
                    expect(error.code).to.equal("ERR_FAILED_TO_FETCH_PAGE_IPFS_FROM_GATEWAYS");
                    expect((error.details.gatewayToError as Record<string, PKCError>)["http://localhost:18080"].code).to.equal(
                        "ERR_OVER_DOWNLOAD_LIMIT"
                    );
                } else {
                    // fetching with kubo/helia
                    expect(error.code).to.equal("ERR_OVER_DOWNLOAD_LIMIT");
                }
            }
        });

        it("should throw an error when a first page exceeds the default 1MB limit", async () => {
            // Create an oversized first page (2MB instead of default 1MB)
            const oversizedFirstPage = await createMockPageOfSize(2 * 1024 * 1024);
            const oversizedFirstPageCid = await addStringToIpfs(JSON.stringify(oversizedFirstPage));

            // Set up the community's posts to point to our oversized first page
            mockCommunity.posts.pageCids = { ...mockCommunity.posts.pageCids, hot: oversizedFirstPageCid };

            // Attempt to load the oversized first page - should throw an error
            try {
                await mockCommunity.posts.getPage({ cid: oversizedFirstPageCid });
                expect.fail("Should have thrown an error for oversized first page");
            } catch (e) {
                const error = e as PKCError;
                if (isPKCFetchingUsingGateways(pkc)) {
                    expect(error.code).to.equal("ERR_FAILED_TO_FETCH_PAGE_IPFS_FROM_GATEWAYS");
                    expect((error.details.gatewayToError as Record<string, PKCError>)["http://localhost:18080"].code).to.equal(
                        "ERR_OVER_DOWNLOAD_LIMIT"
                    );
                } else {
                    // fetching with kubo/helia
                    expect(error.code).to.equal("ERR_OVER_DOWNLOAD_LIMIT");
                }
            }
        });

        it("should throw when fetching a page CID not in pageCids with no cached max size", async () => {
            // When pageCids is non-empty and the requested CID is not among them,
            // and there's no cached pageMaxSize, fetchPage cannot determine the download limit.
            // In normal usage this doesn't happen because pages are navigated sequentially
            // (each page caches pageMaxSize*2 for its nextCid).

            const page: PageIpfs = JSON.parse(JSON.stringify(validPageFixture));
            delete page.nextCid;
            const pageCid = await addStringToIpfs(JSON.stringify(page));

            // Set pageCids to a dummy value so it's non-empty, but does NOT include our pageCid
            mockCommunity.posts.pageCids = { ...mockCommunity.posts.pageCids, hot: "QmDummyFirstPageCidThatIsNotOurTargetPage" };

            try {
                await mockCommunity.posts.getPage({ cid: pageCid });
                expect.fail("Should have thrown an error for page with unknown max size");
            } catch (e) {
                expect((e as Error).message).to.equal(
                    "Failed to calculate max page size. Is this page cid under the correct community/comment?"
                );
            }
        });
    });
});
