### PKC addresses:

- 'ed25519':

```js
import * as ed from "@noble/ed25519";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import { privateKeyFromRaw, privateKeyToProtobuf, publicKeyFromRaw, publicKeyToProtobuf } from "@libp2p/crypto/keys";
import PeerId from "peer-id";

const generatePrivateKey = async () => {
  const privateKeyBuffer = ed.utils.randomPrivateKey();
  const privateKeyBase64 = uint8ArrayToString(privateKeyBuffer, "base64");
  return privateKeyBase64;
};

const getPublicKeyFromPrivateKey = async (privateKeyBase64) => {
  const privateKeyBuffer = uint8ArrayFromString(privateKeyBase64, "base64");
  const publicKeyBuffer = await ed.getPublicKey(privateKeyBuffer);
  return uint8ArrayToString(publicKeyBuffer, "base64");
};

const getIpfsKeyFromPrivateKey = async (privateKeyBase64) => {
  const privateKeyBuffer = uint8ArrayFromString(privateKeyBase64, "base64");
  const publicKeyBuffer = await ed.getPublicKey(privateKeyBuffer);

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
  const peerId = await PeerId.createFromPrivKey(ipfsKey);
  return peerId;
};

const getPeerIdFromPublicKey = async (publicKeyBase64) => {
  const publicKeyBuffer = uint8ArrayFromString(publicKeyBase64, "base64");

  // the PeerId public key is not a raw public key, it adds a suffix
  const ed25519PublicKeyInstance = publicKeyFromRaw(publicKeyBuffer);
  const peerId = await PeerId.createFromPubKey(publicKeyToProtobuf(ed25519PublicKeyInstance));
  return peerId;
};

const getPkcAddressFromPrivateKey = async (privateKeyBase64) => {
  const peerId = await getPeerIdFromPrivateKey(privateKeyBase64);
  return peerId.toB58String().trim();
};

const getPkcAddressFromPublicKey = async (publicKeyBase64) => {
  const peerId = await getPeerIdFromPublicKey(publicKeyBase64);
  return peerId.toB58String().trim();
};

(async () => {
  // generate private key
  const privateKey = await generatePrivateKey();
  console.log({ privateKey });

  // get public key from private key
  const publicKey = await getPublicKeyFromPrivateKey(privateKey);
  console.log({ publicKey });

  // get PeerId from public key
  const peerIdFromPublicKey = await getPeerIdFromPublicKey(publicKey);
  console.log({ peerIdFromPublicKey });

  // get PeerId from private key
  const peerIdFromPrivateKey = await getPeerIdFromPrivateKey(privateKey);
  console.log({ peerIdFromPrivateKey });

  // get pkc address from public key
  const pkcAddressFromPublicKey = await getPkcAddressFromPublicKey(publicKey);
  console.log({ pkcAddressFromPublicKey });

  // get pkc address from private key
  const pkcAddressFromPrivateKey = await getPkcAddressFromPrivateKey(privateKey);
  console.log({ pkcAddressFromPrivateKey });

  // get ipfs key from private key
  const ipfsKey = await getIpfsKeyFromPrivateKey(privateKey);
  console.log({ ipfsKey });
})();
```
