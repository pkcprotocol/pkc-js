import { it, beforeAll, afterAll, expect, vi } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { path as getKuboBinaryPath } from "kubo";

import { mockPKC, createSubWithNoChallenge, publishRandomPost, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { timestamp } from "../../../dist/node/util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import {
    calculateNewCommentUpdate,
    syncPostUpdatesWithIpfs
} from "../../../dist/node/runtime/node/community/local-community/comment-updates.js";

import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

// A postUpdates bucket is built in node, imported, and then swapped into MFS. Between the import and the
// swap its new blocks hang off nothing but the pin the import made, and that pin is not on the bucket's
// root: it is on a manifest that links the new blocks only (see buildSwapPinManifests). This checks the
// property that design rests on, against a real repo gc: a gc that runs between the import and the swap
// takes none of the new blocks, the bucket's own rebuilt node included, and completes without an error
// (a pin with missing blocks would make it abort). The daemon is this test's own, so its gc is not at the
// mercy of the other suites' pins and does not touch their blocks.

const ISOLATED_KUBO_API_PORT = 25190;
const ISOLATED_KUBO_GATEWAY_PORT = 25191;
const ISOLATED_KUBO_SWARM_PORT = 25192;
const ISOLATED_KUBO_API_URL = `http://localhost:${ISOLATED_KUBO_API_PORT}/api/v0`;

async function spawnIsolatedKuboDaemon(repoDir: string): Promise<ChildProcess> {
    const ipfsBin = getKuboBinaryPath();
    fs.mkdirSync(repoDir, { recursive: true });
    const env = { ...process.env, IPFS_PATH: repoDir };

    execFileSync(ipfsBin, ["init"], { stdio: "ignore", env });
    execFileSync(ipfsBin, ["config", "Addresses.API", `/ip4/127.0.0.1/tcp/${ISOLATED_KUBO_API_PORT}`], { env });
    execFileSync(ipfsBin, ["config", "Addresses.Gateway", `/ip4/127.0.0.1/tcp/${ISOLATED_KUBO_GATEWAY_PORT}`], { env });
    execFileSync(ipfsBin, ["config", "--json", "Addresses.Swarm", `["/ip4/127.0.0.1/tcp/${ISOLATED_KUBO_SWARM_PORT}"]`], { env });
    execFileSync(ipfsBin, ["config", "--json", "API.HTTPHeaders.Access-Control-Allow-Origin", '["*"]'], { env });
    execFileSync(ipfsBin, ["bootstrap", "rm", "--all"], { stdio: "ignore", env });
    execFileSync(ipfsBin, ["config", "--json", "Discovery.MDNS.Enabled", "false"], { env });

    const proc = spawn(ipfsBin, ["daemon", "--enable-namesys-pubsub"], { env, stdio: ["ignore", "pipe", "pipe"] });
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

// Skipped under RPC: the test calls the low-level postUpdates sync on a LocalCommunity and reaches into its
// kubo client, neither of which exists on the RPC community wrapper.
describeSkipIfRpc("a repo gc in the middle of a postUpdates bucket swap (isolated real Kubo daemon)", () => {
    const repoDir = path.join(process.cwd(), `.tmp/kubo-swap-gc-test-${uuidv4()}`);
    let kuboProcess: ChildProcess;
    let pkc: PKC;
    let community: LocalCommunity;

    beforeAll(async () => {
        kuboProcess = await spawnIsolatedKuboDaemon(repoDir);
        pkc = await mockPKC(
            {
                kuboRpcClientsOptions: [ISOLATED_KUBO_API_URL],
                pubsubKuboRpcClientsOptions: [ISOLATED_KUBO_API_URL],
                httpRoutersOptions: []
            },
            true // forceMockPubsub: pubsub goes over the in-memory mock server
        );
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    }, 60_000);

    afterAll(async () => {
        vi.restoreAllMocks();
        try {
            if (community) await community.delete();
        } catch {}
        try {
            if (pkc) await pkc.destroy();
        } catch {}
        if (kuboProcess) await killKuboDaemon(kuboProcess);
        try {
            fs.rmSync(repoDir, { recursive: true, force: true });
        } catch {}
    }, 30_000);

    it("takes none of the bucket's new blocks, and completes", async () => {
        const kubo = community._clientsManager.getDefaultKuboRpcClient()._client;
        const post = await publishRandomPost({ communityAddress: community.address, pkc });
        let mfsPath: string | undefined;
        const readUpdate = async (): Promise<{ updatedAt: number } | undefined> => {
            const chunks: Uint8Array[] = [];
            try {
                // offline: a block the gc took must fail the read, not send the daemon looking for it
                for await (const chunk of kubo.files.read(mfsPath!, { timeout: 10_000 })) chunks.push(chunk);
            } catch (e) {
                expect((e as Error).message).to.equal("file does not exist");
                return undefined;
            }
            return JSON.parse(Buffer.concat(chunks).toString()) as { updatedAt: number };
        };
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => {
                const bucket = community.postUpdates && Object.keys(community.postUpdates)[0];
                if (!bucket) return false;
                mfsPath = `/${community.address}/postUpdates/${bucket}/${post.cid}/update`;
                return (await readUpdate()) !== undefined;
            }
        });
        const updatedAtBefore = (await readUpdate())!.updatedAt;

        await new Promise((resolve) => setTimeout(resolve, 1100)); // updatedAt is in seconds
        const row = await calculateNewCommentUpdate({
            community,
            comment: community._dbHandler.queryComment(post.cid!)!,
            batchStartTimestamp: timestamp()
        });
        expect(row.newCommentUpdate.updatedAt).to.be.greaterThan(updatedAtBefore);

        // The gc runs when the new bucket has been imported and is about to be staged in MFS
        const originalCp = kubo.files.cp.bind(kubo.files);
        const gcErrors: string[] = [];
        let gcRuns = 0;
        const cpSpy = vi.spyOn(kubo.files, "cp").mockImplementation(async (...args: Parameters<typeof originalCp>) => {
            if (String(args[1]).endsWith(".next") && gcRuns === 0) {
                gcRuns++;
                for await (const result of kubo.repo.gc()) if (result.err) gcErrors.push(result.err.message);
            }
            return originalCp(...args);
        });
        try {
            await syncPostUpdatesWithIpfs(community, [row]);
        } finally {
            cpSpy.mockRestore();
        }

        expect(gcRuns, "a gc should have run between the import and the swap").to.equal(1);
        expect(gcErrors, "the gc should complete: a pin with missing blocks makes it abort").to.deep.equal([]);
        expect((await readUpdate())?.updatedAt).to.equal(row.newCommentUpdate.updatedAt);
        // The whole bucket is still walkable: its directory node and every post's file are there
        const bucketPath = mfsPath!.split("/").slice(0, -2).join("/");
        const bucketCid = (await kubo.files.stat(bucketPath)).cid;
        const walked: string[] = [];
        for await (const ref of kubo.refs(bucketCid, { recursive: true, timeout: 10_000 })) {
            expect(ref.err, `a block of the bucket is missing: ${ref.err}`).to.be.oneOf([undefined, ""]);
            walked.push(ref.ref);
        }
        expect(walked.length).to.be.greaterThan(1);

        // and once the swap is done nothing of it stays pinned: a second gc completes too
        for await (const result of kubo.repo.gc()) if (result.err) gcErrors.push(result.err.message);
        expect(gcErrors).to.deep.equal([]);
        expect((await readUpdate())?.updatedAt).to.equal(row.newCommentUpdate.updatedAt);
    }, 180_000);
});
