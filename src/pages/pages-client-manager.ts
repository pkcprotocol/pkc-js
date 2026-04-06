import { BaseClientsManager, OptionsToLoadFromGateway } from "../clients/base-client-manager.js";
import type { ModQueuePageIpfs, ModQueueSortName, PageIpfs } from "./types.js";
import * as remeda from "remeda";
import Logger from "../logger.js";
import { BasePages, ModQueuePages, PostsPages, RepliesPages } from "./pages.js";
import { POSTS_SORT_TYPES, POST_REPLIES_SORT_TYPES, type PageRuntimeFields } from "./util.js";
import {
    parseJsonWithPlebbitErrorIfFails,
    parseModQueuePageIpfsSchemaWithPlebbitErrorIfItFails,
    parsePageIpfsSchemaWithPlebbitErrorIfItFails
} from "../schema/schema-util.js";
import { hideClassPrivateProps } from "../util.js";
import { Plebbit } from "../pkc/pkc.js";
import { sha256 } from "js-sha256";
import { PagesIpfsGatewayClient, PagesKuboRpcClient, PagesLibp2pJsClient, PagesPlebbitRpcStateClient } from "./pages-clients.js";

export class BasePagesClientsManager extends BaseClientsManager {
    clients: {
        ipfsGateways: { [sortType: string]: { [ipfsGatewayUrl: string]: PagesIpfsGatewayClient } };
        kuboRpcClients: { [sortType: string]: { [kuboRpcClientUrl: string]: PagesKuboRpcClient } };
        plebbitRpcClients: { [sortType: string]: { [rpcUrl: string]: PagesPlebbitRpcStateClient } };
        libp2pJsClients: { [sortType: string]: { [libp2pJsClientKey: string]: PagesLibp2pJsClient } };
    };

    protected _pages: RepliesPages | PostsPages | ModQueuePages; // can be undefined if it's a mod queue

    constructor(opts: { pages: BasePagesClientsManager["_pages"]; plebbit: Plebbit }) {
        super(opts.plebbit);
        this._pages = opts.pages;
        //@ts-expect-error
        this.clients = {};
        this._updateIpfsGatewayClientStates(this.getSortTypes());
        this._updateKuboRpcClientStates(this.getSortTypes());
        this._updatePlebbitRpcClientStates(this.getSortTypes());
        this._updateLibp2pJsClientStates(this.getSortTypes());

        if (opts.pages.pageCids) this.updatePageCidsToSortTypes(opts.pages.pageCids);
        hideClassPrivateProps(this);
    }

    // Init functions here
    protected _updateIpfsGatewayClientStates(sortTypes: string[]) {
        if (!this.clients.ipfsGateways) this.clients.ipfsGateways = {};
        for (const sortType of sortTypes) {
            if (!this.clients.ipfsGateways[sortType]) this.clients.ipfsGateways[sortType] = {};
            for (const gatewayUrl of remeda.keys.strict(this._plebbit.clients.ipfsGateways))
                if (!this.clients.ipfsGateways[sortType][gatewayUrl])
                    this.clients.ipfsGateways[sortType][gatewayUrl] = new PagesIpfsGatewayClient("stopped");
        }
    }

    protected _updateKuboRpcClientStates(sortTypes: string[]) {
        if (this._plebbit.clients.kuboRpcClients && !this.clients.kuboRpcClients) this.clients.kuboRpcClients = {};
        for (const sortType of sortTypes) {
            if (!this.clients.kuboRpcClients[sortType]) this.clients.kuboRpcClients[sortType] = {};
            for (const kuboRpcUrl of remeda.keys.strict(this._plebbit.clients.kuboRpcClients))
                if (!this.clients.kuboRpcClients[sortType][kuboRpcUrl])
                    this.clients.kuboRpcClients[sortType][kuboRpcUrl] = new PagesKuboRpcClient("stopped");
        }
    }

    protected _updateLibp2pJsClientStates(sortTypes: string[]) {
        if (this._plebbit.clients.libp2pJsClients && !this.clients.libp2pJsClients) this.clients.libp2pJsClients = {};
        for (const sortType of sortTypes) {
            if (!this.clients.libp2pJsClients[sortType]) this.clients.libp2pJsClients[sortType] = {};
            for (const libp2pJsClientKey of remeda.keys.strict(this._plebbit.clients.libp2pJsClients))
                if (!this.clients.libp2pJsClients[sortType][libp2pJsClientKey])
                    this.clients.libp2pJsClients[sortType][libp2pJsClientKey] = new PagesLibp2pJsClient("stopped");
        }
    }

