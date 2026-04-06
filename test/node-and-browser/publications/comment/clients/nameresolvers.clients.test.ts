import { beforeAll, afterAll, it } from "vitest";
import signers from "../../../../fixtures/signers.js";
import {
    createMockNameResolver,
    generateMockPost,
    publishWithExpectedResult,
    publishRandomPost,
    mockPKCV2,
    resolveWhenConditionIsTrue,
    publishRandomReply,
    waitTillReplyInParentPages,
    describeSkipIfRpc
} from "../../../../../dist/node/test/test-util.js";
import type { PKC } from "../../../../../dist/node/pkc/pkc.js";
import type { CommentIpfsWithCidDefined } from "../../../../../dist/node/publications/comment/types.js";

const communityAddress = signers[0].address;

// Helper type for required fields for test utilities
type CommentWithRequiredFields = Required<Pick<CommentIpfsWithCidDefined, "cid" | "parentCid"> & { communityAddress: string }>;

async function createPKCWithMockResolver({
    records = new Map<string, string | undefined>(),
    remotePKC = false,
    stubStorage = false,
    forceMockPubsub,
    plebbitOptions
}: {
    records?: Map<string, string | undefined>;
    remotePKC?: boolean;
    stubStorage?: boolean;
    forceMockPubsub?: boolean;
    plebbitOptions?: Parameters<typeof mockPKCV2>[0]["plebbitOptions"];
} = {}) {
    const pkc = await mockPKCV2({
        remotePKC,
        stubStorage,
        forceMockPubsub,
        mockResolve: false,
        plebbitOptions: {
            ...plebbitOptions,
            nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records })]
        }
    });

    return { plebbit: pkc, records };
}

