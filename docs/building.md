#### Build steps

- 1. Create the node build from `./src` to `./dist/node` (`npm run build:node:watch`)
- 2. Create the browser build from `./dist/node` to `./dist/browser` (`npm run build:browser:watch`)
- 3. (For testing only) Create the karma test file bundles from `./test/browser` and `.test/node-and-browser` to `./test-karma-webpack` (`npm run webpack:watch`)

#### 1. Node build

The node build is a simple typescript build from `./src` to `./dist/node` with target ES5 and commonjs modules.

#### 2. Browser build

The browser build is an exact copy of `./dist/node`, but with search and replace `"/runtime/node/"` with `"/runtime/browser/"`. This fixes all errors related to importing packages that don't run in the browser like `fs`, `knex`, captchas, etc. All files that don't run in the browser should be in `./src/runtime/node` and mirrored in `./src/runtime/browser` with non-browser functions and packages removed.

#### 3. Karma test file bundles

The karma test file bundles are built from `./test/browser` and `.test/node-and-browser` to `./test-karma-webpack` using a default webpack 5 and babel 7 preset-env config. Do not add any configuration to the webpack or babel config because the goal is for `pkc-js` to work out of the box without any extra configuration. Polyfills can be added manually to `./src/runtime/browser/polyfills` and code not meant for the browser should be put in `./src/runtime/node`.

Tests in `./test/browser` and `.test/node-and-browser` are run fully in the browser, they cannot use any node code whatsoever. "Node only" tests should be put in `./test/node` and a test server should be run in parallel with a local ipfs node and some test communities that the browser tests can interact with. The test server is in `./test/test-server.js` and can be ran with `npm run test:server`.

##### Importing `pkc-js` in test files

The test files should be written in plain javascript and import the built files from `./dist/node`, not `./src`. The `node-and-browser` test files should still import from `./dist/node` because webpack will automatically replace it with `./dist/browser` (because of the `browser` property in `package.json`).

The test files should import using commonjs (using require(), not ES import) and use the built files in`./dist` because we want our tests to run directly against the production builds to simulate a real user importing `pkc-js`.

#### Browser-only libp2p transports

`./src/runtime/browser/libp2p-extra-transports.ts` is mirrored into the browser build (see step 2 above) and its array is appended to helia's default libp2p transports. It holds `webTransport()` (#475). Keep transports that need browser-only APIs in this file and never import it from Node code: the Node build gets `./src/runtime/node/libp2p-extra-transports.ts`, which is empty.

`webTransport()` was added once before (#85) and removed in May 2026, because the browser IPNS benchmark failed with it (most communities timing out on the first iteration). The benchmark logs from the days after the removal show the same failure without WebTransport, until the libp2p ConnectionMonitor abort fix landed, so that failure was not caused by WebTransport. #475 re-tested WebSockets plus WebTransport against production seeders before adding it back.