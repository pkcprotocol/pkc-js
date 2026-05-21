import { describe, it, expect } from "vitest";
import { getAvailablePKCConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";

const configs = getAvailablePKCConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true });

const MAX_MS = 100;
const TIMED_RUNS = 3;

describe.concurrent("Pkc() construction time", () => {
    configs.forEach((config) => {
        describe(`${config.name} (${config.testConfigCode})`, () => {
            it(`constructs in under ${MAX_MS}ms (median of ${TIMED_RUNS} runs)`, async () => {
                const warmup = await config.pkcInstancePromise();
                await warmup.destroy();

                const timings: number[] = [];
                for (let i = 0; i < TIMED_RUNS; i++) {
                    const start = performance.now();
                    const pkc = await config.pkcInstancePromise();
                    timings.push(performance.now() - start);
                    await pkc.destroy();
                }

                const sorted = [...timings].sort((a, b) => a - b);
                const median = sorted[Math.floor(sorted.length / 2)];
                console.log({ config: config.testConfigCode, timings, median });
                expect(median).to.be.lessThan(MAX_MS);
            }, 30_000);
        });
    });
});
