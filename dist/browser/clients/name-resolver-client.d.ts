import type { GenericClientEvents } from "../types.js";
import { PKCTypedEmitter } from "./pkc-typed-emitter.js";
type NameResolverState = "stopped" | "resolving-author-name" | "resolving-community-name";
export declare class NameResolverClient extends PKCTypedEmitter<GenericClientEvents<NameResolverState>> {
    state: NameResolverState;
    constructor(state: NameResolverState);
}
export {};
