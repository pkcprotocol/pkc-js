import type { SignerType } from "./types.js";
export { verifyCommentIpfs, verifyCommentPubsubMessage, verifyCommunity, verifyVote } from "./signatures.js";
export { encryptEd25519AesGcm, decryptEd25519AesGcm, decryptEd25519AesGcmPublicKeyBuffer } from "./encryption.js";
import { CreateSignerOptions } from "./types.js";
export declare class Signer implements SignerType {
    type: "ed25519";
    privateKey: string;
    publicKey?: string;
    address: string;
    shortAddress: string;
    ipfsKey?: Uint8Array;
    ipnsKeyName?: string;
    constructor(props: SignerType);
}
export declare class SignerWithPublicKeyAddress extends Signer {
    publicKey: string;
    constructor(props: SignerType & {
        publicKey: string;
    });
}
export declare const createSigner: (createSignerOptions?: CreateSignerOptions) => Promise<SignerWithPublicKeyAddress>;
