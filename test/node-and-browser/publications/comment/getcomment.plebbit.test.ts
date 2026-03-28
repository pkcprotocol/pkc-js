import signers from "../../../fixtures/signers.js";
import {
    getAvailablePlebbitConfigsToTestAgainst,
    addStringToIpfs,
    itSkipIfRpc,
    isPlebbitFetchingUsingGateways
} from "../../../../dist/node/test/test-util.js";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { describe, it, beforeAll, afterAll, vi } from "vitest";
import { CID } from "kubo-rpc-client";
import validCommentFixture from "../../../fixtures/signatures/comment/commentUpdate/valid_comment_ipfs.json" with { type: "json" };
import validCommentAuthorAddressDomainFixture from "../../../fixtures/signatures/comment/valid_comment_author_address_as_domain.json" with { type: "json" };
import { messages } from "../../../../dist/node/errors.js";
import { getPlebbitAddressFromPublicKeySync } from "../../../../dist/node/signer/util.js";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";
import type { PlebbitError } from "../../../../dist/node/plebbit-error.js";

// Helper type for accessing internal methods on Comment
type CommentWithInternals = { updateOnce: () => Promise<void>; _setUpdatingState: () => Promise<void> };
type LegacyRawAuthor = { address?: string; name?: string; publicKey?: string };

