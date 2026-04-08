import { BaseClientsManager } from "../clients/base-client-manager.js";
import * as remeda from "remeda";
import Logger from "../logger.js";
import { POSTS_SORT_TYPES, POST_REPLIES_SORT_TYPES } from "./util.js";
import { parseJsonWithPKCErrorIfFails, parseModQueuePageIpfsSchemaWithPKCErrorIfItFails, parsePageIpfsSchemaWithPKCErrorIfItFails } from "../schema/schema-util.js";
import { hideClassPrivateProps } from "../util.js";
import { sha256 } from "js-sha256";
import { PagesIpfsGatewayClient, PagesKuboRpcClient, PagesLibp2pJsClient, PagesPKCRpcStateClient } from "./pages-clients.js";
export class BasePagesClientsManager extends BaseClientsManager {
    constructor(opts) {
        super(opts.pkc);
        this._pages = opts.pages;
        //@ts-expect-error
        this.clients = {};
        this._updateIpfsGatewayClientStates(this.getSortTypes());
        this._updateKuboRpcClientStates(this.getSortTypes());
        this._updatePKCRpcClientStates(this.getSortTypes());
        this._updateLibp2pJsClientStates(this.getSortTypes());
        if (opts.pages.pageCids)
            this.updatePageCidsToSortTypes(opts.pages.pageCids);
        hideClassPrivateProps(this);
    }
    // Init functions here
    _updateIpfsGatewayClientStates(sortTypes) {
        if (!this.clients.ipfsGateways)
            this.clients.ipfsGateways = {};
        for (const sortType of sortTypes) {
            if (!this.clients.ipfsGateways[sortType])
                this.clients.ipfsGateways[sortType] = {};
            for (const gatewayUrl of remeda.keys.strict(this._pkc.clients.ipfsGateways))
                if (!this.clients.ipfsGateways[sortType][gatewayUrl])
                    this.clients.ipfsGateways[sortType][gatewayUrl] = new PagesIpfsGatewayClient("stopped");
        }
    }
    _updateKuboRpcClientStates(sortTypes) {
        if (this._pkc.clients.kuboRpcClients && !this.clients.kuboRpcClients)
            this.clients.kuboRpcClients = {};
        for (const sortType of sortTypes) {
            if (!this.clients.kuboRpcClients[sortType])
                this.clients.kuboRpcClients[sortType] = {};
            for (const kuboRpcUrl of remeda.keys.strict(this._pkc.clients.kuboRpcClients))
                if (!this.clients.kuboRpcClients[sortType][kuboRpcUrl])
                    this.clients.kuboRpcClients[sortType][kuboRpcUrl] = new PagesKuboRpcClient("stopped");
        }
    }
    _updateLibp2pJsClientStates(sortTypes) {
        if (this._pkc.clients.libp2pJsClients && !this.clients.libp2pJsClients)
            this.clients.libp2pJsClients = {};
        for (const sortType of sortTypes) {
            if (!this.clients.libp2pJsClients[sortType])
                this.clients.libp2pJsClients[sortType] = {};
            for (const libp2pJsClientKey of remeda.keys.strict(this._pkc.clients.libp2pJsClients))
                if (!this.clients.libp2pJsClients[sortType][libp2pJsClientKey])
                    this.clients.libp2pJsClients[sortType][libp2pJsClientKey] = new PagesLibp2pJsClient("stopped");
        }
    }
    _updatePKCRpcClientStates(sortTypes) {
        if (this._pkc.clients.pkcRpcClients && !this.clients.pkcRpcClients)
            this.clients.pkcRpcClients = {};
        for (const sortType of sortTypes) {
            if (!this.clients.pkcRpcClients[sortType])
                this.clients.pkcRpcClients[sortType] = {};
            for (const rpcUrl of remeda.keys.strict(this._pkc.clients.pkcRpcClients))
                if (!this.clients.pkcRpcClients[sortType][rpcUrl])
                    this.clients.pkcRpcClients[sortType][rpcUrl] = new PagesPKCRpcStateClient("stopped");
        }
    }
    // Override methods from BaseClientsManager here
    preFetchGateway(gatewayUrl, loadOpts) {
        const cid = loadOpts.root;
        const sortTypes = this._pkc._memCaches.pageCidToSortTypes.get(cid);
        this.updateGatewayState("fetching-ipfs", gatewayUrl, sortTypes);
    }
    postFetchGatewaySuccess(gatewayUrl, loadOpts) {
        const cid = loadOpts.root;
        const sortTypes = this._pkc._memCaches.pageCidToSortTypes.get(cid);
        this.updateGatewayState("stopped", gatewayUrl, sortTypes);
    }
    postFetchGatewayFailure(gatewayUrl, loadOpts) {
        this.postFetchGatewaySuccess(gatewayUrl, loadOpts);
    }
    postFetchGatewayAborted(gatewayUrl, loadOpts) {
        this.postFetchGatewaySuccess(gatewayUrl, loadOpts);
    }
    _updatePageCidsSortCache(pageCid, sortTypes) {
        const curSortTypes = this._pkc._memCaches.pageCidToSortTypes.get(pageCid);
        if (!curSortTypes) {
            this._pkc._memCaches.pageCidToSortTypes.set(pageCid, sortTypes);
        }
        else {
            const newSortTypes = remeda.unique([...curSortTypes, ...sortTypes]);
            this._pkc._memCaches.pageCidToSortTypes.set(pageCid, newSortTypes);
        }
    }
    updatePageCidsToSortTypes(newPageCids) {
        for (const [sortType, pageCid] of Object.entries(newPageCids)) {
            this._updatePageCidsSortCache(pageCid, [sortType]);
        }
        this._updateIpfsGatewayClientStates(Object.keys(newPageCids));
        this._updateKuboRpcClientStates(Object.keys(newPageCids));
        this._updatePKCRpcClientStates(Object.keys(newPageCids));
    }
    _calculatePageMaxSizeCacheKey(pageCid) {
        return sha256(this._pages._community.address + pageCid);
    }
    updatePagesMaxSizeCache(newPageCids, pageMaxSizeBytes) {
        remeda
            .unique(newPageCids)
            .forEach((pageCid) => this._pkc._memCaches.pagesMaxSize.set(this._calculatePageMaxSizeCacheKey(pageCid), pageMaxSizeBytes));
    }
    updatePageCidsToSortTypesToIncludeSubsequent(nextPageCid, previousPageCid) {
        const sortTypes = this._pkc._memCaches.pageCidToSortTypes.get(previousPageCid);
        if (!Array.isArray(sortTypes))
            return;
        this._updatePageCidsSortCache(nextPageCid, sortTypes);
    }
    updateKuboRpcState(newState, kuboRpcClientUrl, sortTypes) {
        if (!Array.isArray(sortTypes))
            return;
        for (const sortType of sortTypes) {
            if (this.clients.kuboRpcClients[sortType][kuboRpcClientUrl].state === newState)
                continue;
            this.clients.kuboRpcClients[sortType][kuboRpcClientUrl].state = newState;
            this.clients.kuboRpcClients[sortType][kuboRpcClientUrl].emit("statechange", newState);
        }
    }
    updateLibp2pJsClientState(newState, libp2pJsClientKey, sortTypes) {
        if (!Array.isArray(sortTypes))
            return;
        for (const sortType of sortTypes) {
            if (this.clients.libp2pJsClients[sortType][libp2pJsClientKey].state === newState)
                continue;
            this.clients.libp2pJsClients[sortType][libp2pJsClientKey].state = newState;
            this.clients.libp2pJsClients[sortType][libp2pJsClientKey].emit("statechange", newState);
        }
    }
    updateGatewayState(newState, gateway, sortTypes) {
        if (!Array.isArray(sortTypes))
            return;
        for (const sortType of sortTypes) {
            if (this.clients.ipfsGateways[sortType][gateway].state === newState)
                continue;
            this.clients.ipfsGateways[sortType][gateway].state = newState;
            this.clients.ipfsGateways[sortType][gateway].emit("statechange", newState);
        }
    }
    updateRpcState(newState, rpcUrl, sortTypes) {
        if (!Array.isArray(sortTypes))
            return;
        for (const sortType of sortTypes) {
            if (this.clients.pkcRpcClients[sortType][rpcUrl].state === newState)
                continue;
            this.clients.pkcRpcClients[sortType][rpcUrl].state = newState;
            this.clients.pkcRpcClients[sortType][rpcUrl].emit("statechange", newState);
        }
    }
    _updateKuboRpcClientOrHeliaState(newState, kuboRpcOrHelia, sortTypes) {
        if ("_helia" in kuboRpcOrHelia)
            this.updateLibp2pJsClientState(newState, kuboRpcOrHelia._libp2pJsClientsOptions.key, sortTypes);
        else
            this.updateKuboRpcState(newState, kuboRpcOrHelia.url, sortTypes);
    }
    preFetchPage() {
        throw Error("should be implemented");
    }
    async _requestPageFromRPC(opts) {
        throw Error("Should be implemented");
    }
    async _fetchPageWithRpc(opts) {
        const currentRpcUrl = this._pkc.pkcRpcClientsOptions[0];
        this.preFetchPage();
        opts.log.trace(`Fetching page cid (${opts.pageCid}) using rpc`);
        this.updateRpcState("fetching-ipfs", currentRpcUrl, opts.sortTypes);
        try {
            return this._requestPageFromRPC(opts);
        }
        catch (e) {
            opts.log.error(`Failed to retrieve page (${opts.pageCid}) with rpc due to error:`, e);
            throw e;
        }
        finally {
            this.updateRpcState("stopped", currentRpcUrl, opts.sortTypes);
        }
    }
    parsePageJson(json) {
        // default validator; subclasses can override
        return parsePageIpfsSchemaWithPKCErrorIfItFails(json);
    }
    async _fetchPageWithKuboOrHeliaP2P(pageCid, log, sortTypes, pageMaxSize) {
        const heliaOrKubo = this.getDefaultKuboRpcClientOrHelia();
        this._updateKuboRpcClientOrHeliaState("fetching-ipfs", heliaOrKubo, sortTypes);
        const pageTimeoutMs = this._pkc._timeouts["page-ipfs"];
        try {
            return this.parsePageJson(parseJsonWithPKCErrorIfFails(await this._fetchCidP2P(pageCid, { maxFileSizeBytes: pageMaxSize, timeoutMs: pageTimeoutMs })));
        }
        catch (e) {
            //@ts-expect-error
            e.details = { ...e.details, pageCid, sortTypes, pageMaxSize };
            log.error(`Failed to fetch the page (${pageCid}) due to error:`, e);
            throw e;
        }
        finally {
            this._updateKuboRpcClientOrHeliaState("stopped", heliaOrKubo, sortTypes);
        }
    }
    async _fetchPageFromGateways(pageCid, log, pageMaxSize) {
        // No need to validate schema for every gateway, because the cid validation will make sure it's the page ipfs we're looking for
        // we just need to validate the end result's schema
        const res = await this.fetchFromMultipleGateways({
            root: pageCid,
            recordIpfsType: "ipfs",
            recordPKCType: "page-ipfs",
            validateGatewayResponseFunc: async () => { },
            maxFileSizeBytes: pageMaxSize,
            timeoutMs: this._pkc._timeouts["page-ipfs"],
            log
        });
        const pageIpfs = this.parsePageJson(parseJsonWithPKCErrorIfFails(res.resText));
        return pageIpfs;
    }
    async fetchPage(pageCid, overridePageMaxSize) {
        const log = Logger("pkc-js:pages:getPage");
        const sortTypesFromPageCids = remeda.keys
            .strict(this._pages.pageCids)
            .filter((sortType) => this._pages.pageCids[sortType] === pageCid);
        if (sortTypesFromPageCids.length > 0) {
            this.updatePageCidsToSortTypes(this._pages.pageCids);
        }
        const sortTypesFromMemcache = this._pkc._memCaches.pageCidToSortTypes.get(pageCid);
        const isFirstPage = Object.values(this._pages.pageCids).includes(pageCid) || remeda.isEmpty(this._pages.pageCids);
        const pageMaxSize = overridePageMaxSize
            ? overridePageMaxSize
            : this._pkc._memCaches.pagesMaxSize.get(this._calculatePageMaxSizeCacheKey(pageCid))
                ? this._pkc._memCaches.pagesMaxSize.get(this._calculatePageMaxSizeCacheKey(pageCid))
                : isFirstPage
                    ? 1024 * 1024
                    : undefined;
        if (!pageMaxSize)
            throw Error("Failed to calculate max page size. Is this page cid under the correct community/comment?");
        let result;
        try {
            if (this._pkc._pkcRpcClient) {
                result = await this._fetchPageWithRpc({ pageCid, log, sortTypes: sortTypesFromMemcache, pageMaxSize });
            }
            else if (Object.keys(this._pkc.clients.kuboRpcClients).length > 0 ||
                Object.keys(this._pkc.clients.libp2pJsClients).length > 0)
                result = { page: await this._fetchPageWithKuboOrHeliaP2P(pageCid, log, sortTypesFromMemcache, pageMaxSize) };
            else
                result = { page: await this._fetchPageFromGateways(pageCid, log, pageMaxSize) };
        }
        catch (e) {
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
    getSortTypes() {
        throw Error("This function should be overridden");
    }
}
export class RepliesPagesClientsManager extends BasePagesClientsManager {
    getSortTypes() {
        return remeda.keys.strict(POST_REPLIES_SORT_TYPES);
    }
    preFetchPage() {
        if (!this._pages._parentComment)
            throw Error("parent comment needs to be defined");
        if (!this._pages._parentComment?.cid)
            throw Error("Parent comment cid is not defined");
    }
    async _requestPageFromRPC(opts) {
        const result = await this._pkc._pkcRpcClient.getCommentPage({
            cid: opts.pageCid,
            commentCid: this._pages._parentComment.cid,
            communityAddress: this._pages._community.address,
            pageMaxSize: opts.pageMaxSize
        });
        return { page: result.page, runtimeFields: result.runtimeFields };
    }
}
export class CommunityPostsPagesClientsManager extends BasePagesClientsManager {
    getSortTypes() {
        return remeda.keys.strict(POSTS_SORT_TYPES);
    }
    preFetchPage() {
        if (!this._pages._community)
            throw Error("Community needs to be defined");
        if (!this._pages._community.address)
            throw Error("Community address is not defined");
    }
    async _requestPageFromRPC(opts) {
        const result = await this._pkc._pkcRpcClient.getCommunityPage({
            cid: opts.pageCid,
            communityAddress: this._pages._community.address,
            type: "posts",
            pageMaxSize: opts.pageMaxSize
        });
        return { page: result.page, runtimeFields: result.runtimeFields };
    }
}
export class CommunityModQueueClientsManager extends BasePagesClientsManager {
    getSortTypes() {
        return ["pendingApproval"];
    }
    async fetchPage(pageCid, overridePageMaxSize) {
        const result = await super.fetchPage(pageCid, overridePageMaxSize);
        return { page: result.page, runtimeFields: result.runtimeFields };
    }
    preFetchPage() {
        if (!this._pages._community)
            throw Error("Community needs to be defined");
        if (!this._pages._community.address)
            throw Error("Community address is not defined");
    }
    parsePageJson(json) {
        // Validate using the ModQueue page schema, then coerce to PageIpfs for consumers
        return parseModQueuePageIpfsSchemaWithPKCErrorIfItFails(json);
    }
    async _requestPageFromRPC(opts) {
        const result = await this._pkc._pkcRpcClient.getCommunityPage({
            type: "modqueue",
            cid: opts.pageCid,
            communityAddress: this._pages._community.address,
            pageMaxSize: opts.pageMaxSize
        });
        return { page: result.page, runtimeFields: result.runtimeFields };
    }
}
//# sourceMappingURL=pages-client-manager.js.map