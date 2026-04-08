import { PKC } from "../../pkc/pkc.js";
export declare function setupKuboAddressesRewriterAndHttpRouters(pkc: PKC): Promise<{
    destroy: () => Promise<void>;
}>;
