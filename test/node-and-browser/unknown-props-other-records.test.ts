// The Comment instance copies unknown props off the records it loads (see the unknown-props-*.comment
// tests). This file asks the same question of every other record that becomes an instance: Community,
// CommunityList, Vote, CommentEdit, CommentModeration and CommunityEdit. A name that collides with a
// member of the instance must never replace it. Most of these are expected to hold already (they copy
// named fields); they are here so that is verified, and so a later change that adds a bare copy fails.
// Community is the one that copies unknown props the way Comment does.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mockRemotePKC, generateMockVote } from "../../dist/node/test/test-util.js";
import { HOSTILE_VALUE, hostileNamesFor, recordWith, valueFor, objectPrototypeIsClean, memberNamesOf } from "../helpers/hostile-props.js";
import communityFixture from "../fixtures/signatures/community/valid_community_ipfs_new_format_with_name.json" with { type: "json" };
import { CommunityIpfsSchema } from "../../dist/node/community/schema.js";
import type { PKC } from "../../dist/node/pkc/pkc.js";
import type { CommentIpfsWithCidDefined } from "../../dist/node/publications/comment/types.js";
import type { CommunityIpfsType } from "../../dist/node/community/types.js";
import type { CommunityListIpfsType } from "../../dist/node/community-list/types.js";

type Bag = Record<string, unknown>;
const asBag = (x: object): Bag => <Bag>(<unknown>x);
const COMMUNITY = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";
const CID = "QmeaD98zCjbs3h9GSCMixCGxMSJC3vUgW2i9pZoJpwkN7u";

