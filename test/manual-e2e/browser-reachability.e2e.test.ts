import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
    formatProbeReport,
    formatProviderReport,
    probeBrowserReachability,
    type ProbeReport,
    type ProviderReport
} from "./browser-reachability-probe.js";

// Browser-transport-only reachability probe against production seeders (issue #475). Answers "can a browser running
// pkc-js reach at least one provider of this community?" without a browser: a libp2p node gated to WebSocket Secure
// dials every /tls/ws address with full certificate verification, and every /webtransport address gets a QUIC
// version-negotiation probe on its UDP endpoint (see browser-reachability-probe.ts). NOT part of any CI glob (CI runs
// test/node, test/node-and-browser, test/browser, test/challenges). The probe itself needs no test server, but
// run-test-config.js refuses to start without one, so have `npm run test:server:node` running. It talks to the production
// HTTP routers and seeders, so results depend on the network it runs from. Run it by hand:
//
//   E2E_TARGETS=<community publicKey>[,<publicKey>...] node test/run-test-config.js --pkc-config local-kubo-rpc test/manual-e2e/browser-reachability.e2e.test.ts
//
// Env:
//   E2E_TARGETS         comma-separated community IPNS names (the community publicKey, 12D3... or k51...); providers are
//                       looked up on every router the way pkc-js does it
//   E2E_PEERS           comma-separated provider multiaddrs with /p2p/<peer id>, probed directly with no router lookup
//                       (one of E2E_TARGETS / E2E_PEERS is required)
//   E2E_ROUTERS         comma-separated HTTP routers (default: the six pkc-js defaults from src/schema.ts)
//   E2E_REQUIRE         wss (default) | webtransport | any: what counts as reachable. `wss` is what a pkc-js browser can
//                       dial today; `webtransport` is a certhash address whose UDP endpoint answers; `any` is either
//   E2E_MIN_PROVIDERS   providers per target that must pass (default 1); the explicit E2E_PEERS list is one target
//   The default passes as soon as E2E_MIN_PROVIDERS providers have a working WSS address: WebTransport, UDP 443 and IPv6
//   are reported per provider and listed under problems, not asserted, unless E2E_REQUIRE says so
//   E2E_DIAL_TIMEOUT_MS (15000), E2E_UDP_TIMEOUT_MS (3000)
//   E2E_REPORT_JSON     write the full report there (default .tmp/browser-reachability-<timestamp>.json), for the
//                       external monitor (bitsocialnet/bitsocial-web#55) and for diffing runs from different networks

const DEFAULT_ROUTERS = [
    "https://peers.pleb.bot",
    "https://routing.lol",
    "https://peers.forumindex.com",
    "https://peers.plebpubsub.xyz",
    "https://routerofbitsocial.xyz",
    "https://bsotracker.online"
];

function envList(name: string): string[] {
    return (process.env[name] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

function envInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got ${raw}`);
    return value;
}

type Requirement = "wss" | "webtransport" | "any";

function parseRequirement(raw: string | undefined): Requirement {
    if (raw === undefined || raw === "" || raw === "wss") return "wss";
    if (raw === "webtransport" || raw === "any") return raw;
    throw new Error(`E2E_REQUIRE must be wss, webtransport or any, got ${raw}`);
}

function meetsRequirement(provider: ProviderReport, requirement: Requirement): boolean {
    const v = provider.verdict;
    if (requirement === "wss") return v.wssDialable;
    if (requirement === "webtransport") return v.webtransportUdpAnswers;
    return v.browserDialableWithWebTransport;
}

describe("browser reachability of production providers (manual, issue #475)", () => {
    const targets = envList("E2E_TARGETS");
    const peers = envList("E2E_PEERS");
    const routers = envList("E2E_ROUTERS");
    const requirement = parseRequirement(process.env["E2E_REQUIRE"]);
    const minProviders = envInt("E2E_MIN_PROVIDERS", 1);
    const dialTimeoutMs = envInt("E2E_DIAL_TIMEOUT_MS", 15_000);
    const udpTimeoutMs = envInt("E2E_UDP_TIMEOUT_MS", 3_000);
    const reportPath =
        process.env["E2E_REPORT_JSON"] || path.join(".tmp", `browser-reachability-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

    it(
        `every target has at least ${minProviders} provider(s) a browser can reach over ${requirement}`,
        async () => {
            if (targets.length === 0 && peers.length === 0) {
                throw new Error(
                    "Set E2E_TARGETS (community publicKeys) and/or E2E_PEERS (provider multiaddrs with /p2p/); see the header of this file"
                );
            }

            const report: ProbeReport = await probeBrowserReachability({
                ipnsNames: targets,
                peerMultiaddrs: peers,
                routers: routers.length > 0 ? routers : DEFAULT_ROUTERS,
                dialTimeoutMs,
                udpTimeoutMs,
                onProvider: (target, provider) => console.log(`[${target}]\n${formatProviderReport(provider)}`)
            });

            mkdirSync(path.dirname(reportPath), { recursive: true });
            writeFileSync(reportPath, JSON.stringify(report, null, 2));
            console.log(`\n${formatProbeReport(report)}\n\nreport written to ${reportPath}`);

            const failures: string[] = [];
            for (const target of report.targets) {
                const passing = target.providers.filter((p) => meetsRequirement(p, requirement));
                const routerErrors = Object.keys(target.routerErrors).length;
                if (target.target !== "peers" && target.providers.length === 0) {
                    failures.push(
                        `${target.target}: no providers returned by any router${routerErrors > 0 ? ` (${routerErrors} router error(s))` : ""}`
                    );
                } else if (passing.length < minProviders) {
                    failures.push(
                        `${target.target}: ${passing.length}/${target.providers.length} provider(s) reachable over ${requirement}, need ${minProviders}; ` +
                            target.providers.map((p) => `${p.peerId}: ${p.problems.join("; ") || "ok"}`).join(" | ")
                    );
                }
            }
            expect(failures, failures.join("\n")).toEqual([]);
        },
        // routers plus one WSS dial per announced WSS address per provider; a dead AutoTLS name costs a full dial timeout
        20 * 60 * 1000
    );
});
