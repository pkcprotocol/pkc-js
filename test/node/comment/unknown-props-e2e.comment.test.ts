// End to end: an author signs a comment carrying an unknown prop named like a member of the Comment
// instance, a throwaway community accepts it, and a separate reader loads it. The unit suites
// (test/node-and-browser/**/unknown-props-*) show the assignment sites are unsafe; this shows what a
// real community lets through and what a real reader suffers.
//
// The acceptance table pins what a community does with each name. A community refuses every name that would replace a
// member of a Comment instance, so no reader of an up-to-date community meets one; the reader-side suites cover
// a record that got past an older community.
//
// The poisoned comments only ever go to a community this file creates and deletes, never to the shared
// signers[*] boards, which a poisoned comment would break for every other running suite.
//
// describeSkipIfRpc: the community runs in this process (mockPKC) and the reader reads it through
// mockRemotePKC; under RPC the local community would live in the RPC server process on a different dist,
// so this suite cannot test the build under change. The RPC client's own merge of server-sent runtime
// fields is a separate vector, not covered here.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mockPKC, mockRemotePKC, createSubWithNoChallenge, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { publishPoisonedComment } from "../../helpers/poisoned-publish.js";
import type { PublishedComment } from "../../helpers/poisoned-publish.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { captureProcessFatalErrors, objectPrototypeIsClean, stopOutcome } from "../../helpers/hostile-props.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

type Bag = Record<string, unknown>;
const asBag = (x: object): Bag => <Bag>(<unknown>x);
const HOSTILE = "hostile value";
const BENIGN = "extraProp";

// [name, community accepts it]. Rejected: names in the reserved-field list (`raw`, and the method names of a Comment
// such as `update` and `stop`) and names the forbidden-key rule refuses (`_` prefix, `__proto__`, `constructor`,
// anything Object.prototype has). Accepted: a name that means nothing to a Comment instance.
const SNAPSHOT: Array<[string, boolean]> = [
    [BENIGN, true],
    ["update", false],
    ["stop", false],
    ["_clientsManager", false],
    ["_wasPublishCalled", false],
    ["_updateAttempt", false],
    ["constructor", false],
    ["toString", false],
    ["__proto__", false],
    ["raw", false]
];

type Published = PublishedComment;

