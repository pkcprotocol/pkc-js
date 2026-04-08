### How to resolve `.bso` domain names for communities and authors

Name resolution in pkc-js is plugin-based. The core library does not perform DNS/ENS lookups directly — external resolver packages handle the actual TXT record queries.

#### DNS TXT Record Format

Communities and authors using `.bso` domains set a single `bitsocial` TXT record:

- **Key:** `bitsocial`
- **Value:** `<ipnsPublicKey>` (e.g., `12D3KooWNvSZn...`)

This single record replaces the old two-record approach (`subplebbit-address` + `plebbit-author-address`). Since communities and author profiles share the same IPNS record type, one record is sufficient.

The value format supports optional key-value extensions: `<ipnsPublicKey>[;key=value;other=value]`

#### Setup with `@bitsocial/bso-resolver`

Install the resolver package:

```bash
npm install @bitsocial/bso-resolver
```

Wire it into pkc-js via `nameResolvers`:

```ts
import Pkc from "@pkcprotocol/pkc-js";
import { BsoResolver } from "@bitsocial/bso-resolver";

// Create resolver instances — one per chain provider URL
const chainProviderUrls = [
  "viem", // uses viem's default public transport
  "https://mainnet.infura.io/v3/YOUR_KEY",
];

const resolvers = chainProviderUrls.map(
  (url) => new BsoResolver({ key: `bso-${url}`, provider: url })
);

const pkc = await Pkc({ nameResolvers: resolvers });
```

The resolver handles:
- Looking up `bitsocial` TXT records via ENS on Ethereum mainnet
- Caching results (SQLite on Node, IndexedDB in browser, 1-hour TTL)
- `.bso` domain detection via `canResolve()`

See the full API at https://github.com/bitsocialhq/bso-resolver.

#### How Resolution Works Inside pkc-js

When pkc-js needs to resolve a domain (e.g., `example.bso`), it calls each configured resolver's `canResolve({ name })` method. The first resolver that returns `true` is used to call `resolve({ name })`, which returns `{ publicKey: "12D3KooW..." }` or `undefined` if not found.

The resolver interface (`NameResolverSchema` in `src/schema.ts`):

```ts
{
  key: string;             // unique identifier (e.g., "bso-viem")
  resolve: (opts: { name: string; provider: string; abortSignal?: AbortSignal }) =>
    Promise<{ publicKey: string; [key: string]: string } | undefined>;
  canResolve: (opts: { name: string }) => boolean;
  provider: string;        // RPC URL or "viem"
  dataPath?: string;       // optional — enables persistent cache on Node
}
```

#### Migrating from Old DNS Records

If you have existing `.bso` or `.eth` domains with the old TXT records:

1. **Remove** the `subplebbit-address` TXT record
2. **Remove** the `plebbit-author-address` TXT record
3. **Add** a `bitsocial` TXT record with the IPNS public key as the value

Whether resolver plugins support the old record names during a transition period is a resolver-level decision. Check your resolver package's documentation for backward compatibility details.

#### RPC Configuration

When using pkc-js as an RPC client, name resolvers are configured on the **server** side. RPC clients pass domain names to the server, which resolves them using its own configured resolvers. RPC clients do not need `nameResolvers` in their options.
