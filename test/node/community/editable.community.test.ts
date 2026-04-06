import { beforeAll, afterAll, describe, it } from "vitest";
import { mockPKC } from "../../../dist/node/test/test-util.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";

describe(`subplebbit.editable`, async () => {
    let plebbit: PKC;

    beforeAll(async () => {
        plebbit = await mockPKC();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`subplebbit.editable is up to date after creating a new subplebbit`, async () => {
        const title = "Test title" + Date.now();
        const sub = await plebbit.createCommunity({ title });
        expect(sub.editable.title).to.equal(title);
    });
    it(`subplebbit.editable is up to date after calling subplebbit.edit()`, async () => {
        const sub = await plebbit.createCommunity({});
        expect(sub.title).to.be.undefined;
        const title = "Test title" + Date.now();
        await sub.edit({ title });
        expect(sub.editable.title).to.equal(title);
    });
    it(`subplebbit.editable is up to date when loading local sub`, async () => {
        const title = "Test Title" + Date.now();
        const sub = await plebbit.createCommunity({ title });

        const recreatedSub = await plebbit.createCommunity({ address: sub.address });
        expect(recreatedSub.editable.title).to.equal(title);
    });
});
