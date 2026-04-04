import { beforeAll, afterAll, it } from "vitest";
import signers from "../../../../fixtures/signers.js";
import {
    createMockNameResolver,
    generateMockPost,
    publishWithExpectedResult,
    publishRandomPost,
    mockPlebbitV2,
    resolveWhenConditionIsTrue,
    publishRandomReply,
    waitTillReplyInParentPages
} from "../../../../../dist/node/test/test-util.js";
import type { Plebbit } from "../../../../../dist/node/plebbit/plebbit.js";
import type { CommentIpfsWithCidDefined } from "../../../../../dist/node/publications/comment/types.js";

const subplebbitAddress = signers[0].address;

// Helper type for required fields for test utilities
type CommentWithRequiredFields = Required<Pick<CommentIpfsWithCidDefined, "cid" | "parentCid"> & { communityAddress: string }>;

async function createPlebbitWithMockResolver({
    records = new Map<string, string | undefined>(),
    remotePlebbit = false,
    stubStorage = false,
    forceMockPubsub,
    plebbitOptions
}: {
    records?: Map<string, string | undefined>;
    remotePlebbit?: boolean;
    stubStorage?: boolean;
    forceMockPubsub?: boolean;
    plebbitOptions?: Parameters<typeof mockPlebbitV2>[0]["plebbitOptions"];
} = {}) {
    const plebbit = await mockPlebbitV2({
        remotePlebbit,
        stubStorage,
        forceMockPubsub,
        mockResolve: false,
        plebbitOptions: {
            ...plebbitOptions,
            nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records })]
        }
    });

    return { plebbit, records };
}

