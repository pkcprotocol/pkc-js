### PKC signature types:

- 'ed25519':

```js
const ed = require('@noble/ed25519')
const {fromString: uint8ArrayFromString} = require('uint8arrays/from-string')
const {toString: uint8ArrayToString} = require('uint8arrays/to-string')
const cborg = require('cborg')

const generatePrivateKey = async () => {
  const privateKeyBuffer = ed.utils.randomPrivateKey()
  const privateKeyBase64 = uint8ArrayToString(privateKeyBuffer, 'base64')
  return privateKeyBase64
}

const getPublicKeyFromPrivateKey = async (privateKeyBase64) => {
  const privateKeyBuffer = uint8ArrayFromString(privateKeyBase64, 'base64')
  const publicKeyBuffer = await ed.getPublicKey(privateKeyBuffer)
  return uint8ArrayToString(publicKeyBuffer, 'base64')
}

const signBufferEd25519 = async (bufferToSign, privateKeyBase64) => {
  const privateKeyBuffer = uint8ArrayFromString(privateKeyBase64, 'base64')
  // do not use to sign strings, it doesn't encode properly in the browser
  const signature = await ed.sign(bufferToSign, privateKeyBuffer)
  return signature
}

const verifyBufferEd25519 = async (bufferToSign, bufferSignature, publicKeyBase64) => {
  const publicKeyBuffer = uint8ArrayFromString(publicKeyBase64, 'base64')
  const isValid = await ed.verify(bufferSignature, bufferToSign, publicKeyBuffer)
  return isValid
}

const getBufferToSign = (objectToSign, signedPropertyNames) => {
  const propsToSign = {}
  for (const propertyName of signedPropertyNames) {
    if (objectToSign[propertyName] !== undefined && objectToSign[propertyName] !== null) {
      propsToSign[propertyName] = objectToSign[propertyName]
    }
  }
  const bufferToSign = cborg.encode(propsToSign)
  return bufferToSign
}

;(async () => {
  // generate private key
  const privateKey = await generatePrivateKey()
  console.log({privateKey})

  // get public key from private key
  const publicKey = await getPublicKeyFromPrivateKey(privateKey)
  console.log({publicKey})

  // sign
  const bufferToSign = getBufferToSign({content: 'content', author: {address: 'address'}}, ['author', 'content', 'parentCid'])
  console.log({bufferToSign, bufferToSignUtf8: uint8ArrayToString(bufferToSign, 'utf8')})
  console.log(JSON.stringify({content: 'content', author: {address: 'address'}, signedPropertyNames: ['author', 'content', 'parentCid']}))
  const bufferSignature = await signBufferEd25519(bufferToSign, privateKey)
  console.log({bufferSignature})

  // verify
  const verification = await verifyBufferEd25519(bufferToSign, bufferSignature, publicKey)
  console.log({verification})
})()
```
