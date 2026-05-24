// Tests for community.export() — embedded LocalCommunity and RPC RpcLocalCommunity.
// Issue: https://github.com/pkcprotocol/pkc-js/issues/79
// Spec:  src/rpc/EXPORT_COMMUNITY_SPEC.md
//
// The matrix runs each test under whichever pkc-config the test runner selected
// (local-kubo-rpc for embedded, remote-pkc-rpc for RPC). Tests that exercise
// embedded-only semantics (fs straggler checks, exportPath, pkc.destroy() cancellation)
// are individually gated; tests that exercise RPC-only behaviors live in the
// RPC-only describe block at the bottom.
import { describe, beforeAll, afterAll, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { promises as fsPromises, existsSync, createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import Database from "better-sqlite3";
import {
    mockPKC,
    mockPKCNoDataPathWithOnlyKuboClient,
    mockRpcRemotePKC,
    createSubWithNoChallenge,
    publishRandomPost,
    resolveWhenConditionIsTrue,
    getAvailablePKCConfigsToTestAgainst
} from "../../../dist/node/test/test-util.js";
import { itSkipIfRpc, describeIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { CommunityExportRecord } from "../../../dist/node/community/types.js";

// Either flavor of community has `.export()`, `.exports`, `.signer`, and emits `exportschange`.
type AnyLocalCommunity = LocalCommunity | RpcLocalCommunity;

// Narrow shape of the signer entry inside the exported community's internalCommunity KeyV record.
// Private material is undefined after scrubbing; public material is always present.
interface ExportedSigner {
    privateKey?: string;
    ipfsKey?: Uint8Array;
    publicKey?: string;
    address?: string;
}

async function hashFile(p: string): Promise<string> {
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
        const s = createReadStream(p);
        s.on("data", (chunk) => hash.update(chunk));
        s.on("end", () => resolve());
        s.on("error", reject);
    });
    return hash.digest("hex");
}

// URL-agnostic helper: downloads HTTP-served exports to a local temp path so the rest of the
// assertions (sha256 verification, sqlite open) don't care whether the record came from the
// embedded path (file://) or the RPC HTTP endpoint (http://).
async function materializeExport(rec: CommunityExportRecord): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
    if (!rec.url) throw new Error("Export record has no url");
    const parsed = new URL(rec.url);
    if (parsed.protocol === "file:") return { filePath: fileURLToPath(parsed), cleanup: async () => {} };
    const out = path.join(".tmp", "test-downloads", `${rec.exportId}.sqlite`);
    await fsPromises.mkdir(path.dirname(out), { recursive: true });
    const res = await fetch(rec.url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    if (!res.body) throw new Error("No body in fetch response");
    await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(out));
    return { filePath: out, cleanup: async () => fsPromises.rm(out, { force: true }) };
}

async function waitForCompleteRecord(community: AnyLocalCommunity, exportId: string, timeoutMs = 30_000): Promise<CommunityExportRecord> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const rec = community.exports.find((r) => r.exportId === exportId);
        if (rec?.progress === 1) return rec;
        if (rec?.error) throw new Error(`Export failed: ${rec.error.code}: ${rec.error.message}`);
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for export ${exportId} to complete`);
}

async function waitForRecord(
    community: AnyLocalCommunity,
    exportId: string,
    predicate: (r: CommunityExportRecord | undefined) => boolean,
    timeoutMs = 30_000
): Promise<CommunityExportRecord | undefined> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const rec = community.exports.find((r) => r.exportId === exportId);
        if (predicate(rec)) return rec;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting on export ${exportId} predicate`);
}