    protected _updatePlebbitRpcClientStates(sortTypes: string[]) {
        if (this._plebbit.clients.plebbitRpcClients && !this.clients.plebbitRpcClients) this.clients.plebbitRpcClients = {};
        for (const sortType of sortTypes) {
            if (!this.clients.plebbitRpcClients[sortType]) this.clients.plebbitRpcClients[sortType] = {};
            for (const rpcUrl of remeda.keys.strict(this._plebbit.clients.plebbitRpcClients))
                if (!this.clients.plebbitRpcClients[sortType][rpcUrl])
                    this.clients.plebbitRpcClients[sortType][rpcUrl] = new PagesPlebbitRpcStateClient("stopped");
        }
    }

    // Override methods from BaseClientsManager here

    override preFetchGateway(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway): void {
        const cid = loadOpts.root;
        const sortTypes = this._plebbit._memCaches.pageCidToSortTypes.get(cid);

        this.updateGatewayState("fetching-ipfs", gatewayUrl, sortTypes);
    }

    override postFetchGatewaySuccess(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway) {
        const cid = loadOpts.root;
        const sortTypes = this._plebbit._memCaches.pageCidToSortTypes.get(cid);

        this.updateGatewayState("stopped", gatewayUrl, sortTypes);
    }

    override postFetchGatewayFailure(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway) {
        this.postFetchGatewaySuccess(gatewayUrl, loadOpts);
    }

    override postFetchGatewayAborted(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway): void {
        this.postFetchGatewaySuccess(gatewayUrl, loadOpts);
    }

    _updatePageCidsSortCache(pageCid: string, sortTypes: string[]) {
        const curSortTypes: string[] | undefined = this._plebbit._memCaches.pageCidToSortTypes.get(pageCid);
        if (!curSortTypes) {
            this._plebbit._memCaches.pageCidToSortTypes.set(pageCid, sortTypes);
        } else {
            const newSortTypes = remeda.unique([...curSortTypes, ...sortTypes]);
            this._plebbit._memCaches.pageCidToSortTypes.set(pageCid, newSortTypes);
        }
    }

    updatePageCidsToSortTypes(newPageCids: BasePages["pageCids"]) {
        for (const [sortType, pageCid] of Object.entries(newPageCids)) {
            this._updatePageCidsSortCache(pageCid, [sortType]);
        }
        this._updateIpfsGatewayClientStates(Object.keys(newPageCids));
        this._updateKuboRpcClientStates(Object.keys(newPageCids));
        this._updatePlebbitRpcClientStates(Object.keys(newPageCids));
    }

    private _calculatePageMaxSizeCacheKey(pageCid: string) {
        return sha256(this._pages._subplebbit.address + pageCid);
    }

    updatePagesMaxSizeCache(newPageCids: string[], pageMaxSizeBytes: number) {
        remeda
            .unique(newPageCids)
            .forEach((pageCid) => this._plebbit._memCaches.pagesMaxSize.set(this._calculatePageMaxSizeCacheKey(pageCid), pageMaxSizeBytes));
    }

    updatePageCidsToSortTypesToIncludeSubsequent(nextPageCid: string, previousPageCid: string) {
        const sortTypes: string[] | undefined = this._plebbit._memCaches.pageCidToSortTypes.get(previousPageCid);
        if (!Array.isArray(sortTypes)) return;
        this._updatePageCidsSortCache(nextPageCid, sortTypes);
    }

    updateKuboRpcState(newState: PagesKuboRpcClient["state"], kuboRpcClientUrl: string, sortTypes: string[] | undefined) {
        if (!Array.isArray(sortTypes)) return;
        for (const sortType of sortTypes) {
            if (this.clients.kuboRpcClients[sortType][kuboRpcClientUrl].state === newState) continue;
            this.clients.kuboRpcClients[sortType][kuboRpcClientUrl].state = newState;
            this.clients.kuboRpcClients[sortType][kuboRpcClientUrl].emit("statechange", newState);
        }
    }

    updateLibp2pJsClientState(
        newState: PagesLibp2pJsClient["state"],
        libp2pJsClientKey: keyof Plebbit["clients"]["libp2pJsClients"],
        sortTypes: string[] | undefined
    ) {
        if (!Array.isArray(sortTypes)) return;
        for (const sortType of sortTypes) {
            if (this.clients.libp2pJsClients[sortType][libp2pJsClientKey].state === newState) continue;
            this.clients.libp2pJsClients[sortType][libp2pJsClientKey].state = newState;
            this.clients.libp2pJsClients[sortType][libp2pJsClientKey].emit("statechange", newState);
        }
    }

