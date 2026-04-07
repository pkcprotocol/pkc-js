import signers from "../../fixtures/signers.js";

import { createMockNameResolver, processAllCommentsRecursively, mockPKCV2, createNewIpns } from "../../../dist/node/test/test-util.js";
import { signCommunity } from "../../../dist/node/signer/signatures.js";
import { it } from "vitest";
import { describeSkipIfRpc } from "../../../dist/node/test/test-util.js";
import type { InputPKCOptions } from "../../../dist/node/types.js";

const communityAddress = signers[9].address;

// Domain authors for the fixture: 3 domain comments + 1 non-domain
const domainAuthors = [
    { name: "alice.bso", signerIndex: 3 }, // resolver returns signers[3].address → nameResolved = true
    { name: "bob.bso", signerIndex: 0 }, // resolver returns signers[0].address → nameResolved = true
    { name: "carol.bso", signerIndex: 2 } // resolver returns undefined → nameResolved = false
] as const;

const expectedDomainNames = new Set(domainAuthors.map((a) => a.name));

function createTrackingResolver() {
    const resolvedDomains = new Set<string>();
    const records = new Map<string, string>([
        ["alice.bso", signers[3].address],
        ["bob.bso", signers[0].address]
        // carol.bso intentionally missing → resolves to undefined → nameResolved = false
    ]);

    const resolver = createMockNameResolver({
        records,
        resolveFunction: async ({ name }: { name: string }) => {
            resolvedDomains.add(name);
            const addr = records.get(name);
            return addr ? { publicKey: addr } : undefined;
        }
    });

    return { resolver, resolvedDomains };
}

function createRemotePKCWithTrackingResolver({ stubStorage = true }: { stubStorage?: boolean } = {}) {
    const { resolver, resolvedDomains } = createTrackingResolver();
    const pkcPromise = mockPKCV2({
        stubStorage,
        remotePKC: true,
        mockResolve: false,
        pkcOptions: {
            validatePages: false,
            nameResolvers: [resolver]
        }
    });
    return { pkcPromise, resolvedDomains };
}

async function createRemotePKCWithMockResolver({
    records = new Map<string, string | undefined>(),
    stubStorage = true,
    validatePages = false,
    nameResolvers
}: {
    records?: Map<string, string | undefined>;
    stubStorage?: boolean;
    validatePages?: boolean;
    nameResolvers?: InputPKCOptions["nameResolvers"];
} = {}) {
    const pkc = await mockPKCV2({
        stubStorage,
        remotePKC: true,
        mockResolve: false,
        pkcOptions: {
            validatePages,
            nameResolvers: nameResolvers || [createMockNameResolver({ includeDefaultRecords: true, records })]
        }
    });

    return { pkc, records };
}

// Build a minimal CommentIpfs-like object that passes CommentIpfsSchema.loose() parsing in pages.
// Signatures are dummy values since validatePages: false skips verification.
function buildPageComment({
    authorName,
    signerPublicKey,
    communityAddress: subAddr,
    cid,
    depth = 0
}: {
    authorName?: string;
    signerPublicKey: string;
    communityAddress: string;
    cid: string;
    depth?: number;
}) {
    const now = Math.floor(Date.now() / 1000);
    return {
        comment: {
            ...(authorName ? { author: { name: authorName } } : {}),
            content: `Fixture comment by ${authorName || "anon"} - ${cid}`,
            depth,
            communityAddress: subAddr,
            timestamp: now,
            protocolVersion: "1.0.0",
            signature: {
                publicKey: signerPublicKey,
                signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                signedPropertyNames: ["content", "author", "subplebbitAddress", "protocolVersion", "timestamp"],
                type: "ed25519"
            }
        },
        commentUpdate: {
            cid,
            upvoteCount: 0,
            downvoteCount: 0,
            replyCount: 0,
            updatedAt: now,
            protocolVersion: "1.0.0",
            signature: {
                publicKey: signerPublicKey,
                signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                signedPropertyNames: ["cid", "upvoteCount", "downvoteCount", "replyCount", "updatedAt", "protocolVersion"],
                type: "ed25519"
            }
        }
    };
}

// Create a static CommunityIpfs record published to IPNS with inline pages
// containing a known set of domain-author and non-domain comments.
async function createCommunityFixtureWithDomainAuthors() {
    const ipnsObj = await createNewIpns();
    const communityAddress = ipnsObj.signer.address;

    // Fetch a real CommunityIpfs to use as template
    const templatePKC = await mockPKCV2({ stubStorage: true, remotePKC: true });
    const templateSub = await templatePKC.createCommunity({ address: signers[1].address });
    await templateSub.update();
    await new Promise((resolve) => templateSub.once("update", resolve));
    const templateRecord = templateSub.raw.communityIpfs!;
    await templateSub.stop();
    await templatePKC.destroy();

    // Use CIDs from existing fixtures - these are valid CID v0 strings
    const fakeCids = [
        "QmeaD98zCjbs3h9GSCMixCGxMSJC3vUgW2i9pZoJpwkN7u",
        "Qmc93vcfpHhcscUMvXaJJTpk9CxCyMniAtxCmREF8LSBbS",
        "QmQ9mK33zshLf4Bj8dVSQimdbyXGgw5QFRoUQpsCqqz6We",
        "QmeBYYTTmRNmwbcSVw5TpdxsmR26HeNs8P47FYXQZ65NS1"
    ];

    const pageComments = [
        // 3 domain-author comments
        ...domainAuthors.map((da, i) =>
            buildPageComment({
                authorName: da.name,
                signerPublicKey: signers[da.signerIndex].publicKey,
                communityAddress: communityAddress,
                cid: fakeCids[i]
            })
        ),
        // 1 non-domain comment (no author.name)
        buildPageComment({
            signerPublicKey: signers[1].publicKey,
            communityAddress: communityAddress,
            cid: fakeCids[3]
        })
    ];

    const communityRecord = {
        ...templateRecord,
        posts: {
            pages: {
                hot: { comments: pageComments }
            }
        },
        pubsubTopic: communityAddress
    };

    communityRecord.signature = await signCommunity({ community: communityRecord, signer: ipnsObj.signer });
    await ipnsObj.publishToIpns(JSON.stringify(communityRecord));
    await ipnsObj.pkc.destroy();

    return { communityAddress };
}