// Portable test bodies — shared between the started-community matrix (embedded + RPC) and the
// non-started RPC sub-suite below. Each test body grabs pkc/community/isEmbedded via the getter
// so it sees the values populated by the enclosing beforeAll, not stale undefineds from module
// load time.
function defineExportTests(getCtx: () => { pkc: PKCType; community: AnyLocalCommunity; isEmbedded: boolean }) {
    it("happy path: file is reachable, sha256 matches, sqlite is readable", async () => {
        const { community } = getCtx();
        const { exportId } = await community.export();
        const rec = await waitForCompleteRecord(community, exportId);
        expect(rec.url).toBeDefined();

        const { filePath, cleanup } = await materializeExport(rec);
        try {
            const recomputed = await hashFile(filePath);
            expect(recomputed).to.equal(rec.sha256);
            const stat = await fsPromises.stat(filePath);
            expect(stat.size).to.equal(rec.size);
            const db = new Database(filePath, { readonly: true });
            try {
                const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
                expect(tables.some((t) => t.name === "comments")).to.equal(true);
                expect(tables.some((t) => t.name === "keyv")).to.equal(true);
            } finally {
                db.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("includePrivateKey: false (default) scrubs the signer.privateKey", async () => {
        const { community } = getCtx();
        const { exportId } = await community.export();
        const rec = await waitForCompleteRecord(community, exportId);
        const { filePath, cleanup } = await materializeExport(rec);
        try {
            const db = new Database(filePath, { readonly: true });
            try {
                const row = db.prepare("SELECT value FROM keyv WHERE key = ?").get("keyv:INTERNAL_COMMUNITY") as
                    | { value: string }
                    | undefined;
                expect(row).toBeDefined();
                const parsed = JSON.parse(row!.value) as { value: { signer: ExportedSigner } };
                expect(parsed.value.signer.privateKey).to.equal(undefined);
                expect(parsed.value.signer.ipfsKey).to.equal(undefined);
                expect(typeof parsed.value.signer.publicKey).to.equal("string");
                expect(typeof parsed.value.signer.address).to.equal("string");
            } finally {
                db.close();
            }
        } finally {
            await cleanup();
        }
    });

    it("includePrivateKey: true preserves the signer.privateKey", async () => {
        const { community } = getCtx();
        const { exportId } = await community.export({ includePrivateKey: true });
        const rec = await waitForCompleteRecord(community, exportId);
        const { filePath, cleanup } = await materializeExport(rec);
        try {
            const db = new Database(filePath, { readonly: true });
            try {
                const row = db.prepare("SELECT value FROM keyv WHERE key = ?").get("keyv:INTERNAL_COMMUNITY") as
                    | { value: string }
                    | undefined;
                expect(row).toBeDefined();
                const parsed = JSON.parse(row!.value) as { value: { signer: ExportedSigner } };
                // Under embedded mode the client holds the same privateKey the server wrote, so
                // we can do strict equality. The RPC client receives a scrubbed signer (no
                // privateKey transmitted on the wire), so we settle for an "is a string" check.
                const clientSigner = community.signer as { privateKey?: string } | undefined;
                if (clientSigner?.privateKey !== undefined) {
                    expect(parsed.value.signer.privateKey).to.equal(clientSigner.privateKey);
                } else {
                    expect(typeof parsed.value.signer.privateKey).to.equal("string");
                    expect(parsed.value.signer.privateKey!.length).to.be.greaterThan(0);
                }
            } finally {
                db.close();
            }
        } finally {
            await cleanup();
        }
    });

    // RPC: skipped — exportPath is embedded-only by spec. The RPC-only suite below verifies
    // that passing exportPath through an RPC client rejects synchronously.
    itSkipIfRpc("exportPath option writes to the caller-supplied location", async () => {
        const { community } = getCtx();
        const customPath = path.join(
            await fsPromises.mkdtemp(path.join((await import("node:os")).tmpdir(), "pkc-export-")),
            "custom.sqlite"
        );
        const { exportId } = await community.export({ exportPath: customPath });
        const rec = await waitForCompleteRecord(community, exportId);
        expect(existsSync(customPath)).to.equal(true);
        expect(fileURLToPath(new URL(rec.url!))).to.equal(customPath);
        await fsPromises.rm(customPath, { force: true });
    });

    it("exportschange fires for every transition with the full list", async () => {
        const { community } = getCtx();
        const seen: CommunityExportRecord[][] = [];
        const listener = (records: CommunityExportRecord[]) => seen.push(records);
        community.on("exportschange", listener);
        try {
            const { exportId } = await community.export();
            await waitForCompleteRecord(community, exportId);
            // At least: initial 0-progress emission + complete emission. Progress emissions may
            // be throttled to 0 if the DB is small enough that the backup finishes in one transfer.
            expect(seen.length).to.be.greaterThanOrEqual(2);
            const last = seen[seen.length - 1].find((r) => r.exportId === exportId);
            expect(last?.progress).to.equal(1);
        } finally {
            community.removeListener("exportschange", listener);
        }
    });

    it("cancellation via AbortSignal records ERR_EXPORT_CANCELLED", async () => {
        const { pkc, community, isEmbedded } = getCtx();
        const ac = new AbortController();
        const { exportId } = await community.export({ signal: ac.signal });
        ac.abort();
        const rec = await waitForRecord(community, exportId, (r) => Boolean(r?.error || r?.progress === 1));
        expect(rec?.error?.code).to.equal("ERR_EXPORT_CANCELLED");

        // Embedded-only: verify no straggler files on the local fs. Under RPC the server's
        // exports directory is not the client's, so this assertion would be meaningless.
        if (isEmbedded && pkc.dataPath) {
            const exportsDir = path.join(pkc.dataPath, "exports");
            if (existsSync(exportsDir)) {
                const stragglers = (await fsPromises.readdir(exportsDir)).filter((f) => f.includes(exportId));
                expect(stragglers).to.deep.equal([]);
            }
        }
    });

    it("pre-aborted signal rejects synchronously without creating a record", async () => {
        const { community } = getCtx();
        const ac = new AbortController();
        ac.abort(new Error("nope"));
        const exportsBefore = community.exports.length;
        await expect(community.export({ signal: ac.signal })).rejects.toThrow();
        expect(community.exports.length).to.equal(exportsBefore);
    });

    it("two concurrent exports of the same community both reach progress=1", async () => {
        const { community } = getCtx();
        const [{ exportId: a }, { exportId: b }] = await Promise.all([community.export(), community.export()]);
        const recA = await waitForCompleteRecord(community, a);
        const recB = await waitForCompleteRecord(community, b);
        expect(recA.progress).to.equal(1);
        expect(recB.progress).to.equal(1);
        expect(recA.exportId).to.not.equal(recB.exportId);

        const matA = await materializeExport(recA);
        try {
            expect(existsSync(matA.filePath)).to.equal(true);
        } finally {
            await matA.cleanup();
        }
        const matB = await materializeExport(recB);
        try {
            expect(existsSync(matB.filePath)).to.equal(true);
        } finally {
            await matB.cleanup();
        }
    });
}

// Started-community matrix — embedded (local-kubo-rpc) and RPC (remote-pkc-rpc).
getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`community.export() — ${config.name} (started)`, async () => {
        let pkc: PKCType;
        let community: AnyLocalCommunity;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            community = (await createSubWithNoChallenge({}, pkc)) as AnyLocalCommunity;
            await community.start();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            await publishRandomPost({ communityAddress: community.address, pkc });
        });

        afterAll(async () => {
            await community.stop();
            await pkc.destroy();
        });

        defineExportTests(() => ({ pkc, community, isEmbedded: config.testConfigCode === "local-kubo-rpc" }));
    });
});

