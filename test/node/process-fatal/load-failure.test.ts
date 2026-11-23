// Findings 4 and 5: a plain fetch failure (every gateway refuses the connection) while loading a comment or a community
// list. The failure is retriable, so the loader emits "error" from inside a detached retry callback and keeps going.
// With a listener nothing may end the process. Without one, the emit throws inside that callback: the documented
// behaviour, pinned here so the finding is classified by observation (see error-listener-baseline.test.ts).
import { describe, it, expect } from "vitest";
import PKC from "../../../dist/node/index.js";
import { captureProcessFatalErrors, letDetachedWorkSettle } from "../../helpers/process-fatal.js";

const CID = "QmUDRXeoTt4kCZSwEK78UyduLcQcvhzfeEmUXTzuvVFRmu";

async function fatalsWhileLoading(kind: "comment" | "communityList", withListener: boolean): Promise<string[]> {
    const pkc = await PKC({ dataPath: undefined, httpRoutersOptions: [], ipfsGatewayUrls: ["http://127.0.0.1:1"] });
    const instance = kind === "comment" ? await pkc.createComment({ cid: CID }) : await pkc.createCommunityList({ cid: CID });
    if (withListener) pkc.on("error", () => {});
    const capture = captureProcessFatalErrors();
    void instance.update().catch(() => {});
    await letDetachedWorkSettle(2500);
    capture.stop();
    await Promise.race([pkc.destroy().catch(() => {}), letDetachedWorkSettle(3000)]);
    return capture.fatals.map((f) => `${f.kind}: ${f.message.slice(0, 80)}`);
}

describe("a retriable fetch failure while loading", () => {
    it("raises no process-fatal error when something listens", async () => {
        expect({
            comment: await fatalsWhileLoading("comment", true),
            communityList: await fatalsWhileLoading("communityList", true)
        }).toEqual({ comment: [], communityList: [] });
    });

    it("ends the process when nothing listens (documented), recorded per loader", async () => {
        const outcomes = {
            comment: await fatalsWhileLoading("comment", false),
            communityList: await fatalsWhileLoading("communityList", false)
        };
        console.log("NO-LISTENER OUTCOMES", JSON.stringify(outcomes));
        expect(outcomes.comment.length).toBeGreaterThan(0);
        expect(outcomes.communityList.length).toBeGreaterThan(0);
    });
});
