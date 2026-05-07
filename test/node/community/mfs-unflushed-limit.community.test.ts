import { it, beforeAll, afterAll, expect } from "vitest";
import { spawn, execSync, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { path as getKuboBinaryPath } from "kubo";

import {
    mockPKC,
    createSubWithNoChallenge,
    publishRandomPost,
    resolveWhenConditionIsTrue,
    mockPKCNoDataPathWithOnlyKuboClient
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";

import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

// Reproduces https://www.markdownpaste.com/document/reached-limit-of-256-unflushed-mfs-operations
//
// Production hits Kubo's `Internal.MFSNoFlushLimit` (default 256) because
// `_syncPostUpdatesWithIpfs` writes comment-updates with `flush: false`, so
// under multi-community concurrency / retry pressure the global counter
// exceeds the limit and Kubo returns HTTP 500 on every subsequent flush=false
// write — until the daemon is restarted.
//
// To reproduce deterministically we spawn an isolated Kubo daemon with
// `MFSNoFlushLimit` configured very low, point a real LocalCommunity at it,
// publish enough posts that one sync batch trivially exceeds the limit, and
// assert the community syncs without emitting the unflushed-MFS error.

const SIMULATED_MFS_LIMIT = 5;
const POSTS_TO_PUBLISH = 15; // > limit, ensures one sync batch reliably exceeds it

const ISOLATED_KUBO_API_PORT = 25090;
const ISOLATED_KUBO_GATEWAY_PORT = 25091;
const ISOLATED_KUBO_SWARM_PORT = 25092;
const ISOLATED_KUBO_API_URL = `http://localhost:${ISOLATED_KUBO_API_PORT}/api/v0`;

async function spawnIsolatedKuboDaemon(repoDir: string): Promise<ChildProcess> {
    const ipfsBin = getKuboBinaryPath();
    fs.mkdirSync(repoDir, { recursive: true });
    const env = { ...process.env, IPFS_PATH: repoDir };

    execSync(`${ipfsBin} init`, { stdio: "ignore", env });

    // The bug: Kubo's Internal.MFSNoFlushLimit. Set it very low so a single
    // sync batch reliably exceeds it (instead of needing 256+ in-flight writes).
    execSync(`${ipfsBin} config --json Internal.MFSNoFlushLimit ${SIMULATED_MFS_LIMIT}`, { env });

    execSync(`${ipfsBin} config Addresses.API /ip4/127.0.0.1/tcp/${ISOLATED_KUBO_API_PORT}`, { env });
    execSync(`${ipfsBin} config Addresses.Gateway /ip4/127.0.0.1/tcp/${ISOLATED_KUBO_GATEWAY_PORT}`, { env });
    execSync(`${ipfsBin} config --json Addresses.Swarm '["/ip4/127.0.0.1/tcp/${ISOLATED_KUBO_SWARM_PORT}"]'`, { env });
    execSync(`${ipfsBin} config --json API.HTTPHeaders.Access-Control-Allow-Origin '["*"]'`, { env });
    execSync(`${ipfsBin} bootstrap rm --all`, { stdio: "ignore", env });
    execSync(`${ipfsBin} config --json Discovery.MDNS.Enabled false`, { env });

    const proc = spawn(ipfsBin, ["daemon", "--enable-namesys-pubsub"], {
        env,
        stdio: ["ignore", "pipe", "pipe"]
    });

    await new Promise<void>((resolve, reject) => {
        const onStdout = (data: Buffer) => {
            if (data.toString().includes("Daemon is ready")) {
                proc.stdout?.off("data", onStdout);
                resolve();
            }
        };
        proc.stdout?.on("data", onStdout);
        proc.on("error", reject);
        proc.on("exit", (code) => reject(new Error(`Kubo daemon exited early with code ${code}`)));
        setTimeout(() => reject(new Error("Kubo daemon failed to become ready within 30s")), 30_000);
    });

    return proc;
}

async function killKuboDaemon(proc: ChildProcess): Promise<void> {
    if (proc.killed || proc.exitCode !== null) return;
    await new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        proc.kill("SIGTERM");
        setTimeout(() => {
            if (proc.exitCode === null) proc.kill("SIGKILL");
        }, 5_000);
    });
}

