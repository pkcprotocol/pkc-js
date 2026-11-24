// Stats.sortGatewaysAccordingToScore passed an async scorer to remeda's sortBy, which compared the
// returned promises (all equal) and so never reordered anything: the configured order was always
// used, whatever each gateway's record of successes, failures and speed. These tests pin that the
// best-scoring gateway comes first.
import { describe, it, expect } from "vitest";
import Stats from "../../../dist/node/stats.js";

type StatsDeps = ConstructorParameters<typeof Stats>[0];

function makeStats(gatewayUrls: string[], opts?: { pubsubProviderUrls?: string[]; stored?: Record<string, unknown> }) {
    const store = new Map<string, unknown>(Object.entries(opts?.stored ?? {}));
    const toClients = (urls: string[]) => Object.fromEntries(urls.map((url) => [url, {}]));
    const deps = {
        _storage: {
            getItem: async (key: string) => store.get(key),
            setItem: async (key: string, value: unknown) => {
                store.set(key, value);
            }
        },
        clients: {
            ipfsGateways: toClients(gatewayUrls),
            pubsubKuboRpcClients: toClients(opts?.pubsubProviderUrls ?? []),
            libp2pJsClients: {}
        }
    } as unknown as StatsDeps;
    return new Stats(deps);
}

describe("Stats.sortGatewaysAccordingToScore", () => {
    const gateways = ["https://a.example", "https://b.example", "https://c.example"];

    it("keeps the configured order when no gateway has stats", async () => {
        const stats = makeStats(gateways);
        expect(await stats.sortGatewaysAccordingToScore("ipfs")).toEqual(gateways);
    });

    it("puts a gateway that keeps failing last and one that keeps succeeding first", async () => {
        const stats = makeStats(gateways);
        for (let i = 0; i < 5; i++) {
            await stats.recordGatewayFailure("https://a.example", "ipfs");
            await stats.recordGatewaySuccess("https://c.example", "ipfs", 200);
        }
        expect(await stats.sortGatewaysAccordingToScore("ipfs")).toEqual(["https://c.example", "https://b.example", "https://a.example"]);
    });

    it("puts the faster of two equally reliable gateways first", async () => {
        const stats = makeStats(gateways);
        for (let i = 0; i < 5; i++) {
            await stats.recordGatewaySuccess("https://a.example", "ipns", 3000);
            await stats.recordGatewaySuccess("https://b.example", "ipns", 100);
        }
        const sorted = await stats.sortGatewaysAccordingToScore("ipns");
        expect(sorted.indexOf("https://b.example")).toBeLessThan(sorted.indexOf("https://a.example"));
    });

    it("scores each record type separately", async () => {
        const stats = makeStats(gateways);
        for (let i = 0; i < 5; i++) await stats.recordGatewayFailure("https://a.example", "ipns");
        expect(await stats.sortGatewaysAccordingToScore("ipfs")).toEqual(gateways);
        expect((await stats.sortGatewaysAccordingToScore("ipns")).at(-1)).toBe("https://a.example");
    });

    it("sorts pubsub providers by their own record, not the gateways'", async () => {
        const providers = ["https://pubsub-a.example", "https://pubsub-b.example"];
        const stats = makeStats(gateways, { pubsubProviderUrls: providers });
        for (let i = 0; i < 5; i++) await stats.recordGatewayFailure("https://pubsub-a.example", "pubsub-publish");
        expect(await stats.sortGatewaysAccordingToScore("pubsub-publish")).toEqual([
            "https://pubsub-b.example",
            "https://pubsub-a.example"
        ]);
        expect(await stats.sortGatewaysAccordingToScore("pubsub-subscribe")).toEqual(providers);
    });

    // Until the sort worked, nothing read these counters, and they counted every request pkc-js aborted
    // itself as a failure of the gateway. They are stored for good, so the counters now live under a new
    // key and the ones recorded before are ignored.
    it("ignores the counters recorded under the old STATS_ keys", async () => {
        const stats = makeStats(gateways, {
            stored: { "STATS_https://a.example_ipfs_COUNT_FAILURE": 50, "STATS_https://c.example_ipfs_COUNT_SUCCESS": 50 }
        });
        expect(await stats.sortGatewaysAccordingToScore("ipfs")).toEqual(gateways);
    });
});