describe(`comment.clients.nameResolvers`, async () => {
    let plebbit: Plebbit;
    beforeAll(async () => {
        ({ plebbit } = await createPlebbitWithMockResolver({
            plebbitOptions: { dataPath: undefined },
            forceMockPubsub: false,
            stubStorage: false
        }));
    });
    afterAll(async () => {
        await plebbit.destroy();
    });
    it(`comment.clients.nameResolvers[resolverKey].state is stopped by default`, async () => {
        const mockPost = await generateMockPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
        expect(Object.keys(mockPost.clients.nameResolvers).length).to.be.greaterThanOrEqual(1);
        for (const resolverKey of Object.keys(mockPost.clients.nameResolvers))
            expect(mockPost.clients.nameResolvers[resolverKey].state).to.equal("stopped");
    });

    it(`Correct order of nameResolvers state when updating a comment whose sub is a domain - uncached`, async () => {
        const mockPost = await publishRandomPost({ communityAddress: "plebbit.bso", plebbit: plebbit });

        await mockPost.stop();

        const { plebbit: differentPlebbit } = await createPlebbitWithMockResolver({
            remotePlebbit: true,
            stubStorage: false
        });
        const updatingPost = await differentPlebbit.createComment({ cid: mockPost.cid });

        const expectedStates = ["resolving-community-name", "stopped"];

        const actualStates: string[] = [];

        const resolverKey = Object.keys(updatingPost.clients.nameResolvers)[0];

        updatingPost.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => actualStates.push(newState));

        await updatingPost.update();

        await resolveWhenConditionIsTrue({ toUpdate: updatingPost, predicate: async () => typeof updatingPost.updatedAt === "number" });

        await updatingPost.stop();

        expect(actualStates.slice(0, expectedStates.length)).to.deep.equal(expectedStates);

        await differentPlebbit.destroy();
    });

    it(`Correct order of nameResolvers state when updating a comment whose author address is a domain - uncached`, async () => {
        // Create a post with a domain as author address, signed with the correct signer
        const { plebbit } = await createPlebbitWithMockResolver({
            remotePlebbit: true,
            stubStorage: false
        });
        const mockPost = await publishRandomPost({
            communityAddress: subplebbitAddress,
            plebbit: plebbit,
            postProps: {
                author: { address: "plebbit.eth" },
                signer: signers[3]
            }
        });

        // Create a new plebbit instance to avoid caching
        const { plebbit: differentPlebbit } = await createPlebbitWithMockResolver({
            remotePlebbit: true,
            stubStorage: false
        });

        const updatingPost = await differentPlebbit.createComment({ cid: mockPost.cid });

        const expectedStates = ["resolving-author-name", "stopped"];
        const actualStates: string[] = [];

        const resolverKey = Object.keys(updatingPost.clients.nameResolvers)[0];

        updatingPost.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => actualStates.push(newState));

        await updatingPost.update();

        await resolveWhenConditionIsTrue({ toUpdate: updatingPost, predicate: async () => typeof updatingPost.updatedAt === "number" });

        await updatingPost.stop();

        expect(actualStates.slice(0, expectedStates.length)).to.deep.equal(expectedStates);

        await differentPlebbit.destroy();
    });

    it(`Correct order of nameResolvers state when updating a comment whose author address is a domain`, async () => {
        // Create a post with a domain as author address, signed with the correct signer
        const mockPost = await publishRandomPost({
            communityAddress: subplebbitAddress,
            plebbit: plebbit,
            postProps: {
                author: { address: "plebbit.eth" },
                signer: signers[3]
            }
        });

        // Create a new plebbit instance
        const { plebbit: differentPlebbit } = await createPlebbitWithMockResolver({
            remotePlebbit: true,
            stubStorage: false
        });

        const updatingPost = await differentPlebbit.createComment({ cid: mockPost.cid });

        const expectedStates = ["resolving-author-name", "stopped"];
        const actualStates: string[] = [];

        const resolverKey = Object.keys(updatingPost.clients.nameResolvers)[0];

        updatingPost.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => actualStates.push(newState));

        await updatingPost.update();

        await resolveWhenConditionIsTrue({ toUpdate: updatingPost, predicate: async () => typeof updatingPost.updatedAt === "number" });

        await updatingPost.stop();

        expect(actualStates.slice(0, expectedStates.length)).to.deep.equal(expectedStates);

        await differentPlebbit.destroy();
    });

    it(`correct order of nameResolvers state when publishing a comment to a sub with a domain address - uncached`, async () => {
        const { plebbit } = await createPlebbitWithMockResolver({
            remotePlebbit: true,
            stubStorage: false
        }); // need to use different plebbit so it won't use the memory cache of subplebbit for publishing
        const mockPost = await generateMockPost({ communityAddress: "plebbit.bso", plebbit: plebbit });
        const expectedStates = ["resolving-community-name", "stopped"];

        const actualStates: string[] = [];

        const resolverKey = Object.keys(mockPost.clients.nameResolvers)[0];

        mockPost.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => actualStates.push(newState));

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

        expect(actualStates).to.deep.equal(expectedStates);
        await plebbit.destroy();
    });

    it(`correct order of nameResolvers state when publishing a comment to a sub with a domain address - cached`, async () => {
        const { plebbit: localPlebbit } = await createPlebbitWithMockResolver({ stubStorage: false });

        // Pre-cache the subplebbit so _updatingSubplebbits has an entry
        await localPlebbit.getSubplebbit({ address: "plebbit.bso" });

        const mockPost = await generateMockPost({ communityAddress: "plebbit.bso", plebbit: localPlebbit });
        const expectedStates: string[] = []; // empty because sub is cached in _updatingSubplebbits

        const actualStates: string[] = [];

        const resolverKey = Object.keys(mockPost.clients.nameResolvers)[0];

        mockPost.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => actualStates.push(newState));

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

        expect(actualStates).to.deep.equal(expectedStates);
        await localPlebbit.destroy();
    });

    it(`nameResolvers state does not show resolving-author-name for reply page authors`, async () => {
        const mockPost = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
        const reply = await publishRandomReply({
            parentComment: mockPost as CommentIpfsWithCidDefined,
            plebbit: plebbit,
            commentProps: {
                author: { address: "plebbit.eth" },
                signer: signers[3]
            }
        });
        await waitTillReplyInParentPages(reply as CommentWithRequiredFields, plebbit); // make sure until reply is in mockPost.replies

        const { plebbit: differentPlebbit } = await createPlebbitWithMockResolver({
            remotePlebbit: true,
            stubStorage: true,
            plebbitOptions: { validatePages: true }
        });
        const loadedPost = await differentPlebbit.createComment({ cid: mockPost.cid });
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
