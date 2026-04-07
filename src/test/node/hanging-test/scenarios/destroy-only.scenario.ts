import { createScenarioContext, defineHangingScenario } from "./hanging-test-util.js";

/**
 * Baseline scenario that simply exercises the PKC lifecycle.
 * The scenario itself is responsible for destroying the instance so the test
 * harness can measure whether anything keeps the process or worker alive.
 */
export default defineHangingScenario({
    id: "destroy-only",
    description: "instantiate a PKC client and destroy it",
    run: async ({ configCode }) => {
        const { pkc } = await createScenarioContext(configCode);

        await pkc.destroy();
    }
});
