#### Install

- `npm install`

#### Preapre for tests

- Create a `.env` file and add `CHROME_BIN=/usr/bin/chromium` (replace the path with your chrome path)
- In a new terminal run `npm run build:watch` to compile typescript
- In a new terminal run `npm run webpack:watch` to compile the browser tests
- In a new terminal run `npm run test:server` to start an ipfs node and the test subplebbits
- (Optional) run all the scripts at the same time with `scripts/build-watch-all`

> Note: tests are written in Javascript (using commonjs `require`, not `import`), to test the Typescript ouput from commonjs.

#### Tests

- `npm run test:node` for node tests and node-and-browser tests
- `npm run test:browser` for browser tests and node-and-browser tests
- `npm test` for all tests
- `DEBUG="pkc-js*,pkc-react-hooks*" npm test` for tests with logs

#### Build

- `npm run build`

> TODO: add config to to run a single file when doing `npm run test file-name`, for now to run a single file use `describe.only()` and `it.only()` in tests files.