// RPC clients don't have nameResolvers clients — name resolution happens server-side, so resolver state is not exposed to the client
describeSkipIfRpc(`community.clients.nameResolvers`, async () => {
    it(`community.clients.nameResolvers[resolverKey].state is stopped by default`, async () => {
        const { pkc } = await createRemotePKCWithMockResolver();
        const mockSub = await pkc.getCommunity({ address: communityAddress });
        expect(Object.keys(mockSub.clients.nameResolvers).length).to.be.greaterThanOrEqual(1);
        for (const resolverKey of Object.keys(mockSub.clients.nameResolvers))
            expect(mockSub.clients.nameResolvers[resolverKey].state).to.equal("stopped");
        await pkc.destroy();
    });

    it(`Correct order of nameResolvers state when sub pages has comments with author.address as domain - uncached`, async () => {
        // These tests can't work with RPC clients because:
        // - RPC clients have empty clients.nameResolvers (nameResolvers contain functions that can't be serialized over RPC, see pkc.ts)
        // - The RPC server resolves names server-side and doesn't transmit resolver state changes to the client
        // - Until the RPC protocol is extended to relay nameResolver state changes, these tests only exercise the non-RPC path

        // Create a static community with a known set of 3 domain-author + 1 non-domain comments
        const { communityAddress } = await createCommunityFixtureWithDomainAuthors();

        const { pkcPromise, resolvedDomains } = createRemotePKCWithTrackingResolver({ stubStorage: true });
        const pkc = await pkcPromise;
        const sub = await pkc.createCommunity({ address: communityAddress });

        const recordedStates: string[] = [];
        const resolverKey = Object.keys(sub.clients.nameResolvers)[0];
        sub.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => recordedStates.push(newState));

        const updatePromise = new Promise((resolve) => sub.once("update", resolve));
        await sub.update();
        await updatePromise;

        // Verify the pages loaded with the expected comments
        expect(sub.posts?.pages?.hot?.comments?.length).to.equal(domainAuthors.length + 1); // 3 domain + 1 non-domain

        const commentsWithDomainAuthor: { author: { address: string } }[] = [];
        processAllCommentsRecursively(
            sub.posts.pages.hot.comments,
            (comment: { author: { address: string } }) => comment.author.address.includes(".") && commentsWithDomainAuthor.push(comment)
        );
        expect(commentsWithDomainAuthor.length).to.equal(domainAuthors.length);

        // Wait for background resolution to complete by polling the resolver tracker.
        // Background resolution runs on the internal updating instance (not the user-facing one),
        // so we poll resolvedDomains rather than nameResolved on the user-facing pages.
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            if (resolvedDomains.size >= expectedDomainNames.size) break;
            await new Promise((r) => setTimeout(r, 100));
        }

        await sub.stop();

        // The mock resolver was called for exactly the 3 expected domains
        expect(resolvedDomains).to.deep.equal(expectedDomainNames);

        // Non-domain comment was NOT resolved
        expect(resolvedDomains.has(signers[1].address)).to.equal(false);

        // With concurrent resolution (pLimit), the resolver state transitions once to resolving-author-name
        // and once to stopped, regardless of how many authors are resolved through the same resolver key.
        expect(recordedStates).to.include("resolving-author-name");
        expect(recordedStates).to.include("stopped");
        expect(recordedStates[recordedStates.length - 1]).to.equal("stopped");

        await pkc.destroy();
    });

    it(`Correct order of nameResolvers state when updating a community that was created with pkc.createCommunity({address}) - uncached`, async () => {
        const { pkc: remotePKC } = await createRemotePKCWithMockResolver({
            stubStorage: true
        });
        const sub = await remotePKC.createCommunity({ address: "plebbit.bso" });

        const expectedStates = ["resolving-community-name", "stopped"];

        const recordedStates: string[] = [];

        const resolverKey = Object.keys(sub.clients.nameResolvers)[0];
        sub.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => recordedStates.push(newState));

        const updatePromise = new Promise((resolve) => sub.once("update", resolve));
        await sub.update();

        await updatePromise;

        await sub.stop();

        expect(recordedStates.slice(0, 2)).to.deep.equal(expectedStates);
        await remotePKC.destroy();
    });
});
