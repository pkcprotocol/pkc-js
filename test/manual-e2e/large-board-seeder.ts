// Seeds a LocalCommunity's database with a production-shaped board of posts and nested replies, large enough to
// exercise the publish pipeline at the scale of a real imageboard (issue #386). Every comment is a real
// CommentIpfs: signed by its author's own ed25519 signer, its cid the sha256 of its deterministic JSON, so
// `community.start()` re-adds it to kubo byte for byte (`_addCommentRowToIPFS` asserts the cid) and a remote
// client verifies every signature in the published pages. The challenge/pubsub flow is bypassed because it is
// the only way to get a million comments into a board in minutes rather than days; the rows written here are
// the rows `storeCommentInDb` writes for a comment that passed its challenge.
//
// Rows are flushed in batches so the seeder itself holds nothing board-sized: the board is streamed into
// SQLite the way the publish cycle streams it back out.
import { stringify as deterministicStringify } from "safe-stable-stringify";
import Logger from "@pkcprotocol/pkc-logger";
import { signComment } from "../../dist/node/signer/signatures.js";
import { createSigner } from "../../dist/node/signer/index.js";
import { getPKCAddressFromPublicKey } from "../../dist/node/signer/util.js";
import { calculateIpfsCidV0 } from "../../dist/node/util.js";
import { deriveCommentIpfsFromCommentTableRow } from "../../dist/node/runtime/node/util.js";
import { communityIdentityPublicKey } from "../../dist/node/runtime/node/community/local-community/identity.js";
import { cleanWireAuthor } from "../../dist/node/publications/publication-author.js";
import env from "../../dist/node/version.js";
import type { LocalCommunity } from "../../dist/node/runtime/node/community/local-community.js";
import type { PKC } from "../../dist/node/pkc/pkc.js";
import type {
    CommentIpfsType,
    CommentsTableRow,
    CommentsTableRowInsert,
    CommentOptionsToSign
} from "../../dist/node/publications/comment/types.js";
import type { SignerType } from "../../dist/node/signer/types.js";

// Free signer/verify helpers and raw clients take a required log (issue #493); tests use the process-default root
const testLog = Logger({ namespace: "pkc-js:test:large-board-seeder" });

export interface SeedLargeBoardOptions {
    community: LocalCommunity;
    pkc: PKC;
    posts: number;
    /** Replies per post, uniform in [minReplies, maxReplies]. About 20% of replies nest under an earlier reply. */
    minReplies: number;
    maxReplies: number;
    /** One author signer per this many posts; every comment is drawn from that author pool (issue #352). */
    postsPerAuthor: number;
    /** xorshift32 seed, so two runs produce the same board shape. Signers are fresh keys every run. */
    seed?: number;
    /** Rows per insert transaction. */
    batchSize?: number;
    /** Timestamp of the first post; posts are one minute apart, replies five seconds apart after their post. */
    firstPostTimestamp?: number;
    onProgress?: (progress: { posts: number; comments: number; elapsedMs: number }) => void;
}

export interface SeedLargeBoardResult {
    posts: number;
    replies: number;
    comments: number;
    authors: number;
    seedMs: number;
    /** Cid of the last post seeded, the one a client is expected to find first under `new`. */
    newestPostCid: string;
    /** One past the last seeded timestamp, so a later call can append to the same board. */
    nextTimestamp: number;
}

const CONTENT = "x".repeat(200); // the bench's entry size, so page byte sizes line up with its tables

export function makeDeterministicRandom(seed: number) {
    let state = seed >>> 0 || 1;
    const random = () => {
        // xorshift32
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return ((state >>> 0) % 1_000_000) / 1_000_000;
    };
    const randomInt = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
    return { random, randomInt };
}

// What storeCommentInDb builds for a comment that passed its challenge: the author-signed publication plus the
// fields the community adds (depth; link and previousCid props are not needed for a text board), the wire author
// cleaned of runtime fields, hashed to its cid. Nothing else is in the IPFS bytes.
export async function buildSeededCommentRow({
    pkc,
    community,
    signer,
    depth,
    fields
}: {
    pkc: PKC;
    community: LocalCommunity;
    signer: SignerType;
    depth: number;
    fields: Pick<CommentOptionsToSign, "content" | "title" | "parentCid" | "postCid" | "timestamp">;
}): Promise<{ cid: string; row: CommentsTableRowInsert }> {
    // A wire author with no fields is dropped by cleanWireAuthor, which would leave the stored comment without the
    // `author` its signature names; production comments carry a displayName, so these do too. Whether a real
    // community does the same to a pubsub comment signed with `author: {}` is being investigated in issue #387.
    const toSign: CommentOptionsToSign = {
        ...fields,
        author: { displayName: `seeded ${signer.address.slice(-6)}` },
        protocolVersion: env.PROTOCOL_VERSION,
        communityPublicKey: communityIdentityPublicKey(community),
        communityAddress: community.address,
        signer
    };
    const signature = await signComment({ comment: toSign, pkc, log: testLog });
    const { signer: _signer, communityAddress: _communityAddress, ...publication } = toSign;
    const commentIpfs = <CommentIpfsType>{ ...publication, signature, depth };
    commentIpfs.author = cleanWireAuthor(commentIpfs.author)!;
    const cid = await calculateIpfsCidV0(deterministicStringify(commentIpfs));
    const row: CommentsTableRowInsert = {
        ...commentIpfs,
        cid,
        postCid: commentIpfs.postCid ?? cid,
        authorSignerAddress: getPKCAddressFromPublicKey(signature.publicKey),
        insertedAt: fields.timestamp!
    };
    return { cid, row };
}

