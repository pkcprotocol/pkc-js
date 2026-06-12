import { describe, it, expect } from "vitest";
import { getAvailablePKCConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";

const configs = getAvailablePKCConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true });

const DEFAULT_MAX_MS = 100;
// remote-libp2pjs constructs a Helia/libp2p node (keypair generation, transports), measured at 40-110ms
// on Firefox CI runners, so it gets a higher budget than the thin kubo-rpc/gateway clients
const MAX_MS_PER_CONFIG: Partial<Record<(typeof configs)[number]["testConfigCode"], number>> = { "remote-libp2pjs": 200 };
const TIMED_RUNS = 5;

// not describe.concurrent: timing runs must not overlap with the other configs constructing/destroying
// instances on the same runner, which inflates timings on slow CI machines
describe("Pkc() construction time", () => {
    configs.forEach((config) => {
        const maxMs = MAX_MS_PER_CONFIG[config.testConfigCode] ?? DEFAULT_MAX_MS;
        describe(`${config.name} (${config.testConfigCode})`, () => {
            it(`constructs in under ${maxMs}ms (min of ${TIMED_RUNS} runs)`, async () => {
                const warmup = await config.pkcInstancePromise();
                await warmup.destroy();

                const timings: number[] = [];
                for (let i = 0; i < TIMED_RUNS; i++) {
                    const start = performance.now();
                    const pkc = await config.pkcInstancePromise();
                    timings.push(performance.now() - start);
                    await pkc.destroy();
                }

                // assert on the minimum: noise (CI contention, GC) only ever adds time, so min-of-N is the
                // lowest-variance estimator of the true construction cost. A real eager-load regression adds
                // hundreds of ms to every run, which the minimum still catches
                const min = Math.min(...timings);
                console.log({ config: config.testConfigCode, timings, min });
                expect(min).to.be.lessThan(maxMs);
            }, 30_000);
        });
    });
});
