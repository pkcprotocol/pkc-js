import { generatePrivateKey, getPublicKeyFromPrivateKey, getPKCAddressFromPrivateKey } from "./util.js";
import { hideClassPrivateProps, shortifyAddress } from "../util.js";
export { verifyCommentIpfs, verifyCommentPubsubMessage, verifyCommunity, verifyVote } from "./signatures.js";
export { encryptEd25519AesGcm, decryptEd25519AesGcm, decryptEd25519AesGcmPublicKeyBuffer } from "./encryption.js";
import { CreateSignerSchema } from "../schema/schema.js";
export class Signer {
    constructor(props) {
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
    constructor(props) {
        super(props);
        this.publicKey = props.publicKey;
    }
}
export const createSigner = async (createSignerOptions) => {
    let privateKey;
    let type;
    if (!createSignerOptions) {
        type = "ed25519";
        privateKey = await generatePrivateKey();
    }
    else {
        const parsed = CreateSignerSchema.parse(createSignerOptions);
        privateKey = parsed.privateKey;
        type = parsed.type;
    }
    const [publicKey, address] = await Promise.all([getPublicKeyFromPrivateKey(privateKey), getPKCAddressFromPrivateKey(privateKey)]);
    return new SignerWithPublicKeyAddress({
        type,
        publicKey,
        address,
        privateKey
    });
};
//# sourceMappingURL=index.js.map