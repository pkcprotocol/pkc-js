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