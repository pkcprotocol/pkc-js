import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import PKC from "../../../../../dist/node/index.js";
import type { PKC as PKCType } from "../../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../../dist/node/publications/comment/comment.js";

// comment.update() creates the shared pkc._updatingComments instance for the cid and only then mirrors and starts it. A
// stop() that lands before that (e.g. `comment.update(); await comment.stop()`) found nothing to detach, and update()
// then tracked, mirrored and started the shared instance anyway: a stopped comment kept a live update loop.
// The loop itself is stubbed, so this runs without the test server: what matters is whether it gets started.

const COMMENT_CID = "QmUFu8fzuT1th3jJYgR4oRgGpw3sgRALr4nbenA4pyoCav";

describe("comment.stop() before update() has started the shared updating instance", () => {
    let pkc: PKCType;

    beforeEach(async () => {
        pkc = await PKC({
            ipfsGatewayUrls: ["http://localhost:23426"],
            kuboRpcClientsOptions: undefined,
            pubsubKuboRpcClientsOptions: ["http://localhost:23425/api/v0"],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        pkc.on("error", () => {});
    });

    afterEach(async () => {
        if (!pkc.destroyed) await pkc.destroy();
    });

    it("does not track, mirror or start the shared instance", async () => {
        const comment = await pkc.createComment({ cid: COMMENT_CID });

        // Capture the shared instance update() creates, and stub its update loop
        const createdInstances: Comment[] = [];
        const loopStarts = vi.fn(async () => {});
        const realCreateComment = pkc.createComment.bind(pkc);
        vi.spyOn(pkc, "createComment").mockImplementation(async (...args: Parameters<PKCType["createComment"]>) => {
            const created = await realCreateComment(...args);
            createdInstances.push(created);
            created.loadCommentIpfsAndStartCommentUpdateSubscription = loopStarts;
            return created;
        });

        const updatePromise = comment.update();
        await comment.stop();
        await updatePromise;

        expect(createdInstances.length).to.equal(1);
        const sharedInstance = createdInstances[0];
        expect(comment.state).to.equal("stopped");
        expect(comment._updatingCommentInstance).to.be.undefined;
        expect(loopStarts).not.toHaveBeenCalled();
        expect(sharedInstance.state).to.equal("stopped");
        expect(sharedInstance._numOfListenersForUpdatingInstance).to.equal(0);
        expect(pkc._updatingComments.size()).to.equal(0);
    });

    // update() emits statechange "updating" before it starts anything, so a listener that calls stop() there runs before
    // the start-up. The start-up used to read the update attempt only after that emission, which took the stop()'s
    // attempt for its own
    it("does not start the shared instance when a statechange listener stops the comment on updating", async () => {
        const comment = await pkc.createComment({ cid: COMMENT_CID });
        const loopStarts = vi.fn(async () => {});
        const realCreateComment = pkc.createComment.bind(pkc);
        vi.spyOn(pkc, "createComment").mockImplementation(async (...args: Parameters<PKCType["createComment"]>) => {
            const created = await realCreateComment(...args);
            created.loadCommentIpfsAndStartCommentUpdateSubscription = loopStarts;
            return created;
        });
        let stopping: Promise<void> | undefined;
        comment.on("statechange", (state) => {
            if (state === "updating" && !stopping) stopping = comment.stop();
        });

        await comment.update();
        await stopping;

        expect(comment.state).to.equal("stopped");
        expect(comment._updatingCommentInstance).to.be.undefined;
        expect(loopStarts).not.toHaveBeenCalled();
        expect(pkc._updatingComments.size()).to.equal(0);
    });

    // update(), then stop(), then update() again, while the first update()'s pkc.createComment() is still pending. The
    // first start-up used to check only `state`, which the second update() had set back to "updating", so both start-ups
    // went on: one shared instance was orphaned with a running loop, and the other update() rejected with "This client is
    // already mirroring another client".
    it.each([
        ["first", [0, 1]],
        ["second", [1, 0]]
    ])(
        "update() after the stop() starts exactly one shared instance when the %s createComment() resolves first",
        async (_, releaseOrder) => {
            const comment = await pkc.createComment({ cid: COMMENT_CID });

            // Every createComment() made by update() waits for the test, and the update loop of what it creates is stubbed
            const created: { instance: Comment; loopStarts: Mock; release: () => void }[] = [];
            const realCreateComment = pkc.createComment.bind(pkc);
            vi.spyOn(pkc, "createComment").mockImplementation(async (...args: Parameters<PKCType["createComment"]>) => {
                const instance = await realCreateComment(...args);
                const loopStarts = vi.fn(async () => {});
                instance.loadCommentIpfsAndStartCommentUpdateSubscription = loopStarts;
                let release!: () => void;
                const gate = new Promise<void>((resolve) => (release = resolve));
                created.push({ instance, loopStarts, release });
                await gate;
                return instance;
            });

            const firstUpdate = comment.update();
            await vi.waitFor(() => expect(created.length).to.equal(1), { timeout: 5000, interval: 10 });
            await comment.stop();
            const secondUpdate = comment.update();
            await vi.waitFor(() => expect(created.length).to.equal(2), { timeout: 5000, interval: 10 });

            for (const index of releaseOrder) {
                created[index].release();
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            const outcomes = await Promise.allSettled([firstUpdate, secondUpdate]);
            expect(outcomes.map((outcome) => outcome.status)).to.deep.equal(["fulfilled", "fulfilled"]);

            const [stale, current] = created;
            expect(comment.state).to.equal("updating");
            expect(comment._updatingCommentInstance?.comment).to.equal(current.instance);
            expect(current.instance.state).to.equal("updating");
            expect(current.instance._numOfListenersForUpdatingInstance).to.equal(1);
            expect(current.loopStarts).toHaveBeenCalledTimes(1);
            expect(stale.instance.state).to.equal("stopped");
            expect(stale.instance._numOfListenersForUpdatingInstance).to.equal(0);
            expect(stale.loopStarts).not.toHaveBeenCalled();
            expect(pkc._updatingComments.size()).to.equal(1);
            expect(pkc._updatingComments.has(current.instance)).to.be.true;

            await comment.stop();
            expect(comment.state).to.equal("stopped");
            expect(comment._updatingCommentInstance).to.be.undefined;
            expect(current.instance.state).to.equal("stopped");
            expect(current.instance._numOfListenersForUpdatingInstance).to.equal(0);
            expect(pkc._updatingComments.size()).to.equal(0);
        }
    );
});
