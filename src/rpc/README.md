## Get started running the plebbit JSON-RPC websocket server

```js
const {PlebbitWsServer} = require('@plebbit/plebbit-js/rpc')
const port = 8080
const plebbitOptions = {ipfsHttpClientsOptions: ['http://localhost:5001/api/v0']}
const plebbitWebSocketServer = await PlebbitWsServer({port, plebbitOptions})

// debug raw JSON RPC messages in console (optional)
plebbitWebSocketServer.ws.on('connection', (socket, request) => {
  console.log('connection')
  socket.on('message', (message) => console.log(message.toString()))
})

// handle plebbit and wss errors
plebbitWebSocketServer.on('error', console.log)

console.log(`test server plebbit wss listening on port ${port}`)
```

## Get started making client requests

```js
const WebSocketClient = require('rpc-websockets').Client // or any JSON RPC websocket compatible library
const webSocketClient = new WebSocketClient(`ws://localhost:${port}`)

// debug raw JSON RPC messages in console (optional)
webSocketClient.socket.on('message', (message) => console.log('from server:', message.toString()))

// wait for websocket connection  to open
await new Promise((resolve) => webSocketClient.on('open', resolve))

// save all subscription messages (ie json rpc messages without 'id', also called json rpc 'notifications')
// NOTE: it is possible to receive a subscription message before receiving the subscription id
const subscriptionsMessages = {}
webSocketClient.socket.on('message', (jsonMessage) => {
  const message = JSON.parse(jsonMessage)
  const subscriptionId = message?.params?.subscription
  if (subscriptionId) {
    if (!subscriptionsMessages[subscriptionId]) {
      subscriptionsMessages[subscriptionId] = []
    }
    subscriptionsMessages[subscriptionId].push(message)
    // delete the message after 1 minute to not cause memory leak
    setTimeout(() => subscriptionsMessages[subscriptionId].shift(), 60000)
  }
})

class Subscription extends EventEmitter {
  constructor(subscriptionId) {
    super()
    let emittingMessages = false
    this.on('newListener', (eventName) => {
      // emit all subscription messages received before the listener started
      if (eventName === 'message') {
        for (const message of subscriptionsMessages[subscriptionId] || []) {
          this.emit('message', message)
        }
      }
      // emit all new messages
      if (!emittingMessages) {
        emittingMessages = true
        webSocketClient.socket.on('message', emitMessage)
      }
    })
    // stop listening if listener is removed
    this.on('removeListener', (eventName) => {
      if (eventName === 'message' && this.listenerCount('message') === 0) {
        emittingMessages = false
        webSocketClient.socket.off('message', emitMessage)
      }
    })
    function emitMessage(jsonMessage) {
      const message = JSON.parse(jsonMessage)
      if (subscriptionId === message?.params?.subscription) {
        this.emit('message', message)
      }
    }
  }
}

// get comment
const commentCid = 'Qm...'
const comment = await webSocketClient.call('getComment', [{cid: commentCid}])
console.log(comment)

