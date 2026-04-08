import { RemoteCommunity } from "./remote-community.js";
export declare class RpcRemoteCommunity extends RemoteCommunity {
    private _updateRpcSubscriptionId?;
    private _updatingRpcCommunityInstanceWithListeners?;
    protected _setRpcClientStateWithoutEmission(newState: RemoteCommunity["clients"]["pkcRpcClients"][""]["state"]): void;
    protected _setRpcClientStateWithEmission(newState: RemoteCommunity["clients"]["pkcRpcClients"][""]["state"]): void;
    get updatingState(): RemoteCommunity["updatingState"];
    protected _updateRpcClientStateFromUpdatingState(updatingState: RpcRemoteCommunity["updatingState"]): void;
    protected _processUpdateEventFromRpcUpdate(args: any): void;
    private _handleUpdatingStateChangeFromRpcUpdate;
    private _initMirroringUpdatingCommunity;
    protected _handleRpcErrorEvent(args: any): void;
    _initRpcUpdateSubscription(): Promise<void>;
    _createAndSubscribeToNewUpdatingCommunity(updatingCommunity?: RpcRemoteCommunity): Promise<void>;
    update(): Promise<void>;
    private _cleanupMirroringUpdatingCommunity;
    stop(): Promise<void>;
}
