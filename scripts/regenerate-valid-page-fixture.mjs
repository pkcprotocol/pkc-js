#!/usr/bin/env node
// Script to regenerate test/fixtures/valid_page.json from the running test server.
// Connects to local kubo, fetches a real subplebbit's page, and saves it.
//
// Usage: node scripts/regenerate-valid-page-fixture.mjs

import Plebbit from "../dist/node/index.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
    const plebbit = await Plebbit({
        ipfsHttpClientsOptions: ["http://localhost:15001/api/v0"],
        httpRoutersOptions: []
    });

    // signers[0].address — the main test subplebbit
    const subAddress = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";

    console.log("Fetching subplebbit:", subAddress);
    const sub = await plebbit.getSubplebbit({ address: subAddress });

    console.log("Available pageCids:", Object.keys(sub.posts?.pageCids || {}));
    console.log("Available preloaded pages:", Object.keys(sub.posts?.pages || {}));

    // Try pageCids first, then fall back to preloaded pages
    let pageObj;
    const pageCids = sub.posts?.pageCids || {};
    const sortName = pageCids.hot ? "hot" : pageCids.new ? "new" : Object.keys(pageCids)[0];

    if (sortName && pageCids[sortName]) {
        const pageCid = pageCids[sortName];
        console.log(`Fetching page from IPFS: sort="${sortName}", cid=${pageCid}`);
        const response = await fetch(`http://localhost:15001/api/v0/cat?arg=${pageCid}`, {
            method: "POST"
        });
        const rawPage = await response.text();
        pageObj = JSON.parse(rawPage);
    } else if (sub.posts?.pages) {
        // Use a preloaded page — need to get the raw PageIpfs format
        const preloadedSort = Object.keys(sub.posts.pages)[0];
        console.log(`Using preloaded page: sort="${preloadedSort}"`);
        // The preloaded page is already in runtime format with comment instances
        // We need the raw IPFS format. Let's fetch from the raw subplebbitIpfs
        const rawSubIpfs = sub.raw.subplebbitIpfs;
        if (rawSubIpfs?.posts?.pages?.[preloadedSort]) {
            pageObj = rawSubIpfs.posts.pages[preloadedSort];
        } else {
            throw new Error("No raw page available in subplebbitIpfs");
        }
    } else {
        throw new Error("Subplebbit has no pages");
    }

    console.log(`Page has ${pageObj.comments?.length || 0} comments`);

    // Verify the page has the new wire format
    if (pageObj.comments?.length > 0) {
        const firstComment = pageObj.comments[0].comment;
        const keys = Object.keys(firstComment);
        console.log("First comment keys:", keys);
        if (keys.includes("subplebbitAddress")) {
            console.log("WARNING: Page still uses old wire format (subplebbitAddress)");
        }
        if (keys.includes("communityPublicKey")) {
            console.log("Page uses new wire format (communityPublicKey)");
        }
    }

    // Save the fixture
    const fixturePath = path.join(__dirname, "..", "test", "fixtures", "valid_page.json");
    fs.writeFileSync(fixturePath, JSON.stringify(pageObj, null, 2) + "\n");
    console.log("Saved fixture to:", fixturePath);

    await plebbit.destroy();
    console.log("Done!");
}

main().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
});
