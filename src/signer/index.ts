import type { SignerType } from "./types.js";
import { generatePrivateKey, getPublicKeyFromPrivateKey, getPlebbitAddressFromPrivateKey } from "./util.js";
import { hideClassPrivateProps, shortifyAddress } from "../util.js";
export { verifyCommentIpfs, verifyCommentPubsubMessage, verifyCommunity, verifyVote } from "./signatures.js";
export { encryptEd25519AesGcm, decryptEd25519AesGcm, decryptEd25519AesGcmPublicKeyBuffer } from "./encryption.js";
import { CreateSignerSchema } from "../schema/schema.js";
import { CreateSignerOptions } from "./types.js";

export class Signer implements SignerType {
    type: "ed25519";
    privateKey: string;
    publicKey?: string;
    address: string;
    shortAddress: string;
    ipfsKey?: Uint8Array;
    ipnsKeyName?: string;

    constructor(props: SignerType) {
        this.type = props.type;
        this.privateKey = props.privateKey;
        this.publicKey = props.publicKey;
        this.address = props.address;
        this.shortAddress = shortifyAddress(this.address);
        this.ipnsKeyName = props.ipnsKeyName;

        this.ipfsKey =
            props.ipfsKey?.constructor?.name === "Object"
                ? new Uint8Array(Object.values(props.ipfsKey))
                : props.ipfsKey
                  ? new Uint8Array(props.ipfsKey)
                  : undefined;
        hideClassPrivateProps(this);
    }
}

export class SignerWithPublicKeyAddress extends Signer {
    override publicKey: string;
    constructor(props: SignerType & { publicKey: string }) {
        super(props);
        this.publicKey = props.publicKey;
    }
}

export const createSigner = async (createSignerOptions?: CreateSignerOptions): Promise<SignerWithPublicKeyAddress> => {
    let privateKey: CreateSignerOptions["privateKey"];
    let type: CreateSignerOptions["type"];
    if (!createSignerOptions) {
        type = "ed25519";
        privateKey = await generatePrivateKey();
    } else {
        const parsed = CreateSignerSchema.parse(createSignerOptions);
        privateKey = parsed.privateKey;
        type = parsed.type;
    }

    const [publicKey, address] = await Promise.all([getPublicKeyFromPrivateKey(privateKey), getPlebbitAddressFromPrivateKey(privateKey)]);

    return new SignerWithPublicKeyAddress({
        type,
        publicKey,
        address,
        privateKey
    });
};
