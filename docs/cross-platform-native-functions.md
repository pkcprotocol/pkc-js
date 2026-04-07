# Cross platform native functions

`pkc-js` is written entirely in Javascript and can run in the browser. Some pkc functionalities require native functions like the file system and native HTTP requests. Electron and Android WebView allow injecting native functions into the browser renderer. Example:

```javascript
import Pkc from '@pkc/pkc-js'

const nativeFunctions = {
  fetch: async () => {},
  listCommunities: async () => {},
  // ...no need to override all native functions
}

Pkc.setNativeFunctions(nativeFunctions)
```

# NativeFunctions API

- `nativeFunctions.fetch(url: string, fetchOptions: FetchOptions)`
- `nativeFunctions.listCommunities()`
- `nativeFunctions.deleteCommunity(communityAddress: string)`
- `nativeFunctions.createIpfsClient(ipfsHttpClientOptions: IpfsHttpClientOptions)`

# TODO

- Define SQL native functions to be able to run a community on Android
