import { resolveWhenConditionIsTrue } from "../../../test-util.js";
import { createScenarioContext, defineHangingScenario } from "./hanging-test-util.js";
/**
 * Template scenario showing the shape expected by the hanging test harness.
 * Replace the placeholder steps with the flow you want to exercise before
 * checking for lingering resources. Make sure any asynchronous work is awaited
 * so the destroy call can flush everything properly.
 */
export default defineHangingScenario({
    id: "community-update",
    description: "update a community and destroy pkc",
    run: async ({ configCode }) => {
        const communityAddress = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";
        const { pkc, config } = await createScenarioContext(configCode);
        const community = await pkc.createCommunity({ address: communityAddress });
        await community.update();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        await pkc.destroy();
    }
});
//# sourceMappingURL=community-update.scenario.js.map