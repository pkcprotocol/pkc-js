import { afterAll, beforeAll, it } from "vitest";
import { randomBytes } from "node:crypto";
import { describeSkipIfRpc, mockPKCNoDataPathWithOnlyKuboClient } from "../../../dist/node/test/test-util.js";
import { calculateStringSizeSameAsIpfsAddCidV0 } from "../../../dist/node/util.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { KuboRpcClient } from "../../../dist/node/types.js";

const UTF8_VARIANTS: string[] = [
    "😀😃😄😁😆😅😂🤣😊😇",
    "こんにちは世界",
    "Привет мир",
    "مرحبا بالعالم",
    "हैलो वर्ल्ड",
    "καλημέρα κόσμε",
    "שלום עולם",
    "hola mundo",
    "gå på tur"
];

const randomInt = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1)) + min;
const CHUNK_SIZE = 262144;
const deterministicSamples: string[] = [
    "",
    "hello world",
    "\0binary\0chars",
    "line1\nline2\r\nline3",
    UTF8_VARIANTS.join(" "),
    "😀".repeat(Math.ceil(CHUNK_SIZE / 4) + 10), // multi-byte string crossing chunk boundary
    "x".repeat(CHUNK_SIZE - 1),
    "x".repeat(CHUNK_SIZE),
    "x".repeat(CHUNK_SIZE + 1),
    "x".repeat(CHUNK_SIZE * 3 + 1234)
];

function generateRandomUtf8String(): string {
    const mode = Math.floor(Math.random() * 5);
    switch (mode) {
        case 0:
            return randomBytes(randomInt(1, 200_000)).toString("base64");
        case 1:
            return UTF8_VARIANTS[randomInt(0, UTF8_VARIANTS.length - 1)].repeat(randomInt(1, 5000));
        case 2:
            return randomBytes(randomInt(1, 200_000)).toString("hex");
        case 3:
            return "x".repeat(randomInt(1, 700_000));
        default:
            return UTF8_VARIANTS.join(" ").repeat(randomInt(1, 200));
    }
}

describeSkipIfRpc("calculateStringSize matches kubo add sizes", function () {
    let pkc: PKC;
    let kuboClient: KuboRpcClient["_client"];

    beforeAll(async () => {
        pkc = await mockPKCNoDataPathWithOnlyKuboClient();
        kuboClient = pkc._clientsManager.getDefaultKuboRpcClient()!._client;
    });

    afterAll(async () => {
        if (pkc) await pkc.destroy();
    });

    it("matches kubo's /api/v0/add sizes for deterministic edge cases and 20 random strings", async () => {
        const randomSamples: string[] = Array.from({ length: 20 }, () => generateRandomUtf8String());
        const samples: string[] = [...deterministicSamples, ...randomSamples];

        for (const sample of samples) {
            const calculated = await calculateStringSizeSameAsIpfsAddCidV0(sample);
            const addRes = await kuboClient.add(sample);
            expect(addRes.size).to.equal(calculated);
        }
    });
});
