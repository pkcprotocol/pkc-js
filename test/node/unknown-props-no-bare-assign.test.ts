// Every loader copies the unknown props of a record through assignUnknownProps (or the author through
// mergeAuthorProps). A bare Object.assign / spread of record data onto an instance brings the overwrite back, so the
// loaders are read here and fail the day one reappears. Reads the source: the sites are private to the loaders.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("record data is only copied onto an instance through the unknown-props helpers", () => {
    for (const path of ["src/publications/comment/comment.ts", "src/community/remote-community.ts", "src/publications/publication.ts"])
        it(`${path} has no Object.assign onto the instance or onto an author`, () => {
            const offenders = read(path)
                .split("\n")
                .filter((line) => /Object\.assign\(\s*(this|this\.author)\b/.test(line));
            expect(offenders).toEqual([]);
        });

    it("the helpers are what the loaders call", () => {
        expect(read("src/publications/comment/comment.ts")).toMatch(/assignUnknownProps\(/);
        expect(read("src/publications/comment/comment.ts")).toMatch(/mergeAuthorProps\(/);
        expect(read("src/community/remote-community.ts")).toMatch(/assignUnknownProps\(/);
        expect(read("src/publications/publication.ts")).toMatch(/mergeAuthorProps\(/);
        expect(read("src/publications/comment/crosspost-runtime.ts")).toMatch(/mergeAuthorProps\(/);
    });
});
