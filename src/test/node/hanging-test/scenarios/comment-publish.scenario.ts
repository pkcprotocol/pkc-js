import { publishRandomPost } from "../../../test-util.js";
import { createScenarioContext, defineHangingScenario } from "./hanging-test-util.js";

/**
 * Template scenario showing the shape expected by the hanging test harness.
 * Replace the placeholder steps with the flow you want to exercise before
 * checking for lingering resources. Make sure any asynchronous work is awaited
 * so the destroy call can flush everything properly.
 */
export default defineHangingScenario({
    id: "comment-publish",
    description: "Finish publishing a comment and destroy pkc",
    run: async ({ configCode }) => {
        const communityAddress = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";
        const { pkc, config } = await createScenarioContext(configCode);

        const post = await publishRandomPost({ communityAddress, pkc });

        await pkc.destroy();
    }
});
