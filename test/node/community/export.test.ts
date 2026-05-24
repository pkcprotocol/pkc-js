// Tests for community.export() — embedded (LocalCommunity) path.
// Issue: https://github.com/pkcprotocol/pkc-js/issues/79
// Spec:  src/rpc/EXPORT_COMMUNITY_SPEC.md
import { describe, beforeAll, afterAll, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { promises as fsPromises, existsSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import {
    mockPKC,
    mockPKCNoDataPathWithOnlyKuboClient,
    createSubWithNoChallenge,
    publishRandomPost,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { itSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { CommunityExportRecord } from "../../../dist/node/community/types.js";

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

async function waitForCompleteRecord(community: LocalCommunity, exportId: string, timeoutMs = 30_000): Promise<CommunityExportRecord> {
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
    community: LocalCommunity,
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

// All tests below are skipped under RPC because this PR only ships the embedded export path.
// The RPC wire protocol (exportCommunity / exportsSubscribe / cancelExport) and the HTTP
// download endpoint are deferred to a follow-up PR (tracked on issue #79), at which point a
// matching test suite will live under test/node-and-browser/rpc/. The tests below also inspect
// the local filesystem (file:// URLs, better-sqlite3) and the in-memory community._exports
// array directly, which are not observable through an RPC client.
// TODO: add a matching RPC suite once the wire protocol lands.
describe(`community.export() — embedded`, async () => {
    let pkc: PKCType;
    let community: LocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC({});
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        // Populate with a post so the DB has real rows.
        await publishRandomPost({ communityAddress: community.address, pkc });
    });

    afterAll(async () => {
        await community.stop();
        await pkc.destroy();
    });

    // RPC: skipped — embedded-only feature this PR; test also reads file:// URL on the local fs.
    itSkipIfRpc("happy path: file is on disk, sha256 matches, sqlite is readable", async () => {
        const { exportId } = await community.export();
        const rec = await waitForCompleteRecord(community, exportId);

        expect(rec.url).toBeDefined();
        const parsed = new URL(rec.url!);
        expect(parsed.protocol).to.equal("file:");
        const filePath = fileURLToPath(parsed);
        expect(existsSync(filePath)).to.equal(true);

        // sha256 verification
        const recomputed = await hashFile(filePath);
        expect(recomputed).to.equal(rec.sha256);

        // file size matches
        const stat = await fsPromises.stat(filePath);
        expect(stat.size).to.equal(rec.size);

        // The backup is a real sqlite DB with the community's tables
        const db = new Database(filePath, { readonly: true });
        try {
            const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
            expect(tables.some((t) => t.name === "comments")).to.equal(true);
            expect(tables.some((t) => t.name === "keyv")).to.equal(true);
        } finally {
            db.close();
        }
    });

    // RPC: skipped — embedded-only feature this PR; test opens the exported sqlite locally.
    itSkipIfRpc("includePrivateKey: false (default) scrubs the signer.privateKey", async () => {
        const { exportId } = await community.export();
        const rec = await waitForCompleteRecord(community, exportId);
        const filePath = fileURLToPath(new URL(rec.url!));

        const db = new Database(filePath, { readonly: true });
        try {
            const row = db.prepare("SELECT value FROM keyv WHERE key = ?").get("keyv:INTERNAL_COMMUNITY") as { value: string } | undefined;
            expect(row).toBeDefined();
            const parsed = JSON.parse(row!.value) as { value: { signer: ExportedSigner } };
            expect(parsed.value.signer.privateKey).to.equal(undefined);
            expect(parsed.value.signer.ipfsKey).to.equal(undefined);
            // public material is preserved
            expect(typeof parsed.value.signer.publicKey).to.equal("string");
            expect(typeof parsed.value.signer.address).to.equal("string");
        } finally {
            db.close();
        }
    });

    // RPC: skipped — embedded-only feature this PR; test opens the exported sqlite locally.
    itSkipIfRpc("includePrivateKey: true preserves the signer.privateKey", async () => {
        const { exportId } = await community.export({ includePrivateKey: true });
        const rec = await waitForCompleteRecord(community, exportId);
        const filePath = fileURLToPath(new URL(rec.url!));

        const db = new Database(filePath, { readonly: true });
        try {
            const row = db.prepare("SELECT value FROM keyv WHERE key = ?").get("keyv:INTERNAL_COMMUNITY") as { value: string } | undefined;
            expect(row).toBeDefined();
            const parsed = JSON.parse(row!.value) as { value: { signer: ExportedSigner } };
            expect(parsed.value.signer.privateKey).to.equal(community.signer.privateKey);
        } finally {
            db.close();
        }
    });

    // RPC: skipped — exportPath is embedded-only (rejected over the wire per the spec).
    itSkipIfRpc("exportPath option writes to the caller-supplied location", async () => {
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

    // RPC: skipped — exportschange events would arrive via an RPC subscription that isn't wired yet.
    itSkipIfRpc("exportschange fires for every transition with the full list", async () => {
        const seen: CommunityExportRecord[][] = [];
        const listener = (records: CommunityExportRecord[]) => seen.push(records);
        community.on("exportschange", listener);
        try {
            const { exportId } = await community.export();
            await waitForCompleteRecord(community, exportId);
            // At least: initial 0-progress emission + complete emission. Progress emissions may be
            // throttled to 0 if the DB is small enough that the backup finishes in one transfer.
            expect(seen.length).to.be.greaterThanOrEqual(2);
            const last = seen[seen.length - 1].find((r) => r.exportId === exportId);
            expect(last?.progress).to.equal(1);
        } finally {
            community.removeListener("exportschange", listener);
        }
    });

    // RPC: skipped — AbortSignal routing over the wire (cancelExport) is part of the deferred follow-up.
    itSkipIfRpc("cancellation via AbortSignal records ERR_EXPORT_CANCELLED", async () => {
        const ac = new AbortController();
        const { exportId } = await community.export({ signal: ac.signal });
        // Abort immediately; record may still be at progress 0 or partway through.
        ac.abort();
        const rec = await waitForRecord(community, exportId, (r) => Boolean(r?.error || r?.progress === 1));
        expect(rec?.error?.code).to.equal("ERR_EXPORT_CANCELLED");

        // No .partial or completed file should be left behind
        const exportsDir = path.join(pkc.dataPath!, "exports");
        if (existsSync(exportsDir)) {
            const stragglers = (await fsPromises.readdir(exportsDir)).filter((f) => f.includes(exportId));
            expect(stragglers).to.deep.equal([]);
        }
    });

    // RPC: skipped — pre-abort behavior is verified at the embedded entrypoint; RPC client wrapping is follow-up work.
    itSkipIfRpc("pre-aborted signal rejects synchronously without creating a record", async () => {
        const ac = new AbortController();
        ac.abort(new Error("nope"));
        const exportsBefore = community.exports.length;
        await expect(community.export({ signal: ac.signal })).rejects.toThrow();
        expect(community.exports.length).to.equal(exportsBefore);
    });

    // RPC: skipped — verifies both output files on the local fs; embedded-only.
    itSkipIfRpc("two concurrent exports of the same community both reach progress=1", async () => {
        const [{ exportId: a }, { exportId: b }] = await Promise.all([community.export(), community.export()]);
        const recA = await waitForCompleteRecord(community, a);
        const recB = await waitForCompleteRecord(community, b);
        expect(recA.progress).to.equal(1);
        expect(recB.progress).to.equal(1);
        expect(recA.exportId).to.not.equal(recB.exportId);
        expect(existsSync(fileURLToPath(new URL(recA.url!)))).to.equal(true);
        expect(existsSync(fileURLToPath(new URL(recB.url!)))).to.equal(true);
    });
});

describe(`community.export() — error paths`, async () => {
    // RPC: skipped — spins up its own no-dataPath PKC; not meaningful through the shared RPC server.
    itSkipIfRpc("a read-only RemoteCommunity rejects with ERR_COMMUNITY_NOT_LOCAL", async () => {
        // Create a publishing community in pkc1, then load it as a RemoteCommunity in pkc2.
        const pkc1 = await mockPKC({});
        const localComm = (await createSubWithNoChallenge({}, pkc1)) as LocalCommunity;
        await localComm.start();
        await resolveWhenConditionIsTrue({ toUpdate: localComm, predicate: async () => typeof localComm.updatedAt === "number" });

        // pkc2 has no dataPath, so createCommunity({ address }) returns a read-only RemoteCommunity
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

describe(`pkc.createCommunity loads community.exports from the DB`, async () => {
    // RPC: skipped — spins up isolated PKC instances against a shared dataPath to exercise the
    // on-disk KeyV persistence path, which is not reachable through the shared RPC server.
    itSkipIfRpc("a fresh LocalCommunity instance for the same address sees prior exports", async () => {
        const pkc = await mockPKC({});
        const first = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await first.start();
        await resolveWhenConditionIsTrue({ toUpdate: first, predicate: async () => typeof first.updatedAt === "number" });
        await publishRandomPost({ communityAddress: first.address, pkc });

        const { exportId } = await first.export();
        const completed = await waitForCompleteRecord(first, exportId);
        expect(completed.progress).to.equal(1);

        // Sibling instance in the same PKC mirrors from the started instance
        const sibling = (await pkc.createCommunity({ address: first.address })) as LocalCommunity;
        expect(sibling.exports.find((r) => r.exportId === exportId)?.progress).to.equal(1);

        // Tear down so a brand-new PKC pointing at the same dataPath has to load from DB
        await first.stop();

        const pkc2 = await mockPKC({ dataPath: pkc.dataPath });
        try {
            const reloaded = (await pkc2.createCommunity({ address: first.address })) as LocalCommunity;
            const rec = reloaded.exports.find((r) => r.exportId === exportId);
            expect(rec?.progress).to.equal(1);
            expect(rec?.url).to.equal(completed.url);
            expect(rec?.sha256).to.equal(completed.sha256);
        } finally {
            await pkc2.destroy();
            await pkc.destroy();
        }
    });
});

describe(`pkc.destroy() cancels in-flight exports`, async () => {
    // RPC: skipped — uses its own pkc.destroy() lifecycle; the shared RPC test server would tear down its own instance.
    itSkipIfRpc("aborts active exports and resolves cleanly", async () => {
        const pkc = await mockPKC({});
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        await publishRandomPost({ communityAddress: community.address, pkc });

        const { exportId } = await community.export();
        // Don't wait — destroy while the export is in flight.
        await pkc.destroy();

        // After destroy, the record should either be complete or cancelled — never stuck in-flight.
        const finalRec = community.exports.find((r) => r.exportId === exportId);
        if (finalRec) {
            const isTerminal = finalRec.progress === 1 || Boolean(finalRec.error);
            expect(isTerminal).to.equal(true);
        }
    });
});
