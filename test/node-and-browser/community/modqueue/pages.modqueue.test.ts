import {
    mockGatewayPKC,
    addStringToIpfs,
    getAvailablePKCConfigsToTestAgainst,
    isPKCFetchingUsingGateways,
    itSkipIfRpc
} from "../../../../dist/node/test/test-util.js";

import validModQueuePage from "../../../fixtures/valid_modqueue_page.json" with { type: "json" };

import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { Buffer } from "buffer";
import { messages } from "../../../../dist/node/errors.js";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { describe, it } from "vitest";

import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../../dist/node/pkc-error.js";

const communityAddressOfFixture = validModQueuePage.comments[0].comment.subplebbitAddress;

// need to test if comments with approved=false appear in any flattened pages, comment.replies, post.replies, community.posts
// same thing for pending comments

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) => {
    describe(`modQueue.getPage - ${config.name}`, async () => {
        it(`modQueue.getPage will throw if retrieved page is not equivalent to its CID - IPFS Gateway`, async () => {
            const gatewayUrl = "http://localhost:13415"; // a gateway that's gonna respond with invalid content
            const pkc: PKCType = await mockGatewayPKC({
                pkcOptions: { ipfsGatewayUrls: [gatewayUrl], validatePages: true }
            });

            try {
                const sub = await pkc.createCommunity({ address: communityAddressOfFixture });

                const invalidPageCid = "QmUFu8fzuT1th3jJYgR4oRgGpw3sgRALr4nbenA4pyoCav"; // Gateway will respond with content that is not mapped to this cid
                sub.modQueue.pageCids.pendingApproval = invalidPageCid; // need to hardcode it here so we can calculate max size
                await sub.modQueue.getPage({ cid: invalidPageCid });
                expect.fail("Should fail");
            } catch (e) {
                const error = e as PKCError;
                expect(error.code).to.equal("ERR_FAILED_TO_FETCH_PAGE_IPFS_FROM_GATEWAYS");
                expect((error.details.gatewayToError[gatewayUrl] as PKCError).code).to.equal("ERR_CALCULATED_CID_DOES_NOT_MATCH");
            } finally {
                await pkc.destroy();
            }
        });
    });
});

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent("modQueue.getPage - " + config.name, () => {
        itSkipIfRpc(`community.modQueue.getPage will throw if retrieved page has a comment with an signature `, async () => {
            const pkc: PKCType = await config.pkcInstancePromise({ pkcOptions: { validatePages: true } });

            try {
                const sub = await pkc.createCommunity({ address: communityAddressOfFixture });

                const fixtureToInvalidate = JSON.parse(JSON.stringify(validModQueuePage));

                fixtureToInvalidate.comments[0].comment.content += "invalidate signature";

                const invalidPageCid = await addStringToIpfs(JSON.stringify(fixtureToInvalidate));
                sub.modQueue.pageCids.pendingApproval = invalidPageCid; // need to hardcode it here so we can calculate max size

                await sub.modQueue.getPage({ cid: invalidPageCid });
                expect.fail("should fail");
            } catch (e) {
                const error = e as PKCError;
                expect(error.code).to.equal("ERR_MOD_QUEUE_PAGE_IS_INVALID");
                expect(error.details.signatureValidity.reason).to.equal(messages.ERR_SIGNATURE_IS_INVALID);
            } finally {
                await pkc.destroy();
            }
        });

        itSkipIfRpc("Should fail getPage if a modqueue comment belongs to a different sub", async () => {
            // TODO: Ensure cross-sub comments cannot appear under another sub's modqueue
            // and that the operation fails or rejects with an appropriate error
            const pkc: PKCType = await config.pkcInstancePromise({ pkcOptions: { validatePages: true } });

            try {
                const sub = await pkc.createCommunity({ address: communityAddressOfFixture });

                const invalidPage = JSON.parse(JSON.stringify(validModQueuePage));
                invalidPage.comments[0].comment.subplebbitAddress = "different-address";

                const invalidPageCid = await addStringToIpfs(JSON.stringify(invalidPage));
                sub.modQueue.pageCids.pendingApproval = invalidPageCid; // need to hardcode it here so we can calculate max size

                await sub.modQueue.getPage({ cid: invalidPageCid });
                expect.fail("Should have thrown");
            } catch (e) {
                const error = e as PKCError;
                expect(error.code).to.equal("ERR_MOD_QUEUE_PAGE_IS_INVALID");
                expect(error.details.signatureValidity.reason).to.equal(messages.ERR_COMMENT_IN_PAGE_BELONG_TO_DIFFERENT_COMMUNITY);
            } finally {
                await pkc.destroy();
            }
        });

        itSkipIfRpc("fails validation when calculated CID of CommentIpfs doesn't match commentUpdate.cid", async () => {
            const pkc: PKCType = await config.pkcInstancePromise({ pkcOptions: { validatePages: true } });

            try {
                const sub = await pkc.createCommunity({ address: communityAddressOfFixture });

                const invalidPage = JSON.parse(JSON.stringify(validModQueuePage));
                // Modify the comment but keep the same commentUpdate.cid
                invalidPage.comments[0].commentUpdate.cid = invalidPage.comments[1].commentUpdate.cid;

                const invalidPageCid = await addStringToIpfs(JSON.stringify(invalidPage));
                sub.modQueue.pageCids.pendingApproval = invalidPageCid; // need to hardcode it here so we can calculate max size
                await sub.modQueue.getPage({ cid: invalidPageCid });
                expect.fail("Should have thrown");
            } catch (e) {
                const error = e as PKCError;
                expect(error.code).to.equal("ERR_MOD_QUEUE_PAGE_IS_INVALID");
                expect(error.details.signatureValidity.reason).to.equal(messages.ERR_COMMENT_UPDATE_DIFFERENT_CID_THAN_COMMENT);
            } finally {
                await pkc.destroy();
            }
        });

        itSkipIfRpc("fails validation when a post has parentCid defined", async () => {
            const pkc: PKCType = await config.pkcInstancePromise({ pkcOptions: { validatePages: true } });

            try {
                const invalidPage = JSON.parse(JSON.stringify(validModQueuePage));

                const sub = await pkc.createCommunity({ address: communityAddressOfFixture });

                invalidPage.comments.find(
                    (comment: Record<string, Record<string, unknown>>) => comment.comment.depth === 0
                ).comment.parentCid = "QmYgRRQaybe12KWGnxjvaCetsxWutVRb9Piqcw8irgx9Xf"; // random cid unrelated to this comment. It's a post so it shouldn't have a postCid

                // Update the commentUpdate.cid to match the modified comment
                invalidPage.comments.find(
                    (comment: Record<string, Record<string, unknown>>) => comment.comment.depth === 0
                ).commentUpdate.cid = await calculateIpfsHash(
                    JSON.stringify(
                        invalidPage.comments.find((comment: Record<string, Record<string, unknown>>) => comment.comment.depth === 0).comment
                    )
                );

                const invalidPageCid = await addStringToIpfs(JSON.stringify(invalidPage));
                sub.modQueue.pageCids.pendingApproval = invalidPageCid; // need to hardcode it here so we can calculate max size

                await sub.modQueue.getPage({ cid: invalidPageCid });
                expect.fail("Should have thrown");
            } catch (e) {
                const error = e as PKCError;
                expect(error.code).to.equal("ERR_MOD_QUEUE_PAGE_IS_INVALID");
                expect(error.details.signatureValidity.reason).to.equal(messages.ERR_COMMENT_UPDATE_DIFFERENT_CID_THAN_COMMENT);
            } finally {
                await pkc.destroy();
            }
        });

        itSkipIfRpc(`Fails validation when pending posts have postCid defined`, async () => {
            const pkc: PKCType = await config.pkcInstancePromise({ pkcOptions: { validatePages: true } });

            try {
                const invalidPage = JSON.parse(JSON.stringify(validModQueuePage));

                const sub = await pkc.createCommunity({ address: communityAddressOfFixture });

                const indexOfPost = invalidPage.comments.findIndex(
                    (comment: Record<string, Record<string, unknown>>) => comment.comment.depth === 0
                );
                expect(indexOfPost).to.be.greaterThanOrEqual(0);
                invalidPage.comments[indexOfPost].comment.postCid = "QmYgRRQaybe12KWGnxjvaCetsxWutVRb9Piqcw8irgx9Xf"; // random cid unrelated to this comment. It's a post so it shouldn't have a postCid

                // Update the commentUpdate.cid to match the modified comment
                invalidPage.comments[indexOfPost].commentUpdate.cid = await calculateIpfsHash(
                    deterministicStringify(invalidPage.comments[indexOfPost].comment)
                );
                const invalidPageCid = await addStringToIpfs(JSON.stringify(invalidPage));
                sub.modQueue.pageCids.pendingApproval = invalidPageCid; // need to hardcode it here so we can calculate max size

                await sub.modQueue.getPage({ cid: invalidPageCid });
                expect.fail("Should have thrown");
            } catch (e) {
                const error = e as PKCError;
                expect(error.code).to.equal("ERR_MOD_QUEUE_PAGE_IS_INVALID");
                expect(error.details.signatureValidity.reason).to.equal(messages.ERR_PAGE_COMMENT_POST_HAS_POST_CID_DEFINED_WITH_DEPTH_0);
            } finally {
                await pkc.destroy();
            }
        });

        itSkipIfRpc(`modQueue.getPage will throw if the first page is over 1mb`, async () => {
            const pkc: PKCType = await config.pkcInstancePromise({ pkcOptions: { validatePages: true } });

            try {
                const community = await pkc.createCommunity({ address: communityAddressOfFixture });
                const page = JSON.parse(JSON.stringify(validModQueuePage));

                // Make sure the page is over 1MB
                // Keep adding comments until the page exceeds 1MB
                while (Buffer.byteLength(JSON.stringify(page)) <= 1024 * 1024) {
                    page.comments.push(...page.comments);
                }

                // Verify the page is actually over 1MB
                const pageSizeInMB = Buffer.byteLength(JSON.stringify(page)) / (1024 * 1024);
                console.log(`Page size: ${pageSizeInMB.toFixed(2)}MB`);
                expect(pageSizeInMB).to.be.greaterThan(1, "Page should be larger than 1MB for this test");
                const pageCid = await addStringToIpfs(JSON.stringify(page));

                community.modQueue.pageCids.pendingApproval = pageCid;

                await community.modQueue.getPage({ cid: pageCid });
                expect.fail("Should have thrown");
            } catch (e) {
                const error = e as PKCError;
                if (isPKCFetchingUsingGateways(pkc)) {
                    expect(error.code).to.equal("ERR_FAILED_TO_FETCH_PAGE_IPFS_FROM_GATEWAYS");
                    for (const gatewayUrl of Object.keys(pkc.clients.ipfsGateways))
                        expect((error.details.gatewayToError[gatewayUrl] as PKCError).code).to.equal("ERR_OVER_DOWNLOAD_LIMIT");
                } else expect(error.code).to.equal("ERR_OVER_DOWNLOAD_LIMIT");
            } finally {
                await pkc.destroy();
            }
        });

        itSkipIfRpc("modQueue.getPage will throw a timeout error when request times out", async () => {
            // Create a pkc instance with a very short timeout for page-ipfs
            const pkc: PKCType = await config.pkcInstancePromise();

            try {
                pkc._timeouts["page-ipfs"] = 100;

                // Create a comment with a CID that doesn't exist or will time out
                const nonExistentCid = "QmbSiusGgY4Uk5LdAe91bzLkBzidyKyKHRKwhXPDz7gGzx"; // Random CID that doesn't exist

                const sub = await pkc.createCommunity({ address: communityAddressOfFixture });

                // Override the pageCid to use our non-existent CID
                sub.modQueue.pageCids.pendingApproval = nonExistentCid;
                // This should time out
                await sub.modQueue.getPage({ cid: nonExistentCid });
                expect.fail("Should have timed out");
            } catch (e) {
                const error = e as PKCError;
                if (isPKCFetchingUsingGateways(pkc)) {
                    expect(error.code).to.equal("ERR_FAILED_TO_FETCH_PAGE_IPFS_FROM_GATEWAYS");
                    for (const gatewayUrl of Object.keys(pkc.clients.ipfsGateways))
                        expect((error.details.gatewayToError[gatewayUrl] as PKCError).code).to.equal("ERR_GATEWAY_TIMED_OUT_OR_ABORTED");
                } else {
                    expect(error.code).to.equal("ERR_FETCH_CID_P2P_TIMEOUT");
                }
            } finally {
                await pkc.destroy();
            }
        });
    });
});