    updateGatewayState(newState: PagesIpfsGatewayClient["state"], gateway: string, sortTypes: string[] | undefined) {
        if (!Array.isArray(sortTypes)) return;
        for (const sortType of sortTypes) {
            if (this.clients.ipfsGateways[sortType][gateway].state === newState) continue;
            this.clients.ipfsGateways[sortType][gateway].state = newState;
            this.clients.ipfsGateways[sortType][gateway].emit("statechange", newState);
        }
    }

    updateRpcState(newState: PagesPlebbitRpcStateClient["state"], rpcUrl: string, sortTypes: string[] | undefined) {
        if (!Array.isArray(sortTypes)) return;
        for (const sortType of sortTypes) {
            if (this.clients.plebbitRpcClients[sortType][rpcUrl].state === newState) continue;
            this.clients.plebbitRpcClients[sortType][rpcUrl].state = newState;
            this.clients.plebbitRpcClients[sortType][rpcUrl].emit("statechange", newState);
        }
    }

    _updateKuboRpcClientOrHeliaState(
        newState: PagesKuboRpcClient["state"] | PagesLibp2pJsClient["state"],
        kuboRpcOrHelia: Plebbit["clients"]["kuboRpcClients"][string] | Plebbit["clients"]["libp2pJsClients"][string],
        sortTypes: string[] | undefined
    ) {
        if ("_helia" in kuboRpcOrHelia) this.updateLibp2pJsClientState(newState, kuboRpcOrHelia._libp2pJsClientsOptions.key, sortTypes);
        else this.updateKuboRpcState(newState, kuboRpcOrHelia.url, sortTypes);
    }

    protected preFetchPage() {
        throw Error("should be implemented");
    }

    protected async _requestPageFromRPC(opts: {
        pageCid: string;
        log: Logger;
        sortTypes: string[] | undefined;
        pageMaxSize: number;
    }): Promise<{ page: ModQueuePageIpfs | PageIpfs; runtimeFields?: PageRuntimeFields }> {
        throw Error("Should be implemented");
    }

    private async _fetchPageWithRpc(opts: {
        pageCid: string;
        log: Logger;
        sortTypes: string[] | undefined;
        pageMaxSize: number;
    }): Promise<{ page: ModQueuePageIpfs | PageIpfs; runtimeFields?: PageRuntimeFields }> {
        const currentRpcUrl = this._plebbit.plebbitRpcClientsOptions![0];

        this.preFetchPage();
        opts.log.trace(`Fetching page cid (${opts.pageCid}) using rpc`);
        this.updateRpcState("fetching-ipfs", currentRpcUrl, opts.sortTypes);

        try {
            return this._requestPageFromRPC(opts);
        } catch (e) {
            opts.log.error(`Failed to retrieve page (${opts.pageCid}) with rpc due to error:`, e);
            throw e;
        } finally {
            this.updateRpcState("stopped", currentRpcUrl, opts.sortTypes);
        }
    }

    protected parsePageJson(json: unknown): PageIpfs | ModQueuePageIpfs {
        // default validator; subclasses can override
        return parsePageIpfsSchemaWithPlebbitErrorIfItFails(json as any);
    }

    private async _fetchPageWithKuboOrHeliaP2P(
        pageCid: string,
        log: Logger,
        sortTypes: string[] | undefined,
        pageMaxSize: number
    ): Promise<PageIpfs | ModQueuePageIpfs> {
        const heliaOrKubo = this.getDefaultKuboRpcClientOrHelia();
        this._updateKuboRpcClientOrHeliaState("fetching-ipfs", heliaOrKubo, sortTypes);
        const pageTimeoutMs = this._plebbit._timeouts["page-ipfs"];
        try {
            return this.parsePageJson(
                parseJsonWithPlebbitErrorIfFails(
                    await this._fetchCidP2P(pageCid, { maxFileSizeBytes: pageMaxSize, timeoutMs: pageTimeoutMs })
                )
            ) as PageIpfs;
        } catch (e) {
            //@ts-expect-error
            e.details = { ...e.details, pageCid, sortTypes, pageMaxSize };
            log.error(`Failed to fetch the page (${pageCid}) due to error:`, e);
            throw e;
        } finally {
            this._updateKuboRpcClientOrHeliaState("stopped", heliaOrKubo, sortTypes);
        }
    }