describeSkipIfRpc("unknown props that collide with an instance member, through a real community and reader", () => {
    let pkc: PKC;
    let reader: PKC;
    let community: LocalCommunity;
    let parentPost: Comment;
    const published: Published[] = [];
    const fatal = captureProcessFatalErrors();

    const publishPoisoned = ({ name, asReply }: { name: string; asReply: boolean }) =>
        publishPoisonedComment({ pkc, communityAddress: community.address, parent: asReply ? parentPost : undefined, name });

    beforeAll(async () => {
        pkc = await mockPKC();
        reader = await mockRemotePKC();
        community = <LocalCommunity>await createSubWithNoChallenge({}, pkc);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        parentPost = (await publishPoisoned({ name: BENIGN, asReply: false })).publisher;
        for (const [name] of SNAPSHOT) published.push(await publishPoisoned({ name, asReply: false }));
        // replies are loaded through their ancestor's pages, which is the other place a record becomes an instance
        for (const [name] of SNAPSHOT) published.push({ ...(await publishPoisoned({ name, asReply: true })), name: `reply:${name}` });
    }, 600_000);

    afterAll(async () => {
        fatal.stop();
        await community.delete();
        await reader.destroy();
        await pkc.destroy();
    });

    it("the community rejects every colliding name and accepts a benign extra prop", () => {
        for (const [name, expected] of SNAPSHOT) {
            const p = published.find((x) => x.name === name)!;
            expect.soft(p.accepted, `[${name}] accepted (reason: ${p.reason})`).toBe(expected);
        }
    });

    for (const prefix of ["", "reply:"]) {
        it(`a reader that loads the ${prefix ? "reply" : "post"} by cid keeps a working instance`, async () => {
            for (const [name, accepted] of SNAPSHOT) {
                if (!accepted) continue;
                const p = published.find((x) => x.name === `${prefix}${name}`)!;
                if (!p.cid) continue;
                const readerComment = <Comment>await reader.createComment({ cid: p.cid });
                const readerErrors: Error[] = [];
                readerComment.on("error", (e) => readerErrors.push(e));
                try {
                    await readerComment.update();
                    await resolveWhenConditionIsTrue({
                        toUpdate: readerComment,
                        predicate: async () => typeof readerComment.updatedAt === "number"
                    });
                } catch (e) {
                    expect.soft((<Error>e).message, `[${prefix}${name}] reader failed to load the comment`).toBe("loaded");
                }
                expect.soft(typeof readerComment.update, `[${prefix}${name}] reader's update must stay a function`).toBe("function");
                expect.soft(typeof readerComment.stop, `[${prefix}${name}] reader's stop must stay a function`).toBe("function");
                expect.soft(await stopOutcome(readerComment), `[${prefix}${name}] reader's stop() must not throw`).toBeUndefined();
                if (name === BENIGN) expect.soft(asBag(readerComment)[BENIGN], "the benign extra prop is still readable").toBe(HOSTILE);
                expect.soft(objectPrototypeIsClean(), `[${prefix}${name}] Object.prototype polluted`).toBe(true);
                expect
                    .soft(
                        readerErrors.map((e) => e.message),
                        `[${prefix}${name}] reader emitted errors`
                    )
                    .toEqual([]);
            }
        }, 600_000);
    }

    // The same class one level down: a prototype-member name inside the author object the author signs. The
    // community accepts it or not (pinned below), and a reader merges comment.author with Object.assign.
    it("a prototype-member name inside author leaves the reader's comment.author intact", async () => {
        for (const name of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
            const p = await publishPoisonedComment({ pkc, communityAddress: community.address, name, inAuthor: true });
            if (!p.accepted || !p.cid) {
                // pinned as a snapshot: a rejection here is the community refusing it, which is safe for this name
                continue;
            }
            const readerComment = <Comment>await reader.createComment({ cid: p.cid });
            try {
                await readerComment.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: readerComment,
                    predicate: async () => typeof readerComment.updatedAt === "number"
                });
            } catch (e) {
                expect.soft((<Error>e).message, `[author.${name}] reader failed to load the comment`).toBe("loaded");
            }
            expect.soft(Object.getPrototypeOf(readerComment.author), `[author.${name}] author prototype`).toBe(Object.prototype);
            expect.soft(asBag(readerComment.author)[name] === HOSTILE, `[author.${name}] hostile value replaced the member`).toBe(false);
            expect.soft(objectPrototypeIsClean(), `[author.${name}] Object.prototype polluted`).toBe(true);
            await stopOutcome(readerComment);
        }
    }, 600_000);

    // Decided: a key named like a member of an object (or starting with `_`) inside author makes the record
    // invalid, so the community refuses it at acceptance (verifyComment) instead of signing it into its pages.
    it("the community rejects a comment whose author carries a prototype-member or underscore key", async () => {
        for (const name of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__", "_private"]) {
            const p = await publishPoisonedComment({ pkc, communityAddress: community.address, name, inAuthor: true });
            expect.soft(p.accepted, `[author.${name}] accepted by the community (reason: ${p.reason})`).toBe(false);
        }
    }, 600_000);

    it("publishing the poisoned comments raises nothing that would terminate the process", () => {
        // an uncaught TypeError from the publish teardown ends a Node process; a server publishing for others dies with it
        expect(fatal.errors.join(" | ")).toBe("");
    });

    it("the author's own instance survives the verdict on its poisoned comment", async () => {
        for (const p of published.filter((x) => x.accepted && !x.name.startsWith("reply:"))) {
            expect.soft(typeof p.publisher.update, `[${p.name}] publisher's update must stay a function`).toBe("function");
            expect.soft(typeof p.publisher.stop, `[${p.name}] publisher's stop must stay a function`).toBe("function");
            expect
                .soft(
                    p.publisherErrors.map((e) => e.message),
                    `[${p.name}] publisher emitted errors`
                )
                .toEqual([]);
            expect.soft(await stopOutcome(p.publisher), `[${p.name}] publisher's stop() must not throw`).toBeUndefined();
        }
    });
});
