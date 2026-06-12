// Regression test for kubo#11213 (Routing.Type=custom publishing unresolved/empty/0.0.0.0
// addresses in IPIP-526 provider records), fixed in Kubo >= 0.41. The removed address rewriter
// proxy (#128) existed solely to work around that bug. Complements test/node/httprouter.test.ts:
// here Kubo's Routing config is set DIRECTLY in the repo config (bypassing pkc's
// _setupHttpRoutersWithKuboNodeInBackground entirely) and the provider records Kubo publishes
// natively to a MockHttpRouter are asserted valid, with Provide.DHT.SweepEnabled both off and on.
//
// This file spawns its OWN throwaway Kubo daemon (pattern copied from
// test/node/community/mfs-unflushed-limit.community.test.ts) instead of restarting the shared
// test-server daemon on port 15006. Restarting the shared daemon raced with
// test/node/httprouter.test.ts in parallel runs: that file's httpRoutersOptions flow also
// config-changes + bounces the 15006 daemon, and the two files' restart cycles interleaved until
// this file's tcp-port-used polling timed out in beforeAll/afterAll (see issue #136).
import { beforeAll, afterAll, describe } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { path as getKuboBinaryPath } from "kubo";
import PKC from "../../dist/node/index.js";
import { createSubWithNoChallenge, resolveWhenConditionIsTrue } from "../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../helpers/conditional-tests.js";
import { MockHttpRouter } from "../../dist/node/runtime/node/test/mock-http-router.js";
import type { PKC as PKCType } from "../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../dist/node/runtime/node/community/local-community.js";

import tcpPortUsed from "tcp-port-used";

// Ports chosen to not collide with the test server daemons (API 15001-15006, swarm 24001-24006)
// or the isolated daemon of mfs-unflushed-limit.community.test.ts (25090-25092)
const ISOLATED_KUBO_API_PORT = 25190;
const ISOLATED_KUBO_GATEWAY_PORT = 25191;
const ISOLATED_KUBO_SWARM_PORT = 25192;
const kuboApiUrl = `http://localhost:${ISOLATED_KUBO_API_PORT}/api/v0`;
const legacyRewriterProxyPort = 19575; // first port the removed address rewriter proxy used to listen on

