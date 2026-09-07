import { describe, expect, it } from "vitest";
import {
    calculateStringSizeSameAsIpfsAddCidV0,
    calculateStringSizeSameAsIpfsAddCidV0Sync,
    calculateUnixFsDagSizeCidV0
} from "../../../dist/node/util.js";

// The page generator sizes every comment and page against what `ipfs add` (CIDv0, no raw leaves, 256 KiB chunks,
// balanced layout with 174 links per node) reports. That number depends only on the byte length, so pkc-js computes
// it without hashing or importing (issue #351); this pins the sync formula to the importer at every encoding boundary:
// protobuf varint widths, the chunk size, the per-node link cap and the multi-level tree above it.
const CHUNK = 262144;
const LINKS_PER_NODE = 174;
const BOUNDARY_LENGTHS = [
    0,
    1,
    2,
    127,
    128,
    129,
    16383,
    16384,
    16385,
    2097151,
    2097152,
    CHUNK - 1,
    CHUNK,
    CHUNK + 1,
    2 * CHUNK - 1,
    2 * CHUNK,
    2 * CHUNK + 1,
    1024 * 1024,
    3 * 1024 * 1024 + 777,
    8 * 1024 * 1024,
    LINKS_PER_NODE * CHUNK - 1,
    LINKS_PER_NODE * CHUNK,
    LINKS_PER_NODE * CHUNK + 1,
    (LINKS_PER_NODE + 1) * CHUNK,
    2 * LINKS_PER_NODE * CHUNK + 5
];

describe("calculateUnixFsDagSizeCidV0", () => {
    it("matches the UnixFS importer at every encoding boundary", async () => {
        for (const length of BOUNDARY_LENGTHS) {
            const expected = await calculateStringSizeSameAsIpfsAddCidV0("x".repeat(length));
            expect(calculateUnixFsDagSizeCidV0(length), `byte length ${length}`).to.equal(expected);
        }
    }, 120_000);

    it("matches the importer at random lengths across the single-node and two-level ranges", async () => {
        const lengths: number[] = [];
        for (let i = 0; i < 12; i++) lengths.push(Math.floor(Math.random() * 4 * CHUNK));
        for (let i = 0; i < 3; i++) lengths.push(LINKS_PER_NODE * CHUNK + Math.floor(Math.random() * 3 * CHUNK));
        for (const length of lengths) {
            const expected = await calculateStringSizeSameAsIpfsAddCidV0("x".repeat(length));
            expect(calculateUnixFsDagSizeCidV0(length), `byte length ${length}`).to.equal(expected);
        }
    }, 120_000);

    it("sizes a string by its UTF-8 byte length, the same as the async importer path", async () => {
        const samples = ["", "hello", "😀".repeat(70000), "é".repeat(CHUNK), JSON.stringify({ comments: [{ a: "ü".repeat(999) }] })];
        for (const sample of samples)
            expect(calculateStringSizeSameAsIpfsAddCidV0Sync(sample)).to.equal(await calculateStringSizeSameAsIpfsAddCidV0(sample));
    }, 60_000);
});
