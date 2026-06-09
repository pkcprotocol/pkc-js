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
import net from "node:net";
import Database from "better-sqlite3";
import PKC from "../../../dist/node/index.js";
import PKCWsServer from "../../../dist/node/rpc/src/index.js";
import {
    mockPKC,
    mockPKCNoDataPathWithOnlyKuboClient,
    mockRpcRemotePKC,
    mockRpcServerPKC,
    mockRpcServerForTests,
    createSubWithNoChallenge,
    publishRandomPost,
    resolveWhenConditionIsTrue,
    getAvailablePKCConfigsToTestAgainst
} from "../../../dist/node/test/test-util.js";
import { itSkipIfRpc, itIfRpc, describeIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { CommunityExportRecord } from "../../../dist/node/community/types.js";

type PKCWsServerType = Awaited<ReturnType<typeof PKCWsServer.PKCWsServer>>;

// Find a free TCP port so the in-process RPC servers below never collide with the shared test
// servers (39652/39653) or each other when suites run in parallel.
async function getAvailablePort(startPort = 39820): Promise<number> {
    for (let port = startPort; port < startPort + 100; port++) {
        try {
            return await new Promise<number>((resolve, reject) => {
                const server = net.createServer();
                server.unref();
                server.on("error", reject);
                server.listen(port, () => {
                    server.close(() => resolve(port));
                });
            });
        } catch {
            continue;
        }
    }
    throw new Error(`No available port found in range ${startPort}-${startPort + 99}`);
}

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

interface WaitForRecordOptions {
    community: AnyLocalCommunity;
    exportId: string;
    predicate: (r: CommunityExportRecord | undefined) => boolean;
    timeoutMs?: number;
}

async function waitForRecord({
    community,
    exportId,
    predicate,
    timeoutMs = 30_000
}: WaitForRecordOptions): Promise<CommunityExportRecord | undefined> {
    // Fast path: if the predicate is already satisfied by the current state, return
    // immediately without depending on a future event.
    const initial = community.exports.find((r) => r.exportId === exportId);
    if (predicate(initial)) return initial;

    // Otherwise, derive state from the exportschange event payload itself rather than
    // re-reading community.exports. The records array delivered by the emitter is the
    // authoritative wire-level snapshot, and using it ensures the test actually verifies
    // that an event was emitted with the expected record fields.
    let timer: NodeJS.Timeout | undefined;
    return await new Promise<CommunityExportRecord | undefined>((resolve, reject) => {
        const listener = (records: CommunityExportRecord[]) => {
            const rec = records.find((r) => r.exportId === exportId);
            if (predicate(rec)) {
                community.removeListener("exportschange", listener);
                if (timer) clearTimeout(timer);
                resolve(rec);
            }
        };
        community.on("exportschange", listener);
        timer = setTimeout(() => {
            community.removeListener("exportschange", listener);
            reject(new Error(`Timed out waiting on export ${exportId} predicate`));
        }, timeoutMs);
    });
}

interface WaitForCompleteRecordOptions {
    community: AnyLocalCommunity;
    exportId: string;
    timeoutMs?: number;
}

async function waitForCompleteRecord({
    community,
    exportId,
    timeoutMs = 30_000
}: WaitForCompleteRecordOptions): Promise<CommunityExportRecord> {
    const rec = await waitForRecord({
        community,
        exportId,
        predicate: (r) => r?.progress === 1 || Boolean(r?.error),
        timeoutMs
    });
    if (rec?.error) throw new Error(`Export failed: ${rec.error.code}: ${rec.error.message}`);
    return rec!;
}

// Portable test bodies — shared between the started-community matrix (embedded + RPC) and the
// non-started RPC sub-suite below. Each test body grabs pkc/community/isEmbedded via the getter
// so it sees the values populated by the enclosing beforeAll, not stale undefineds from module
// load time.
function defineExportTests(getCtx: () => { pkc: PKCType; community: AnyLocalCommunity; isEmbedded: boolean; postCid: string }) {
    it("happy path: file is reachable, sha256 matches, sqlite is readable", async () => {
        const { community } = getCtx();
        const { exportId } = await community.export();
        const rec = await waitForCompleteRecord({ community, exportId });
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

    it("a post published to the community appears in the exported database's comments table", async () => {
        const { community, postCid } = getCtx();
        // postCid was published by the enclosing beforeAll (publishing requires the community
        // running, which the non-started RPC suite no longer has — so reuse the bootstrap post
        // rather than publishing a fresh one here).
        expect(postCid.length).to.be.greaterThan(0);

        const { exportId } = await community.export();
        const rec = await waitForCompleteRecord({ community, exportId });
        const { filePath, cleanup } = await materializeExport(rec);
        try {
            const db = new Database(filePath, { readonly: true });
            try {
                const row = db.prepare("SELECT cid FROM comments WHERE cid = ?").get(postCid) as { cid: string } | undefined;
                expect(row, `published post ${postCid} should be present in the exported comments table`).toBeDefined();
                expect(row!.cid).to.equal(postCid);
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
        const rec = await waitForCompleteRecord({ community, exportId });
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

    // Note: the inverse — an RPC server with allowPrivateKeyExport:false rejecting a client's
    // includePrivateKey:true request with ERR_PRIVATE_KEY_EXPORT_NOT_ALLOWED — is covered by the
    // dedicated "RPC private-key policy" suite at the bottom, which spins up its own server with
    // that policy (the shared test server defaults allowPrivateKeyExport to true).
    it("includePrivateKey: true preserves the signer.privateKey", async () => {
        const { community } = getCtx();
        const { exportId } = await community.export({ includePrivateKey: true });
        const rec = await waitForCompleteRecord({ community, exportId });
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
        const rec = await waitForCompleteRecord({ community, exportId });
        expect(existsSync(customPath)).to.equal(true);
        expect(fileURLToPath(new URL(rec.url!))).to.equal(customPath);
        await fsPromises.rm(customPath, { force: true });
    });

    // RPC: skipped — exportPath is embedded-only, and the live-DB path lives on the server's fs,
    // not the client's. The sync rejection on exportPath itself is covered by the RPC-only suite.
    itSkipIfRpc("exportPath resolving to the live community DB rejects with ERR_EXPORT_PATH_TARGETS_LIVE_DB", async () => {
        const { pkc, community } = getCtx();
        // The live community DB lives at <dataPath>/communities/<address>. Pointing exportPath at it
        // would clobber the running DB, so export() must reject synchronously and create no record.
        const liveDbPath = path.join(pkc.dataPath!, "communities", community.address);
        const exportsBefore = community.exports.length;
        await expect(community.export({ exportPath: liveDbPath })).rejects.toMatchObject({
            code: "ERR_EXPORT_PATH_TARGETS_LIVE_DB"
        });
        expect(community.exports.length).to.equal(exportsBefore);
    });

    // RPC: skipped — exportPath is embedded-only (RPC routes backups to the server's exports dir).
    // The async ERR_EXPORT_BACKUP_FAILED path is the same code on both transports, so the embedded
    // run exercises it. We force a deterministic backup failure by pointing exportPath under a
    // regular file, so backupCommunityDb's `mkdir -p` of the parent throws ENOTDIR.
    itSkipIfRpc("a backup failure records ERR_EXPORT_BACKUP_FAILED on the export record", async () => {
        const { community } = getCtx();
        const tmpDir = await fsPromises.mkdtemp(path.join((await import("node:os")).tmpdir(), "pkc-export-fail-"));
        const blockingFile = path.join(tmpDir, "not-a-dir");
        await fsPromises.writeFile(blockingFile, "i am a file, not a directory");
        // dirname of this path is `blockingFile`, which is a regular file — mkdir -p fails (ENOTDIR).
        const unwritablePath = path.join(blockingFile, "sub", "export.sqlite");

        try {
            const { exportId } = await community.export({ exportPath: unwritablePath });
            const rec = await waitForCompleteRecord({ community, exportId }).catch((e) => e as Error);
            // waitForCompleteRecord throws on a terminal-error record; recover the record either way.
            const record = community.exports.find((r) => r.exportId === exportId);
            expect(record?.error?.code).to.equal("ERR_EXPORT_BACKUP_FAILED");
            expect(record?.progress).to.not.equal(1);
            // The thrown helper error (if any) should also reflect the backup failure, not a timeout.
            if (rec instanceof Error) expect(rec.message).to.contain("ERR_EXPORT_BACKUP_FAILED");
        } finally {
            await fsPromises.rm(tmpDir, { recursive: true, force: true });
        }
    });

    it("exportschange fires for every transition with the full list", async () => {
        const { community } = getCtx();
        const seen: CommunityExportRecord[][] = [];
        const listener = (records: CommunityExportRecord[]) => seen.push(records);
        community.on("exportschange", listener);
        try {
            const { exportId } = await community.export();
            await waitForCompleteRecord({ community, exportId });

            // The community is shared across this suite and `exportschange` broadcasts the FULL
            // export list. Under RPC, events arrive asynchronously over the websocket, so a
            // lagging emission from a previous test's export can land in our listener before
            // this export's record is registered server-side — that snapshot won't contain this
            // exportId. Restrict the assertions to emissions that actually carry this exportId;
            // those are exactly this export's transitions, which is what the test verifies.
            const relevant = seen.filter((records) => records.some((r) => r.exportId === exportId));

            // At least: initial 0-progress emission + complete emission. Progress emissions may
            // be throttled to 0 if the DB is small enough that the backup finishes in one transfer.
            expect(relevant.length).to.be.greaterThanOrEqual(2);

            // Every relevant emission is an array containing a record for this exportId with the
            // identity-level fields populated.
            for (const records of relevant) {
                expect(Array.isArray(records)).to.equal(true);
                const rec = records.find((r) => r.exportId === exportId);
                expect(rec).toBeDefined();
                expect(rec!.exportId).to.equal(exportId);
                expect(typeof rec!.publicKey).to.equal("string");
                expect(rec!.publicKey.length).to.be.greaterThan(0);
                expect(typeof rec!.includePrivateKey).to.equal("boolean");
                expect(typeof rec!.progress).to.equal("number");
                expect(rec!.progress).to.be.greaterThanOrEqual(0);
                expect(rec!.progress).to.be.lessThanOrEqual(1);
            }

            // The first relevant emission is the initial enqueue: progress=0 and no terminal fields.
            const first = relevant[0].find((r) => r.exportId === exportId)!;
            expect(first.progress).to.equal(0);
            expect(first.url).to.equal(undefined);
            expect(first.size).to.equal(undefined);
            expect(first.sha256).to.equal(undefined);
            expect(first.error).to.equal(undefined);

            // The last relevant emission for this exportId is terminal-complete with all output fields.
            const last = relevant[relevant.length - 1].find((r) => r.exportId === exportId)!;
            expect(last.progress).to.equal(1);
            expect(typeof last.url).to.equal("string");
            expect(last.url!.length).to.be.greaterThan(0);
            expect(typeof last.sha256).to.equal("string");
            expect(last.sha256!).to.match(/^[0-9a-f]{64}$/);
            expect(typeof last.size).to.equal("number");
            expect(last.size!).to.be.greaterThan(0);
            expect(last.error).to.equal(undefined);

            // Per spec, the emitted records are deep-cloned snapshots: mutating one must not
            // affect community.exports.
            last.progress = 0.42;
            const live = community.exports.find((r) => r.exportId === exportId);
            expect(live?.progress).to.equal(1);
        } finally {
            community.removeListener("exportschange", listener);
        }
    });

    // Regression for the flaky failure at export.test.ts:346 (run 27196010884): because the
    // community is shared across this suite and `exportschange` carries the FULL export list, a
    // lagging broadcast from a previous test's export — delivered asynchronously over the RPC
    // websocket — could land in the listener before this export's record existed, so its snapshot
    // didn't contain this exportId and `expect(rec).toBeDefined()` blew up. We reproduce that
    // ordering deterministically by emitting a stale full-list snapshot (without our exportId)
    // right after attaching the listener, then assert the per-transition checks only consider
    // emissions that actually carry this exportId.
    it("ignores lagging exportschange broadcasts that predate this export", async () => {
        const { community } = getCtx();
        const seen: CommunityExportRecord[][] = [];
        const listener = (records: CommunityExportRecord[]) => seen.push(records);
        community.on("exportschange", listener);
        // A valid-but-unrelated record, standing in for a previous export still flushing events.
        const stalePriorId = "00000000-0000-4000-8000-000000000000";
        try {
            community.emit("exportschange", [{ exportId: stalePriorId, publicKey: "stale", includePrivateKey: false, progress: 1 }]);

            const { exportId } = await community.export();
            await waitForCompleteRecord({ community, exportId });

            // The stale snapshot is captured...
            expect(seen.some((records) => records.some((r) => r.exportId === stalePriorId))).to.equal(true);

            // ...but the per-transition assertions must only consider this export's emissions.
            const relevant = seen.filter((records) => records.some((r) => r.exportId === exportId));
            expect(relevant.length).to.be.greaterThanOrEqual(2);
            for (const records of relevant) {
                const rec = records.find((r) => r.exportId === exportId);
                expect(rec).toBeDefined();
            }
            // The first relevant emission is this export's enqueue (progress 0), never the stale one.
            expect(relevant[0].find((r) => r.exportId === exportId)!.progress).to.equal(0);
        } finally {
            community.removeListener("exportschange", listener);
        }
    });

    it("cancellation via AbortSignal records ERR_EXPORT_CANCELLED", async () => {
        const { pkc, community, isEmbedded } = getCtx();
        const ac = new AbortController();
        const { exportId } = await community.export({ signal: ac.signal });
        ac.abort();
        const rec = await waitForRecord({ community, exportId, predicate: (r) => Boolean(r?.error || r?.progress === 1) });
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
        const recA = await waitForCompleteRecord({ community, exportId: a });
        const recB = await waitForCompleteRecord({ community, exportId: b });
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
        let postCid: string;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            community = (await createSubWithNoChallenge({}, pkc)) as AnyLocalCommunity;
            await community.start();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            const post = await publishRandomPost({ communityAddress: community.address, pkc });
            postCid = post.cid!;
        });

        afterAll(async () => {
            await community.stop();
            await pkc.destroy();
        });

        defineExportTests(() => ({ pkc, community, isEmbedded: config.testConfigCode === "local-kubo-rpc", postCid }));
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
    let postCid: string;

    beforeAll(async () => {
        // Bootstrap: start once via pkcA so we can publish a post (publishing requires the
        // community running), then stop and disconnect. The community lives on disk after this.
        const pkcA = await mockRpcRemotePKC();
        const commA = (await createSubWithNoChallenge({}, pkcA)) as RpcLocalCommunity;
        await commA.start();
        await resolveWhenConditionIsTrue({ toUpdate: commA, predicate: async () => typeof commA.updatedAt === "number" });
        const post = await publishRandomPost({ communityAddress: commA.address, pkc: pkcA });
        postCid = post.cid!;
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

    defineExportTests(() => ({ pkc, community, isEmbedded: false, postCid }));
});

// RemoteCommunity rejection — same observable contract on both transports, but the setups
// don't share much, so each transport gets its own test. The embedded test spins up two
// separate PKCs (one with a dataPath, one without) to construct a read-only RemoteCommunity.
// The RPC test asks the daemon for an address the daemon doesn't host, which is what causes
// pkc-with-rpc-client.ts to return an RpcRemoteCommunity. Both variants assert the same
// ERR_COMMUNITY_NOT_LOCAL throw from the base RemoteCommunity.export().
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

    itIfRpc("an RpcRemoteCommunity rejects with ERR_COMMUNITY_NOT_LOCAL", async () => {
        const pkc = await mockRpcRemotePKC();
        try {
            // Fresh signer → address the RPC server has never seen as a community. With the
            // address absent from rpcCommunities, pkc-with-rpc-client.ts returns an
            // RpcRemoteCommunity (which doesn't override export()), so the call hits the base
            // RemoteCommunity.export() rejection client-side.
            const freshSigner = await pkc.createSigner();
            const remoteComm = await pkc.createCommunity({ address: freshSigner.address });
            expect(remoteComm).not.toBeInstanceOf(RpcLocalCommunity);
            await expect(remoteComm.export()).rejects.toMatchObject({ code: "ERR_COMMUNITY_NOT_LOCAL" });
        } finally {
            await pkc.destroy();
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
            const completed = await waitForCompleteRecord({ community: first, exportId });
            expect(completed.progress).to.equal(1);

            // Sibling instance in the same pkc mirrors from the started instance
            const sibling = (await pkc.createCommunity({ address: first.address })) as AnyLocalCommunity;
            expect(sibling.exports.find((r) => r.exportId === exportId)?.progress).to.equal(1);

            await first.stop();

            // Fresh PKC pointing at the same daemon. pkcInstancePromise() handles both flavors:
            // for local-kubo-rpc it forces local kubo options and defaults to the same .pkc dataPath
            // as `pkc`; for remote-pkc-rpc it yields a fresh RPC client to the same server.
            const pkc2 = await config.pkcInstancePromise();
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

    // The RPC counterpart to this — surviving disconnect mid-export — lives in the RPC-only
    // suite below at "client disconnect mid-export". Under embedded the destroy cancels the
    // export instead of letting it continue, so loadAndPruneExportsFromKeyv must keep the
    // resulting terminal-error record visible to a freshly constructed PKC on the same dataPath.
    itSkipIfRpc("a fresh PKC sees the in-flight record after destroy() persists its terminal state", async () => {
        const pkc = await mockPKC({});
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        for (let i = 0; i < 10; i++) await publishRandomPost({ communityAddress: community.address, pkc });

        const { exportId } = await community.export();
        await waitForRecord({ community, exportId, predicate: (r) => r !== undefined, timeoutMs: 5_000 });

        const dataPath = pkc.dataPath;
        const address = community.address;
        await pkc.destroy();

        const pkc2 = await mockPKC({ dataPath });
        try {
            const reloaded = (await pkc2.createCommunity({ address })) as LocalCommunity;
            const rec = reloaded.exports.find((r) => r.exportId === exportId);
            expect(rec).toBeDefined();
            const isTerminal = rec!.progress === 1 || Boolean(rec!.error);
            expect(isTerminal).to.equal(true);
            if (rec!.error) expect(rec!.error.code).to.equal("ERR_EXPORT_CANCELLED");
        } finally {
            await pkc2.destroy();
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

    it("HTTP download response carries sqlite content-type and matching content-length", async () => {
        const { exportId } = await community.export();
        const rec = await waitForCompleteRecord({ community, exportId });
        const res = await fetch(rec.url!);
        try {
            expect(res.status).to.equal(200);
            expect(res.headers.get("content-type")).to.equal("application/vnd.sqlite3");
            // Content-Length must equal the byte count advertised on the record.
            expect(res.headers.get("content-length")).to.equal(String(rec.size));
            const body = await res.arrayBuffer();
            expect(body.byteLength).to.equal(rec.size);
        } finally {
            // Body already consumed via arrayBuffer(); nothing to cancel.
        }
    });

    it("cancelExport for an unknown exportId is idempotent (resolves with success, no throw)", async () => {
        // Per spec, cancelExport is idempotent: an unknown exportId returns success without action.
        const result = await pkc._pkcRpcClient!.cancelExport({ exportId: "00000000-0000-0000-0000-000000000000" });
        expect(result.success).to.equal(true);
    });

    it("download cleans up the export server-side", async () => {
        const { exportId } = await community.export();
        const rec = await waitForCompleteRecord({ community, exportId });
        const res = await fetch(rec.url!);
        expect(res.status).to.equal(200);
        // Consume the body fully so the server fires its cleanup hook after the stream finishes.
        await res.arrayBuffer();

        // Wait for the cleanup-driven exportschange notification to propagate to the client.
        try {
            await waitForRecord({ community, exportId, predicate: (r) => r === undefined, timeoutMs: 5_000 });
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
        await waitForRecord({ community: heavyComm, exportId, predicate: (r) => r !== undefined, timeoutMs: 5_000 });

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

            const finalRec = await waitForCompleteRecord({ community: comm2, exportId });
            expect(finalRec.progress).to.equal(1);
            expect(finalRec.sha256).toBeDefined();
        } finally {
            await pkc2.destroy();
        }
    });
});

// RPC private-key policy — the shared test server defaults allowPrivateKeyExport to true, so to
// exercise the rejection path we stand up our own in-process RPC server with the policy disabled
// (mirroring how a public-RPC operator would configure it) and point a fresh client at it.
describeIfRpc(`community.export() — RPC private-key policy`, () => {
    const RPC_AUTH_KEY = "test-export-private-key-policy";
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let clientPKC: PKCType;
    let community: RpcLocalCommunity;
    let RPC_URL: string;

    beforeAll(async () => {
        serverPKC = await mockRpcServerPKC({ dataPath: path.join(process.cwd(), ".pkc-rpc-export-policy-test") });

        const rpcPort = await getAvailablePort();
        RPC_URL = `ws://localhost:${rpcPort}`;

        rpcServer = await PKCWsServer.PKCWsServer({
            port: rpcPort,
            authKey: RPC_AUTH_KEY,
            allowPrivateKeyExport: false,
            pkcOptions: {
                kuboRpcClientsOptions: ["http://localhost:15001/api/v0"],
                httpRoutersOptions: [],
                dataPath: serverPKC.dataPath
            }
        });

        const server = rpcServer as unknown as Record<string, Function>;
        server._initPKC(serverPKC);
        mockRpcServerForTests(rpcServer);

        clientPKC = await PKC({ pkcRpcClientsOptions: [RPC_URL], dataPath: undefined, httpRoutersOptions: [] });
        clientPKC.on("error", () => {});

        community = (await createSubWithNoChallenge({}, clientPKC)) as RpcLocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    });

    afterAll(async () => {
        if (community) await community.stop();
        if (clientPKC) await clientPKC.destroy();
        if (rpcServer) await rpcServer.destroy();
    });

    it("includePrivateKey: true rejects with ERR_PRIVATE_KEY_EXPORT_NOT_ALLOWED when the server forbids it", async () => {
        const exportsBefore = community.exports.length;
        await expect(community.export({ includePrivateKey: true })).rejects.toMatchObject({
            code: "ERR_PRIVATE_KEY_EXPORT_NOT_ALLOWED"
        });
        // The rejection is synchronous server-side (before any record is created), so no record
        // should have been appended for the refused request.
        expect(community.exports.length).to.equal(exportsBefore);
    });

    it("includePrivateKey: false still succeeds under the same policy", async () => {
        const { exportId } = await community.export({ includePrivateKey: false });
        const rec = await waitForCompleteRecord({ community, exportId });
        expect(rec.progress).to.equal(1);
        expect(rec.url).toBeDefined();
    });
});

// Out-of-band file deletion — embedded retention has no auto-delete, but a record whose backing
// file the user removed must be pruned from community.exports on the next community load (via
// loadAndPruneExportsFromKeyv). RPC is skipped: the file lives on the server fs (not the client's)
// and prune-on-load keys on file:// URLs.
describe(`community.export() — out-of-band file deletion`, async () => {
    itSkipIfRpc("a completed export whose file is deleted out of band is pruned from community.exports on next load", async () => {
        const pkc = await mockPKC({});
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        await publishRandomPost({ communityAddress: community.address, pkc });

        const { exportId } = await community.export();
        const rec = await waitForCompleteRecord({ community, exportId });
        const filePath = fileURLToPath(new URL(rec.url!));
        expect(existsSync(filePath)).to.equal(true);

        const dataPath = pkc.dataPath;
        const address = community.address;
        await community.stop();

        // Delete the backing file out of band, then reload on a fresh PKC at the same dataPath.
        await fsPromises.rm(filePath, { force: true });
        await pkc.destroy();

        const pkc2 = await mockPKC({ dataPath });
        try {
            const reloaded = (await pkc2.createCommunity({ address })) as LocalCommunity;
            // loadAndPruneExportsFromKeyv runs on community load and drops the record with a missing file.
            expect(reloaded.exports.find((r) => r.exportId === exportId)).to.equal(undefined);
        } finally {
            await pkc2.destroy();
        }
    });
});

// Private-key scrubbing scope — includePrivateKey:false must scrub the community signer's private
// material but intentionally leave pseudonymityAliases.aliasPrivateKey intact (those keys belong to
// the per-comment publication identity, not the community's own signing material). RPC is skipped:
// this needs embedded _dbHandler-style access and pseudonymity-mode publishing (also embedded-only
// in the pseudonymity feature suite).
describe(`community.export() — private-key scrubbing scope`, async () => {
    itSkipIfRpc("includePrivateKey:false scrubs the community signer but NOT pseudonymityAliases.aliasPrivateKey", async () => {
        const pkc = await mockPKC({});
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.edit({ features: { pseudonymityMode: "per-author" } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        // Publishing under per-author pseudonymity writes a pseudonymityAliases row carrying an aliasPrivateKey.
        await publishRandomPost({ communityAddress: community.address, pkc });

        const { exportId } = await community.export({ includePrivateKey: false });
        const rec = await waitForCompleteRecord({ community, exportId });
        const { filePath, cleanup } = await materializeExport(rec);
        try {
            const db = new Database(filePath, { readonly: true });
            try {
                // Community signer private material IS scrubbed...
                const row = db.prepare("SELECT value FROM keyv WHERE key = ?").get("keyv:INTERNAL_COMMUNITY") as
                    | { value: string }
                    | undefined;
                expect(row).toBeDefined();
                const parsed = JSON.parse(row!.value) as { value: { signer: ExportedSigner } };
                expect(parsed.value.signer.privateKey).to.equal(undefined);
                expect(parsed.value.signer.ipfsKey).to.equal(undefined);

                // ...but per-comment alias private keys are preserved.
                const aliasRows = db.prepare("SELECT aliasPrivateKey FROM pseudonymityAliases").all() as { aliasPrivateKey: string }[];
                expect(aliasRows.length, "expected at least one pseudonymityAliases row from the per-author post").to.be.greaterThan(0);
                for (const a of aliasRows) {
                    expect(typeof a.aliasPrivateKey).to.equal("string");
                    expect(a.aliasPrivateKey.length).to.be.greaterThan(0);
                }
            } finally {
                db.close();
            }
        } finally {
            await cleanup();
            await community.stop();
            await pkc.destroy();
        }
    });
});

// Different communities export in parallel — the spec promises per-community serialization but
// cross-community parallelism. Runs on both transports.
getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`community.export() — distinct communities export in parallel — ${config.name}`, async () => {
        it("two distinct communities export concurrently and both complete with distinct files", async () => {
            const pkc = await config.pkcInstancePromise();
            const commA = (await createSubWithNoChallenge({}, pkc)) as AnyLocalCommunity;
            const commB = (await createSubWithNoChallenge({}, pkc)) as AnyLocalCommunity;
            try {
                await Promise.all([commA.start(), commB.start()]);
                await Promise.all([
                    resolveWhenConditionIsTrue({ toUpdate: commA, predicate: async () => typeof commA.updatedAt === "number" }),
                    resolveWhenConditionIsTrue({ toUpdate: commB, predicate: async () => typeof commB.updatedAt === "number" })
                ]);
                await publishRandomPost({ communityAddress: commA.address, pkc });
                await publishRandomPost({ communityAddress: commB.address, pkc });

                const [{ exportId: idA }, { exportId: idB }] = await Promise.all([commA.export(), commB.export()]);
                const recA = await waitForCompleteRecord({ community: commA, exportId: idA });
                const recB = await waitForCompleteRecord({ community: commB, exportId: idB });
                expect(recA.progress).to.equal(1);
                expect(recB.progress).to.equal(1);
                expect(recA.url).to.not.equal(recB.url);

                const matA = await materializeExport(recA);
                const matB = await materializeExport(recB);
                try {
                    expect(existsSync(matA.filePath)).to.equal(true);
                    expect(existsSync(matB.filePath)).to.equal(true);
                } finally {
                    await matA.cleanup();
                    await matB.cleanup();
                }
            } finally {
                await commA.stop().catch(() => {});
                await commB.stop().catch(() => {});
                await pkc.destroy();
            }
        });
    });
});
