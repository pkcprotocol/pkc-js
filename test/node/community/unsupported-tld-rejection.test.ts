import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
    mockPKC,
    createMockNameResolver,
    createSubWithNoChallenge,
    publishWithExpectedResult,
    publishRandomPost,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { messages } from "../../../dist/node/errors.js";
import signers from "../../fixtures/signers.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";

describe("Community rejects publications with unsupported author TLDs", () => {
    let pkc: PKC;
    let community: LocalCommunity | RpcLocalCommunity;
    let validPost: CommentIpfsWithCidDefined;

    beforeAll(async () => {
        pkc = await mockPKC(
            {
                nameResolvers: [
                    createMockNameResolver({
                        includeDefaultRecords: true,
                        canResolve: ({ name }) => /\.(eth|bso)$/i.test(name)
                    })
                ]
            },
            undefined,
            undefined,
            false // mockResolve=false since we're providing our own nameResolvers
        );
        community = await createSubWithNoChallenge({}, pkc);
        await community.start();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.updatedAt === "number"
        });
        // Publish a valid post for Vote/CommentEdit/CommentModeration tests
        validPost = (await publishRandomPost({ communityAddress: community.address, pkc: pkc })) as CommentIpfsWithCidDefined;
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("rejects Comment with unsupported TLD (.xyz)", async () => {
        const unsupportedTldAddress = "user.xyz";
        const signer = await pkc.createSigner();

        // even we as a rpc client, the rpc server shouldn't refuse to publish it even if it doesn't have .xyz resolver
        // rpc server should just trust the rpc client and publish it, the community owner will take care of validation
        const comment = await pkc.createComment({
            author: { address: unsupportedTldAddress },
            signer,
            title: "Test post with unsupported TLD",
            content: "This should be rejected",
            communityAddress: community.address
        });

        await publishWithExpectedResult({
            publication: comment,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMUNITY_HAS_NO_RESOLVER_FOR_AUTHOR_NAME_TLD
        });
    });

    it("rejects Vote with unsupported TLD (.xyz)", async () => {
        // even we as a rpc client, the rpc server shouldn't refuse to publish it even if it doesn't have .xyz resolver
        // rpc server should just trust the rpc client and publish it, the community owner will take care of validation

        const unsupportedTldAddress = "voter.xyz";
        const signer = await pkc.createSigner();

        const vote = await pkc.createVote({
            author: { address: unsupportedTldAddress },
            signer,
            commentCid: validPost.cid,
            vote: 1,
            communityAddress: community.address
        });

        await publishWithExpectedResult({
            publication: vote,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMUNITY_HAS_NO_RESOLVER_FOR_AUTHOR_NAME_TLD
        });
    });

    it("rejects CommentEdit with unsupported TLD (.xyz)", async () => {
        // even we as a rpc client, the rpc server shouldn't refuse to publish it even if it doesn't have .xyz resolver
        // rpc server should just trust the rpc client and publish it, the community owner will take care of validation

        const unsupportedTldAddress = "editor.xyz";
        const signer = await pkc.createSigner();

        const commentEdit = await pkc.createCommentEdit({
            author: { address: unsupportedTldAddress },
            signer,
            commentCid: validPost.cid,
            content: "Edited content from unsupported TLD",
            communityAddress: community.address
        });

        await publishWithExpectedResult({
            publication: commentEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMUNITY_HAS_NO_RESOLVER_FOR_AUTHOR_NAME_TLD
        });
    });

    it("rejects setting a role with unsupported TLD (.xyz) during edit", async () => {
        const unsupportedTldAddress = "moderator.xyz";

        // community.edit() should reject unsupported TLD domain in roles
        await expect(
            community.edit({
                roles: {
                    ...community.roles,
                    [unsupportedTldAddress]: { role: "moderator" }
                }
            })
        ).rejects.toMatchObject({
            code: "ERR_ROLE_ADDRESS_NAME_COULD_NOT_BE_RESOLVED"
        });
    });
});

// Issue #353. checkPublicationValidity resolves the wire author.name for every publication that carries one,
// and its policy is unchanged: an author name it cannot verify against the signer is refused, whatever the
// publication type. What changed is that the four ways that can happen no longer share one message, because
// each asks the publisher to do something different: add a TXT record, fix the value in the one they have,
// use a name this community can resolve, or wait for the community's node to recover.
describe("Community names the reason it could not verify an author name", () => {
    let pkc: PKC;
    let community: LocalCommunity | RpcLocalCommunity;
    // Flipped per test to drive one resolver outcome at a time.
    const resolverBehaviour: { value: "no-record" | "throws" | "garbage" } = { value: "no-record" };

    beforeAll(async () => {
        pkc = await mockPKC(
            {
                nameResolvers: [
                    createMockNameResolver({
                        includeDefaultRecords: true,
                        resolveFunction: async ({ name }) => {
                            if (!name.endsWith(".bso")) return undefined;
                            if (resolverBehaviour.value === "throws") throw new Error("resolver is down");
                            if (resolverBehaviour.value === "garbage") return { publicKey: "not-an-ipns-address" };
                            return undefined;
                        }
                    })
                ]
            },
            undefined,
            undefined,
            false
        );
        community = await createSubWithNoChallenge({}, pkc);
        await community.start();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.updatedAt === "number"
        });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    const publishClaiming = async (name: string, expectedReason: string) => {
        const signer = await pkc.createSigner();
        const comment = await pkc.createComment({
            author: { address: name },
            signer,
            title: "Test post claiming a name",
            content: "content",
            communityAddress: community.address
        });
        await publishWithExpectedResult({ publication: comment, expectedChallengeSuccess: false, expectedReason });
    };

    it("says the name has no record when the resolvers answer that there is none", async () => {
        resolverBehaviour.value = "no-record";
        await publishClaiming(`no-record-${Date.now()}.bso`, messages.ERR_AUTHOR_NAME_HAS_NO_RECORD);
    });

    it("says its own resolvers failed when none of them could answer", async () => {
        resolverBehaviour.value = "throws";
        // The publisher may have done nothing wrong at all here, so the message points at the community's node.
        await publishClaiming(`resolver-down-${Date.now()}.bso`, messages.ERR_COMMUNITY_FAILED_TO_RESOLVE_AUTHOR_NAME);
    });

    it("says the record is not a valid key when the name resolves to something else entirely", async () => {
        resolverBehaviour.value = "garbage";
        await publishClaiming(`garbage-${Date.now()}.bso`, messages.ERR_AUTHOR_NAME_RECORD_IS_NOT_A_VALID_KEY);
    });
});
