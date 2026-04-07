#### Types

```js
Client {
  state: string
}

ClientEvents {
  statechange(state: string): void
}

Clients {
  ipfsGateways: {[ipfsGatewayUrl: string]: Client}
  ipfsClients: {[ipfsClientUrl: string]: Client}
  pubsubClients: {[pubsubClientUrl: string]: Client}
  chainProviders: {[chainTicker: string]: {[chainProviderUrl: string]: Client}}
}

Comment {
  clients: Clients
}

Community {
  clients: Clients
}

Pages {
  clients: {[sortType: string]: {[chainProviderUrl: string]: Client}}
}

IpfsStats {
  totalIn: number // IPFS stats https://docs.ipfs.tech/reference/kubo/rpc/#api-v0-stats-bw
  totalOut: number
  rateIn: number
  rateOut: number
  succeededIpfsCount: number
  failedIpfsCount: number
  succeededIpfsAverageTime: number
  succeededIpfsMedianTime: number
  succeededIpnsCount: number
  failedIpnsCount: number
  succeededIpnsAverageTime: number
  succeededIpnsMedianTime: number
}

IpfsCommunityStats {
  stats: IpfsStats
  sessionStats: IpfsStats // session means in the last 1h
}

PubsubStats {
  totalIn: number // IPFS stats https://docs.ipfs.tech/reference/kubo/rpc/#api-v0-stats-bw
  totalOut: number
  rateIn: number
  rateOut: number
  succeededChallengeRequestMessageCount: number
  failedChallengeRequestMessageCount: number
  succeededChallengeRequestMessageAverageTime: number
  succeededChallengeRequestMessageMedianTime: number
  succeededChallengeAnswerMessageCount: number
  failedChallengeAnswerMessageCount: number
  succeededChallengeAnswerMessageAverageTime: number
  succeededChallengeAnswerMessageMedianTime: number
}

PubsubCommunityStats {
  stats: PubsubStats
  sessionStats: PubsubStats // session means in the last 1h
}

IpfsClient extends Client {
  getPeers(): Promise<Peer[]> // IPFS peers https://docs.ipfs.tech/reference/kubo/rpc/#api-v0-swarm-peers
  getStats(): Promise<{
    stats: IpfsStats
    sessionStats: IpfsStats // session means in the last 1h
    communityStats: {[communityAddress: string]: IpfsCommunityStats}
  }>
}

GatewayClient extends Client {
  getStats(): Promise<{
    stats: IpfsStats
    sessionStats: IpfsStats // session means in the last 1h
    communityStats: {[communityAddress: string]: IpfsCommunityStats}
  }>
}

PubsubClient extends Client {
  getPeers(): Promise<Peer[]> // IPFS peers https://docs.ipfs.tech/reference/kubo/rpc/#api-v0-swarm-peers
  getStats(): Promise<{
    stats: PubsubStats
    sessionStats: PubsubStats
    communityStats: {[communityAddress: string]: PubsubCommunityStats}
  }>
}

ChainProvider extends Client {
  // No need to implement for now since blockchain providers are usually fast and don't fail
}

PKCClients {
  ipfsGateways: {[ipfsGatewayUrl: string]: GatewayClient}
  ipfsClients: {[ipfsClientUrl: string]: IpfsClient}
  pubsubClients: {[pubsubClientUrl: string]: PubsubClient}
  chainProviders: {[chainTicker: string]: {[chainProviderUrl: string]: Client}}
}

PKC {
  clients: PKCClients
}
```
