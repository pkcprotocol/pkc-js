// Stats.sortGatewaysAccordingToScore passed an async scorer to remeda's sortBy, which compared the
// returned promises (all equal) and so never reordered anything: the configured order was always
// used, whatever each gateway's record of successes, failures and speed. These tests pin that the
// best-scoring gateway comes first.
import { describe, it, expect } from "vitest";
import Stats from "../../../dist/node/stats.js";

type StatsDeps = ConstructorParameters<typeof Stats>[0];

function makeStats(gatewayUrls: string[]) {
    const store = new Map<string, unknown>();
    const deps = {
        _storage: {
            getItem: async (key: string) => store.get(key),
            setItem: async (key: string, value: unknown) => {
                store.set(key, value);
            }
        },
        clients: { ipfsGateways: Object.fromEntries(gatewayUrls.map((url) => [url, {}])) }
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
});
