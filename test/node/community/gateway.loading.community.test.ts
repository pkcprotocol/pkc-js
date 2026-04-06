import {
    describeSkipIfRpc,
    mockGatewayPlebbit,
    mockPlebbit,
    mockPlebbitNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { describe, beforeAll, afterAll, it } from "vitest";

import type { Plebbit as PlebbitType } from "../../../dist/node/pkc/pkc.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/community/local-community.js";
import type { SubplebbitIpfsType } from "../../../dist/node/community/types.js";

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
    address?: string;
    port?: number;
}

const getGatewayBaseUrl = (gatewayPlebbit: PlebbitType): string => {
    const [gatewayUrl] = gatewayPlebbit.ipfsGatewayUrls || [];
    if (!gatewayUrl) throw new Error("Gateway Plebbit has no ipfsGatewayUrls configured");
    return gatewayUrl;
};

const buildGatewayIpnsUrl = (gatewayPlebbit: PlebbitType, subplebbit: LocalSubplebbit): string => {
    return new URL(`/ipns/${subplebbit.address}`, getGatewayBaseUrl(gatewayPlebbit)).toString();
};

const buildGatewayIpfsUrl = (gatewayPlebbit: PlebbitType, cid: string): string => {
    return new URL(`/ipfs/${cid}`, getGatewayBaseUrl(gatewayPlebbit)).toString();
};

const fetchGatewayJson = async (url: string, context: string): Promise<SubplebbitIpfsType> => {
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
        return JSON.parse(bodyText) as SubplebbitIpfsType;
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

const fetchIpnsRecordDirectly = async (gatewayPlebbit: PlebbitType, subplebbit: LocalSubplebbit): Promise<SubplebbitIpfsType> => {
    const ipnsUrl = buildGatewayIpnsUrl(gatewayPlebbit, subplebbit);
    return fetchGatewayJson(ipnsUrl, "Direct IPNS fetch");
};

const fetchCidRecordDirectly = async (gatewayPlebbit: PlebbitType, cid: string): Promise<SubplebbitIpfsType> => {
    const ipfsUrl = buildGatewayIpfsUrl(gatewayPlebbit, cid);
    return fetchGatewayJson(ipfsUrl, "Direct CID fetch");
};

describeSkipIfRpc.concurrent("Gateway loading of local subplebbit IPNS", async () => {
    let plebbit: PlebbitType;
    let subplebbit: LocalSubplebbit;
    let gatewayPlebbit: PlebbitType;
    let kuboPlebbit: PlebbitType;
    let latestUpdateCid: string;

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        gatewayPlebbit = await mockGatewayPlebbit();
        gatewayPlebbit.on("error", (err) => console.error("gatewayPlebbit error event", err));
        console.log("Gateway URLs:", gatewayPlebbit.ipfsGatewayUrls);
        try {
            const probeRes = await fetch("http://localhost:18080", { method: "HEAD" });
            console.log("Gateway HEAD status:", probeRes.status);
        } catch (error) {
            console.error("Gateway HEAD probe failed", error);
        }

        kuboPlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
        subplebbit = (await plebbit.createSubplebbit()) as LocalSubplebbit;

        await subplebbit.start();

        const modSigner = await plebbit.createSigner();
        await subplebbit.edit({
            settings: { challenges: [{ ...subplebbit.settings.challenges[0], pendingApproval: true }] },
            roles: {
                [modSigner.address]: { role: "moderator" }
            }
        });

        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updateCid === "string" });
        latestUpdateCid = subplebbit.updateCid!;
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await gatewayPlebbit.destroy();
        await kuboPlebbit.destroy();
    });

    it("Can fetch the IPNS record directly from gateway without plebbit instance", async () => {
        console.log("Starting test: Direct IPNS fetch without plebbit instance");
        const record = await fetchIpnsRecordDirectly(gatewayPlebbit, subplebbit);
        expect(record.updatedAt).to.equal(subplebbit.updatedAt);
    });

    it("Can fetch the CID directly from gateway without plebbit instance", async () => {
        console.log("Starting test: Direct CID fetch without plebbit instance");
        const record = await fetchCidRecordDirectly(gatewayPlebbit, latestUpdateCid);
        expect(record.updatedAt).to.equal(subplebbit.updatedAt);
    });

    it("Can load the CID using gatewayPlebbit.fetchCid after it's published", async () => {
        console.log("Starting test: Can load the CID using gatewayPlebbit.fetchCid after it's published");
        const rawRecord = await gatewayPlebbit.fetchCid({ cid: latestUpdateCid });
        const record = JSON.parse(rawRecord) as SubplebbitIpfsType;
        expect(record.updatedAt).to.equal(subplebbit.updatedAt);
    });

    it("Can load the IPNS record from gateway Plebbit after it's published", async () => {
        console.log("Starting test: Can load the IPNS record from gateway after it's published");
        const remoteSub = await gatewayPlebbit.getSubplebbit({ address: subplebbit.address });
        expect(remoteSub.updatedAt).to.equal(subplebbit.updatedAt);
    });

    it("Can load the IPNS record from kubo after it's published", async () => {
        console.log("Starting test: Can load the IPNS record from kubo after it's published");
        const remoteSub = await kuboPlebbit.getSubplebbit({ address: subplebbit.address });
        expect(remoteSub.updatedAt).to.equal(subplebbit.updatedAt);
    });
});
