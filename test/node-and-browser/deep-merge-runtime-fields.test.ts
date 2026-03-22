import { describe, it, expect } from "vitest";
import { deepMergeRuntimeFields } from "../../dist/node/util.js";

describe("deepMergeRuntimeFields", () => {
    it("merges nested objects", () => {
        const target: any = { author: { name: "test", address: "12D3..." } };
        deepMergeRuntimeFields(target, { author: { nameResolved: true } });
        expect(target.author.nameResolved).to.equal(true);
        expect(target.author.name).to.equal("test");
        expect(target.author.address).to.equal("12D3...");
    });

    it("merges arrays element-by-element", () => {
        const target: any = { comments: [{ author: { name: "a" } }, { author: { name: "b" } }] };
        deepMergeRuntimeFields(target, { comments: [{ author: { nameResolved: true } }, {}] });
        expect(target.comments[0].author.nameResolved).to.equal(true);
        expect(target.comments[0].author.name).to.equal("a");
        expect(target.comments[1].author).to.not.have.property("nameResolved");
    });

    it("does not overwrite when source value is undefined", () => {
        const target: any = { author: { nameResolved: true } };
        deepMergeRuntimeFields(target, { author: { nameResolved: undefined } });
        expect(target.author.nameResolved).to.equal(true);
    });

    it("does nothing when source is empty object", () => {
        const target: any = { author: { name: "test" } };
        deepMergeRuntimeFields(target, {});
        expect(target.author.name).to.equal("test");
    });

    it("handles mismatched array lengths (source shorter)", () => {
        const target: any = { comments: [{ author: {} }, { author: {} }, { author: {} }] };
        deepMergeRuntimeFields(target, { comments: [{ author: { nameResolved: true } }] });
        expect(target.comments[0].author.nameResolved).to.equal(true);
        expect(target.comments[1].author).to.not.have.property("nameResolved");
    });

    it("handles mismatched array lengths (source longer)", () => {
        const target: any = { comments: [{ author: {} }] };
        deepMergeRuntimeFields(target, { comments: [{ author: { nameResolved: true } }, { author: { nameResolved: false } }] });
        expect(target.comments[0].author.nameResolved).to.equal(true);
        // second element ignored since target only has 1
        expect(target.comments.length).to.equal(1);
    });

    it("handles null/undefined targets gracefully", () => {
        expect(() => deepMergeRuntimeFields(null, { author: { nameResolved: true } })).to.not.throw();
        expect(() => deepMergeRuntimeFields(undefined, { author: { nameResolved: true } })).to.not.throw();
    });

    it("handles null/undefined sources gracefully", () => {
        const target: any = { author: { name: "test" } };
        deepMergeRuntimeFields(target, null);
        deepMergeRuntimeFields(target, undefined);
        expect(target.author.name).to.equal("test");
    });

    it("deeply merges nested page structure with preloaded pages", () => {
        const target: any = {
            posts: {
                pages: {
                    hot: {
                        comments: [{ author: { name: "a" } }, { author: { name: "b" } }]
                    }
                }
            }
        };
        deepMergeRuntimeFields(target, {
            posts: {
                pages: {
                    hot: {
                        comments: [{ author: { nameResolved: true } }, { author: { nameResolved: false } }]
                    }
                }
            }
        });
        expect(target.posts.pages.hot.comments[0].author.nameResolved).to.equal(true);
        expect(target.posts.pages.hot.comments[1].author.nameResolved).to.equal(false);
        expect(target.posts.pages.hot.comments[0].author.name).to.equal("a");
    });

    it("overwrites primitive values", () => {
        const target: any = { author: { nameResolved: false } };
        deepMergeRuntimeFields(target, { author: { nameResolved: true } });
        expect(target.author.nameResolved).to.equal(true);
    });

    it("sets getter-only properties via their backing _field", () => {
        class MyClass {
            _updatingState = "stopped";
            updateCid: string | undefined = undefined;

            get updatingState() {
                return this._updatingState;
            }
        }

        const target = new MyClass();
        // Should not throw even though updatingState is getter-only
        expect(() => deepMergeRuntimeFields(target, { updatingState: "succeeded", updateCid: "Qm123" })).to.not.throw();
        // Getter-only property should be set via _updatingState
        expect(target.updatingState).to.equal("succeeded");
        expect(target._updatingState).to.equal("succeeded");
        // Regular property should be updated
        expect(target.updateCid).to.equal("Qm123");
    });

    it("should not create new complex properties on the target when key does not exist", () => {
        // Simulates a comment with empty replies (pages not yet loaded) receiving runtimeFields
        // that include replies.pages.best - the runtimeFields should NOT create fake page data
        const target: any = {
            author: { name: "test" },
            replies: {
                pages: {},
                pageCids: {}
            }
        };
        const runtimeFields = {
            author: { nameResolved: true },
            replies: {
                pages: {
                    best: {
                        comments: [{ author: { nameResolved: false } }]
                    }
                }
            }
        };
        deepMergeRuntimeFields(target, runtimeFields);
        // author.nameResolved should be merged (merging into existing property)
        expect(target.author.nameResolved).to.equal(true);
        // replies.pages.best should NOT be created (target.replies.pages has no 'best' key)
        expect(target.replies.pages).to.not.have.property("best");
    });

    it("should not create new array properties on the target when key does not exist", () => {
        // When target has no 'comments' key, runtimeFields should not assign their comments array
        const target: any = { author: { name: "test" } };
        deepMergeRuntimeFields(target, { comments: [{ author: { nameResolved: true } }] });
        expect(target).to.not.have.property("comments");
    });

    it("sets inherited getter-only properties via their backing _field", () => {
        class Base {
            _updatingState = "stopped";
            get updatingState() {
                return this._updatingState;
            }
        }
        class Child extends Base {
            someField = "original";
        }

        const target = new Child();
        expect(() => deepMergeRuntimeFields(target, { updatingState: "succeeded", someField: "updated" })).to.not.throw();
        expect(target.updatingState).to.equal("succeeded");
        expect(target.someField).to.equal("updated");
    });
});