// Non-started community over RPC — keeps the _exportCommunityInstances cache honest. When the
// community isn't in _startedCommunities, the server's _resolveLocalCommunityForExport falls
// through to pkc.createCommunity, which constructs a fresh LocalCommunity per call. Without the
// cache, exportCommunity and the eager exportsSubscribe would land on different instances and
// the export's exportschange would never reach the subscription's listener — every poll-based
// assertion here would time out.
describeIfRpc(`community.export() — RPC, non-started`, async () => {
    let pkc: PKCType;
    let community: RpcLocalCommunity;

    beforeAll(async () => {
        // Bootstrap: start once via pkcA so we can publish a post (publishing requires the
        // community running), then stop and disconnect. The community lives on disk after this.
        const pkcA = await mockRpcRemotePKC();
        const commA = (await createSubWithNoChallenge({}, pkcA)) as RpcLocalCommunity;
        await commA.start();
        await resolveWhenConditionIsTrue({ toUpdate: commA, predicate: async () => typeof commA.updatedAt === "number" });
        await publishRandomPost({ communityAddress: commA.address, pkc: pkcA });
        await commA.stop();
        const address = commA.address;
        await pkcA.destroy();

        // Fresh client. Do NOT call community.start() — every export call from this point hits
        // the non-started branch of _resolveLocalCommunityForExport and uses the cache.
        pkc = await mockRpcRemotePKC();
        community = (await pkc.createCommunity({ address })) as RpcLocalCommunity;
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    defineExportTests(() => ({ pkc, community, isEmbedded: false }));
});

// RemoteCommunity rejection — sets up its own no-dataPath PKC so the matrix doesn't apply.
// Kept embedded-only; under RPC the equivalent rejection happens server-side via the
// exportCommunity handler's ERR_COMMUNITY_NOT_LOCAL path, exercised when no LocalCommunity
// matches the identifier on the RPC daemon.
describe(`community.export() — error paths`, async () => {
    itSkipIfRpc("a read-only RemoteCommunity rejects with ERR_COMMUNITY_NOT_LOCAL", async () => {
        const pkc1 = await mockPKC({});
        const localComm = (await createSubWithNoChallenge({}, pkc1)) as LocalCommunity;
        await localComm.start();
        await resolveWhenConditionIsTrue({ toUpdate: localComm, predicate: async () => typeof localComm.updatedAt === "number" });

        const pkc2 = await mockPKCNoDataPathWithOnlyKuboClient();
        const remoteComm = await pkc2.createCommunity({ address: localComm.address });
        try {
            await expect(remoteComm.export()).rejects.toMatchObject({ code: "ERR_COMMUNITY_NOT_LOCAL" });
        } finally {
            await localComm.stop();
            await pkc1.destroy();
            await pkc2.destroy();
        }
    });
});

// Persistence: a fresh instance for the same community sees prior exports. Under embedded this
// goes through KeyV reload on a fresh PKC pointing at the same dataPath; under RPC it goes
// through the initial exportsSubscribe notification from a fresh client to the same server.
getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`pkc.createCommunity loads community.exports — ${config.name}`, async () => {
        it("a fresh instance for the same community sees prior exports", async () => {
            const pkc = await config.pkcInstancePromise();
            const first = (await createSubWithNoChallenge({}, pkc)) as AnyLocalCommunity;
            await first.start();
            await resolveWhenConditionIsTrue({ toUpdate: first, predicate: async () => typeof first.updatedAt === "number" });
            await publishRandomPost({ communityAddress: first.address, pkc });

            const { exportId } = await first.export();
            const completed = await waitForCompleteRecord(first, exportId);
            expect(completed.progress).to.equal(1);

            // Sibling instance in the same pkc mirrors from the started instance
            const sibling = (await pkc.createCommunity({ address: first.address })) as AnyLocalCommunity;
            expect(sibling.exports.find((r) => r.exportId === exportId)?.progress).to.equal(1);

            await first.stop();

            // Fresh PKC pointing at the same daemon. Embedded: same dataPath. RPC: fresh client.
            const pkc2 =
                config.testConfigCode === "local-kubo-rpc" ? await mockPKC({ dataPath: pkc.dataPath }) : await config.pkcInstancePromise();
            try {
                const reloaded = (await pkc2.createCommunity({ address: first.address })) as AnyLocalCommunity;
                const rec = reloaded.exports.find((r) => r.exportId === exportId);
                expect(rec?.progress).to.equal(1);
                expect(rec?.sha256).to.equal(completed.sha256);
            } finally {
                await pkc2.destroy();
                await pkc.destroy();
            }
        });
    });
});

