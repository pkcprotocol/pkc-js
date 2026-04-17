import { publishRandomPost, resolveWhenConditionIsTrue } from "../../../test-util.js";
import { createScenarioContext, defineHangingScenario } from "./hanging-test-util.js";

/**
 * Template scenario showing the shape expected by the hanging test harness.
 * Replace the placeholder steps with the flow you want to exercise before
 * checking for lingering resources. Make sure any asynchronous work is awaited
 * so the destroy call can flush everything properly.
 */
export default defineHangingScenario({
    id: "comment-update",
    description: "Fetch community, update a comment and destroy pkc",
    run: async ({ configCode }) => {
        const communityAddress = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";
        const { pkc, config } = await createScenarioContext(configCode);

        const communityLookupArgs = { publicKey: communityAddress };
        const community = await pkc.getCommunity(communityLookupArgs);

        const post = await pkc.createComment({ cid: community.lastPostCid! });
        await post.update();
        await resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => typeof post.updatedAt === "number" });

        await pkc.destroy();
    }
});
