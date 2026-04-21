### PKC encryption types:

- 'ed25519-aes-gcm':

```js
const {ed25519, x25519} = require('@noble/curves/ed25519')
const {fromString: uint8ArrayFromString} = require('uint8arrays/from-string')
const {toString: uint8ArrayToString} = require('uint8arrays/to-string')
const forge = require('node-forge')

const generatePrivateKey = async () => {
  const privateKeyBuffer = ed25519.utils.randomSecretKey()
  const privateKeyBase64 = uint8ArrayToString(privateKeyBuffer, 'base64')
  return privateKeyBase64
}

const getPublicKeyFromPrivateKey = async (privateKeyBase64) => {
  const privateKeyBuffer = uint8ArrayFromString(privateKeyBase64, 'base64')
  const publicKeyBuffer = ed25519.getPublicKey(privateKeyBuffer)
  return uint8ArrayToString(publicKeyBuffer, 'base64')
}

const uint8ArrayToNodeForgeBuffer = (uint8Array) => {
  const forgeBuffer = forge.util.createBuffer()
  for (const byte of uint8Array) {
    forgeBuffer.putByte(byte)
  }
  return forgeBuffer
}

// NOTE: never pass the last param 'iv', only used for testing, it must always be random
const encryptStringAesGcm = async (plaintext, key) => {
  // use random 12 bytes uint8 array for iv
  const iv = ed25519.utils.randomSecretKey().slice(0, 12)

  // node-forge doesn't accept uint8Array
  const keyAsForgeBuffer = uint8ArrayToNodeForgeBuffer(key)
  const ivAsForgeBuffer = uint8ArrayToNodeForgeBuffer(iv)

  const cipher = forge.cipher.createCipher("AES-GCM", keyAsForgeBuffer)
  cipher.start({iv: ivAsForgeBuffer})
  cipher.update(forge.util.createBuffer(plaintext, "utf8"))
  cipher.finish()

  return {
    ciphertext: uint8ArrayFromString(cipher.output.toHex(), "base16"), // Uint8Array
    iv, // Uint8Array
    // AES-GCM has authentication tag https://en.wikipedia.org/wiki/Galois/Counter_Mode
    tag: uint8ArrayFromString(cipher.mode.tag.toHex(), "base16") // Uint8Array
  }
}

const decryptStringAesGcm = async (ciphertext, key, iv, tag) => {
  // node-forge doesn't accept uint8Array
  const keyAsForgeBuffer = uint8ArrayToNodeForgeBuffer(key)
  const ivAsForgeBuffer = uint8ArrayToNodeForgeBuffer(iv)
  const tagAsForgeBuffer = uint8ArrayToNodeForgeBuffer(tag)

  const cipher = forge.cipher.createDecipher("AES-GCM", keyAsForgeBuffer)
  cipher.start({iv: ivAsForgeBuffer, tag: tagAsForgeBuffer})
  cipher.update(forge.util.createBuffer(ciphertext))
  cipher.finish()
  const decrypted = cipher.output.toString()
  return decrypted
}

const encryptEd25519AesGcm = async (plaintext, privateKeyBase64, publicKeyBase64) => {
  const privateKeyBuffer = uint8ArrayFromString(privateKeyBase64, "base64")
  const publicKeyBuffer = uint8ArrayFromString(publicKeyBase64, "base64")

  // add random padding to prevent linking encrypted publications by sizes
  const randomPaddingLength = Math.round(Math.random() * 5000)
  let padding = ""
  while (padding.length < randomPaddingLength) {
    padding += " "
  }

  // compute the shared secret of the sender and recipient and use it as the encryption key
  // do not publish this secret https://datatracker.ietf.org/doc/html/rfc7748#section-6.1
  const x25519Priv = ed25519.utils.toMontgomerySecret(privateKeyBuffer)
  const x25519Pub = ed25519.utils.toMontgomery(publicKeyBuffer)
  const aesGcmKey = x25519.getSharedSecret(x25519Priv, x25519Pub)
  // use 16 bytes key for AES-128
  const aesGcmKey16Bytes = aesGcmKey.slice(0, 16)

  // AES GCM using 128-bit key https://en.wikipedia.org/wiki/Galois/Counter_Mode
  const {ciphertext, iv, tag} = await encryptStringAesGcm(plaintext + padding, aesGcmKey16Bytes)

  const encrypted = {
    ciphertext, // Uint8Array
    iv, // Uint8Array
    // AES-GCM has authentication tag https://en.wikipedia.org/wiki/Galois/Counter_Mode
    tag, // Uint8Array
    type: "ed25519-aes-gcm"
  }
  return encrypted
}

const decryptEd25519AesGcm = async (encrypted, privateKeyBase64, publicKeyBase64) => {
  const privateKeyBuffer = uint8ArrayFromString(privateKeyBase64, "base64")
  const publicKeyBuffer = uint8ArrayFromString(publicKeyBase64, "base64")

  // compute the shared secret of the sender and recipient and use it as the encryption key
  // do not publish this secret https://datatracker.ietf.org/doc/html/rfc7748#section-6.1
  const x25519Priv = ed25519.utils.toMontgomerySecret(privateKeyBuffer)
  const x25519Pub = ed25519.utils.toMontgomery(publicKeyBuffer)
  const aesGcmKey = x25519.getSharedSecret(x25519Priv, x25519Pub)
  // use 16 bytes key for AES-128
  const aesGcmKey16Bytes = aesGcmKey.slice(0, 16)

  // AES GCM using 128-bit key https://en.wikipedia.org/wiki/Galois/Counter_Mode
  let decrypted = await decryptStringAesGcm(encrypted.ciphertext, aesGcmKey16Bytes, encrypted.iv, encrypted.tag)

  // remove padding
  decrypted = decrypted.replace(/ *$/, "")

  return decrypted
}

;(async () => {
  // generate private key
  const privateKey = await generatePrivateKey()
  console.log({privateKey})

  // get public key from private key
  const publicKey = await getPublicKeyFromPrivateKey(privateKey)
  console.log({publicKey})

  // encrypt
  const recipientPrivateKey = await generatePrivateKey()
  const recipientPublicKey = await getPublicKeyFromPrivateKey(recipientPrivateKey)
  const encrypted = await encryptEd25519AesGcm('hello', privateKey, recipientPublicKey)
  console.log({encrypted})

  // decrypt
  const decrypted = await decryptEd25519AesGcm(encrypted, recipientPrivateKey, publicKey)
  console.log({decrypted})
})()
```
