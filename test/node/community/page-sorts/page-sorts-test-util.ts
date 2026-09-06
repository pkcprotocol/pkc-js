import { mockPKC } from "../../../../dist/node/test/test-util.js";
import { vi } from "vitest";
import { of as calculateIpfsCidV0Lib } from "typestub-ipfs-only-hash";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { calculateStringSizeSameAsIpfsAddCidV0 } from "../../../../dist/node/util.js";
import env from "../../../../dist/node/version.js";

import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { CommentsTableRow, CommentsTableRowInsert } from "../../../../dist/node/publications/comment/types.js";
import type { PageGenerator } from "../../../../dist/node/runtime/node/community/page-generator.js";

// Deterministic page-sort tests: rows go straight into the community DB, IPFS adds are faked, and page
// generation is driven by calling the generator (or updateCommentsThatNeedToBeUpdated) directly. Same
// approach as test/node/community/page-generation/edgecases.page.generation.community.test.ts, trimmed to
// small comments so a whole board fits in one chunk unless a test asks for more.

export const NO_BUMP_KEYWORD_SORT_PATH = path.resolve(process.cwd(), "test/fixtures/page-sorts/active-no-bump-keyword.js");
export const THROWING_SORT_PATH = path.resolve(process.cwd(), "test/fixtures/page-sorts/throwing.js");

export interface CommunityContext {
    pkc: PKCType;
    community: LocalCommunity;
    cleanup: () => Promise<void>;
}

export interface TreeNode {
    label: string;
    timestamp?: number;
    content?: string;
    contentBytes?: number;
    children?: TreeNode[];
}

type TestCommentRow = { [K in keyof CommentsTableRow]: CommentsTableRow[K] | null };

const AUTHOR_ADDRESS = "12D3KooWLjZGiL8t2FyNZc21EMKw1SLR7U6khv4RW9sEFKD4aFXJ";
const DEFAULT_COMMENT_SIGNATURE = { type: "ed25519", signature: "sig", publicKey: "pk", signedPropertyNames: [] as string[] };

export function getPageGenerator(community: LocalCommunity): PageGenerator {
    return community._pageGenerator;
}

export async function createCommunityWithDefaultDb(pkcOptions?: Parameters<typeof mockPKC>[0]): Promise<CommunityContext> {
    const pkc: PKCType = await mockPKC(pkcOptions);
    const community = (await pkc.createCommunity()) as LocalCommunity;
    await community._dbHandler.initDbIfNeeded();
    await community._dbHandler.createOrMigrateTablesIfNeeded();
    const fakeIpfsClient = createFakeIpfsClient();
    vi.spyOn(community._clientsManager, "getDefaultKuboRpcClient").mockReturnValue({ _client: fakeIpfsClient } as unknown as ReturnType<
        typeof community._clientsManager.getDefaultKuboRpcClient
    >);
    return {
        pkc,
        community,
        cleanup: async () => {
            await community._dbHandler.destoryConnection();
            await community.delete();
            await pkc.destroy();
        }
    };
}

interface FakeIpfsClient {
    add: (content: string) => Promise<{ cid: string; path: string; size: number }>;
    pin: { rm: () => Promise<void> };
    files: { rm: () => Promise<void> };
    key: { rm: () => Promise<void> };
    routing: { provide: () => AsyncGenerator<never, void, unknown> };
}

function createFakeIpfsClient(): FakeIpfsClient {
    const noopAsync = async (): Promise<void> => {};
    return {
        add: async (content: string) => {
            const size = await calculateStringSizeSameAsIpfsAddCidV0(content);
            const cid = await calculateIpfsCidV0Lib(`${content.length}-${Math.random()}`);
            return { cid, path: cid, size };
        },
        pin: { rm: noopAsync },
        files: { rm: noopAsync },
        key: { rm: noopAsync },
        routing: {
            async *provide(): AsyncGenerator<never, void, unknown> {
                return;
            }
        }
    };
}

export async function seedComments(
    community: LocalCommunity,
    trees: TreeNode[]
): Promise<{ rows: TestCommentRow[]; cidOf: (label: string) => string }> {
    const rows: TestCommentRow[] = [];
    const labelToCid = new Map<string, string>();
    let timestampCursor = Math.floor(Date.now() / 1000) - 1000;

    async function traverse(node: TreeNode, depth: number, parentCid: string | null, rootCid: string | null): Promise<void> {
        const cid = await calculateIpfsCidV0Lib(`${node.label}-${randomUUID()}`);
        labelToCid.set(node.label, cid);
        const nodeTimestamp = node.timestamp ?? timestampCursor++;
        const authorSignerAddress = `${AUTHOR_ADDRESS}-${cid}`;
        const content =
            node.content ??
            (node.contentBytes ? `${node.label}-`.repeat(Math.ceil(node.contentBytes / (node.label.length + 1))) : node.label);
        rows.push({
            cid,
            authorSignerAddress,
            author: { address: authorSignerAddress, displayName: `Author ${node.label}` },
            link: null,
            linkWidth: null,
            linkHeight: null,
            thumbnailUrl: null,
            thumbnailUrlWidth: null,
            thumbnailUrlHeight: null,
            parentCid: depth === 0 ? null : parentCid,
            postCid: depth === 0 ? cid : rootCid ?? parentCid ?? cid,
            previousCid: null,
            communityPublicKey: community.signer.address,
            communityName: null,
            content,
            timestamp: nodeTimestamp,
            signature: JSON.parse(JSON.stringify(DEFAULT_COMMENT_SIGNATURE)),
            title: depth === 0 ? `title-${node.label}` : null,
            depth,
            linkHtmlTagName: null,
            flairs: null,
            spoiler: null,
            pendingApproval: null,
            nsfw: null,
            extraProps: null,
            protocolVersion: env.PROTOCOL_VERSION,
            insertedAt: nodeTimestamp
        });
        for (const child of node.children ?? []) await traverse(child, depth + 1, cid, rootCid ?? cid);
    }

    for (const tree of trees) await traverse(tree, 0, null, null);
    community._dbHandler.insertComments(rows as CommentsTableRowInsert[]);
    return {
        rows,
        cidOf: (label: string) => {
            const cid = labelToCid.get(label);
            if (!cid) throw new Error(`No seeded comment with label ${label}`);
            return cid;
        }
    };
}

export function sortedKeys(record: Record<string, unknown> | undefined): string[] {
    return Object.keys(record ?? {}).sort();
}
