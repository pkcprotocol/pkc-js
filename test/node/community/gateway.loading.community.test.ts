import {
    mockGatewayPKC,
    mockPKC,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { describe, beforeAll, afterAll, it } from "vitest";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { CommunityIpfsType } from "../../../dist/node/community/types.js";

interface FetchError extends Error {
    responseBody?: string;
    status?: number;
    statusText?: string;
    responseHeaders?: Record<string, string>;
    responseType?: string;
    redirected?: boolean;
    url?: string;
}

interface NetworkError extends NodeJS.ErrnoException {
    cause?: unknown;
    address?: string;
    port?: number;
}

const getGatewayBaseUrl = (gatewayPKC: PKCType): string => {
    const [gatewayUrl] = gatewayPKC.ipfsGatewayUrls || [];
    if (!gatewayUrl) throw new Error("Gateway PKC has no ipfsGatewayUrls configured");
    return gatewayUrl;
};

const buildGatewayIpnsUrl = (gatewayPKC: PKCType, community: LocalCommunity): string => {
    return new URL(`/ipns/${community.address}`, getGatewayBaseUrl(gatewayPKC)).toString();
};

const buildGatewayIpfsUrl = (gatewayPKC: PKCType, cid: string): string => {
    return new URL(`/ipfs/${cid}`, getGatewayBaseUrl(gatewayPKC)).toString();
};

const fetchGatewayJson = async (url: string, context: string): Promise<CommunityIpfsType> => {
    console.log(`${context} attempt to ${url}`);
    let res: Response;
    try {
        res = await fetch(url, { cache: "no-store" });
    } catch (error) {
        const err = error as NetworkError;
        console.error(`${context} request threw before receiving a response`, {
            url,
            errorName: err?.name,
            errorMessage: err?.message,
            errorStack: err?.stack,
            errorCause: err?.cause,
            errorCode: err?.code,
            errorErrno: err?.errno,
            errorSyscall: err?.syscall,
            errorAddress: err?.address,
            errorPort: err?.port
        });
        throw error;
    }
    const bodyText = await res.text();
    if (!res.ok) {
        const headers = Object.fromEntries(res.headers.entries());
        const failureDetails = {
            url,
            status: res.status,
            statusText: res.statusText,
            headers,
            bodyPreview: bodyText.slice(0, 2000),
            bodyLength: bodyText.length,
            redirect: res.redirected,
            type: res.type
        };
        console.error(`${context} received non-OK response`, failureDetails);
        const fetchError: FetchError = new Error(`${context} failed with status ${res.status}`);
        fetchError.responseBody = bodyText;
        fetchError.status = res.status;
        fetchError.statusText = res.statusText;
        fetchError.responseHeaders = headers;
        fetchError.responseType = res.type;
        fetchError.redirected = res.redirected;
        fetchError.url = url;
        throw fetchError;
    }
    try {
        return JSON.parse(bodyText) as CommunityIpfsType;
    } catch (error) {
        const parseError = error as FetchError;
        console.error(`Failed to parse ${context} response`, {
            url,
            status: res.status,
            statusText: res.statusText,
            bodyPreview: bodyText.slice(0, 2000),
            bodyLength: bodyText.length,
            parseErrorName: parseError?.name,
            parseErrorMessage: parseError?.message,
            parseErrorStack: parseError?.stack
        });
        parseError.url = url;
        parseError.responseBody = bodyText;
        throw parseError;
    }
};

const fetchIpnsRecordDirectly = async (gatewayPKC: PKCType, community: LocalCommunity): Promise<CommunityIpfsType> => {
    const ipnsUrl = buildGatewayIpnsUrl(gatewayPKC, community);
    return fetchGatewayJson(ipnsUrl, "Direct IPNS fetch");
};

const fetchCidRecordDirectly = async (gatewayPKC: PKCType, cid: string): Promise<CommunityIpfsType> => {
    const ipfsUrl = buildGatewayIpfsUrl(gatewayPKC, cid);
    return fetchGatewayJson(ipfsUrl, "Direct CID fetch");
};

describeSkipIfRpc.concurrent("Gateway loading of local community IPNS", async () => {
    let pkc: PKCType;
    let community: LocalCommunity;
    let gatewayPKC: PKCType;
    let kuboPKC: PKCType;
    let latestUpdateCid: string;

    beforeAll(async () => {
        pkc = await mockPKC();
        gatewayPKC = await mockGatewayPKC();
        gatewayPKC.on("error", (err) => console.error("gatewayPKC error event", err));
        console.log("Gateway URLs:", gatewayPKC.ipfsGatewayUrls);
        try {
            const probeRes = await fetch("http://localhost:18080", { method: "HEAD" });
            console.log("Gateway HEAD status:", probeRes.status);
        } catch (error) {
            console.error("Gateway HEAD probe failed", error);
        }

        kuboPKC = await mockPKCNoDataPathWithOnlyKuboClient();
        community = (await pkc.createCommunity()) as LocalCommunity;

        await community.start();

        const modSigner = await pkc.createSigner();
        await community.edit({
            settings: { challenges: [{ ...community.settings.challenges[0], pendingApproval: true }] },
            roles: {
                [modSigner.address]: { role: "moderator" }
            }
        });

        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updateCid === "string" });
        latestUpdateCid = community.updateCid!;
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await gatewayPKC.destroy();
        await kuboPKC.destroy();
    });

    it("Can fetch the IPNS record directly from gateway without pkc instance", async () => {
        console.log("Starting test: Direct IPNS fetch without pkc instance");
        const record = await fetchIpnsRecordDirectly(gatewayPKC, community);
        expect(record.updatedAt).to.equal(community.updatedAt);
    });

    it("Can fetch the CID directly from gateway without pkc instance", async () => {
        console.log("Starting test: Direct CID fetch without pkc instance");
        const record = await fetchCidRecordDirectly(gatewayPKC, latestUpdateCid);
        expect(record.updatedAt).to.equal(community.updatedAt);
    });

    it("Can load the CID using gatewayPKC.fetchCid after it's published", async () => {
        console.log("Starting test: Can load the CID using gatewayPKC.fetchCid after it's published");
        const { content: rawRecord } = await gatewayPKC.fetchCid({ cid: latestUpdateCid });
        const record = JSON.parse(rawRecord) as CommunityIpfsType;
        expect(record.updatedAt).to.equal(community.updatedAt);
    });

    it("Can load the IPNS record from gateway PKC after it's published", async () => {
        console.log("Starting test: Can load the IPNS record from gateway after it's published");
        const remoteCommunity = await gatewayPKC.getCommunity({ address: community.address });
        expect(remoteCommunity.updatedAt).to.equal(community.updatedAt);
    });

    it("Can load the IPNS record from kubo after it's published", async () => {
        console.log("Starting test: Can load the IPNS record from kubo after it's published");
        const remoteCommunity = await kuboPKC.getCommunity({ address: community.address });
        expect(remoteCommunity.updatedAt).to.equal(community.updatedAt);
    });
});