describeSkipIfRpc("local community survives Kubo MFSNoFlushLimit (isolated real Kubo daemon)", () => {
    const repoDir = path.join(process.cwd(), `.tmp/kubo-mfs-test-${uuidv4()}`);

    let kuboProcess: ChildProcess;
    let pkc: PKC;
    let community: LocalCommunity;
    let remotePKC: PKC;

    beforeAll(async () => {
        kuboProcess = await spawnIsolatedKuboDaemon(repoDir);

        pkc = await mockPKC(
            {
                kuboRpcClientsOptions: [ISOLATED_KUBO_API_URL],
                pubsubKuboRpcClientsOptions: [ISOLATED_KUBO_API_URL],
                httpRoutersOptions: []
            },
            true // forceMockPubsub — pubsub goes over the in-memory mock socket.io server
        );
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        community.setMaxListeners(200);
        await community.start();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.updatedAt === "number"
        });

        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient({
            pkcOptions: {
                kuboRpcClientsOptions: [ISOLATED_KUBO_API_URL],
                pubsubKuboRpcClientsOptions: [ISOLATED_KUBO_API_URL],
                httpRoutersOptions: []
            },
            forceMockPubsub: true
        });
    }, 60_000);

    afterAll(async () => {
        try {
            if (community) await community.delete();
        } catch {}
        try {
            if (pkc) await pkc.destroy();
        } catch {}
        try {
            if (remotePKC) await remotePKC.destroy();
        } catch {}
        if (kuboProcess) await killKuboDaemon(kuboProcess);
        try {
            fs.rmSync(repoDir, { recursive: true, force: true });
        } catch {}
    }, 30_000);

    it(`syncs comment-updates without hitting Kubo's MFSNoFlushLimit (configured to ${SIMULATED_MFS_LIMIT})`, async () => {
        const errors: Error[] = [];
        const onError = (e: Error) => errors.push(e);
        community.on("error", onError);

        // Force the bug condition: pre-fill Kubo's global unflushed-MFS counter to its
        // limit. This is what production hits when multiple communities concurrently
        // write with flush=false. After this, ANY further flush=false write to this
        // daemon will fail with the "reached limit of N unflushed MFS operations" error,
        // while flush=true writes (the proposed fix) will continue to succeed because
        // they are self-flushing.
        const kuboClientType = community as never as Record<
            string,
            {
                getDefaultKuboRpcClient: () => {
                    _client: { files: { write: (path: string, content: Uint8Array, opts: object) => Promise<void> } };
                };
            }
        >;
        const kuboFiles = kuboClientType._clientsManager.getDefaultKuboRpcClient()._client.files;
        const encoder = new TextEncoder();
        let prefillIdx = 0;
        const maxPrefill = SIMULATED_MFS_LIMIT * 4;
        while (prefillIdx < maxPrefill) {
            try {
                await kuboFiles.write(`/__mfs_prefill__/p${prefillIdx}`, encoder.encode("x"), {
                    create: true,
                    parents: true,
                    flush: false
                });
                prefillIdx += 1;
            } catch {
                break;
            }
        }
        expect(prefillIdx).to.be.greaterThan(0);

        // Now publish posts. Sync's commentUpdate writes (with flush=false in the buggy
        // code) will hit the saturated counter and the community will emit the error.
        await Promise.all(
            Array.from({ length: POSTS_TO_PUBLISH }, () => publishRandomPost({ communityAddress: community.address, pkc: remotePKC }))
        );

        // Wait for sync to either complete (postUpdates defined) or fail (error emitted).
        const start = Date.now();
        while (Date.now() - start < 60_000) {
            if (community.postUpdates) break;
            if (errors.find((e) => e.message?.includes("unflushed MFS operations"))) break;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }

        community.off("error", onError);

        const unflushedError = errors.find((e) => e.message?.includes("unflushed MFS operations"));
        expect(unflushedError, unflushedError?.message).to.be.undefined;
        expect(community.postUpdates).to.exist;
    }, 180_000);
});
