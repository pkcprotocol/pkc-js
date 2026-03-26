import { generateMockPost } from "../../../test-util.js";
import { createScenarioContext, defineHangingScenario } from "./hanging-test-util.js";

/**
 * Template scenario showing the shape expected by the hanging test harness.
 * Replace the placeholder steps with the flow you want to exercise before
 * checking for lingering resources. Make sure any asynchronous work is awaited
 * so the destroy call can flush everything properly.
 */
export default defineHangingScenario({
    id: "comment-publish-pending",
    description: "publish a comment over pubsub without succeeding and instead hanging. Then destroy plebbit",
    run: async ({ configCode }) => {
        const mathCliSub = "12D3KooWANwdyPERMQaCgiMnTT1t3Lr4XLFbK1z4ptFVhW2ozg1z";
        const { plebbit, config } = await createScenarioContext(configCode);

        const post = await generateMockPost({ communityAddress: mathCliSub, plebbit });
        post.removeAllListeners("challenge");

        await post.publish(); // it will receive a challenge, but we won't respond because we wanna keep process hanging

        await plebbit.destroy(); // destroy here should remove pubsub subscription
    }
});
