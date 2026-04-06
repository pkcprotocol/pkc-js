import { resolveWhenConditionIsTrue } from "../../../test-util.js";
import { createScenarioContext, defineHangingScenario } from "./hanging-test-util.js";

/**
 * Template scenario showing the shape expected by the hanging test harness.
 * Replace the placeholder steps with the flow you want to exercise before
 * checking for lingering resources. Make sure any asynchronous work is awaited
 * so the destroy call can flush everything properly.
 */
export default defineHangingScenario({
    id: "subplebbit-update",
    description: "update a subplebbit and destroy plebbit",
    run: async ({ configCode }) => {
        const subplebbitAddress = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";
        const { plebbit, config } = await createScenarioContext(configCode);

        const subplebbit = await plebbit.createSubplebbit({ address: subplebbitAddress });

        await subplebbit.update();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        await plebbit.destroy();
    }
});
