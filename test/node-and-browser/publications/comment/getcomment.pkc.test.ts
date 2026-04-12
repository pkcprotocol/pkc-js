import signers from "../../../fixtures/signers.js";
import {
    getAvailablePKCConfigsToTestAgainst,
    addStringToIpfs,
    itSkipIfRpc,
    isPKCFetchingUsingGateways
} from "../../../../dist/node/test/test-util.js";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { describe, it, beforeAll, afterAll, vi } from "vitest";
import { CID } from "kubo-rpc-client";
import validCommentFixture from "../../../fixtures/signatures/comment/commentUpdate/valid_comment_ipfs.json" with { type: "json" };
import validCommentAuthorAddressDomainFixture from "../../../fixtures/signatures/comment/valid_comment_author_address_as_domain.json" with { type: "json" };
import { messages } from "../../../../dist/node/errors.js";
import { getPKCAddressFromPublicKeySync } from "../../../../dist/node/signer/util.js";
import { _signJson, cleanUpBeforePublishing } from "../../../../dist/node/signer/signatures.js";
import Logger from "@pkcprotocol/pkc-logger";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../../dist/node/pkc-error.js";

// Helper type for accessing internal methods on Comment
type CommentWithInternals = { updateOnce: () => Promise<void>; _setUpdatingState: () => Promise<void> };
type LegacyRawAuthor = { address?: string; name?: string; publicKey?: string };