// pkc.destroy() cancellation: embedded-only by spec. RPC client disconnect must NOT cancel
// the server's in-flight exports — the feature exists partly to survive disconnects. The
// disconnect-then-reconnect behavior is covered in the RPC-only suite below.
describe(`pkc.destroy() cancels in-flight exports`, async () => {
    itSkipIfRpc("aborts active exports and resolves cleanly", async () => {
        const pkc = await mockPKC({});
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        await publishRandomPost({ communityAddress: community.address, pkc });

        const { exportId } = await community.export();
        await pkc.destroy();

        const finalRec = community.exports.find((r) => r.exportId === exportId);
        if (finalRec) {
            const isTerminal = finalRec.progress === 1 || Boolean(finalRec.error);
            expect(isTerminal).to.equal(true);
        }
    });
});

// RPC-only behaviors — only the wire transport exposes these.
describeIfRpc(`community.export() — RPC-only`, async () => {
    let pkc: PKCType;
    let community: RpcLocalCommunity;

    beforeAll(async () => {
        pkc = await mockRpcRemotePKC();
        community = (await createSubWithNoChallenge({}, pkc)) as RpcLocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        await publishRandomPost({ communityAddress: community.address, pkc });
    });

    afterAll(async () => {
        await community.stop();
        await pkc.destroy();
    });

    it("exportPath rejects synchronously with ERR_EXPORT_PATH_NOT_SUPPORTED_OVER_RPC", async () => {
        await expect(community.export({ exportPath: "/tmp/whatever.sqlite" })).rejects.toMatchObject({
            code: "ERR_EXPORT_PATH_NOT_SUPPORTED_OVER_RPC"
        });
    });

    it("HTTP GET /exports/<unknown> returns 404", async () => {
        const httpOrigin = pkc._pkcRpcClient!.rpcHttpOrigin;
        const res = await fetch(`${httpOrigin}/exports/00000000-0000-0000-0000-000000000000`);
        expect(res.status).to.equal(404);
        await res.body?.cancel();
    });

    it("download cleans up the export server-side", async () => {
        const { exportId } = await community.export();
        const rec = await waitForCompleteRecord(community, exportId);
        const res = await fetch(rec.url!);
        expect(res.status).to.equal(200);
        // Consume the body fully so the server fires its cleanup hook after the stream finishes.
        await res.arrayBuffer();

        // Wait for the cleanup-driven exportschange notification to propagate to the client.
        try {
            await waitForRecord(community, exportId, (r) => r === undefined, 5_000);
        } catch {
            // Either the notification arrived (predicate met) or it didn't — the next assertion
            // is authoritative.
        }
        expect(community.exports.find((r) => r.exportId === exportId)).to.equal(undefined);

        // A second download attempt for the same exportId should now 404.
        const second = await fetch(rec.url!);
        expect(second.status).to.equal(404);
        await second.body?.cancel();
    });

    it("client disconnect mid-export: reconnecting client sees the record (survives disconnect)", async () => {
        // Publish multiple posts so the backup spans multiple progress emissions and the export
        // is more likely to still be in-flight when we disconnect.
        const heavyPkc = await mockRpcRemotePKC();
        const heavyComm = (await createSubWithNoChallenge({}, heavyPkc)) as RpcLocalCommunity;
        await heavyComm.start();
        await resolveWhenConditionIsTrue({ toUpdate: heavyComm, predicate: async () => typeof heavyComm.updatedAt === "number" });
        for (let i = 0; i < 10; i++) await publishRandomPost({ communityAddress: heavyComm.address, pkc: heavyPkc });

        const { exportId } = await heavyComm.export();
        // The record must be observable before we disconnect; the export may already be complete,
        // both outcomes are acceptable.
        await waitForRecord(heavyComm, exportId, (r) => r !== undefined, 5_000);

        const address = heavyComm.address;
        await heavyPkc.destroy();

        const pkc2 = await mockRpcRemotePKC();
        try {
            const comm2 = (await pkc2.createCommunity({ address })) as RpcLocalCommunity;
            const survivor = comm2.exports.find((r) => r.exportId === exportId);
            expect(survivor).toBeDefined();
            // The export must NOT have been cancelled by the disconnect — the whole point of
            // persisting records server-side is to survive client disconnects.
            expect(survivor?.error).to.equal(undefined);

            const finalRec = await waitForCompleteRecord(comm2, exportId);
            expect(finalRec.progress).to.equal(1);
            expect(finalRec.sha256).toBeDefined();
        } finally {
            await pkc2.destroy();
        }
    });
});
