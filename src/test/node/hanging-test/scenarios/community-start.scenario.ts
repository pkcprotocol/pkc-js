import { resolveWhenConditionIsTrue } from "../../../test-util.js";
import { createScenarioContext, defineHangingScenario } from "./hanging-test-util.js";

/**
 * Template scenario showing the shape expected by the hanging test harness.
 * Replace the placeholder steps with the flow you want to exercise before
 * checking for lingering resources. Make sure any asynchronous work is awaited
 * so the destroy call can flush everything properly.
 */
export default defineHangingScenario({
    id: "subplebbit-start",
    description: "start a subplebbit and destroy plebbit",
    run: async ({ configCode }) => {
        const allowedConfigCodes = ["local-kubo-rpc", "remote-plebbit-rpc"];
        if (!allowedConfigCodes.includes(configCode)) return;
        const { plebbit, config } = await createScenarioContext(configCode);

        const subplebbit = await plebbit.createSubplebbit();

        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        await plebbit.destroy();
    }
});
