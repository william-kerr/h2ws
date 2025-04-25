import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  createSecureServer,
  type Http2ServerRequest,
  type Http2ServerResponse,
  type SecureServerOptions
} from 'node:http2'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type IncomingRequest, WebSocket, WebSocketServer, type WebSocketServerOptions } from '../src/index.js' // 'h2ws'

/**
 * Usage:
 *
 * 1. Follow ssl/README.md
 * 2. Run tsx examples/server.ts
 * 3. Visit https://localhost:443/ and open DevTools
 * 4. Press Ctrl-C to start shutting down server
 * 5. Close browser to terminate connections so server can fully exit
 */

const __dirname = dirname(fileURLToPath(import.meta.url))

const html = readFileSync(join(__dirname, 'index.html'))

const http2Options: SecureServerOptions = {
  allowHTTP1: true, // HTTP/1.1 fallback

  // Browsers usually require HTTPS for HTTP/2
  cert: readFileSync(join(__dirname, 'ssl', 'example.crt')),
  key: readFileSync(join(__dirname, 'ssl', 'example.key'))
}
const server = createSecureServer(
  http2Options,
  (req: IncomingMessage | Http2ServerRequest, res: ServerResponse | Http2ServerResponse) => {
    if (req.url === '/') {
      res.writeHead(200, {
        'Content-Length': Buffer.byteLength(html),
        'Content-Type': 'text/html'
      })
      res.end(html)
    } else {
      res.writeHead(404).end()
    }
  }
)

const wsOptions: WebSocketServerOptions = {
  path: '/ws', // ignore paths other than /ws
  server
}
const wss = new WebSocketServer(wsOptions)

wss.on('connection', (ws: WebSocket, req: IncomingRequest) => {
  ws.on('message', (message: string, binary: boolean) => {
    console.log(`Received message: ${message}`)

    // Send to client
    ws.send('Hello from server', { binary: false })
  })

  ws.on('error', (err) => {
    console.error(err.message)
  })
})

// Start server
server.listen(443, () => {
  console.log(`Server listening on https://localhost:443/`)
})

let isShuttingDown = false

// Shutdown server gracefully
function shutdown() {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log('Server shutting down, close browser to terminate connections')

  // Stop accepting new WebSocket connections
  wss.close((err) => {
    if (err) console.warn(err)

    console.log('WebSocket connections closed')

    // Stop server from accepting new connections
    if (server.listening) {
      server.close((err) => {
        if (err) console.warn(err)

        console.log('Server connections closed')
      })
    }
  })

  // Close WebSocket connections gracefully
  for (const ws of wss.clients) {
    ws.close(1001, 'Server Shutting Down')
  }
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown) // Ctrl+C
