import { beforeAll, afterAll, describe, it, expect } from "vitest";
import signers from "../../fixtures/signers.js";
import { getAvailablePKCConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";
import { PostsPagesIpfsSchema, RepliesPagesIpfsSchema, ModQueuePagesIpfsSchema } from "../../../dist/node/pages/schema.js";
import { CommunityPageSortSettingSchema, CommunityPageSortsSchema, PageSortFileSchema } from "../../../dist/node/community/schema.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";

// Sort names are plain-object keys on a client (pages.clients[transport][sortName], pages.pages[sortName]). A record
// naming a sort `__proto__`, `constructor` or `prototype` must neither validate nor, when it slips past validation
// (zod drops an own `__proto__` key without visiting it, and the community record is kept as parsed JSON), write
// through Object.prototype. See the CodeRabbit review of PR #346 and src/object-key-util.ts.
//
// The same goes for every other key a plain object inherits (toString, hasOwnProperty, valueOf, ...): the client
// manager's `if (!clients[sortName])` finds the inherited function and would hang per-transport client state on it,
// a function shared by every object in the process. See the review of PR #538.

const INHERITED = ["toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "__defineGetter__"];
const RESERVED = ["__proto__", "constructor", "prototype", ...INHERITED];
const CID = "QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH";
const EMPTY_PAGE = { comments: [] as unknown[] };

// JSON.parse is the only way to get an own `__proto__` key, which is how a record from the wire carries one
const recordKeyedBy = (key: string, value: unknown): Record<string, unknown> =>
    JSON.parse(`{${JSON.stringify(key)}: ${JSON.stringify(value)}}`);

describe("reserved sort names are rejected by the page and community schemas", () => {
    // zod never visits an own `__proto__` key (it drops it), so the refine can only reject the two it does visit
    const visibleReserved = RESERVED.filter((key) => key !== "__proto__");

    it("pages and pageCids keys", () => {
        for (const key of visibleReserved) {
            expect(PostsPagesIpfsSchema.safeParse({ pages: recordKeyedBy(key, EMPTY_PAGE) }).success, `posts.pages.${key}`).to.be.false;
            expect(PostsPagesIpfsSchema.safeParse({ pages: {}, pageCids: recordKeyedBy(key, CID) }).success, `posts.pageCids.${key}`).to.be
                .false;
            expect(RepliesPagesIpfsSchema.safeParse({ pages: recordKeyedBy(key, EMPTY_PAGE) }).success, `replies.pages.${key}`).to.be.false;
            expect(RepliesPagesIpfsSchema.safeParse({ pages: {}, pageCids: recordKeyedBy(key, CID) }).success, `replies.pageCids.${key}`).to
                .be.false;
            expect(ModQueuePagesIpfsSchema.safeParse({ pageCids: recordKeyedBy(key, CID) }).success, `modQueue.pageCids.${key}`).to.be
                .false;
        }
        expect(PostsPagesIpfsSchema.safeParse({ pages: {}, pageCids: { hot: CID, activeNoBump: CID } }).success).to.be.true;
    });

    it("an own __proto__ key never survives parsing as an own key", () => {
        const parsed = PostsPagesIpfsSchema.safeParse({ pages: {}, pageCids: recordKeyedBy("__proto__", CID) });
        if (parsed.success) expect(Object.keys(parsed.data.pageCids ?? {})).to.deep.equal([]);
    });

    it("community.pageSorts keys", () => {
        for (const key of visibleReserved) {
            expect(CommunityPageSortsSchema.safeParse({ posts: recordKeyedBy(key, { name: "x" }) }).success, `posts.${key}`).to.be.false;
            expect(CommunityPageSortsSchema.safeParse({ replies: recordKeyedBy(key, { name: "x" }) }).success, `replies.${key}`).to.be
                .false;
        }
        expect(CommunityPageSortsSchema.safeParse({ posts: { activeNoBump: { name: "x" } } }).success).to.be.true;
    });

    it("a page sort file's sortName", () => {
        // a string value is visited, so every reserved name is rejected here, __proto__ included
        for (const key of RESERVED) expect(PageSortFileSchema.safeParse({ sortName: key, score: () => 1 }).success, key).to.be.false;
        expect(PageSortFileSchema.safeParse({ sortName: "activeNoBump", score: () => 1 }).success).to.be.true;
    });

    // Issue #483: an entry of settings.pages may override the file's sortName, under the same rule as the file's own
    it("a settings.pages entry's sortName override", () => {
        const entries = [{ name: "hot" }, { path: "/some/page-sort.js" }, { name: "top", options: { maxAge: "2w" }, preloaded: true }];
        for (const entry of entries) {
            // a string value is visited, so every reserved name is rejected here, __proto__ included
            for (const key of RESERVED)
                expect(CommunityPageSortSettingSchema.safeParse({ ...entry, sortName: key }).success, `${JSON.stringify(entry)} ${key}`).to
                    .be.false;
            expect(CommunityPageSortSettingSchema.safeParse({ ...entry, sortName: "" }).success, "empty").to.be.false;
            for (const notAString of [5, true, null, ["hot"], { key: "hot" }])
                expect(CommunityPageSortSettingSchema.safeParse({ ...entry, sortName: notAString }).success, String(notAString)).to.be
                    .false;

            const parsed = CommunityPageSortSettingSchema.safeParse({ ...entry, sortName: "topFortnight" });
            expect(parsed.success, JSON.stringify(entry)).to.be.true;
            if (parsed.success) expect(parsed.data).to.deep.equal({ ...entry, sortName: "topFortnight" });

            // the field is optional: an entry written before it existed parses to itself, with no sortName key added
            const withoutOverride = CommunityPageSortSettingSchema.safeParse(entry);
            expect(withoutOverride.success).to.be.true;
            if (withoutOverride.success) expect(withoutOverride.data).to.deep.equal(entry);
        }
    });

    it("a settings.pages entry's sortName takes any other non-empty string, like a file's sortName", () => {
        for (const key of ["custom-newest", "top 2 weeks", "tostring", "to-string", "älteste/первые", "x".repeat(300)]) {
            expect(CommunityPageSortSettingSchema.safeParse({ name: "hot", sortName: key }).success, key).to.be.true;
            expect(PageSortFileSchema.safeParse({ sortName: key, score: () => 1 }).success, `file ${key}`).to.be.true;
        }
    });

    it("a settings.pages entry is still strict: a misspelt sortName key is rejected instead of silently ignored", () => {
        for (const misspelt of ["sortname", "sort_name", "key", "wireKey"])
            expect(CommunityPageSortSettingSchema.safeParse({ name: "hot", [misspelt]: "frontPage" }).success, misspelt).to.be.false;
        // and the override does not stand in for name/path
        expect(CommunityPageSortSettingSchema.safeParse({ sortName: "frontPage" }).success).to.be.false;
    });
});

type ClientsField = "ipfsGateways" | "kuboRpcClients" | "pkcRpcClients" | "libp2pJsClients";

const clientsFieldName: Record<string, ClientsField> = {
    "remote-ipfs-gateway": "ipfsGateways",
    "remote-kubo-rpc": "kuboRpcClients",
    "remote-pkc-rpc": "pkcRpcClients",
    "remote-libp2pjs": "libp2pJsClients"
};

getAvailablePKCConfigsToTestAgainst({
    includeOnlyTheseTests: ["remote-ipfs-gateway", "remote-kubo-rpc", "remote-pkc-rpc", "remote-libp2pjs"]
}).map((config) => {
    const clientField = clientsFieldName[config.testConfigCode];
    describe(`pages.clients.${clientField} skips reserved sort names - ${config.name}`, () => {
        let pkc: PKCType;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });
        afterAll(async () => {
            await pkc.destroy();
        });

        it("a pageCids record keyed by a reserved name seeds no client state and leaves the global prototypes alone", async () => {
            const community = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
            const globalKeysBefore = { proto: Object.getOwnPropertyNames(Object.prototype), ctor: Object.getOwnPropertyNames(Object) };
            // JSON.parse is how a record from the wire carries an own __proto__ key (an object literal would set the prototype)
            const inheritedFunctionKeysBefore = INHERITED.map((key) => Object.getOwnPropertyNames(Reflect.get(Object.prototype, key)));
            const wire = JSON.parse(
                JSON.stringify(Object.fromEntries(INHERITED.map((key) => [key, CID]))).replace(
                    "{",
                    `{"__proto__": "${CID}", "constructor": "${CID}", "prototype": "${CID}", "hot": "${CID}", `
                )
            ) as Record<string, string>;
            expect(Object.keys(wire)).to.have.members([...RESERVED, "hot"]);
            community.posts._clientsManager.updatePageCidsToSortTypes(wire);
            const clients = community.posts.clients as unknown as Record<ClientsField, Record<string, Record<string, { state: string }>>>;
            expect(Object.keys(clients[clientField])).to.include("hot");
            for (const key of RESERVED) expect(Object.prototype.hasOwnProperty.call(clients[clientField], key), key).to.be.false;
            expect(Object.getOwnPropertyNames(Object.prototype)).to.deep.equal(globalKeysBefore.proto);
            expect(Object.getOwnPropertyNames(Object)).to.deep.equal(globalKeysBefore.ctor);
            // no client state was hung on an inherited function such as Object.prototype.toString
            expect(INHERITED.map((key) => Object.getOwnPropertyNames(Reflect.get(Object.prototype, key)))).to.deep.equal(
                inheritedFunctionKeysBefore
            );
            expect(Object.getPrototypeOf(clients[clientField])).to.equal(Object.prototype);
        });
    });
});
