import type { ParsedPKCOptions } from "../types.js";
import { Libp2pJsClient } from "./libp2pjsClient.js";
export declare function createLibp2pJsClientOrUseExistingOne(pkcOptions: Required<Pick<ParsedPKCOptions, "httpRoutersOptions">> & NonNullable<ParsedPKCOptions["libp2pJsClientsOptions"]>[number]): Promise<Libp2pJsClient>;