    async _fetchPageFromGateways(pageCid: string, log: Logger, pageMaxSize: number): Promise<PageIpfs | ModQueuePageIpfs> {
        // No need to validate schema for every gateway, because the cid validation will make sure it's the page ipfs we're looking for
        // we just need to validate the end result's schema
        const res = await this.fetchFromMultipleGateways({
            root: pageCid,
            recordIpfsType: "ipfs",
            recordPlebbitType: "page-ipfs",
            validateGatewayResponseFunc: async () => {},
            maxFileSizeBytes: pageMaxSize,
            timeoutMs: this._plebbit._timeouts["page-ipfs"],
            log
        });
        const pageIpfs = this.parsePageJson(parseJsonWithPlebbitErrorIfFails(res.resText)) as PageIpfs;

        return pageIpfs;
    }
    async fetchPage(
        pageCid: string,
        overridePageMaxSize?: number
    ): Promise<{ page: PageIpfs | ModQueuePageIpfs; runtimeFields?: PageRuntimeFields }> {
        const log = Logger("pkc-js:pages:getPage");
        const sortTypesFromPageCids = remeda.keys
            .strict(this._pages.pageCids)
            .filter((sortType) => this._pages.pageCids[sortType] === pageCid);
        if (sortTypesFromPageCids.length > 0) {
            this.updatePageCidsToSortTypes(this._pages.pageCids);
        }
        const sortTypesFromMemcache: string[] | undefined = this._plebbit._memCaches.pageCidToSortTypes.get(pageCid);

        const isFirstPage = Object.values(this._pages.pageCids).includes(pageCid) || remeda.isEmpty(this._pages.pageCids);
        const pageMaxSize = overridePageMaxSize
            ? overridePageMaxSize
            : this._plebbit._memCaches.pagesMaxSize.get(this._calculatePageMaxSizeCacheKey(pageCid))
              ? this._plebbit._memCaches.pagesMaxSize.get(this._calculatePageMaxSizeCacheKey(pageCid))
              : isFirstPage
                ? 1024 * 1024
                : undefined;
        if (!pageMaxSize) throw Error("Failed to calculate max page size. Is this page cid under the correct subplebbit/comment?");
        let result: { page: PageIpfs | ModQueuePageIpfs; runtimeFields?: PageRuntimeFields };
        try {
            if (this._plebbit._plebbitRpcClient) {
                result = await this._fetchPageWithRpc({ pageCid, log, sortTypes: sortTypesFromMemcache, pageMaxSize });
            } else if (
                Object.keys(this._plebbit.clients.kuboRpcClients).length > 0 ||
                Object.keys(this._plebbit.clients.libp2pJsClients).length > 0
            )
                result = { page: await this._fetchPageWithKuboOrHeliaP2P(pageCid, log, sortTypesFromMemcache, pageMaxSize) };
            else result = { page: await this._fetchPageFromGateways(pageCid, log, pageMaxSize) };
        } catch (e) {
            //@ts-expect-error
            e.details = { ...e.details, pageCid, pageMaxSize, isFirstPage, sortTypesFromPageCids, sortTypesFromMemcache };
            throw e;
        }

        if (result.page.nextCid) {
            this.updatePageCidsToSortTypesToIncludeSubsequent(result.page.nextCid, pageCid);
            this.updatePagesMaxSizeCache([result.page.nextCid], pageMaxSize * 2);
        }
        return result;
    }

    protected getSortTypes(): string[] {
        throw Error("This function should be overridden");
    }
}

export class RepliesPagesClientsManager extends BasePagesClientsManager {
    // for both post and reply
    override clients!: {
        ipfsGateways: Record<keyof typeof POST_REPLIES_SORT_TYPES, { [ipfsGatewayUrl: string]: PagesIpfsGatewayClient }>;
        kuboRpcClients: Record<keyof typeof POST_REPLIES_SORT_TYPES, { [kuboRpcClientUrl: string]: PagesIpfsGatewayClient }>;
        plebbitRpcClients: Record<keyof typeof POST_REPLIES_SORT_TYPES, { [rpcUrl: string]: PagesPlebbitRpcStateClient }>;
        libp2pJsClients: Record<keyof typeof POST_REPLIES_SORT_TYPES, { [libp2pJsClientKey: string]: PagesIpfsGatewayClient }>;
    };

    protected override getSortTypes() {
        return remeda.keys.strict(POST_REPLIES_SORT_TYPES);
    }