const subplebbitSigner = signers[0];

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe.concurrent(`plebbit.getComment - ${config.name}`, async () => {
        let plebbit: Plebbit;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        // sequential because we're spying on global fetch here which may affect other tests
        itSkipIfRpc.sequential(
            "calling plebbit.getSubplebbit({address: ) in parallel of the same subplebbit resolves IPNS only once",
            async () => {
                const localPlebbit: Plebbit = await config.plebbitInstancePromise();
                const randomCid = (await plebbit.getSubplebbit({ address: subplebbitSigner.address })).lastPostCid;
                expect(randomCid).to.be.a("string");
                const randomCidInGatewayUrl = CID.parse(randomCid).toV1().toString();
                let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
                let catSpy: ReturnType<typeof vi.spyOn> | undefined;
                try {
                    const usesGateways = isPlebbitFetchingUsingGateways(localPlebbit);
                    const isRemoteIpfsGatewayConfig = isPlebbitFetchingUsingGateways(localPlebbit);
                    const shouldMockFetchForIpns = isRemoteIpfsGatewayConfig && typeof globalThis.fetch === "function";

                    const stressCount = 100;

                    if (!usesGateways) {
                        const p2pClient =
                            Object.keys(localPlebbit.clients.kuboRpcClients).length > 0
                                ? Object.values(localPlebbit.clients.kuboRpcClients)[0]._client
                                : Object.keys(localPlebbit.clients.libp2pJsClients).length > 0
                                  ? Object.values(localPlebbit.clients.libp2pJsClients)[0].heliaWithKuboRpcClientFunctions
                                  : undefined;
                        if (!p2pClient?.cat) {
                            throw new Error("Expected p2p client like kubo or helia RPC client with cat for this test");
                        }
                        catSpy = vi.spyOn(p2pClient, "cat");
                    } else if (shouldMockFetchForIpns) {
                        fetchSpy = vi.spyOn(globalThis, "fetch");
                    }
                    expect(localPlebbit._updatingComments.size()).to.equal(0);

                    const commentInstances = await Promise.all(
                        new Array(stressCount).fill(null).map(async () => {
                            return localPlebbit.getComment({ cid: randomCid });
                        })
                    );

                    expect(localPlebbit._updatingComments.size()).to.equal(0);

                    const catOrFetchCallsCount = fetchSpy
                        ? fetchSpy.mock.calls.filter(([input]: [string | { url?: string }]) => {
                              const url = typeof input === "string" ? input : input?.url;
                              return typeof url === "string" && url.includes("/ipfs/" + randomCidInGatewayUrl);
                          }).length
                        : catSpy?.mock.calls.length;

                    expect(catOrFetchCallsCount).to.equal(
                        1,
                        "calling getComment() on many comment instances with the same cid in parallel should only fetch CID once"
                    );
                } finally {
                    if (catSpy) catSpy.mockRestore();
                    if (fetchSpy) fetchSpy.mockRestore();
                    await localPlebbit.destroy();
                }
            }
        );

        it("post props are loaded correctly", async () => {
            const subplebbit = await plebbit.getSubplebbit({ address: subplebbitSigner.address });
            expect(subplebbit.lastPostCid).to.be.a("string"); // Part of setting up test-server.js to publish a test post
            const expectedPostProps = JSON.parse(await plebbit.fetchCid({ cid: subplebbit.lastPostCid }));
            const loadedPost = await plebbit.getComment({ cid: subplebbit.lastPostCid });
            expect(loadedPost.author.subplebbit).to.be.undefined;
            expect(loadedPost.author.publicKey).to.be.a("string");

            // make sure these generated props are the same as the instance one
            expectedPostProps.author = {
                ...(expectedPostProps.author || {}),
                address: loadedPost.author.address,
                publicKey: loadedPost.author.publicKey,
                shortAddress: loadedPost.author.shortAddress
            };
            expectedPostProps.cid = loadedPost.cid;

            for (const key of Object.keys(expectedPostProps))
                expect(deterministicStringify(expectedPostProps[key])).to.equal(
                    deterministicStringify((loadedPost as unknown as Record<string, unknown>)[key])
                );
        });

        it("reply props are loaded correctly", async () => {
            const subplebbit = await plebbit.getSubplebbit({ address: subplebbitSigner.address });
            const reply = subplebbit.posts.pages.hot.comments.find((comment) => comment.replies).replies.pages.best.comments[0];
            expect(reply).to.exist;
            const expectedReplyProps = JSON.parse(await plebbit.fetchCid({ cid: reply.cid }));
            expect(expectedReplyProps.postCid).to.be.a("string");
            expect(expectedReplyProps.postCid).to.equal(expectedReplyProps.parentCid);
            expect(expectedReplyProps.protocolVersion).to.be.a("string");
            expect(expectedReplyProps.depth).to.equal(1);
            // communityAddress is runtime-only; wire format has communityPublicKey/communityName/subplebbitAddress
            const rawCommunityAddr =
                expectedReplyProps.communityName || expectedReplyProps.communityPublicKey || expectedReplyProps.subplebbitAddress;
            expect(rawCommunityAddr).to.equal(subplebbit.address);
            expect(expectedReplyProps.timestamp).to.be.a("number");
            expect(expectedReplyProps.signature).to.be.a("object");
            expect(expectedReplyProps.author).to.be.a("object");
            expect(expectedReplyProps.protocolVersion).to.be.a("string");
            expectedReplyProps.cid = reply.cid;

            const loadedReply = await plebbit.getComment({ cid: reply.cid });
            expect(loadedReply.constructor.name).to.equal("Comment");
            expect(loadedReply.author.publicKey).to.be.a("string");
            expectedReplyProps.author = {
                ...(expectedReplyProps.author || {}),
                address: loadedReply.author.address,
                publicKey: loadedReply.author.publicKey,
                shortAddress: loadedReply.author.shortAddress
            };
            if (loadedReply.author.subplebbit) delete loadedReply.author.subplebbit; // If it's running on RPC then it will fetch both CommentIpfs and CommentUpdate
            for (const key of Object.keys(expectedReplyProps))
                expect(deterministicStringify(expectedReplyProps[key])).to.equal(
                    deterministicStringify((loadedReply as unknown as Record<string, unknown>)[key])
                );
        });

        it("loads a legacy comment fixture with base58 wire author.address and computes runtime author.publicKey", async () => {
            // Use a byte-distinct payload so this test does not warm caches for later tests that reuse the raw fixture CID.
            const legacyCommentCid = await addStringToIpfs(JSON.stringify(validCommentFixture, null, 2));
            const loadedComment = await plebbit.getComment({ cid: legacyCommentCid });
            const expectedPublicKey = getPlebbitAddressFromPublicKeySync(validCommentFixture.signature.publicKey);

            expect(loadedComment.author.publicKey).to.equal(expectedPublicKey);
            expect(loadedComment.author.name).to.be.undefined;
            expect(loadedComment.author.address).to.equal(expectedPublicKey);

            const rawAuthor = loadedComment.raw.comment.author as LegacyRawAuthor;
            expect(rawAuthor.address).to.equal(validCommentFixture.author.address);
            expect(rawAuthor.name).to.be.undefined;
            expect(rawAuthor.publicKey).to.be.undefined;
        });

        it("loads a legacy comment fixture with domain wire author.address and computes runtime author.name", async () => {
            const legacyCommentCid = await addStringToIpfs(JSON.stringify(validCommentAuthorAddressDomainFixture));
            const loadedComment = await plebbit.getComment({ cid: legacyCommentCid });
            const expectedPublicKey = getPlebbitAddressFromPublicKeySync(validCommentAuthorAddressDomainFixture.signature.publicKey);

            expect(loadedComment.author.publicKey).to.equal(expectedPublicKey);
            expect(loadedComment.author.name).to.equal("plebbit.eth");
            expect(loadedComment.author.address).to.equal("plebbit.eth");

            const rawAuthor = loadedComment.raw.comment.author as LegacyRawAuthor;
            expect(rawAuthor.address).to.equal("plebbit.eth");
            expect(rawAuthor.name).to.be.undefined;
            expect(rawAuthor.publicKey).to.be.undefined;
        });

        it(`plebbit.getComment is not fetching comment updates in background after fulfilling its promise`, async () => {
            const loadedSubplebbit = await plebbit.getSubplebbit({ address: subplebbitSigner.address });
            const comment = await plebbit.getComment({ cid: loadedSubplebbit.posts.pages.hot.comments[0].cid });
            let updatedHasBeenCalled = false;
            const commentWithInternals = comment as unknown as CommentWithInternals;
            commentWithInternals.updateOnce = commentWithInternals._setUpdatingState = async () => {
                updatedHasBeenCalled = true;
            };
            await new Promise((resolve) => setTimeout(resolve, plebbit.updateInterval * 2));
            expect(updatedHasBeenCalled).to.be.false;
        });

        it(`plebbit.getComment should throw immeditely if CommentIpfs has an invalid signature (non retriable error)`, async () => {
            const commentIpfsOfInvalidSignature = JSON.parse(JSON.stringify(validCommentFixture)); // comment ipfs

            commentIpfsOfInvalidSignature.content += "1234"; // make signature invalid
            const commentIpfsInvalidSignatureCid = await addStringToIpfs(JSON.stringify(commentIpfsOfInvalidSignature));

            try {
                await plebbit.getComment({ cid: commentIpfsInvalidSignatureCid });
                expect.fail("should not succeed");
            } catch (e) {
                expect((e as PlebbitError).code).to.equal("ERR_COMMENT_IPFS_SIGNATURE_IS_INVALID");
            }
        });

        it(`plebbit.getComment should throw if CommentIpfs subplebbitAddress does not match the requested one`, async () => {
            const commentIpfsCid = await addStringToIpfs(JSON.stringify(validCommentFixture));
            const expectedSubplebbitAddress = signers[1].address;
            expect(expectedSubplebbitAddress).to.not.equal(validCommentFixture.subplebbitAddress);

            try {
                await plebbit.getComment({ cid: commentIpfsCid, communityAddress: expectedSubplebbitAddress });
                expect.fail("should not succeed");
            } catch (e) {
                const error = e as PlebbitError;
                expect(error.code).to.equal("ERR_COMMENT_IPFS_SIGNATURE_IS_INVALID");
                expect(error.details.commentIpfsValidation.reason).to.equal(messages.ERR_COMMENT_IPFS_COMMUNITY_ADDRESS_MISMATCH);
            }
        });

        itSkipIfRpc(`plebbit.getComment times out if commentCid does not exist`, async () => {
            const commentCid = "QmbSiusGgY4Uk5LdAe91bzLkBzidyKyKHRKwhXPDz7gGzx"; // random cid doesn't exist anywhere
            const customPlebbit: Plebbit = await config.plebbitInstancePromise();
            customPlebbit._timeouts["comment-ipfs"] = 100;
            try {
                await customPlebbit.getComment({ cid: commentCid });
                expect.fail("should not succeed");
            } catch (e) {
                const error = e as PlebbitError;
                if (isPlebbitFetchingUsingGateways(customPlebbit)) {
                    expect(error.code).to.equal("ERR_FAILED_TO_FETCH_COMMENT_IPFS_FROM_GATEWAYS");
                    expect((error.details.gatewayToError as Record<string, PlebbitError>)["http://localhost:18080"].code).to.equal(
                        "ERR_GATEWAY_TIMED_OUT_OR_ABORTED"
                    );
                } else expect(error.code).to.equal("ERR_FETCH_CID_P2P_TIMEOUT");
            }
            await customPlebbit.destroy();
        });
    });
});