export async function seedLargeBoard(opts: SeedLargeBoardOptions): Promise<SeedLargeBoardResult> {
    const { community, pkc, posts: POSTS, minReplies, maxReplies, postsPerAuthor } = opts;
    const batchSize = opts.batchSize ?? 5000;
    const { random, randomInt } = makeDeterministicRandom(opts.seed ?? 1);
    const authorCount = Math.max(1, Math.ceil(POSTS / postsPerAuthor));
    const authors: SignerType[] = [];
    for (let i = 0; i < authorCount; i++) authors.push(await createSigner());
    const db = community._dbHandler;
    const start = performance.now();
    const base = opts.firstPostTimestamp ?? Math.floor(Date.now() / 1000) - POSTS * 60 - 3600;

    let rows: CommentsTableRowInsert[] = [];
    let replyTotal = 0;
    let newestPostCid = "";
    let authorCounter = 0;
    let reconstructionChecks = 0;
    const flush = () => {
        if (!rows.length) return;
        db.createTransaction();
        try {
            db.insertComments(rows);
            db.commitTransaction();
        } catch (e) {
            db.rollbackTransaction();
            throw e;
        }
        rows = [];
    };
    const nextAuthor = () => authors[authorCounter++ % authors.length];
    const push = async (row: CommentsTableRowInsert) => {
        // The first rows are checked the way start() checks every row: the CommentIpfs derived back from the row
        // must hash to the row's cid, or the repin walk throws on the board's first comment.
        if (reconstructionChecks < 100) {
            reconstructionChecks++;
            const derivedCid = await calculateIpfsCidV0(
                deterministicStringify(deriveCommentIpfsFromCommentTableRow(<CommentsTableRow>row))
            );
            if (derivedCid !== row.cid)
                throw new Error(`seeded comment ${row.cid} does not reconstruct from its row (derived ${derivedCid})`);
        }
        rows.push(row);
        if (rows.length >= batchSize) flush();
    };

    let nextTimestamp = base;
    for (let i = 0; i < POSTS; i++) {
        const postTimestamp = base + i * 60;
        const post = await buildSeededCommentRow({
            pkc,
            community,
            signer: nextAuthor(),
            depth: 0,
            fields: { title: `post ${i}`, content: CONTENT, timestamp: postTimestamp }
        });
        await push(post.row);
        newestPostCid = post.cid;
        const replyCount = randomInt(minReplies, maxReplies);
        const replies: { cid: string; depth: number }[] = [];
        for (let r = 0; r < replyCount; r++) {
            const nested = replies.length > 0 && random() < 0.2 ? replies[randomInt(0, replies.length - 1)] : undefined;
            const timestamp = postTimestamp + (r + 1) * 5;
            const depth = nested ? nested.depth + 1 : 1;
            const reply = await buildSeededCommentRow({
                pkc,
                community,
                signer: nextAuthor(),
                depth,
                fields: { content: CONTENT, parentCid: nested ? nested.cid : post.cid, postCid: post.cid, timestamp }
            });
            await push(reply.row);
            replies.push({ cid: reply.cid, depth });
            nextTimestamp = Math.max(nextTimestamp, timestamp + 5);
        }
        replyTotal += replyCount;
        nextTimestamp = Math.max(nextTimestamp, postTimestamp + 60);
        if (opts.onProgress && (i + 1) % 1000 === 0)
            opts.onProgress({ posts: i + 1, comments: i + 1 + replyTotal, elapsedMs: performance.now() - start });
    }
    flush();
    return {
        posts: POSTS,
        replies: replyTotal,
        comments: POSTS + replyTotal,
        authors: authorCount,
        seedMs: Math.round(performance.now() - start),
        newestPostCid,
        nextTimestamp
    };
}
