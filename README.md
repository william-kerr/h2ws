# Node.js HTTP/2 WebSocket Server

- HTTP/2 (with HTTP/1.1 fallback)
- ESM (with CJS fallback)
- Zero dependencies

## Origin

`h2ws` was forked in 2025 from the popular [websockets/ws](https://github.com/websockets/ws) package.

### Initial Changes

- Added HTTP/2 server support
- Converted CJS JavaScript to ESM TypeScript
- Dropped support for old Node.js versions and isomorphic browser API compatibility
- Removed websocket client functionality

View [releases](https://github.com/william-kerr/h2ws/releases) for more changes.

## Table of Contents

- [Installation](#installation)
- [Usage Examples](#usage-examples)
  - [External HTTP/2 server](#external-http2-server)
  - [Multiple WebSocket servers sharing a single HTTP/2 server](#multiple-websocket-servers-sharing-a-single-http2-server)
- [License](#license)

## Installation

```
npm install h2ws
```

## Usage Examples

- See [examples/server.ts](examples/server.ts) for a working HTTP/2 example.
- Read the original `ws` [README](https://www.npmjs.com/package/ws) for more info.

### External HTTP/2 server

```js
import { readFileSync } from 'fs'
import { createSecureServer } from 'http2'
import { WebSocketServer } from 'h2ws'
// CJS: const { WebSocketServer } = require('h2ws')

const server = createSecureServer({
  allowHTTP1: true, // HTTP/1.1 fallback

  // Browsers usually require HTTPS for HTTP/2
  cert: readFileSync('/path/to/cert.pem'),
  key: readFileSync('/path/to/key.pem')
})

const wss = new WebSocketServer({
  path: '/ws', // ignore paths other than /ws
  server
})

wss.on('connection', (ws) => {
  ws.on('error', console.error)

  ws.on('message', (data) => {
    console.log('received: %s', data)
  })

  ws.send('something')
})

server.listen(443)
```

### Multiple WebSocket servers sharing a single HTTP/2 server

```js
import { createSecureServer } from 'http2'
import { WebSocketServer } from 'h2ws'

const server = createSecureServer({
  // ...
})

const wss1 = new WebSocketServer({ path: '/ws1', server })
const wss2 = new WebSocketServer({ path: '/ws2', server })

wss1.on('connection', (ws) => {
  // ...
})

wss2.on('connection', (ws) => {
  // ...
})

server.listen(443)
```

## License

[MIT](LICENSE)
