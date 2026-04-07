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
        const community = await pkc.createCommunity({ title });
        expect(community.editable.title).to.equal(title);
    });
    it(`community.editable is up to date after calling community.edit()`, async () => {
        const community = await pkc.createCommunity({});
        expect(community.title).to.be.undefined;
        const title = "Test title" + Date.now();
        await community.edit({ title });
        expect(community.editable.title).to.equal(title);
    });
    it(`community.editable is up to date when loading local community`, async () => {
        const title = "Test Title" + Date.now();
        const community = await pkc.createCommunity({ title });

        const recreatedCommunity = await pkc.createCommunity({ address: community.address });
        expect(recreatedCommunity.editable.title).to.equal(title);
    });
});
