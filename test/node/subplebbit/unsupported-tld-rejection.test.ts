import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
    mockPlebbit,
    createMockNameResolver,
    createSubWithNoChallenge,
    publishWithExpectedResult,
    publishRandomPost,
    resolveWhenConditionIsTrue,
    itSkipIfRpc
} from "../../../dist/node/test/test-util.js";
import { messages } from "../../../dist/node/errors.js";
import signers from "../../fixtures/signers.js";
import type { Plebbit } from "../../../dist/node/plebbit/plebbit.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";

describe("Subplebbit rejects publications with unsupported author TLDs", () => {
    let plebbit: Plebbit;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let validPost: CommentIpfsWithCidDefined;

    beforeAll(async () => {
        plebbit = await mockPlebbit(
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
        subplebbit = await createSubWithNoChallenge({}, plebbit);
        await subplebbit.start();
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () => typeof subplebbit.updatedAt === "number"
        });
        // Publish a valid post for Vote/CommentEdit/CommentModeration tests
        validPost = (await publishRandomPost({ subplebbitAddress: subplebbit.address, plebbit: plebbit })) as CommentIpfsWithCidDefined;
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
    });

    itSkipIfRpc("rejects Comment with unsupported TLD (.xyz)", async () => {
        const unsupportedTldAddress = "user.xyz";
        const signer = await plebbit.createSigner();

        const comment = await plebbit.createComment({
            author: { address: unsupportedTldAddress },
            signer,
            title: "Test post with unsupported TLD",
            content: "This should be rejected",
            subplebbitAddress: subplebbit.address
        });

        await publishWithExpectedResult({
            publication: comment,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_FAILED_TO_RESOLVE_AUTHOR_DOMAIN
        });
    });

    itSkipIfRpc("rejects Vote with unsupported TLD (.xyz)", async () => {
        const unsupportedTldAddress = "voter.xyz";
        const signer = await plebbit.createSigner();

        const vote = await plebbit.createVote({
            author: { address: unsupportedTldAddress },
            signer,
            commentCid: validPost.cid,
            vote: 1,
            subplebbitAddress: subplebbit.address
        });

        await publishWithExpectedResult({
            publication: vote,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_FAILED_TO_RESOLVE_AUTHOR_DOMAIN
        });
    });

    itSkipIfRpc("rejects CommentEdit with unsupported TLD (.xyz)", async () => {
        const unsupportedTldAddress = "editor.xyz";
        const signer = await plebbit.createSigner();

        const commentEdit = await plebbit.createCommentEdit({
            author: { address: unsupportedTldAddress },
            signer,
            commentCid: validPost.cid,
            content: "Edited content from unsupported TLD",
            subplebbitAddress: subplebbit.address
        });

        await publishWithExpectedResult({
            publication: commentEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_FAILED_TO_RESOLVE_AUTHOR_DOMAIN
        });
    });

    it("rejects setting a role with unsupported TLD (.xyz) during edit", async () => {
        const unsupportedTldAddress = "moderator.xyz";

        // subplebbit.edit() should reject unsupported TLD domain in roles
        await expect(
            subplebbit.edit({
                roles: {
                    ...subplebbit.roles,
                    [unsupportedTldAddress]: { role: "moderator" }
                }
            })
        ).rejects.toMatchObject({
            code: "ERR_ROLE_ADDRESS_DOMAIN_COULD_NOT_BE_RESOLVED"
        });
    });
});
