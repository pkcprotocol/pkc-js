// End to end for CommentUpdate extras, the community-controlled half of the class. A challenge installed by
// the community owner can return { success: true, commentUpdate: { <key>: <value> } } (issue #572): the
// key is signed into the challenge-verification message AND into the regular CommentUpdate the community
// publishes, so every reader of that comment copies it onto its Comment instance, and the author's own
// instance copies it from the verification. A hostile community can therefore break readers of comments it
// received from honest authors, which an author-signed prop cannot do.
//
// The community refuses a challenge result whose commentUpdate key would replace a member of an instance: a name
// in CommentUpdateReservedFields (the method names of a Comment included), or one the forbidden-key rule refuses
// (`_` prefix, `__proto__`, `constructor`, anything Object.prototype has) (validate-challenge-result.ts). So the
// hostile names below never reach a reader through a community running this build, and the verdict the author
// gets is a failure; the benign key still does. A reader of a record that got past an older community is covered
// by the unit suites.
//
// The challenge is an in-process factory, so this is describeSkipIfRpc: the RPC server could not see it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
    mockPKC,
    mockRemotePKC,
    generateMockPost,
    resolveWhenConditionIsTrue,
    iterateThroughPagesToFindCommentInParentPagesInstance
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { HOSTILE_VALUE, captureProcessFatalErrors, objectPrototypeIsClean, stopOutcome } from "../../helpers/hostile-props.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { ChallengeResult } from "../../../dist/node/community/types.js";

type Bag = Record<string, unknown>;
const asBag = (x: object): Bag => <Bag>(<unknown>x);
const BENIGN = "myExtraKey";
const NAMES = [BENIGN, "update", "stop", "_clientsManager", "_wasPublishCalled", "_updateAttempt", "constructor", "toString"];