const communitySigner = signers[0];

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`pkc.getComment - ${config.name}`, async () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        // sequential because we're spying on global fetch here which may affect other tests
        itSkipIfRpc.sequential(
            "calling pkc.getCommunity({address: ) in parallel of the same community resolves IPNS only once",
            async () => {
                const localPKC: PKC = await config.pkcInstancePromise();
                const randomCid = (await pkc.getCommunity({ address: communitySigner.address })).lastPostCid;
                expect(randomCid).to.be.a("string");
                const randomCidInGatewayUrl = CID.parse(randomCid).toV1().toString();
                let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
                let catSpy: ReturnType<typeof vi.spyOn> | undefined;
                try {
                    const usesGateways = isPKCFetchingUsingGateways(localPKC);
                    const isRemoteIpfsGatewayConfig = isPKCFetchingUsingGateways(localPKC);
                    const shouldMockFetchForIpns = isRemoteIpfsGatewayConfig && typeof globalThis.fetch === "function";

                    const stressCount = 100;

                    if (!usesGateways) {
                        const p2pClient =
                            Object.keys(localPKC.clients.kuboRpcClients).length > 0
                                ? Object.values(localPKC.clients.kuboRpcClients)[0]._client
                                : Object.keys(localPKC.clients.libp2pJsClients).length > 0
                                  ? Object.values(localPKC.clients.libp2pJsClients)[0].heliaWithKuboRpcClientFunctions
                                  : undefined;
                        if (!p2pClient?.cat) {
                            throw new Error("Expected p2p client like kubo or helia RPC client with cat for this test");
                        }
                        catSpy = vi.spyOn(p2pClient, "cat");
                    } else if (shouldMockFetchForIpns) {
                        fetchSpy = vi.spyOn(globalThis, "fetch");
                    }
                    expect(localPKC._updatingComments.size()).to.equal(0);

                    const commentInstances = await Promise.all(
                        new Array(stressCount).fill(null).map(async () => {
                            return localPKC.getComment({ cid: randomCid });
                        })
                    );

                    expect(localPKC._updatingComments.size()).to.equal(0);

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
                    await localPKC.destroy();
                }
            }
        );

        it("post props are loaded correctly", async () => {
            const community = await pkc.getCommunity({ address: communitySigner.address });
            expect(community.lastPostCid).to.be.a("string"); // Part of setting up test-server.js to publish a test post
            const expectedPostProps = JSON.parse(await pkc.fetchCid({ cid: community.lastPostCid }));
            const loadedPost = await pkc.getComment({ cid: community.lastPostCid });
            expect(loadedPost.author.community).to.be.undefined;
            expect(loadedPost.author.publicKey).to.be.a("string");

            // make sure these generated props are the same as the instance one
            expectedPostProps.author = {
                ...(expectedPostProps.author || {}),
                address: loadedPost.author.address,
                publicKey: loadedPost.author.publicKey,
                shortAddress: loadedPost.author.shortAddress,
                ...(loadedPost.author.nameResolved !== undefined ? { nameResolved: loadedPost.author.nameResolved } : {})
            };
            expectedPostProps.cid = loadedPost.cid;

            for (const key of Object.keys(expectedPostProps))
                expect(deterministicStringify(expectedPostProps[key])).to.equal(
                    deterministicStringify((loadedPost as unknown as Record<string, unknown>)[key])
                );
        });

        it("reply props are loaded correctly", async () => {
            const community = await pkc.getCommunity({ address: communitySigner.address });
            const reply = community.posts.pages.hot.comments.find((comment) => comment.replies).replies.pages.best.comments[0];
            expect(reply).to.exist;
            const expectedReplyProps = JSON.parse(await pkc.fetchCid({ cid: reply.cid }));
            expect(expectedReplyProps.postCid).to.be.a("string");
            expect(expectedReplyProps.postCid).to.equal(expectedReplyProps.parentCid);
            expect(expectedReplyProps.protocolVersion).to.be.a("string");
            expect(expectedReplyProps.depth).to.equal(1);
            // communityAddress is runtime-only; wire format has communityPublicKey/communityName/communityAddress
            const rawCommunityAddr =
                expectedReplyProps.communityName || expectedReplyProps.communityPublicKey || expectedReplyProps.subplebbitAddress;
            expect(rawCommunityAddr).to.equal(community.address);
            expect(expectedReplyProps.timestamp).to.be.a("number");
            expect(expectedReplyProps.signature).to.be.a("object");
            expect(expectedReplyProps.author).to.be.a("object");
            expect(expectedReplyProps.protocolVersion).to.be.a("string");
            expectedReplyProps.cid = reply.cid;

            const loadedReply = await pkc.getComment({ cid: reply.cid });
            expect(loadedReply.constructor.name).to.equal("Comment");
            expect(loadedReply.author.publicKey).to.be.a("string");
            expectedReplyProps.author = {
                ...(expectedReplyProps.author || {}),
                address: loadedReply.author.address,
                publicKey: loadedReply.author.publicKey,
                shortAddress: loadedReply.author.shortAddress,
                ...(loadedReply.author.nameResolved !== undefined ? { nameResolved: loadedReply.author.nameResolved } : {})
            };
            if (loadedReply.author.community) delete loadedReply.author.community; // If it's running on RPC then it will fetch both CommentIpfs and CommentUpdate
            for (const key of Object.keys(expectedReplyProps))
                expect(deterministicStringify(expectedReplyProps[key])).to.equal(
                    deterministicStringify((loadedReply as unknown as Record<string, unknown>)[key])
                );
        });

        it("loads a legacy comment fixture with base58 wire author.address and computes runtime author.publicKey", async () => {
            // Use a byte-distinct payload so this test does not warm caches for later tests that reuse the raw fixture CID.
            const legacyCommentCid = await addStringToIpfs(JSON.stringify(validCommentFixture, null, 2));
            const loadedComment = await pkc.getComment({ cid: legacyCommentCid });
            const expectedPublicKey = getPKCAddressFromPublicKeySync(validCommentFixture.signature.publicKey);

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
            const loadedComment = await pkc.getComment({ cid: legacyCommentCid });
            const expectedPublicKey = getPKCAddressFromPublicKeySync(validCommentAuthorAddressDomainFixture.signature.publicKey);

            expect(loadedComment.author.publicKey).to.equal(expectedPublicKey);
            expect(loadedComment.author.name).to.equal("plebbit.eth");
            expect(loadedComment.author.address).to.equal("plebbit.eth");

            const rawAuthor = loadedComment.raw.comment.author as LegacyRawAuthor;
            expect(rawAuthor.address).to.equal("plebbit.eth");
            expect(rawAuthor.name).to.be.undefined;
            expect(rawAuthor.publicKey).to.be.undefined;
        });

        it("loads a new-format CommentIpfs (no wire author.address) and derives author.publicKey and author.address from signature", async () => {
            const signer = signers[7];
            const log = Logger("pkc-js:test:getcomment:new-format-derivation");
            const signedPropertyNames = ["content", "title", "author", "subplebbitAddress", "protocolVersion", "timestamp", "depth"];
            const commentIpfs = {
                content: `New format no author.address ${Date.now()}`,
                title: `New format title ${Date.now()}`,
                author: { displayName: "Test Author" },
                subplebbitAddress: communitySigner.address,
                protocolVersion: "1.0.0",
                timestamp: Math.floor(Date.now() / 1000),
                depth: 0
            };
            const signature = await _signJson(signedPropertyNames, cleanUpBeforePublishing(commentIpfs), signer, log);
            const commentIpfsWithSignature = { ...commentIpfs, signature };

            const cid = await addStringToIpfs(JSON.stringify(commentIpfsWithSignature));
            const loadedComment = await pkc.getComment({ cid });
            const expectedPublicKey = getPKCAddressFromPublicKeySync(signer.publicKey!);

            expect(loadedComment.author.publicKey).to.equal(expectedPublicKey);
            expect(loadedComment.author.name).to.be.undefined;
            expect(loadedComment.author.address).to.equal(expectedPublicKey);
        });

        it("loads a new-format CommentIpfs with domain author.name and derives author.publicKey from signature", async () => {
            const signer = signers[7];
            const log = Logger("pkc-js:test:getcomment:new-format-domain");
            const signedPropertyNames = ["content", "title", "author", "subplebbitAddress", "protocolVersion", "timestamp", "depth"];
            const commentIpfs = {
                content: `New format domain author ${Date.now()}`,
                title: `New format domain title ${Date.now()}`,
                author: { name: "plebbit.bso", displayName: "Domain Author" },
                subplebbitAddress: communitySigner.address,
                protocolVersion: "1.0.0",
                timestamp: Math.floor(Date.now() / 1000),
                depth: 0
            };
            const signature = await _signJson(signedPropertyNames, cleanUpBeforePublishing(commentIpfs), signer, log);
            const commentIpfsWithSignature = { ...commentIpfs, signature };

            const cid = await addStringToIpfs(JSON.stringify(commentIpfsWithSignature));
            const loadedComment = await pkc.getComment({ cid });
            const expectedPublicKey = getPKCAddressFromPublicKeySync(signer.publicKey!);

            expect(loadedComment.author.publicKey).to.equal(expectedPublicKey);
            expect(loadedComment.author.name).to.equal("plebbit.bso");
            expect(loadedComment.author.address).to.equal("plebbit.bso");
        });

        it(`pkc.getComment is not fetching comment updates in background after fulfilling its promise`, async () => {
            const loadedCommunity = await pkc.getCommunity({ address: communitySigner.address });
            const comment = await pkc.getComment({ cid: loadedCommunity.posts.pages.hot.comments[0].cid });
            let updatedHasBeenCalled = false;
            const commentWithInternals = comment as unknown as CommentWithInternals;
            commentWithInternals.updateOnce = commentWithInternals._setUpdatingState = async () => {
                updatedHasBeenCalled = true;
            };
            await new Promise((resolve) => setTimeout(resolve, pkc.updateInterval * 2));
            expect(updatedHasBeenCalled).to.be.false;
        });

        it(`pkc.getComment should throw immeditely if CommentIpfs has an invalid signature (non retriable error)`, async () => {
            const commentIpfsOfInvalidSignature = JSON.parse(JSON.stringify(validCommentFixture)); // comment ipfs

            commentIpfsOfInvalidSignature.content += "1234"; // make signature invalid
            const commentIpfsInvalidSignatureCid = await addStringToIpfs(JSON.stringify(commentIpfsOfInvalidSignature));

            try {
                await pkc.getComment({ cid: commentIpfsInvalidSignatureCid });
                expect.fail("should not succeed");
            } catch (e) {
                expect((e as PKCError).code).to.equal("ERR_COMMENT_IPFS_SIGNATURE_IS_INVALID");
            }
        });

        it(`pkc.getComment should throw if CommentIpfs communityName does not match the requested one`, async () => {
            const commentIpfs = JSON.parse(JSON.stringify(validCommentFixture));
            commentIpfs.communityName = "real-domain.eth";
            const commentIpfsCid = await addStringToIpfs(JSON.stringify(commentIpfs));

            try {
                await pkc.getComment({ cid: commentIpfsCid, communityName: "forged-domain.eth" });
                expect.fail("should not succeed");
            } catch (e) {
                const error = e as PKCError;
                expect(error.code).to.equal("ERR_COMMENT_IPFS_SIGNATURE_IS_INVALID");
                expect(error.details.commentIpfsValidation.reason).to.equal(messages.ERR_COMMENT_IPFS_COMMUNITY_NAME_MISMATCH);
            }
        });

        it(`pkc.getComment succeeds when communityPublicKey differs from sub but communityName matches (key rotation)`, async () => {
            // Simulate a domain-based community that rotated its key: old comments have communityPublicKey set to the old key,
            // but communityName matches the community's domain address. This should NOT be an error because
            // getCommunityAddressFromRecord returns communityName first, so the address check uses the domain.
            const commentIpfs = JSON.parse(JSON.stringify(validCommentFixture));
            commentIpfs.communityName = "example.eth";
            commentIpfs.communityPublicKey = signers[6].address; // "old" key, differs from community's current key
            const cid = await addStringToIpfs(JSON.stringify(commentIpfs));

            const loadedComment = await pkc.getComment({ cid, communityAddress: "example.eth" });
            expect(loadedComment.communityAddress).to.equal("example.eth");
            expect(loadedComment.communityPublicKey).to.equal(signers[6].address);
            expect(loadedComment.communityName).to.equal("example.eth");
        });

        it(`pkc.getComment succeeds when communityPublicKey differs from CommentIpfs (pure key rotation, no domain)`, async () => {
            // Simulate a non-domain community that rotated its IPNS key.
            // The caller passes the old communityPublicKey, but the CommentIpfs has the real (new) key.
            // getComment should load the record and use the community fields from the CommentIpfs.
            const commentIpfsCid = await addStringToIpfs(JSON.stringify(validCommentFixture));
            const realCommunityAddress = validCommentFixture.subplebbitAddress; // the actual community key in the record
            const oldKey = signers[6].address; // differs from the real key
            expect(oldKey).to.not.equal(realCommunityAddress);

            const loadedComment = await pkc.getComment({ cid: commentIpfsCid, communityPublicKey: oldKey });
            // After loading, the community fields should come from the CommentIpfs, not the hint
            expect(loadedComment.communityAddress).to.equal(realCommunityAddress);
            expect(loadedComment.communityPublicKey).to.equal(realCommunityAddress); // non-domain address = public key
        });

        itSkipIfRpc(`pkc.getComment times out if commentCid does not exist`, async () => {
            const commentCid = "QmbSiusGgY4Uk5LdAe91bzLkBzidyKyKHRKwhXPDz7gGzx"; // random cid doesn't exist anywhere
            const customPKC: PKC = await config.pkcInstancePromise();
            customPKC._timeouts["comment-ipfs"] = 100;
            try {
                await customPKC.getComment({ cid: commentCid });
                expect.fail("should not succeed");
            } catch (e) {
                const error = e as PKCError;
                if (isPKCFetchingUsingGateways(customPKC)) {
                    expect(error.code).to.equal("ERR_FAILED_TO_FETCH_COMMENT_IPFS_FROM_GATEWAYS");
                    expect((error.details.gatewayToError as Record<string, PKCError>)["http://localhost:18080"].code).to.equal(
                        "ERR_GATEWAY_TIMED_OUT_OR_ABORTED"
                    );
                } else expect(error.code).to.equal("ERR_FETCH_CID_P2P_TIMEOUT");
            }
            await customPKC.destroy();
        });
    });
});