async function getKuboConfig(key: string): Promise<unknown> {
    const res = await fetch(`${kuboApiUrl}/config?arg=${encodeURIComponent(key)}`, { method: "POST" });
    if (!res.ok) throw new Error(`Failed to get kubo config ${key}: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { Key: string; Value: unknown };
    return json.Value;
}

// Edits the throwaway daemon's on-disk config. Only call while the daemon is down — the daemon
// reads the config once on startup
function setIsolatedKuboConfig(repoDir: string, key: string, value: unknown): void {
    execFileSync(getKuboBinaryPath(), ["config", "--json", key, JSON.stringify(value)], {
        env: { ...process.env, IPFS_PATH: repoDir }
    });
}

function initIsolatedKuboRepo(repoDir: string): void {
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
}

async function spawnIsolatedKuboDaemon(repoDir: string): Promise<ChildProcess> {
    const proc = spawn(getKuboBinaryPath(), ["daemon", "--enable-namesys-pubsub"], {
        env: { ...process.env, IPFS_PATH: repoDir },
        stdio: ["ignore", "pipe", "pipe"]
    });

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Kubo daemon failed to become ready within 30s")), 30_000);
        const onStdout = (data: Buffer) => {
            if (data.toString().includes("Daemon is ready")) {
                proc.stdout?.off("data", onStdout);
                clearTimeout(timer);
                resolve();
            }
        };
        proc.stdout?.on("data", onStdout);
        proc.on("error", reject);
        proc.on("exit", (code) => reject(new Error(`Kubo daemon exited early with code ${code}`)));
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

// Same Routing config shape that setupKuboHttpRouters builds, set manually so pkc's own setup
// stays out of the path entirely
function buildDirectRoutingConfig(httpRouterUrl: string) {
    return {
        Type: "custom",
        Methods: {
            "find-providers": { RouterName: "HttpRoutersParallel" },
            provide: { RouterName: "HttpRoutersParallel" },
            "find-peers": { RouterName: "HttpRouterNotSupported" },
            "get-ipns": { RouterName: "HttpRouterNotSupported" },
            "put-ipns": { RouterName: "HttpRouterNotSupported" }
        },
        Routers: {
            HttpRoutersParallel: {
                Type: "parallel",
                Parameters: { Routers: [{ RouterName: "HttpRouter1", IgnoreErrors: true, Timeout: "10s" }] }
            },
            HttpRouterNotSupported: { Type: "http", Parameters: { Endpoint: "http://kubohttprouternotsupported" } },
            HttpRouter1: { Type: "http", Parameters: { Endpoint: httpRouterUrl } }
        }
    };
}

// Cannot run under RPC: this test asserts against its own throwaway Kubo daemon and the mock
// http router traffic it receives. Under remote-pkc-rpc the RPC server owns the Kubo node and
// applies the http router config itself, so the raw Routing config under test would never be
// exercised by the RPC server's node, and the daemon lifecycle cannot be driven from the test
// process.
describeSkipIfRpc(`kubo#11213 regression: Kubo provides valid addresses directly to HTTP router (raw Routing config)`, () => {
    const repoDir = path.join(process.cwd(), `.tmp/kubo-direct-router-test-${uuidv4()}`);
    let mockHttpRouter: MockHttpRouter;
    let kuboProcess: ChildProcess | undefined;

    beforeAll(async () => {
        mockHttpRouter = new MockHttpRouter();
        await mockHttpRouter.start();
        initIsolatedKuboRepo(repoDir);
        setIsolatedKuboConfig(repoDir, "Routing", buildDirectRoutingConfig(mockHttpRouter.url));
    }, 60_000);

    afterAll(async () => {
        if (kuboProcess) await killKuboDaemon(kuboProcess);
        try {
            fs.rmSync(repoDir, { recursive: true, force: true });
        } catch {}
        if (mockHttpRouter) await mockHttpRouter.destroy();
    }, 60_000);

    // run once with the sweep provider disabled (current production config set by
    // setupKuboHttpRouters) and once enabled, in case the kubo#11213 fix behaves differently
    // between the legacy and sweep provide paths
    for (const sweepEnabled of [false, true]) {
        describe(`Provide.DHT.SweepEnabled=${sweepEnabled}`, () => {
            let pkc: PKCType;
            let community: LocalCommunity | undefined;

            beforeAll(async () => {
                mockHttpRouter.clearRequests();
                // apply the variant config while the daemon is down, then start it — full
                // control over the restart, no dependence on the test server's respawn behavior
                if (kuboProcess) await killKuboDaemon(kuboProcess);
                setIsolatedKuboConfig(repoDir, "Provide.DHT.SweepEnabled", sweepEnabled);
                kuboProcess = await spawnIsolatedKuboDaemon(repoDir);
                // httpRoutersOptions: [] prevents the Zod default production routers AND makes
                // _setupHttpRoutersWithKuboNodeInBackground a no-op, so the Routing config we
                // just set is left untouched
                pkc = await PKC({ kuboRpcClientsOptions: [kuboApiUrl], httpRoutersOptions: [] });
                pkc.on("error", (err) => {
                    console.log("Received an error on PKC instance", err);
                });
            }, 120_000);

            afterAll(async () => {
                try {
                    if (community) await community.delete();
                } catch {}
                try {
                    if (pkc) await pkc.destroy();
                } catch {}
            }, 60_000);

            it(`no legacy address rewriter proxy is running`, async () => {
                expect(await tcpPortUsed.check(legacyRewriterProxyPort)).to.be.false;
            });

            it(`Kubo Routing.Routers points directly at the mock http router (no proxy)`, async () => {
                const routers = (await getKuboConfig("Routing.Routers")) as Record<string, { Parameters: { Endpoint: string } }>;
                expect(routers["HttpRouter1"].Parameters.Endpoint).to.equal(mockHttpRouter.url);
            });

            it(`Kubo publishes provider records with valid addresses directly to the http router`, async () => {
                community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;

                await community.start();
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community!.updatedAt === "number" });

                expect(community.updateCid).to.be.a("string");
                expect(community.pubsubTopicRoutingCid).to.be.a("string");
                expect(community.ipnsPubsubTopicRoutingCid).to.be.a("string");
                const provideToTestAgainst = [
                    { label: "community.updateCid", cid: community.updateCid! },
                    { label: "community.pubsubTopicRoutingCid", cid: community.pubsubTopicRoutingCid! },
                    { label: "community.ipnsPubsubTopicRoutingCid", cid: community.ipnsPubsubTopicRoutingCid! }
                ];

                // provides happen in the background during community.start(), poll instead of asserting instantly
                const deadline = Date.now() + 120000;
                while (Date.now() < deadline) {
                    if (provideToTestAgainst.every(({ cid }) => mockHttpRouter.hasProvidersFor(cid))) break;
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }

                // diagnostics for the report: what Kubo actually sent vs what the rewriter would have injected
                const kuboRpcClient = pkc.clients.kuboRpcClients[kuboApiUrl]._client;
                const kuboId = await kuboRpcClient.id();
                const swarmAddrs = await kuboRpcClient.swarm.addrs();
                console.log("DIAGNOSTIC what the rewriter would have sent (id.Addresses):", JSON.stringify(kuboId.addresses.map(String)));
                console.log(
                    "DIAGNOSTIC swarm.addrs peers:",
                    JSON.stringify(swarmAddrs.map((peer) => ({ id: String(peer.id), addrs: peer.addrs.map(String) })))
                );
                const putRequests = mockHttpRouter.requests.filter(
                    (request) => request.method === "PUT" && request.url.startsWith("/routing/v1/providers")
                );
                console.log(`DIAGNOSTIC mock router received ${putRequests.length} provider PUT request(s):`);
                for (const request of putRequests) console.log("DIAGNOSTIC PUT body:", request.body);

                const providerStatuses = provideToTestAgainst.map(({ cid, label }) => ({
                    label,
                    cid,
                    hasProviders: mockHttpRouter.hasProvidersFor(cid)
                }));
                expect(
                    providerStatuses.every(({ hasProviders }) => hasProviders),
                    providerStatuses
                        .map(({ label, cid, hasProviders }) => `${label} (${cid}): ${hasProviders ? "provided" : "missing"}`)
                        .join(", ")
                ).to.be.true;

                for (const { cid: resourceToProvide } of provideToTestAgainst) {
                    const providersUrl = `${mockHttpRouter.url}/routing/v1/providers/${resourceToProvide}`;
                    const res = await fetch(providersUrl, { method: "GET" });
                    expect(res.status).to.equal(
                        200,
                        "http router " + mockHttpRouter.url + " has responded with wrong status code, did kubo provide correctly?"
                    );
                    const resJson = (await res.json()) as {
                        Providers: Array<{ Schema: string; ID: string; Addrs: string[]; Protocols?: string[] }>;
                    };
                    expect(resJson["Providers"]).to.be.a("array");
                    expect(resJson["Providers"].length).to.be.at.least(1);
                    for (const provider of resJson["Providers"]) {
                        expect(provider.Schema).to.equal("peer");
                        expect(provider.ID).to.be.a("string").and.to.have.length.greaterThan(0);
                        const providerAddrs = provider.Addrs;
                        expect(providerAddrs.length).to.be.at.least(1);
                        for (const providerAddr of providerAddrs) {
                            expect(providerAddr).to.be.a.string;
                            expect(providerAddr).to.not.include("0.0.0.0");
                        }
                        if (provider.Protocols) {
                            expect(provider.Protocols).to.be.an("array");
                        }
                    }
                }

                const hasPutRequest = putRequests.length > 0;
                expect(hasPutRequest).to.be.true;
            });
        });
    }
});
