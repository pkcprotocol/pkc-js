#### Install

- `npm install`

#### Prepare for tests

- Create a `.env` file and add `CHROME_BIN=/usr/bin/chromium` (replace the path with your chrome path)
- In a new terminal run `npm run build:watch` to compile TypeScript for both the Node and browser bundles (runs `build:node:watch` and `build:browser:watch` in parallel)
- In a new terminal run `npm run test:server:node` to start the IPFS/Kubo node and test communities

#### Tests

The canonical entry point is [`test/run-test-config.js`](../test/run-test-config.js); the `test:*` package.json scripts are thin wrappers around it. Use one of those scripts, or call the runner directly when you want to target a specific file:

```bash
node test/run-test-config.js --pkc-config local-kubo-rpc,remote-pkc-rpc test/node/pkc/pkc.test.ts
```

Pick `--pkc-config` based on test location: `test/node` → `local-kubo-rpc,remote-pkc-rpc`, `test/node-and-browser` → `remote-kubo-rpc,remote-pkc-rpc`.

Common script wrappers:

- `npm run test:node` – all Node tests (and `node-and-browser` shared tests)
- `npm run test:node:rpc` – Node tests over the RPC config
- `npm run test:browser:chrome` / `npm run test:browser:firefox` – browser tests
- `npm test` – the full suite
- `DEBUG="pkc-js*,pkc-react-hooks*" npm test` – tests with debug logs

#### Build

- `npm run build`

> TODO: add a config to run a single test file by name through `npm test`; for now use `--pkc-config ...` arguments to `test/run-test-config.js` directly, or filter with vitest's CLI inside that runner.
