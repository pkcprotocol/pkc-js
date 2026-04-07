### How to resolve and verify NFT avatars

```js
const ethers = require('ethers')
const fetch = require('isomorphic-fetch')

// this setting can be edited in the account or pkc-js settings, possible to use a local node
const ipfsGatewayUrl = 'https://ipfs.io'

// the user can edit these blockchains settings in the account or pkc-js settings
const chainProviders = {
  avax: {
    url: 'https://api.avax.network/ext/bc/C/rpc',
    chainId: 43114
  },
  matic: {
    url: 'https://polygon-rpc.com',
    chainId: 137
  }
}

// cache the blockchain providers because only 1 should be running at the same time
const cachedChainProviders = {}
const getChainProvider = (chainTicker) => {
  if (cachedChainProviders[chainTicker]) {
    return cachedChainProviders[chainTicker]
  }
  if (chainProviders[chainTicker]) {
    cachedChainProviders[chainTicker] = new ethers.providers.JsonRpcProvider({url: chainProviders[chainTicker].url}, chainProviders[chainTicker].chainId)
    return cachedChainProviders[chainTicker]
  }
  if (chainTicker === 'eth') {
    cachedChainProviders['eth'] = ethers.getDefaultProvider()
    return cachedChainProviders['eth']
  }
  throw Error(`no chain provider settings for chain ticker '${chainTicker}'`)
}

const nftAbi = [
  {"inputs":[{"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"tokenURI","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"ownerOf","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"}  
]

const getNftImageUrl = async (nft) => {
  const chainProvider = getChainProvider(nft.chainTicker)
  const nftContract = new ethers.Contract(nft.address, nftAbi, chainProvider)
  let nftUrl = await nftContract.tokenURI(nft.id)

  // if the ipfs nft is json, get the image url using the ipfs gateway in account settings
  if (nftUrl.startsWith('ipfs://')) {
    nftUrl = `${ipfsGatewayUrl}/${nftUrl.replace('://', '/')}`
  }

  // if the ipfs file is json, it probably has an 'image' property
  try {
    const json = await fetch(nftUrl).then(resp => resp.json())
    nftUrl = json.image

    // if the image property is an ipfs url, get the image url using the ipfs gateway in account settings
    if (nftUrl.startsWith('ipfs://')) {
      nftUrl = `${ipfsGatewayUrl}/${nftUrl.replace('://', '/')}`
    }
  }
  catch (e) {}

  return nftUrl
}

const getNftMessageToSign = (authorAddress, timestamp, tokenAddress, tokenId) => {
  // use plain JSON so the user can read what he's signing
  // property names must always be in this order for signature to match so don't use JSON.stringify
  return `{"domainSeparator":"pkc-author-avatar","authorAddress":"${authorAddress}","timestamp":${timestamp},"tokenAddress":"${tokenAddress}","tokenId":"${tokenId}"}`
}

const createNftSignature = async (nft, authorAddress, ethersJsSigner) => {
  // use plain JSON so the user can read what he's signing
  // property names must always be in this order for signature to match so don't use JSON.stringify
  const messageToSign = `{"domainSeparator":"pkc-author-avatar","authorAddress":"${authorAddress}","timestamp":${nft.timestamp},"tokenAddress":"${nft.address}","tokenId":"${nft.id}"}`

  // the ethers.js signer is usually gotten from metamask https://docs.ethers.io/v5/api/signer/
  const signature = await ethersJsSigner.signMessage(messageToSign)
  return signature
}

const verifyNftSignature = async (nft, authorAddress) => {
  const chainProvider = getChainProvider(nft.chainTicker)
  const nftContract = new ethers.Contract(nft.address, nftAbi, chainProvider)
  // get the owner of the nft at nft.id
  const currentNftOwnerAddress = await nftContract.ownerOf(nft.id)

  // use plain JSON so the user can read what he's signing
  // property names must always be in this order for signature to match so don't use JSON.stringify
  const messageThatShouldBeSigned = `{"domainSeparator":"pkc-author-avatar","authorAddress":"${authorAddress}","timestamp":${nft.timestamp},"tokenAddress":"${nft.address}","tokenId":"${nft.id}"}`

  const signatureAddress = ethers.utils.verifyMessage(messageThatShouldBeSigned, nft.signature)
  if (currentNftOwnerAddress !== signatureAddress) {
    throw Error(`invalid nft signature address '${signatureAddress}' does not equal '${currentNftOwnerAddress}'`)
  }
}

const avatarNft = {
  chainTicker: 'eth',
  address: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', // the contract address of the nft
  timestamp: Math.round(Date.now() / 1000),
  id: 100 // the nft number 100 in the colletion
}
const avatarNft2 = {
  chainTicker: 'matic',
  address: '0xf6d8e606c862143556b342149a7fe0558c220375', // the contract address of the nft
  timestamp: Math.round(Date.now() / 1000),
  id: 100 // the nft number 100 in the colletion
}
const author = {
  address: 'some test address...',
  avatar: avatarNft
}

;(async () => {
  // get the image url of an nft
  const nftImageUrl = await getNftImageUrl(avatarNft)
  const nftImageUrl2 = await getNftImageUrl(avatarNft2)
  console.log({nftImageUrl, nftImageUrl2})

  // this is a test private key, usually you get an ethers.js signer from metamask
  // https://docs.ethers.io/v5/api/signer
  const testPrivateKey = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const ethersJsSigner = new ethers.Wallet(Buffer.from(testPrivateKey, 'hex'))

  // sign an nft
  const signature = await createNftSignature(avatarNft, author.address, ethersJsSigner)
  const nftWithSignature = {...avatarNft, signature}
  console.log({nftWithSignature})

  // verify nft signature
  try {
    await verifyNftSignature(nftWithSignature, author.address)
  }
  catch (e) {
    console.log(`nft signature is not verified because our test private key doesn't own a bored ape`)
  }
})()
```
