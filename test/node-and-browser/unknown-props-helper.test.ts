// Direct tests of assignUnknownProps and mergeAuthorProps (src/unknown-props.ts), the one place every record
// loader copies unknown props through. The end-to-end suites prove each loader uses it; this file proves the rule.
import { describe, it, expect } from "vitest";
import { assignUnknownProps, mergeAuthorProps, forbiddenKeysOf, isForbiddenRecordKey } from "../../dist/node/unknown-props.js";
import { recordWith } from "../helpers/hostile-props.js";

type Bag = Record<string, unknown>;

class Target {
    cid = "QmTarget";
    _clientsManager = { real: true };
    _wasPublishCalled = false;
    clients = { real: true };
    state = "stopped";
    async update() {
        return "real update";
    }
    get derived() {
        return "getter";
    }
}
class Child extends Target {
    inheritedLevel2() {
        return "child method";
    }
}
const bag = (x: object): Bag => <Bag>(<unknown>x);
const objectPrototypeIsClean = () => bag({}).polluted === undefined;

describe("assignUnknownProps", () => {
    it("assigns an unknown prop and reports it", () => {
        const target = new Target();
        const res = assignUnknownProps({ target, record: { extraProp: { a: 1 }, cid: "ignored" }, knownKeys: ["cid"] });
        expect(bag(target).extraProp).toEqual({ a: 1 });
        expect(res).toEqual({ assigned: ["extraProp"], skipped: [] });
        expect(target.cid).toBe("QmTarget");
    });

    it("never touches a name in knownKeys", () => {
        const target = new Target();
        assignUnknownProps({ target, record: { state: "hostile" }, knownKeys: ["state"] });
        expect(target.state).toBe("stopped");
    });

    it("keeps the assigned prop enumerable and writable like Object.assign did", () => {
        const target = new Target();
        assignUnknownProps({ target, record: { extraProp: 1 }, knownKeys: [] });
        expect(Object.keys(target)).toContain("extraProp");
        expect(Object.getOwnPropertyDescriptor(target, "extraProp")).toMatchObject({
            writable: true,
            enumerable: true,
            configurable: true
        });
    });

    describe("members of the instance are never replaced", () => {
        const names = [
            "update", // inherited method
            "inheritedLevel2", // method two levels up the chain
            "derived", // inherited accessor
            "cid", // own data field
            "state", // own primitive field (a type rule would miss this one)
            "clients", // own plain-object field (a type rule would miss this one)
            "_clientsManager", // own private object
            "_wasPublishCalled", // own private primitive
            "toString", // Object.prototype members
            "valueOf",
            "hasOwnProperty",
            "isPrototypeOf"
        ];
        for (const name of names)
            it(`refuses ${name}`, () => {
                const target = new Child();
                const before = bag(target)[name];
                const res = assignUnknownProps({ target, record: { [name]: "hostile" }, knownKeys: [] });
                expect(bag(target)[name]).toBe(before);
                expect(res.skipped).toEqual([name]);
                expect(res.assigned).toEqual([]);
            });
    });

    describe("underscore names are refused even when the instance does not hold them", () => {
        for (const name of ["_", "_anything", "__private", "_clientsManagerLater"])
            it(`refuses ${name}`, () => {
                const target = new Target();
                const res = assignUnknownProps({ target, record: { [name]: "hostile" }, knownKeys: [] });
                expect(name in target && !(name in new Target())).toBe(false);
                expect(res.skipped).toEqual([name]);
            });
    });

    describe("prototype names", () => {
        it("refuses __proto__ as an own key (a record parsed off the wire) and leaves the prototype alone", () => {
            const target = new Child();
            const record = recordWith({ record: {}, name: "__proto__", value: { polluted: true } });
            expect(Object.keys(record)).toContain("__proto__");
            const res = assignUnknownProps({ target, record, knownKeys: [] });
            expect(res.skipped).toEqual(["__proto__"]);
            expect(Object.getPrototypeOf(target)).toBe(Child.prototype);
            expect(bag(target).polluted).toBeUndefined();
            expect(objectPrototypeIsClean()).toBe(true);
        });
        for (const name of ["constructor", "prototype"])
            it(`refuses ${name}`, () => {
                const target = new Target();
                const before = bag(target)[name];
                const res = assignUnknownProps({ target, record: { [name]: "hostile" }, knownKeys: [] });
                expect(res.skipped).toEqual([name]);
                expect(bag(target)[name]).toBe(before);
            });
    });

    it("refuses a function value", () => {
        const target = new Target();
        const res = assignUnknownProps({ target, record: { callback: () => "x" }, knownKeys: [] });
        expect(res.skipped).toEqual(["callback"]);
        expect("callback" in target).toBe(false);
    });

    it("skips only the hostile names of a mixed record and still assigns the benign ones", () => {
        const target = new Target();
        const res = assignUnknownProps({ target, record: { extraProp: 1, update: "x", tip: 2, _clientsManager: "y" }, knownKeys: [] });
        expect(res.assigned.sort()).toEqual(["extraProp", "tip"]);
        expect(res.skipped.sort()).toEqual(["_clientsManager", "update"]);
        expect(typeof target.update).toBe("function");
    });

    describe("a prop that came from an earlier record stays updatable (commentUpdate.tip over time)", () => {
        it("updates the value on the next load", () => {
            const target = new Target();
            assignUnknownProps({ target, record: { tip: 1 }, knownKeys: [] });
            const res = assignUnknownProps({ target, record: { tip: 2 }, knownKeys: [] });
            expect(bag(target).tip).toBe(2);
            expect(res).toEqual({ assigned: ["tip"], skipped: [] });
        });
        it("a name a record assigned is not a licence for another name", () => {
            const target = new Target();
            assignUnknownProps({ target, record: { tip: 1 }, knownKeys: [] });
            const res = assignUnknownProps({ target, record: { tip: 2, update: "x" }, knownKeys: [] });
            expect(res.skipped).toEqual(["update"]);
            expect(typeof target.update).toBe("function");
        });
        it("another instance does not inherit the licence", () => {
            const a = new Target();
            const b = new Target();
            assignUnknownProps({ target: a, record: { tip: 1 }, knownKeys: [] });
            Object.defineProperty(b, "tip", { value: "member of b", writable: true, enumerable: true, configurable: true });
            const res = assignUnknownProps({ target: b, record: { tip: 2 }, knownKeys: [] });
            expect(res.skipped).toEqual(["tip"]);
            expect(bag(b).tip).toBe("member of b");
        });
        it("a hostile name never becomes updatable by appearing first", () => {
            const target = new Target();
            assignUnknownProps({ target, record: { update: "first" }, knownKeys: [] });
            assignUnknownProps({ target, record: { update: "second" }, knownKeys: [] });
            expect(typeof target.update).toBe("function");
        });
    });

    it("does nothing for an empty record", () => {
        expect(assignUnknownProps({ target: new Target(), record: {}, knownKeys: [] })).toEqual({ assigned: [], skipped: [] });
    });

    it("does not pollute Object.prototype for any hostile name, ever", () => {
        const target = new Target();
        for (const name of ["__proto__", "constructor", "prototype", "toString"])
            assignUnknownProps({ target, record: recordWith({ record: {}, name, value: { polluted: true } }), knownKeys: [] });
        expect(objectPrototypeIsClean()).toBe(true);
    });
});

