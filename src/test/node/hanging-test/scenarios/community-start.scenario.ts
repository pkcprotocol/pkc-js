import { resolveWhenConditionIsTrue } from "../../../test-util.js";
import { createScenarioContext, defineHangingScenario } from "./hanging-test-util.js";

/**
 * Template scenario showing the shape expected by the hanging test harness.
 * Replace the placeholder steps with the flow you want to exercise before
 * checking for lingering resources. Make sure any asynchronous work is awaited
 * so the destroy call can flush everything properly.
 */
export default defineHangingScenario({
    id: "community-start",
    description: "start a community and destroy pkc",
    run: async ({ configCode }) => {
        const allowedConfigCodes = ["local-kubo-rpc", "remote-pkc-rpc"];
        if (!allowedConfigCodes.includes(configCode)) return;
        const { pkc, config } = await createScenarioContext(configCode);

        const community = await pkc.createCommunity();

        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        await pkc.destroy();
    }
});
