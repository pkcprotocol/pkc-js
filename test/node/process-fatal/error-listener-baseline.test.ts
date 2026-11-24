// Characterization of the documented behaviour (README: listen for errors): an "error" emitted by an instance when
// nobody listens ends the process if the emit happens in a detached callback. Instances forward their error to pkc
// when they are the only listener, so a listener on pkc is enough, and a listener on the instance alone is too.
// These tests pin which listener makes which emit safe; the findings tests rely on that to tell a documented crash
// (no listener) from a crash that survives a listener.
import { describe, it, expect } from "vitest";
import PKC from "../../../dist/node/index.js";
import { captureProcessFatalErrors, letDetachedWorkSettle } from "../../helpers/process-fatal.js";

const CID = "QmUDRXeoTt4kCZSwEK78UyduLcQcvhzfeEmUXTzuvVFRmu";

async function fatalsOfDetachedErrorEmit(
    listener: "none" | "pkc" | "instance",
    pick: (pkc: Awaited<ReturnType<typeof PKC>>) => Promise<{ emit: (event: "error", error: Error) => boolean; on: (event: "error", fn: () => void) => unknown }>
): Promise<string[]> {
    const pkc = await PKC({ dataPath: undefined, httpRoutersOptions: [], ipfsGatewayUrls: ["http://127.0.0.1:1"] });
    const instance = await pick(pkc);
    if (listener === "pkc") pkc.on("error", () => {});
    if (listener === "instance") instance.on("error", () => {});
    const capture = captureProcessFatalErrors();
    setTimeout(() => instance.emit("error", new Error("detached")), 0); // detached: nothing awaits or catches it
    await letDetachedWorkSettle(300);
    capture.stop();
    await pkc.destroy();
    return capture.fatals.map((f) => f.kind);
}

describe("an error emitted from a detached callback", () => {
    it("ends the process only when nothing listens, for every instance type", async () => {
        const instances = {
            pkc: async (pkc: Awaited<ReturnType<typeof PKC>>) => pkc,
            comment: (pkc: Awaited<ReturnType<typeof PKC>>) => pkc.createComment({ cid: CID }),
            communityList: (pkc: Awaited<ReturnType<typeof PKC>>) => pkc.createCommunityList({ cid: CID })
        };
        const outcomes: Record<string, string[]> = {};
        for (const [name, pick] of Object.entries(instances))
            for (const listener of <const>["none", "pkc", "instance"])
                outcomes[`${name} | listener: ${listener}`] = await fatalsOfDetachedErrorEmit(listener, pick as never);
        expect(outcomes).toEqual({
            "pkc | listener: none": ["uncaughtException"],
            "pkc | listener: pkc": [],
            "pkc | listener: instance": [],
            "comment | listener: none": ["uncaughtException"],
            "comment | listener: pkc": [],
            "comment | listener: instance": [],
            "communityList | listener: none": ["uncaughtException"],
            "communityList | listener: pkc": [],
            "communityList | listener: instance": []
        });
    });
});
