import { describe, it, expect } from "vitest";
import { bestScore } from "../../../dist/node/pages/util.js";
import { pageSorts } from "../../../dist/node/index.js";

import type { PageIpfs } from "../../../dist/node/pages/types.js";
import Logger from "@pkcprotocol/pkc-logger";

const testLog = Logger({ namespace: "pkc-js:test:best-score" });

// `best` is the Wilson lower bound of the vote ratio. The scorer adds Reddit's implicit first upvote to the
// upvotes but used to leave it out of the total, so p = (up + 1) / (up + down) exceeded 1 whenever a comment had
// upvotes and no downvotes and the square root went NaN. Page generation tolerated the NaN as an arbitrary order
// until the strict numeric check of configurable sorts (issue #73) made the community skip the whole `best` sort
// of any post with such a reply, which is how the createcomment depth-1 test lost its preloaded replies page.

const entry = (upvoteCount: number, downvoteCount: number): PageIpfs["comments"][number] =>
    ({ comment: {}, commentUpdate: { upvoteCount, downvoteCount } }) as unknown as PageIpfs["comments"][number];

describe("bestScore", () => {
    it("is a finite number for every vote combination, upvotes without downvotes included", () => {
        for (const [up, down] of [
            [0, 0],
            [1, 0],
            [2, 0],
            [50, 0],
            [0, 1],
            [1, 1],
            [3, 1],
            [5, 2]
        ]) {
            const score = bestScore(entry(up, down));
            expect(Number.isFinite(score), `bestScore(${up} up, ${down} down) = ${score}`).to.be.true;
        }
    });

    it("stays within the Wilson bound's range and ranks like a vote ratio with confidence", () => {
        for (const [up, down] of [
            [1, 0],
            [0, 1],
            [3, 1],
            [5, 2]
        ]) {
            const score = bestScore(entry(up, down));
            expect(score).to.be.at.least(0).and.at.most(1);
        }
        expect(bestScore(entry(0, 0))).to.equal(0); // no votes: no evidence
        expect(bestScore(entry(10, 0))).to.be.greaterThan(bestScore(entry(1, 0))); // more upvotes: more confidence
        expect(bestScore(entry(1, 0))).to.be.greaterThan(bestScore(entry(0, 1))); // upvoted beats downvoted
        expect(bestScore(entry(5, 5))).to.be.lessThan(bestScore(entry(5, 0)));
    });

    it("the built-in `best` page sort scores a comment with upvotes and no downvotes", () => {
        const file = pageSorts.best!({ pageSortSettings: { name: "best" }, log: testLog });
        const score = file.score({ ...entry(1, 0), replies: undefined } as unknown as Parameters<typeof file.score>[0]);
        expect(typeof score === "number" && Number.isFinite(score), `score = ${String(score)}`).to.be.true;
    });
});