// RPC clients don't have nameResolvers clients — name resolution happens server-side, so resolver state is not exposed to the client
describeSkipIfRpc(`comment.clients.nameResolvers`, async () => {
    let pkc: PKC;
    beforeAll(async () => {
        ({ plebbit: pkc } = await createPKCWithMockResolver({
            plebbitOptions: { dataPath: undefined },
            forceMockPubsub: false,
            stubStorage: false
        }));
    });
    afterAll(async () => {
        await pkc.destroy();
    });
    it(`comment.clients.nameResolvers[resolverKey].state is stopped by default`, async () => {
        const mockPost = await generateMockPost({ communityAddress: communityAddress, plebbit: pkc });
        expect(Object.keys(mockPost.clients.nameResolvers).length).to.be.greaterThanOrEqual(1);
        for (const resolverKey of Object.keys(mockPost.clients.nameResolvers))
            expect(mockPost.clients.nameResolvers[resolverKey].state).to.equal("stopped");
    });

    it(`Correct order of nameResolvers state when updating a comment whose sub is a domain - uncached`, async () => {
        const mockPost = await publishRandomPost({ communityAddress: "plebbit.bso", plebbit: pkc });

        await mockPost.stop();

        const { plebbit: differentPKC } = await createPKCWithMockResolver({
            remotePKC: true,
            stubStorage: false
        });
        const updatingPost = await differentPKC.createComment({ cid: mockPost.cid });

        const expectedStates = ["resolving-community-name", "stopped"];

        const actualStates: string[] = [];

        const resolverKey = Object.keys(updatingPost.clients.nameResolvers)[0];

        updatingPost.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => actualStates.push(newState));

        await updatingPost.update();

        await resolveWhenConditionIsTrue({ toUpdate: updatingPost, predicate: async () => typeof updatingPost.updatedAt === "number" });

        await updatingPost.stop();

        expect(actualStates.slice(0, expectedStates.length)).to.deep.equal(expectedStates);

        await differentPKC.destroy();
    });

    it(`Correct order of nameResolvers state when updating a comment whose author address is a domain - uncached`, async () => {
        // Create a post with a domain as author address, signed with the correct signer
        const { plebbit: pkc } = await createPKCWithMockResolver({
            remotePKC: true,
            stubStorage: false
        });
        const mockPost = await publishRandomPost({
            communityAddress: communityAddress,
            plebbit: pkc,
            postProps: {
                author: { address: "plebbit.eth" },
                signer: signers[3]
            }
        });

        // Create a new pkc instance to avoid caching
        const { plebbit: differentPKC } = await createPKCWithMockResolver({
            remotePKC: true,
            stubStorage: false
        });

        const updatingPost = await differentPKC.createComment({ cid: mockPost.cid });

        const expectedStates = ["resolving-author-name", "stopped"];
        const actualStates: string[] = [];

        const resolverKey = Object.keys(updatingPost.clients.nameResolvers)[0];

        updatingPost.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => actualStates.push(newState));

        await updatingPost.update();

        await resolveWhenConditionIsTrue({ toUpdate: updatingPost, predicate: async () => typeof updatingPost.updatedAt === "number" });

        await updatingPost.stop();

        expect(actualStates.slice(0, expectedStates.length)).to.deep.equal(expectedStates);

        await differentPKC.destroy();
    });

    it(`Correct order of nameResolvers state when updating a comment whose author address is a domain`, async () => {
        // Create a post with a domain as author address, signed with the correct signer
        const mockPost = await publishRandomPost({
            communityAddress: communityAddress,
            plebbit: pkc,
            postProps: {
                author: { address: "plebbit.eth" },
                signer: signers[3]
            }
        });

        // Create a new pkc instance
        const { plebbit: differentPKC } = await createPKCWithMockResolver({
            remotePKC: true,
            stubStorage: false
        });

        const updatingPost = await differentPKC.createComment({ cid: mockPost.cid });

        const expectedStates = ["resolving-author-name", "stopped"];
        const actualStates: string[] = [];

        const resolverKey = Object.keys(updatingPost.clients.nameResolvers)[0];

        updatingPost.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => actualStates.push(newState));

        await updatingPost.update();

        await resolveWhenConditionIsTrue({ toUpdate: updatingPost, predicate: async () => typeof updatingPost.updatedAt === "number" });

        await updatingPost.stop();

        expect(actualStates.slice(0, expectedStates.length)).to.deep.equal(expectedStates);

        await differentPKC.destroy();
    });

    it(`correct order of nameResolvers state when publishing a comment to a sub with a domain address - uncached`, async () => {
        const { plebbit: pkc } = await createPKCWithMockResolver({
            remotePKC: true,
            stubStorage: false
        }); // need to use different plebbit so it won't use the memory cache of subplebbit for publishing
        const mockPost = await generateMockPost({ communityAddress: "plebbit.bso", plebbit: pkc });
        const expectedStates = ["resolving-community-name", "stopped"];

        const actualStates: string[] = [];

        const resolverKey = Object.keys(mockPost.clients.nameResolvers)[0];

        mockPost.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => actualStates.push(newState));

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

        expect(actualStates).to.deep.equal(expectedStates);
        await pkc.destroy();
    });

    it(`correct order of nameResolvers state when publishing a comment to a sub with a domain address - cached`, async () => {
        const { plebbit: localPKC } = await createPKCWithMockResolver({ stubStorage: false });

        // Pre-cache the community so _updatingCommunitys has an entry
        await localPKC.getCommunity({ address: "plebbit.bso" });

        const mockPost = await generateMockPost({ communityAddress: "plebbit.bso", plebbit: localPKC });
        const expectedStates: string[] = []; // empty because sub is cached in _updatingCommunitys

        const actualStates: string[] = [];

        const resolverKey = Object.keys(mockPost.clients.nameResolvers)[0];

        mockPost.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => actualStates.push(newState));

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

        expect(actualStates).to.deep.equal(expectedStates);
        await localPKC.destroy();
    });

    it(`nameResolvers state does not show resolving-author-name for reply page authors`, async () => {
        const mockPost = await publishRandomPost({ communityAddress: communityAddress, plebbit: pkc });
        const reply = await publishRandomReply({
            parentComment: mockPost as CommentIpfsWithCidDefined,
            plebbit: pkc,
            commentProps: {
                author: { address: "plebbit.eth" },
                signer: signers[3]
            }
        });
        await waitTillReplyInParentPages(reply as CommentWithRequiredFields, pkc); // make sure until reply is in mockPost.replies

        const { plebbit: differentPKC } = await createPKCWithMockResolver({
            remotePKC: true,
            stubStorage: true,
            plebbitOptions: { validatePages: true }
        });
        const loadedPost = await differentPKC.createComment({ cid: mockPost.cid });
        const actualStates: string[] = [];

        const resolverKey = Object.keys(loadedPost.clients.nameResolvers)[0];

        loadedPost.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => actualStates.push(newState));

        await loadedPost.update();

        await resolveWhenConditionIsTrue({ toUpdate: loadedPost, predicate: async () => typeof loadedPost.updatedAt === "number" });

        await loadedPost.stop();

        // The post itself has no domain author, so the post's nameResolver should not show resolving-author-name.
        // Reply page authors are resolved through the plebbit-level manager, not the comment's.
        const authorNameStates = actualStates.filter((s) => s === "resolving-author-name");
        expect(authorNameStates).to.have.length(0);
    });
});