describe("unknown props on records other than Comment", () => {
    let pkc: PKC;
    beforeAll(async () => {
        pkc = await mockRemotePKC();
    });
    afterAll(async () => {
        await pkc.destroy();
    });

    it("Community: initCommunityIpfsPropsNoMerge leaves every member of the instance alone", async () => {
        const record = <CommunityIpfsType>(<unknown>communityFixture);
        const probe = await pkc.createCommunity({ address: COMMUNITY });
        // ipnsName is read out of the record by name (see the separate test below), so it is not an unknown prop here
        const hostileNames = hostileNamesFor({
            instance: probe,
            knownKeys: [...Object.keys(record), ...Object.keys(CommunityIpfsSchema.shape)]
        }).filter((name) => name !== "ipnsName");
        expect(hostileNames.length).toBeGreaterThan(20);
        for (const name of hostileNames) {
            const community = await pkc.createCommunity({ address: COMMUNITY });
            const prototypeBefore = Object.getPrototypeOf(community);
            const memberBefore = asBag(community)[name];
            try {
                community.initCommunityIpfsPropsNoMerge(recordWith({ record, name, value: valueFor(name) }));
            } catch (e) {
                expect.soft((<Error>e).message, `[${name}] initCommunityIpfsPropsNoMerge threw`).toBe("did not throw");
                continue;
            }
            expect.soft(Object.getPrototypeOf(community), `[${name}] prototype of the instance`).toBe(prototypeBefore);
            // toEqual: a member such as `exports` is legitimately rebuilt as a fresh empty array by the load
            expect.soft(asBag(community)[name], `[${name}] member must keep its value`).toEqual(memberBefore);
            expect.soft(asBag(community).polluted, `[${name}] polluted through the prototype`).toBeUndefined();
        }
        expect.soft(objectPrototypeIsClean(), "Object.prototype polluted").toBe(true);
    });

    it("Community: an ipnsName extra prop in the record must not decide the instance's ipnsName", async () => {
        // _updateIpnsPubsubPropsIfNeeded reads `ipnsName` out of whatever it is given, a wire record included
        const community = await pkc.createCommunity({ address: COMMUNITY });
        const poisoned = <CommunityIpfsType>(<unknown>{ ...communityFixture, ipnsName: "hostile value" });
        let threw: string | undefined;
        try {
            community.initCommunityIpfsPropsNoMerge(poisoned);
        } catch (e) {
            threw = (<Error>e).message;
        }
        expect.soft(threw, "loading the record threw").toBeUndefined();
        expect.soft(community.ipnsName, "ipnsName of the instance").not.toBe("hostile value");
    });

    it("Community: a benign unknown prop still lands on the instance", async () => {
        const community = await pkc.createCommunity({ address: COMMUNITY });
        community.initCommunityIpfsPropsNoMerge(<CommunityIpfsType>(<unknown>{ ...communityFixture, extraProp: "1234" }));
        expect(asBag(community).extraProp).toBe("1234");
    });

    it("CommunityList: a loaded record's hostile names and entry keys do not replace instance or runtime fields", async () => {
        const list = await pkc.createCommunityList({ cid: CID });
        const record = <CommunityListIpfsType>(<unknown>{
            title: "list",
            timestamp: 1,
            protocolVersion: "1.0.0",
            signature: {
                type: "ed25519",
                publicKey: "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0",
                signature: "y",
                signedPropertyNames: []
            },
            communities: [{ publicKey: COMMUNITY }]
        });
        const names = hostileNamesFor({ instance: list, knownKeys: Object.keys(record) });
        for (const name of names) {
            const target = await pkc.createCommunityList({ cid: CID });
            const prototypeBefore = Object.getPrototypeOf(target);
            const memberBefore = asBag(target)[name];
            const poisoned = recordWith({ record, name, value: valueFor(name) });
            poisoned.communities = [<never>recordWith({ record: { publicKey: COMMUNITY }, name, value: valueFor(name) })];
            try {
                target._initFromWireRecord(poisoned, CID);
            } catch (e) {
                expect.soft((<Error>e).message, `[${name}] _initFromWireRecord threw`).toBe("did not throw");
                continue;
            }
            expect.soft(Object.getPrototypeOf(target), `[${name}] prototype of the instance`).toBe(prototypeBefore);
            // the record's own props are never copied onto the list, so a collision can only come from a bare assign
            expect.soft(asBag(target)[name] === HOSTILE_VALUE, `[${name}] instance member replaced`).toBe(false);
            if (typeof memberBefore === "function" || name.startsWith("_"))
                expect.soft(asBag(target)[name], `[${name}] method or private field replaced`).toBe(memberBefore);
            // runtime fields on an entry are derived from the entry, never taken from it
            expect.soft(target.communities?.[0].address, `[${name}] entry address`).toBe(COMMUNITY);
        }
        expect.soft(objectPrototypeIsClean(), "Object.prototype polluted").toBe(true);
    });

    it("CommunityList: a record that reaches the instance unverified does not put forbidden keys on its author or entries", async () => {
        const target = await pkc.createCommunityList({ cid: CID });
        const record = <CommunityListIpfsType>(<unknown>JSON.parse(
            `{"title":"t","timestamp":1,"protocolVersion":"1.0.0","author":{"toString":"x","_y":1,"displayName":"kept"},` +
                `"signature":{"type":"ed25519","publicKey":"ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0","signature":"y","signedPropertyNames":[]},` +
                `"communities":[{"publicKey":"${COMMUNITY}","constructor":"x","_z":1}]}`
        ));
        target._initFromWireRecord(record, CID);
        expect(Object.keys(target.author ?? {})).not.toContain("toString");
        expect(Object.keys(target.author ?? {})).not.toContain("_y");
        expect((<Bag>(<unknown>target.author)).displayName).toBe("kept");
        expect(Object.keys(target.communities?.[0] ?? {})).not.toContain("constructor");
        expect(Object.keys(target.communities?.[0] ?? {})).not.toContain("_z");
    });

    // Vote, CommentEdit, CommentModeration, CommunityEdit: build a signed wire publication, plant the
    // hostile name on it and instantiate it as a reader would. Rejecting it (a schema error) is as safe as
    // ignoring it; replacing a member is the failure.
    const wires: Array<{ type: string; build: () => Promise<{ wire: object; create: (w: object) => Promise<object> }> }> = [
        {
            type: "Vote",
            build: async () => {
                const vote = await generateMockVote(
                    <CommentIpfsWithCidDefined>(<unknown>{ cid: CID, communityAddress: COMMUNITY }),
                    1,
                    pkc
                );
                if (!vote.raw.pubsubMessageToPublish) {
                    await vote._initCommunity();
                    await vote._signPublicationWithCommunityFields();
                }
                return { wire: structuredClone(vote.raw.pubsubMessageToPublish!), create: (w) => pkc.createVote(<never>w) };
            }
        },
        {
            type: "CommentEdit",
            build: async () => {
                const edit = await pkc.createCommentEdit({
                    commentCid: CID,
                    communityAddress: COMMUNITY,
                    content: "edited",
                    signer: await pkc.createSigner()
                });
                if (!edit.raw.pubsubMessageToPublish) {
                    await edit._initCommunity();
                    await edit._signPublicationWithCommunityFields();
                }
                return { wire: structuredClone(edit.raw.pubsubMessageToPublish!), create: (w) => pkc.createCommentEdit(<never>w) };
            }
        },
        {
            type: "CommentModeration",
            build: async () => {
                const moderation = await pkc.createCommentModeration({
                    commentCid: CID,
                    communityAddress: COMMUNITY,
                    commentModeration: { pinned: true },
                    signer: await pkc.createSigner()
                });
                if (!moderation.raw.pubsubMessageToPublish) {
                    await moderation._initCommunity();
                    await moderation._signPublicationWithCommunityFields();
                }
                return {
                    wire: structuredClone(moderation.raw.pubsubMessageToPublish!),
                    create: (w) => pkc.createCommentModeration(<never>w)
                };
            }
        },
        {
            type: "CommunityEdit",
            build: async () => {
                const edit = await pkc.createCommunityEdit({
                    communityAddress: COMMUNITY,
                    communityEdit: { description: "described" },
                    signer: await pkc.createSigner()
                });
                if (!edit.raw.pubsubMessageToPublish) {
                    await edit._initCommunity();
                    await edit._signPublicationWithCommunityFields();
                }
                return { wire: structuredClone(edit.raw.pubsubMessageToPublish!), create: (w) => pkc.createCommunityEdit(<never>w) };
            }
        }
    ];

    for (const { type, build } of wires) {
        it(`${type}: a hostile unknown prop does not replace a member of the instance`, async () => {
            const { wire, create } = await build();
            const clean = await create(wire);
            const hostileNames = hostileNamesFor({ instance: clean, knownKeys: Object.keys(wire) });
            expect(hostileNames.length).toBeGreaterThan(10);
            for (const name of hostileNames) {
                let instance: object;
                try {
                    instance = await create(recordWith({ record: wire, name, value: valueFor(name) }));
                } catch {
                    continue; // rejected at the schema: safe
                }
                expect.soft(Object.getPrototypeOf(instance), `[${name}] prototype`).toBe(Object.getPrototypeOf(clean));
                // Only methods and private fields count: a field the schema declares (communityName, reason) is
                // legitimately set from the record
                for (const member of memberNamesOf(clean))
                    if (typeof asBag(clean)[member] === "function" || member.startsWith("_"))
                        expect.soft(asBag(instance)[member] === HOSTILE_VALUE, `[${name}] replaced member ${member}`).toBe(false);
            }
            expect.soft(objectPrototypeIsClean(), "Object.prototype polluted").toBe(true);
        });
    }
});
