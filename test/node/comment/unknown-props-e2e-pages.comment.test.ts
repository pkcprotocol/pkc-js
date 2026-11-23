// A comment can reach a reader as an entry of a page the community published (posts, or a post's
// replies) and, when the reader already holds that page, createComment({ cid }) builds the instance from
// the entry at once: _initIpfsProps(entry.comment) and _initCommentUpdate(entry.commentUpdate), with no
// fetch of the comment itself. This is the same assignment site as a direct load, reached through a
// different door, so it gets its own test: the unit table says the sites are unsafe, the direct-load e2e
// says a reader suffers, and this says the page door is open too.
//
// The poisoned comments only go to a throwaway community created here (see helpers/poisoned-publish.ts).
//
// describeSkipIfRpc: the community runs in this process (mockPKC) on this build; under RPC it would live in
// the RPC server on a different dist. The RPC client's page handling is a separate vector, not covered here.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mockPKC, mockRemotePKC, createSubWithNoChallenge, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { publishPoisonedComment } from "../../helpers/poisoned-publish.js";
import { HOSTILE_VALUE, objectPrototypeIsClean, stopOutcome } from "../../helpers/hostile-props.js";
import type { PublishedComment } from "../../helpers/poisoned-publish.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

type Bag = Record<string, unknown>;
const asBag = (x: object): Bag => <Bag>(<unknown>x);
const BENIGN = "extraProp";
// A community refuses every name but BENIGN (see unknown-props-e2e.comment.test.ts), so the page entries below only ever
// carry the benign one. The colliding names are published to prove the refusal for posts and replies as well; the
// reader-side handling of a record that got past an older community is covered by the unit suites, which call the same
// _initIpfsProps / _initCommentUpdate the page door calls.
const NAMES = [BENIGN, "update", "stop", "_clientsManager", "_wasPublishCalled", "constructor", "toString"];

describeSkipIfRpc("unknown props that collide with an instance member, loaded as a page entry", () => {
    let pkc: PKC;
    let reader: PKC;
    let community: LocalCommunity;
    let parentPost: Comment;
    const posts: PublishedComment[] = [];
    const replies: PublishedComment[] = [];

    beforeAll(async () => {
        pkc = await mockPKC();
        reader = await mockRemotePKC();
        community = <LocalCommunity>await createSubWithNoChallenge({}, pkc);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        parentPost = (await publishPoisonedComment({ pkc, communityAddress: community.address, name: BENIGN })).publisher;
        for (const name of NAMES) posts.push(await publishPoisonedComment({ pkc, communityAddress: community.address, name }));
        for (const name of NAMES)
            replies.push(await publishPoisonedComment({ pkc, communityAddress: community.address, parent: parentPost, name }));
    }, 600_000);

    afterAll(async () => {
        await community.delete();
        await reader.destroy();
        await pkc.destroy();
    });

    // The reader holds the community's pages first; only then is createComment({cid}) answered from an entry.
    // The wait asks the question the code under test asks (does createComment fill itself from a page?),
    // so posts and replies, which sit in different pages, use the same probe.
    async function readerHoldingPagesWith(cids: string[]) {
        const remoteCommunity = await reader.createCommunity({ address: community.address });
        await remoteCommunity.update();
        const filledFromPages = async (cid: string) => Boolean((<Comment>await reader.createComment({ cid })).raw.comment);
        await Promise.race([
            resolveWhenConditionIsTrue({
                toUpdate: remoteCommunity,
                predicate: async () => {
                    if (typeof remoteCommunity.updatedAt !== "number") return false;
                    for (const cid of cids) if (!(await filledFromPages(cid))) return false;
                    return true;
                }
            }),
            new Promise((resolve) => setTimeout(resolve, 60_000))
        ]);
        return remoteCommunity;
    }

    for (const kind of ["post", "reply"] as const) {
        it(`the community refuses every colliding name on a ${kind}, and accepts the benign one`, () => {
            for (const p of kind === "post" ? posts : replies)
                expect.soft(p.accepted, `[${kind}:${p.name}] accepted (reason: ${p.reason})`).toBe(p.name === BENIGN);
        });

        it(`a ${kind} read from a page entry keeps a working instance`, async () => {
            const set = (kind === "post" ? posts : replies).filter((p) => p.accepted && p.cid);
            expect(
                set.map((p) => p.name),
                `the accepted ${kind}s`
            ).toEqual([BENIGN]);
            const remoteCommunity = await readerHoldingPagesWith(set.map((p) => p.cid!));
            for (const p of set) {
                const comment = <Comment>await reader.createComment({ cid: p.cid! });
                // the precondition: the instance was filled from the page entry, not from an update loop
                expect.soft(comment.raw.comment, `[${kind}:${p.name}] built from the page entry`).toBeDefined();
                expect.soft(typeof comment.update, `[${kind}:${p.name}] update must stay a function`).toBe("function");
                expect.soft(typeof comment.stop, `[${kind}:${p.name}] stop must stay a function`).toBe("function");
                expect.soft(await stopOutcome(comment), `[${kind}:${p.name}] stop() must not throw`).toBeUndefined();
                if (p.name === BENIGN) expect.soft(asBag(comment)[BENIGN], "the benign extra prop is still readable").toBe(HOSTILE_VALUE);
                expect.soft(objectPrototypeIsClean(), `[${kind}:${p.name}] Object.prototype polluted`).toBe(true);
            }
            await remoteCommunity.stop();
        }, 600_000);
    }
});