    protected override preFetchPage(): void {
        if (!this._pages._parentComment) throw Error("parent comment needs to be defined");

        if (!this._pages._parentComment?.cid) throw Error("Parent comment cid is not defined");
    }
    protected override async _requestPageFromRPC(opts: {
        pageCid: string;
        log: Logger;
        sortTypes: string[] | undefined;
        pageMaxSize: number;
    }): Promise<{ page: PageIpfs; runtimeFields?: PageRuntimeFields }> {
        const result = await this._plebbit._plebbitRpcClient!.getCommentPage({
            cid: opts.pageCid,
            commentCid: this._pages._parentComment!.cid!,
            subplebbitAddress: this._pages._subplebbit.address,
            pageMaxSize: opts.pageMaxSize
        });
        return { page: result.page, runtimeFields: result.runtimeFields };
    }
}

export class SubplebbitPostsPagesClientsManager extends BasePagesClientsManager {
    override clients!: {
        ipfsGateways: Record<keyof typeof POSTS_SORT_TYPES, { [ipfsGatewayUrl: string]: PagesIpfsGatewayClient }>;
        kuboRpcClients: Record<keyof typeof POSTS_SORT_TYPES, { [kuboRpcClientUrl: string]: PagesIpfsGatewayClient }>;
        plebbitRpcClients: Record<keyof typeof POSTS_SORT_TYPES, { [rpcUrl: string]: PagesPlebbitRpcStateClient }>;
        libp2pJsClients: Record<keyof typeof POSTS_SORT_TYPES, { [libp2pJsClientKey: string]: PagesIpfsGatewayClient }>;
    };

    protected override getSortTypes() {
        return remeda.keys.strict(POSTS_SORT_TYPES);
    }

    protected override preFetchPage(): void {
        if (!this._pages._subplebbit) throw Error("Subplebbit needs to be defined");

        if (!this._pages._subplebbit.address) throw Error("Subplebbit address is not defined");
    }

    protected override async _requestPageFromRPC(opts: {
        pageCid: string;
        log: Logger;
        sortTypes: string[] | undefined;
        pageMaxSize: number;
    }): Promise<{ page: PageIpfs; runtimeFields?: PageRuntimeFields }> {
        const result = await this._plebbit._plebbitRpcClient!.getSubplebbitPage({
            cid: opts.pageCid,
            subplebbitAddress: this._pages._subplebbit.address,
            type: "posts",
            pageMaxSize: opts.pageMaxSize
        });
        return { page: result.page as PageIpfs, runtimeFields: result.runtimeFields };
    }
}

export class SubplebbitModQueueClientsManager extends BasePagesClientsManager {
    override clients!: {
        ipfsGateways: Record<ModQueueSortName, { [ipfsGatewayUrl: string]: PagesIpfsGatewayClient }>;
        kuboRpcClients: Record<ModQueueSortName, { [kuboRpcClientUrl: string]: PagesIpfsGatewayClient }>;
        plebbitRpcClients: Record<ModQueueSortName, { [rpcUrl: string]: PagesPlebbitRpcStateClient }>;
        libp2pJsClients: Record<ModQueueSortName, { [libp2pJsClientKey: string]: PagesIpfsGatewayClient }>;
    };

    protected override getSortTypes(): ModQueueSortName[] {
        return ["pendingApproval"];
    }

    override async fetchPage(
        pageCid: string,
        overridePageMaxSize?: number
    ): Promise<{ page: ModQueuePageIpfs; runtimeFields?: PageRuntimeFields }> {
        const result = await super.fetchPage(pageCid, overridePageMaxSize);
        return { page: result.page as ModQueuePageIpfs, runtimeFields: result.runtimeFields };
    }

    protected override preFetchPage(): void {
        if (!this._pages._subplebbit) throw Error("Subplebbit needs to be defined");

        if (!this._pages._subplebbit.address) throw Error("Subplebbit address is not defined");
    }

    protected override parsePageJson(json: unknown): ModQueuePageIpfs {
        // Validate using the ModQueue page schema, then coerce to PageIpfs for consumers
        return parseModQueuePageIpfsSchemaWithPlebbitErrorIfItFails(json as any) as ModQueuePageIpfs;
    }

    protected override async _requestPageFromRPC(opts: {
        pageCid: string;
        log: Logger;
        sortTypes: string[] | undefined;
        pageMaxSize: number;
    }): Promise<{ page: ModQueuePageIpfs; runtimeFields?: PageRuntimeFields }> {
        const result = await this._plebbit._plebbitRpcClient!.getSubplebbitPage({
            type: "modqueue",
            cid: opts.pageCid,
            subplebbitAddress: this._pages._subplebbit.address,
            pageMaxSize: opts.pageMaxSize
        });
        return { page: result.page as ModQueuePageIpfs, runtimeFields: result.runtimeFields };
    }
}
