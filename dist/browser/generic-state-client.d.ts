import { PKCTypedEmitter } from "./clients/pkc-typed-emitter.js";
import { GenericClientEvents } from "./types.js";
export declare class GenericStateClient<T extends string> extends PKCTypedEmitter<GenericClientEvents<T>> {
    state: T;
    constructor(state: T);
}