describe("mergeAuthorProps", () => {
    it("merges every ordinary field, known or not, and overwrites on the next merge", () => {
        const author: Bag = { address: "old", name: "n" };
        mergeAuthorProps({ target: author, props: { address: "new", displayName: "d", extra: 1 } });
        expect(author).toEqual({ address: "new", name: "n", displayName: "d", extra: 1 });
        mergeAuthorProps({ target: author, props: { extra: 2 } });
        expect(author.extra).toBe(2);
    });

    for (const name of ["toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "constructor", "prototype", "_private"])
        it(`refuses ${name}`, () => {
            const author: Bag = { address: "a" };
            const before = author[name];
            const res = mergeAuthorProps({ target: author, props: { [name]: "hostile", displayName: "kept" } });
            expect(author[name]).toBe(before);
            expect(author.displayName).toBe("kept");
            expect(res.skipped).toEqual([name]);
        });

    it("refuses __proto__ as an own key and leaves the prototype alone", () => {
        const author: Bag = { address: "a" };
        const props = recordWith({ record: {}, name: "__proto__", value: { polluted: true } });
        const res = mergeAuthorProps({ target: author, props });
        expect(res.skipped).toEqual(["__proto__"]);
        expect(Object.getPrototypeOf(author)).toBe(Object.prototype);
        expect(author.polluted).toBeUndefined();
        expect(objectPrototypeIsClean()).toBe(true);
    });
});

describe("forbiddenKeysOf", () => {
    it("lists every prototype, Object.prototype and underscore key, own keys only", () => {
        const author = recordWith({
            record: { address: "a", displayName: "d", extraProp: 1, toString: "x", valueOf: "x", _p: 1, constructor: "x" },
            name: "__proto__",
            value: { polluted: true }
        });
        expect(forbiddenKeysOf(author).sort()).toEqual(["__proto__", "_p", "constructor", "toString", "valueOf"].sort());
    });
    it("is empty for ordinary authors, null and non-objects", () => {
        expect(forbiddenKeysOf({ address: "a", displayName: "d", extraProp: 1, community: {} })).toEqual([]);
        for (const x of <unknown[]>[undefined, null, "str", 1, []]) expect(forbiddenKeysOf(x)).toEqual([]);
    });
    it("isForbiddenRecordKey matches the keys mergeAuthorProps refuses", () => {
        for (const name of ["toString", "__proto__", "constructor", "prototype", "_x", "hasOwnProperty"])
            expect(isForbiddenRecordKey(name)).toBe(true);
        for (const name of ["address", "name", "displayName", "tip", "community"]) expect(isForbiddenRecordKey(name)).toBe(false);
    });
});
