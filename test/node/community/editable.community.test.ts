import { beforeAll, afterAll, describe, it } from "vitest";
import { mockPKC } from "../../../dist/node/test/test-util.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";

describe(`community.editable`, async () => {
    let pkc: PKC;

    beforeAll(async () => {
        pkc = await mockPKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`community.editable is up to date after creating a new community`, async () => {
        const title = "Test title" + Date.now();
        const sub = await pkc.createCommunity({ title });
        expect(sub.editable.title).to.equal(title);
    });
    it(`community.editable is up to date after calling community.edit()`, async () => {
        const sub = await pkc.createCommunity({});
        expect(sub.title).to.be.undefined;
        const title = "Test title" + Date.now();
        await sub.edit({ title });
        expect(sub.editable.title).to.equal(title);
    });
    it(`community.editable is up to date when loading local sub`, async () => {
        const title = "Test Title" + Date.now();
        const sub = await pkc.createCommunity({ title });

        const recreatedSub = await pkc.createCommunity({ address: sub.address });
        expect(recreatedSub.editable.title).to.equal(title);
    });
});