// get comment updates
const subscriptionId = await webSocketClient.call('commentUpdateSubscribe', [{cid: comment.cid}])
new Subscription(subscriptionId).on('message', console.log)
```

# JSON-RPC Websocket API

- `method: getComment, params: [{cid: string}], result: CommentIpfs`
- `method: getCommentRepliesPage, params: [{cid: string, commentCid: string}]`
- `method: getSubplebbitPostsPage, params: [{cid: string, subplebbitAddress: string}]`
- `method: getSubplebbitModqueuePage, params: [{cid: string, subplebbitAddress: string}]`
- `method: createSubplebbit, params: [createSubplebbitOptions: CreateSubplebbitOptions]`
- `method: stopSubplebbit, params: [{address: string}]`
- `method: editSubplebbit, params: [address: string, subplebbitEditOptions: SubplebbitEditOptions]`
- `method: deleteSubplebbit, params: [{address: string}]`
- `method: fetchCid, params: [{cid: string}]`
- `method: setSettings, params: [plebbitRpcSettings: PlebbitRpcSettings]`
- (below not implemented yet, probably make them subscriptions only)
- `method: getDefaults, params: []`
- `method: getPeers, params: []`
- `method: getStats, params: []`

# JSON-RPC Pubsub Websocket API

- [`method: commentUpdateSubscribe, params: [{cid: string}]`](#commentupdatesubscribe)
- [`method: subplebbitUpdateSubscribe, params: [{address: string}]`](#subplebbitupdatesubscribe)
- [`method: publishComment, params: [{comment, challengeAnswers, challengeCommentCids}]`](#publishcomment)
- `method: publishVote, params: [{vote, challengeAnswers, challengeCommentCids}]`
- `method: publishCommentEdit, params: [{commentEdit, challengeAnswers, challengeCommentCids}]`
- `method: publishCommentModeration, params: [{commentModeration, challengeAnswers, challengeCommentCids}]`
- `method: publishChallengeAnswers, params: [subscriptionId: number, {challengeAnswers}]`
- `method: startSubplebbit, params: [{address: string}]`
- [`method: subplebbitsSubscribe, params: []`](#subplebbitssubscribe)
- [`method: settingsSubscribe, params: []`](#settingssubscribe)
- [`method: unsubscribe, params: [subscriptionId: number]`](#unsubscribe)

## commentUpdateSubscribe

Subscribe to a comment update to receive notifications when the comment is updated, e.g. has a new reply

### Parameters:

| Name | Type | Description |
| ---- | ---- | ----------- |
| cid | `string` | CID of the comment |

### Result:

`<number>` - Subscription id \(needed to unsubscribe\)

### Code sample:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "commentUpdateSubscribe",
  "params": [
    {
      "cid": "Qm..."
    }
  ]
}
```

### Response:

```json
{ "jsonrpc": "2.0", "result": 23784, "id": 1 }
```

#### Notification Format:

The notification format is the same as seen in the plebbit-js [Comment Events](https://github.com/plebbit/plebbit-js#comment-events)

`update` event:

```json
{
  "jsonrpc": "2.0",
  "method": "commentUpdateNotification",
  "params": {
    "result": {
      "commentUpdate": {
        "cid": "Qm...",
        "upvoteCount": 1,
        "downvoteCount": 0,
        "replyCount": 0,
        "updatedAt": 1689886478
      }
    },
    "event": "update",
    "subscription": 23784
  }
}
```

`updatingstatechange` event:

```json
{
  "jsonrpc": "2.0",
  "method": "commentUpdateNotification",
  "params": {
    "result": "fetching-ipfs",
    "event": "updatingstatechange",
    "subscription": 23784
  }
}
```

## subplebbitUpdateSubscribe

Subscribe to a subplebbit update to receive notifications when the subplebbit is updated, e.g. has a new post

### Parameters:

| Name | Type | Description |
| ---- | ---- | ----------- |
| address | `string` | address of the subplebbit |

### Result:

`<number>` - Subscription id \(needed to unsubscribe\)

### Code sample:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "subplebbitUpdateSubscribe",
  "params": [
    {
      "address": "memes.bso"
    }
  ]
}
```

### Response:

```json
{ "jsonrpc": "2.0", "result": 23784, "id": 1 }
```

#### Notification Format:

The notification format is the same as seen in the plebbit-js [Subplebbit Events](https://github.com/plebbit/plebbit-js#subplebbit-events)

`update` event:

```json
{
  "jsonrpc": "2.0",
  "method": "subplebbitUpdateNotification",
  "params": {
    "result": {
      "title": "Memes",
      "description": "Publish memes here",
      "updatedAt": 1689886478
    },
    "event": "update",
    "subscription": 23784
  }
}
```

`updatingstatechange` event:

```json
{
  "jsonrpc": "2.0",
  "method": "subplebbitUpdateNotification",
  "params": {
    "result": "fetching-ipfs",
    "event": "updatingstatechange",
    "subscription": 23784
  }
}
```

## publishComment

Publish a comment and subscribe to receive notifications of the challenge pubsub message received and other publishing state changes

### Parameters:

| Name | Type | Description |
| ---- | ---- | ----------- |
| comment | `Comment` | Comment to publish |

### Result:

`<number>` - Subscription id \(needed to unsubscribe and publishChallengeAnswers\)

### Code sample:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "publishComment",
  "params": [{
    "comment": {
      "title": "Hello",
      "content": "World",
      "author": {"address": "john.bso"},
      "signature": {
        "signature": "...",
        "publicKey": "...",
        "type": "ed25519",
        "signedPropertyNames": ["title", "content", "author"]
      }
    },
    "challengeAnswers": ["some answer"]
  }]
}
```

