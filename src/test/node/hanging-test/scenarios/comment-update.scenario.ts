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
    description: "Fetch subplebbit, update a comment and destroy plebbit",
    run: async ({ configCode }) => {
        const subplebbitAddress = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";
        const { plebbit, config } = await createScenarioContext(configCode);

        const subplebbit = await plebbit.getCommunity({ address: subplebbitAddress });

        const post = await plebbit.createComment({ cid: subplebbit.lastPostCid! });
        await post.update();
        await resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => typeof post.updatedAt === "number" });

        await plebbit.destroy();
    }
});