describeSkipIfRpc("challenge-supplied commentUpdate extras that collide with an instance member", () => {
    let pkc: PKC;
    let reader: PKC;
    let community: LocalCommunity;
    // the challenge reads this when a publication arrives; the publications below are sequential
    let nextExtraName = BENIGN;
    const emittedErrors: Array<{ code?: string; message: string }> = [];
    const fatal = captureProcessFatalErrors();
    const published: Array<{ name: string; publisher: Comment; publisherErrors: Error[]; cid?: string; gotVerdict: boolean }> = [];

    beforeAll(async () => {
        pkc = await mockPKC();
        reader = await mockRemotePKC();
        pkc.settings = {
            challenges: {
                "hostile-extra": () => ({
                    type: "text/plain" as const,
                    getChallenge: async (): Promise<ChallengeResult> => {
                        const result: ChallengeResult & { commentUpdate?: Record<string, unknown> } = {
                            success: true,
                            commentUpdate: { [nextExtraName]: HOSTILE_VALUE }
                        };
                        return result;
                    }
                })
            }
        };
        community = <LocalCommunity>await pkc.createCommunity();
        community.on("error", (e: Error & { code?: string }) => emittedErrors.push({ code: e.code, message: e.message }));
        await community.edit({ settings: { challenges: [{ name: "hostile-extra" }] } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        for (const name of NAMES) {
            nextExtraName = name;
            const publisherErrors: Error[] = [];
            // not publishRandomPost: once the extra poisons this instance the helper's own follow-up calls on it fail,
            // which would break the setup before any assertion. The verdict is read from the event with a cap: if the
            // extra breaks the publisher before it emits challengeverification, publish() never settles for the author,
            // which is itself a finding, so the cid is then read from the community's own database.
            const post = <Comment>await generateMockPost({ communityAddress: community.address, pkc: reader });
            post.on("error", (e) => publisherErrors.push(e));
            const verdict = new Promise<{ challengeSuccess: boolean; commentUpdate?: { cid: string } } | "no-verdict">((resolve) => {
                post.once("challengeverification", resolve);
                setTimeout(() => resolve("no-verdict"), 45_000);
            });
            await post.publish();
            const v = await verdict;
            let cid = v === "no-verdict" ? undefined : v.challengeSuccess ? v.commentUpdate?.cid : undefined;
            if (v === "no-verdict") {
                // the community stores the post whatever the author's instance does
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => community._dbHandler.queryLatestPostCid()?.cid !== published.at(-1)?.cid
                });
                cid = community._dbHandler.queryLatestPostCid()?.cid;
            }
            published.push({ name, publisher: post, publisherErrors, cid, gotVerdict: v !== "no-verdict" });
        }
    }, 600_000);

    afterAll(async () => {
        fatal.stop();
        await community.delete();
        await reader.destroy();
        await pkc.destroy();
    });

    it("the community refuses every colliding extra, and accepts the benign one", () => {
        expect(published.length).toBe(NAMES.length);
        for (const p of published) {
            if (p.name === BENIGN) expect.soft(p.cid, `[${p.name}] was accepted`).toBeTypeOf("string");
            else expect.soft(p.cid, `[${p.name}] must be refused`).toBeUndefined();
        }
        const refused = emittedErrors.filter((e) => e.code === "ERR_CHALLENGE_RESULT_OVERRIDES_RESERVED_COMMENT_UPDATE_FIELD");
        expect(refused.length, "one refusal per colliding extra").toBe(NAMES.length - 1);
        expect(emittedErrors.length, "the community emitted nothing else").toBe(refused.length);
    });

    it("a reader that loads the post by cid keeps a working instance", async () => {
        for (const { name, cid } of published) {
            if (!cid) continue;
            const readerComment = <Comment>await reader.createComment({ cid });
            try {
                await readerComment.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: readerComment,
                    predicate: async () => typeof readerComment.updatedAt === "number"
                });
            } catch (e) {
                expect.soft((<Error>e).message, `[${name}] reader failed to load the comment`).toBe("loaded");
            }
            expect.soft(typeof readerComment.update, `[${name}] update must stay a function`).toBe("function");
            expect.soft(typeof readerComment.stop, `[${name}] stop must stay a function`).toBe("function");
            expect.soft(await stopOutcome(readerComment), `[${name}] stop() must not throw`).toBeUndefined();
            if (name === BENIGN) expect.soft(asBag(readerComment)[BENIGN], "the benign extra key is still readable").toBe(HOSTILE_VALUE);
            expect.soft(objectPrototypeIsClean(), `[${name}] Object.prototype polluted`).toBe(true);
        }
    }, 600_000);

    it("a reader that builds the post from a page entry keeps a working instance", async () => {
        const remoteCommunity = await reader.createCommunity({ address: community.address });
        await remoteCommunity.update();
        await resolveWhenConditionIsTrue({
            toUpdate: remoteCommunity,
            predicate: async () => {
                if (typeof remoteCommunity.updatedAt !== "number") return false;
                for (const p of published.filter((x) => x.cid))
                    if (!(await iterateThroughPagesToFindCommentInParentPagesInstance(p.cid!, remoteCommunity.posts))) return false;
                return true;
            }
        });
        for (const { name, cid } of published.filter((x) => x.cid)) {
            const comment = <Comment>await reader.createComment({ cid: cid! });
            expect.soft(comment.raw.commentUpdate ?? comment.raw.comment, `[${name}] built from the page entry`).toBeDefined();
            expect.soft(typeof comment.update, `[${name}] update must stay a function`).toBe("function");
            expect.soft(typeof comment.stop, `[${name}] stop must stay a function`).toBe("function");
            expect.soft(await stopOutcome(comment), `[${name}] stop() must not throw`).toBeUndefined();
            if (name === BENIGN) expect.soft(asBag(comment)[BENIGN], "the benign extra key is still readable").toBe(HOSTILE_VALUE);
        }
        await remoteCommunity.stop();
    }, 600_000);

    it("a community-supplied extra raises nothing that would terminate the author's process", () => {
        expect(fatal.errors.join(" | ")).toBe("");
    });

    it("the author's publish() still settles with a verdict", () => {
        for (const p of published) expect.soft(p.gotVerdict, `[${p.name}] the author received a challengeverification`).toBe(true);
    });

    it("the author's own instance survives the verification that carries the extra", async () => {
        for (const { name, publisher, publisherErrors } of published) {
            expect.soft(typeof publisher.update, `[${name}] publisher's update must stay a function`).toBe("function");
            expect.soft(typeof publisher.stop, `[${name}] publisher's stop must stay a function`).toBe("function");
            expect
                .soft(
                    publisherErrors.map((e) => e.message),
                    `[${name}] publisher emitted errors`
                )
                .toEqual([]);
            expect.soft(await stopOutcome(publisher), `[${name}] publisher's stop() must not throw`).toBeUndefined();
        }
    });
});