### Response:

```json
{ "jsonrpc": "2.0", "result": 23784, "id": 1 }
```

#### Notification Format:

The notification format is the same as seen in the plebbit-js [Comment Events](https://github.com/plebbit/plebbit-js#comment-events)

`challenge` event:

```json
{
  "jsonrpc": "2.0",
  "method": "publishCommentNotification",
  "params": {
    "result": {
      "type": "CHALLENGE",
      "challenges": [
        {"type": "text/plain", "challenge": "2+2"},
        {"type": "text/plain", "challenge": "5+5"}
      ]
    },
    "event": "challenge",
    "subscription": 23784
  }
}
```

`challengeverification` event:

```json
{
  "jsonrpc": "2.0",
  "method": "publishCommentNotification",
  "params": {
    "result": {
      "type": "CHALLENGEVERIFICATION",
      "challengeSuccess": true,
      "comment": {
        "title": "Hello",
        "content": "World",
        "author": {"address": "john.bso"},
        "signature": {
          "signature": "...",
          "publicKey": "...",
          "type": "ed25519",
          "signedPropertyNames": ["title", "content", "author"]
        }
      },
      "commentUpdate": {
        "cid": "Qm...",
        "signature": {
          "signature": "...",
          "publicKey": "...",
          "type": "ed25519",
          "signedPropertyNames": ["cid"]
        }
      }
    },
    "event": "challengeverification",
    "subscription": 23784
  }
}
```

## subplebbitsSubscribe

Subscribe to the subplebbits list managed by the plebbit rpc to receive notifications when they change

### Result:

`<number>` - Subscription id \(needed to unsubscribe\)

### Code sample:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "subplebbitsSubscribe",
  "params": []
}
```

### Response:

```json
{ "jsonrpc": "2.0", "result": 23784, "id": 1 }
```

#### Notification Format:

The notification format is the same as seen in the plebbit-js [Plebbit Events](https://github.com/plebbit/plebbit-js#plebbit-events)

`subplebbitschange` event:

```json
{
  "jsonrpc": "2.0",
  "method": "subplebbitsNotification",
  "params": {
    "result": [
      "memes.bso",
      "news.bso"
    ],
    "event": "subplebbitschange",
    "subscription": 23784
  }
}
```

## settingsSubscribe

Subscribe to the plebbit rpc settings to receive notifications when they change

### Result:

`<number>` - Subscription id \(needed to unsubscribe\)

### Code sample:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "settingsSubscribe",
  "params": []
}
```

### Response:

```json
{ "jsonrpc": "2.0", "result": 23784, "id": 1 }
```

#### Notification Format:

The notification format is the same as seen in the plebbit-js [Plebbit Events](https://github.com/plebbit/plebbit-js#plebbit-events)

`settingschange` event:

```json
{
  "jsonrpc": "2.0",
  "method": "settingsNotification",
  "params": {
    "result": {
      "plebbitOptions": {...},
      "challenges": {
        "challenge-name": {...}
      }
    },
    "event": "settingschange",
    "subscription": 23784
  }
}
```

## unsubscribe

Unsubscribe from notifications

### Parameters:

| Name | Type | Description |
| ---- | ---- | ----------- |
| subscriptionId | `number` | id of the account subscription to cancel |

### Result:

`<bool>` - unsubscribe success message

### Code sample:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "unsubscribe",
  "params": [23784]
}
```

### Response:

```json
{ "jsonrpc": "2.0", "result": true, "id": 1 }
```
