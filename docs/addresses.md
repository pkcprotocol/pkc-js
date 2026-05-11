### PKC addresses:

- 'ed25519':

```js
import { ed25519 } from "@noble/curves/ed25519.js";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import {
  privateKeyFromRaw,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
  publicKeyFromRaw
} from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey, peerIdFromPublicKey } from "@libp2p/peer-id";

const generatePrivateKey = async () => {
  const privateKeyBuffer = ed25519.utils.randomSecretKey();
  return uint8ArrayToString(privateKeyBuffer, "base64");
};

const getPublicKeyFromPrivateKey = async (privateKeyBase64) => {
  const privateKeyBuffer = uint8ArrayFromString(privateKeyBase64, "base64");
  const publicKeyBuffer = ed25519.getPublicKey(privateKeyBuffer);
  return uint8ArrayToString(publicKeyBuffer, "base64");
};

const getIpfsKeyFromPrivateKey = async (privateKeyBase64) => {
  const privateKeyBuffer = uint8ArrayFromString(privateKeyBase64, "base64");
  const publicKeyBuffer = ed25519.getPublicKey(privateKeyBuffer);

  // ipfs ed25519 private keys format are private (32 bytes) + public (32 bytes) (64 bytes total)
  const privateAndPublicKeyBuffer = new Uint8Array(64);
  privateAndPublicKeyBuffer.set(privateKeyBuffer);
  privateAndPublicKeyBuffer.set(publicKeyBuffer, 32);

  const ed25519PrivateKeyInstance = privateKeyFromRaw(privateAndPublicKeyBuffer);
  // the "ipfs key" adds a suffix, then the private key, then the public key, it is not the raw private key
  return privateKeyToProtobuf(ed25519PrivateKeyInstance);
};

const getPeerIdFromPrivateKey = async (privateKeyBase64) => {
  const ipfsKey = await getIpfsKeyFromPrivateKey(privateKeyBase64);
  // the PeerId private key is not a raw private key, it's an "ipfs key"
  return peerIdFromPrivateKey(privateKeyFromProtobuf(ipfsKey));
};

const getPeerIdFromPublicKey = (publicKeyBase64) => {
  const publicKeyBuffer = uint8ArrayFromString(publicKeyBase64, "base64");
  // the PeerId public key is not a raw public key, it adds a suffix
  const ed25519PublicKeyInstance = publicKeyFromRaw(publicKeyBuffer);
  return peerIdFromPublicKey(ed25519PublicKeyInstance);
};

const getPkcAddressFromPrivateKey = async (privateKeyBase64) => {
  const peerId = await getPeerIdFromPrivateKey(privateKeyBase64);
  return peerId.toString().trim();
};

const getPkcAddressFromPublicKey = (publicKeyBase64) => {
  const peerId = getPeerIdFromPublicKey(publicKeyBase64);
  return peerId.toString().trim();
};

(async () => {
  const privateKey = await generatePrivateKey();
  console.log({ privateKey });

  const publicKey = await getPublicKeyFromPrivateKey(privateKey);
  console.log({ publicKey });

  const peerIdFromPublicKeyResult = getPeerIdFromPublicKey(publicKey);
  console.log({ peerIdFromPublicKey: peerIdFromPublicKeyResult });

  const peerIdFromPrivateKeyResult = await getPeerIdFromPrivateKey(privateKey);
  console.log({ peerIdFromPrivateKey: peerIdFromPrivateKeyResult });

  const pkcAddressFromPublicKey = getPkcAddressFromPublicKey(publicKey);
  console.log({ pkcAddressFromPublicKey });

  const pkcAddressFromPrivateKey = await getPkcAddressFromPrivateKey(privateKey);
  console.log({ pkcAddressFromPrivateKey });

  const ipfsKey = await getIpfsKeyFromPrivateKey(privateKey);
  console.log({ ipfsKey });
})();
```

The reference implementation lives in `src/signer/util.ts` (`getPKCAddressFromPrivateKey`, `getPKCAddressFromPublicKey`, `getPKCAddressFromPublicKeySync`).
