import { describe, it, expect } from "vitest";
import { TrackedInstanceRegistry } from "../../../dist/node/pkc/tracked-instance-registry.js";

describe("TrackedInstanceRegistry", () => {
    it("Object.keys() returns empty array when no instances are tracked", () => {
        const registry = new TrackedInstanceRegistry<{ id: number }>();
        expect(Object.keys(registry)).to.deep.equal([]);
    });

    it("Object.keys() returns only tracked aliases, not internal properties", () => {
        const registry = new TrackedInstanceRegistry<{ id: number }>();
        const obj = { id: 1 };
        registry.track({ value: obj, aliases: ["alias1", "alias2"] });
        const keys = Object.keys(registry);
        expect(keys).to.include("alias1");
        expect(keys).to.include("alias2");
        expect(keys).to.not.include("_entries");
        expect(keys).to.not.include("_aliases");
    });

    it("Object.keys() excludes aliases after untrack", () => {
        const registry = new TrackedInstanceRegistry<{ id: number }>();
        const obj = { id: 1 };
        registry.track({ value: obj, aliases: ["myAlias"] });
        expect(Object.keys(registry)).to.deep.equal(["myAlias"]);
        registry.untrack(obj);
        expect(Object.keys(registry)).to.deep.equal([]);
    });
});
