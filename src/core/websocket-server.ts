import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as http from 'node:http'
import * as http2 from 'node:http2'
import * as https from 'node:https'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import type { TLSSocket } from 'node:tls'

import { EMPTY_BUFFER, GUID } from '../constants.js'
import { type ExtensionValue, format as extFormat, parse as extParse } from '../extensions/extension.js'
import { PerMessageDeflate, type PerMessageDeflateOptions } from '../extensions/permessage-deflate.js'
import { parse as subprotocolParse } from '../protocol/subprotocol.js'
import { WebSocket, type WebSocketOptions } from './websocket.js'

type ServerState = 'RUNNING' | 'CLOSING' | 'CLOSED'

type Http2IncomingRequest = {
  headers: http2.IncomingHttpHeaders
  method: string
  url: string
}

export type IncomingRequest = http.IncomingMessage | Http2IncomingRequest

interface VerifyClientInfoArg {
  origin: string | undefined
  req: IncomingRequest
  secure: boolean
}

type VerifyClientSync = (info: VerifyClientInfoArg) => boolean
type VerifyClientAsync = (
  info: VerifyClientInfoArg,
  callback: (verified: boolean, code?: number, message?: string, headers?: http.OutgoingHttpHeaders) => void
) => void

export interface WebSocketServerOptions extends WebSocketOptions {
  /** Max length of queue of pending connections */
  backlog?: number

  /**
   * Track clients?
   *
   * @default true
   */
  clientTracking?: boolean

  /** Hook to handle protocols */
  handleProtocols?: (protocols: Set<string>, request: IncomingRequest) => string | false

  /** Hostname where to bind server */
  host?: string

  /** Enable "no server" mode? */
  noServer?: boolean

  /** Accept only connections matching this path */
  path?: string

  /** Port where to bind server */
  port?: number

  /**
   * Pre-created HTTP/S server to use
   *
   * If path is also specified, this server will only handle HTTP/1.1 upgrade
   * requests or HTTP/2 Extended CONNECT requests matching that path, and ignore
   * all other paths rather than returning status 400
   */
  server?: http.Server | https.Server | http2.Http2Server | http2.Http2SecureServer

  /** Hook to reject connections */
  verifyClient?: VerifyClientSync | VerifyClientAsync
}

export class WebSocketServer extends EventEmitter {
  private readonly kWebSocketAttached = Symbol('webSocketAttached')

  public clients?: Set<WebSocket>

  private server: http.Server | https.Server | http2.Http2Server | http2.Http2SecureServer | null = null
  private state: ServerState
  private removeListeners: (() => void) | null
  private shouldEmitClose: boolean

  /**
   * @param options - Configuration options
   * @param callback - Listener for 'listening' event
   */
  constructor(
    readonly options: WebSocketServerOptions = {},
    callback?: () => void
  ) {
    super()

    const opts: WebSocketServerOptions = {
      allowSynchronousEvents: true,
      clientTracking: true,
      maxPayload: 100 * 1024 * 1024,
      ...options
    }
    this.options = opts

    if (
      (opts.port == null && !opts.server && !opts.noServer) ||
      (opts.port != null && (opts.server || opts.noServer)) ||
      (opts.server && opts.noServer)
    ) {
      throw new TypeError('One and only one of the "port", "server", or "noServer" options must be specified')
    }

    if (opts.port != null) {
      this.server = http.createServer((req, res) => {
        const body = http.STATUS_CODES[426]

        res.writeHead(426, {
          'Content-Length': Buffer.byteLength(body),
          'Content-Type': 'text/plain'
        })
        res.end(body)
      })
      this.server.listen(opts.port, opts.host, opts.backlog, callback)
    } else if (opts.server) {
      this.server = opts.server
    }

    if (this.server) {
      this.removeListeners = this.addListeners(this.server, {
        // HTTP/2 connect -> WebSocket
        connect: (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
          if (isWebSocketConnect(req.headers) && this.shouldHandle(req)) {
            this.handleConnect(res.stream, req.headers, (ws: WebSocket, innerReq: Http2IncomingRequest) =>
              this.emit('connection', ws, innerReq)
            )
          }
        },

        error: (err: Error) => this.emit('error', err),
        listening: this.emit.bind(this, 'listening'),

        session: (ses) => {
          /*
           * RFC 8441 defines an "Extended CONNECT Protocol" extension to
           * HTTP/2 that may be used to bootstrap the use of an Http2Stream
           * using the CONNECT method as a tunnel for other communication
           * protocols (such as WebSockets)
           */
          ses.settings({ enableConnectProtocol: true })
        },

        // HTTP/1.1 upgrade -> WebSocket
        upgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
          if (isWebSocketUpgrade(req.headers) && this.shouldHandle(req)) {
            this.handleUpgrade(req, socket, head, (ws: WebSocket, innerReq: http.IncomingMessage) => {
              this.emit('connection', ws, innerReq)
            })
          }
        }
      })
    }

    if (opts.perMessageDeflate === true) this.options.perMessageDeflate = {}

    if (opts.clientTracking) {
      this.clients = new Set<WebSocket>()
      this.shouldEmitClose = false
    }

    this.state = 'RUNNING'
  }

  /**
   * Return bound address, address family name, and port of server as reported
   * by operating system if listening on an IP socket. If server is listening
   * on a pipe or UNIX domain socket, name is returned as a string   *
   * @returns server address
   */
  address(): AddressInfo | string | null {
    if (this.options.noServer) {
      throw new Error('The server is operating in "noServer" mode')
    }

    if (!this.server) return null
    return this.server.address()
  }

  /**
   * See if given request should be handled by this server instance
   *
   * @param req - Request object to inspect
   * @returns true if the request is valid, else false
   */
  private shouldHandle(req: IncomingRequest): boolean {
    if (this.options.path) {
      const index = req.url.indexOf('?')
      const pathname = index !== -1 ? req.url.slice(0, index) : req.url

      if (pathname !== this.options.path) return false
    }

    return true
  }

  /**
   * Stop server from accepting new connections and emit 'close' event when all
   * existing connections are closed
   *
   * @param callback - One-time listener for 'close' event
   */
  close(callback?: (err?: Error) => void): void {
    if (this.state === 'CLOSED') {
      if (callback) {
        callback(new Error('The server is not running'))
      }

      process.nextTick(() => this.emitClose())
      return
    }

    if (callback) this.once('close', callback)

    if (this.state === 'CLOSING') return
    this.state = 'CLOSING'

    if (this.options.noServer || this.options.server) {
      if (this.server) {
        this.removeListeners()
        this.removeListeners = this.server = null
      }

      if (this.clients) {
        if (!this.clients.size) {
          process.nextTick(() => this.emitClose())
        } else {
          this.shouldEmitClose = true
        }
      } else {
        process.nextTick(() => this.emitClose())
      }
    } else {
      const server = this.server

      this.removeListeners()
      this.removeListeners = this.server = null

      // HTTP/S server was created internally; close it, and rely on its 'close' event
      server.close(() => {
        this.emitClose()
      })
    }
  }

  /**
   * Handle HTTP Upgrade request
   *
   * @param req - Request object
   * @param socket - Network socket between server and client
   * @param head - First packet of upgraded stream
   * @param callback - Callback to emit connection
   */
  handleUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WebSocket, req: http.IncomingMessage) => void
  ): void {
    socket.on('error', WebSocketServer.socketOnError)

    if (!req.headers.host) {
      const message = 'Missing Host header'
      this.abortHandshakeOrEmitwsClientError(req, socket, 400, message)
      return
    }

    const key = req.headers['sec-websocket-key']
    const upgrade = req.headers.upgrade
    const version = +req.headers['sec-websocket-version']

    if (req.method !== 'GET') {
      const message = 'Invalid HTTP method'
      this.abortHandshakeOrEmitwsClientError(req, socket, 405, message)
      return
    }

    if (upgrade === undefined || upgrade.toLowerCase() !== 'websocket') {
      const message = 'Invalid Upgrade header'
      this.abortHandshakeOrEmitwsClientError(req, socket, 400, message)
      return
    }

    if (key === undefined) {
      const message = 'Missing Sec-WebSocket-Key header'
      this.abortHandshakeOrEmitwsClientError(req, socket, 400, message)
      return
    }

    let decodedKey: Buffer
    try {
      decodedKey = Buffer.from(key, 'base64')
    } catch (e) {
      const message = 'Invalid Sec-WebSocket-Key header (not valid base64)'
      this.abortHandshakeOrEmitwsClientError(req, socket, 400, message)
      return
    }

    if (decodedKey.length !== 16) {
      const message = 'Invalid Sec-WebSocket-Key header (decoded length not 16 bytes)'
      this.abortHandshakeOrEmitwsClientError(req, socket, 400, message)
      return
    }

    if (version !== 8 && version !== 13) {
      const message = 'Missing or invalid Sec-WebSocket-Version header'
      this.abortHandshakeOrEmitwsClientError(req, socket, 426, message, {
        'Sec-WebSocket-Version': '13, 8'
      })
      return
    }

    if (!this.shouldHandle(req)) {
      this.abortHandshake(socket, 400)
      return
    }

    const secWebSocketProtocol = req.headers['sec-websocket-protocol']
    let protocols = new Set<string>()

    if (secWebSocketProtocol !== undefined) {
      try {
        protocols = subprotocolParse(secWebSocketProtocol)
      } catch (err) {
        const message = 'Invalid Sec-WebSocket-Protocol header'
        this.abortHandshakeOrEmitwsClientError(req, socket, 400, message)
        return
      }
    }

    const secWebSocketExtensions = req.headers['sec-websocket-extensions']
    const extensions: { [key: string]: PerMessageDeflate } = {}

    if (this.options.perMessageDeflate && secWebSocketExtensions !== undefined) {
      const perMessageDeflate = new PerMessageDeflate(
        this.options.perMessageDeflate as PerMessageDeflateOptions,
        this.options.maxPayload
      )

      try {
        const offers = extParse(secWebSocketExtensions)

        if (offers[PerMessageDeflate.extensionName]) {
          perMessageDeflate.accept(offers[PerMessageDeflate.extensionName])
          extensions[PerMessageDeflate.extensionName] = perMessageDeflate
        }
      } catch (err) {
        const message = 'Invalid or unacceptable Sec-WebSocket-Extensions header'
        this.abortHandshakeOrEmitwsClientError(req, socket, 400, message)
        return
      }
    }

    // Optionally call external client verification handler
    if (this.options.verifyClient) {
      const info: VerifyClientInfoArg = {
        origin: req.headers[`${version === 8 ? 'sec-websocket-origin' : 'origin'}`] as string,
        req,
        secure: !!((socket as TLSSocket).authorized || (socket as TLSSocket).encrypted) // is TLS / SSL secured
      }

      const verifyClientFn = this.options.verifyClient
      if (verifyClientFn.length === 2) {
        ;(verifyClientFn as VerifyClientAsync)(info, (verified, code, message, headers) => {
          if (!verified) {
            return this.abortHandshake(socket, code || 401, message, headers)
          }

          this.completeUpgrade(extensions, key, protocols, req, socket, head, callback)
        })
        return
      }

      if (!(verifyClientFn as VerifyClientSync)(info))
        return this.abortHandshake(socket, 401, 'Client verification failed')
    }

    this.completeUpgrade(extensions, key, protocols, req, socket, head, callback)
  }

  /**
   * Upgrade connection to WebSocket
   *
   * @param extensions - Accepted extensions
   * @param key - Value of 'Sec-WebSocket-Key' header
   * @param protocols - Subprotocols
   * @param req - Request object
   * @param socket - Network socket between server and client
   * @param head - First packet of upgraded stream
   * @param callback - Callback to emit connection
   */
  private completeUpgrade(
    extensions: { [key: string]: PerMessageDeflate },
    key: string,
    protocols: Set<string>,
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WebSocket, req: http.IncomingMessage) => void
  ): void {
    // Destroy socket if client has already sent FIN packet, or if socket is already unusable
    if (!socket.readable || !socket.writable) {
      socket.destroy()
      return
    }

    if (socket[this.kWebSocketAttached]) {
      throw new Error(
        'server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration'
      )
    }

    if (this.state === 'CLOSING' || this.state === 'CLOSED') {
      this.abortHandshake(socket, 503)
      return
    }

    socket[this.kWebSocketAttached] = true

    const digest = createHash('sha1')
      .update(key + GUID)
      .digest('base64')

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${digest}`
    ]

    const ws = new WebSocket({
      allowSynchronousEvents: this.options.allowSynchronousEvents,
      autoPong: this.options.autoPong,
      maxPayload: this.options.maxPayload,
      skipUTF8Validation: this.options.skipUTF8Validation
    })

    if (protocols.size) {
      // Optionally call external protocol selection handler
      const protocol: string | false = this.options.handleProtocols
        ? this.options.handleProtocols(protocols, req)
        : protocols.values().next().value

      if (protocol) {
        headers.push(`Sec-WebSocket-Protocol: ${protocol}`)
        ws.protocol = protocol
      }
    }

    const pmdExtension = extensions[PerMessageDeflate.extensionName]
    if (pmdExtension) {
      const params = pmdExtension.params

      const value = extFormat({ [PerMessageDeflate.extensionName]: [params as ExtensionValue] })
      headers.push(`Sec-WebSocket-Extensions: ${value}`)
      ws.extensions = extensions
    }

    // Allow external modification/inspection of handshake headers.
    this.emit('headers', headers, req)

    socket.write(headers.concat('\r\n').join('\r\n'))
    socket.removeListener('error', WebSocketServer.socketOnError)

    ws.setSocket(socket, head, {
      allowSynchronousEvents: this.options.allowSynchronousEvents,
      maxPayload: this.options.maxPayload,
      skipUTF8Validation: this.options.skipUTF8Validation
    })

    ws.once('close', () => {
      delete socket[this.kWebSocketAttached]
    })

    if (this.clients) {
      this.clients.add(ws)
      ws.on('close', () => {
        this.clients.delete(ws)

        if (this.shouldEmitClose && !this.clients.size) {
          process.nextTick(() => this.emitClose())
        }
      })
    }

    callback(ws, req)
  }

  /**
   * Emit 'wsClientError' event on a WebSocketServer if there is at least one
   * listener for it, otherwise call abortHandshake()
   *
   * @param server - WebSocket server
   * @param req - Request object
   * @param socket - Socket of upgrade request
   * @param code - HTTP response status code
   * @param message - HTTP response body
   */
  private abortHandshakeOrEmitwsClientError(
    req: http.IncomingMessage,
    socket: Duplex,
    code: number,
    message: string,
    headers?: http.OutgoingHttpHeaders
  ): void {
    if (this.listenerCount('wsClientError')) {
      const err = new Error(message)
      Error.captureStackTrace(err, this.abortHandshakeOrEmitwsClientError)

      this.emit('wsClientError', err, socket, req)
    } else {
      this.abortHandshake(socket, code, message, headers)
    }
  }

  /**
   * Close connection when preconditions are not fulfilled
   *
   * @param socket - Socket of upgrade request
   * @param code - HTTP response status code
   * @param message - HTTP response body
   * @param headers - Additional HTTP response headers
   */
  private abortHandshake(socket: Duplex, code: number, message?: string, headers?: http.OutgoingHttpHeaders): void {
    /**
     * Socket is writable unless user destroyed or ended it before calling
     * server.handleUpgrade() or in verifyClient function, which is a user
     * error. Handling this does not make much sense as worst that can happen
     * is that some of data written by user might be discarded due to call to
     * socket.end() below, which triggers an 'error' event that in turn causes
     * socket to be destroyed.
     */
    message = message || http.STATUS_CODES[code]
    const resHeaders: http.OutgoingHttpHeaders = {
      Connection: 'close',
      'Content-Length': Buffer.byteLength(message),
      'Content-Type': 'text/html',
      ...headers
    }

    socket.once('finish', socket.destroy)

    if (socket.writable) {
      const statusLine = `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\n`
      const headerLines = Object.entries(resHeaders)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n')

      socket.end(statusLine + headerLines + '\r\n\r\n' + message)
    } else {
      socket.destroy()
    }
  }

  /**
   * Handle established HTTP/2 stream Extended CONNECT request (RFC 8441)
   * intended to bootstrap WebSocket connection
   *
   * 1. Perform WebSocket handshake validation using provided headers
   * 2. If successful, create WebSocket instance over stream and invoke callback
   *
   * @param stream - HTTP/2 stream
   * @param headers - Headers from CONNECT request, used for WebSocket handshake validation
   * @param callback - Callback to emit connection
   */
  handleConnect(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
    callback: (ws: WebSocket, req: Http2IncomingRequest) => void
  ): void {
    if (headers[':method'] !== 'CONNECT') {
      return this.abortConnect(stream, 405, 'Method Not Allowed')
    }

    if (headers[':protocol'] !== 'websocket') {
      return this.abortConnect(stream, 400, 'Bad Request: Invalid or missing ":protocol" header for WebSocket')
    }

    if (!headers[':scheme'] || !headers[':path']) {
      return this.abortConnect(stream, 400, 'Bad Request: ":scheme" and ":path" headers are required')
    }

    if (!headers[':authority']) {
      return this.abortConnect(stream, 400, 'Bad Request: ":authority" header is required')
    }

    if (headers['upgrade'] || headers['connection'] || headers['sec-websocket-key']) {
      return this.abortConnect(stream, 400, 'Bad Request: Connection-specific headers are not allowed in HTTP/2')
    }

    const version = headers['sec-websocket-version'] ? +headers['sec-websocket-version'] : NaN
    if (version !== 8 && version !== 13) {
      return this.abortConnect(stream, 426, 'Upgrade Required', {
        'sec-websocket-version': '13, 8'
      })
    }

    // Mimic parts of http.IncomingMessage interface needed for validation helpers
    const pseudoReq: Http2IncomingRequest = {
      headers,
      method: headers[':method'],
      url: headers[':path']
    }

    if (!this.shouldHandle(pseudoReq)) {
      return this.abortConnect(stream, 400)
    }

    const secWebSocketProtocol = headers['sec-websocket-protocol']
    let protocols = new Set<string>()
    if (secWebSocketProtocol !== undefined) {
      try {
        protocols = subprotocolParse(secWebSocketProtocol)
      } catch (err) {
        const message = 'Invalid Sec-WebSocket-Protocol header'
        return this.abortConnectOrEmitwsClientError(pseudoReq, stream, 400, message)
      }
    }

    const secWebSocketExtensions = headers['sec-websocket-extensions']
    const extensions: { [key: string]: PerMessageDeflate } = {}
    if (this.options.perMessageDeflate && secWebSocketExtensions !== undefined) {
      const perMessageDeflate = new PerMessageDeflate(
        this.options.perMessageDeflate as PerMessageDeflateOptions,
        this.options.maxPayload
      )

      try {
        const offers = extParse(secWebSocketExtensions)
        if (offers[PerMessageDeflate.extensionName]) {
          perMessageDeflate.accept(offers[PerMessageDeflate.extensionName])
          extensions[PerMessageDeflate.extensionName] = perMessageDeflate
        }
      } catch (err) {
        const message = 'Invalid Sec-WebSocket-Extensions header'
        return this.abortConnectOrEmitwsClientError(pseudoReq, stream, 400, message)
      }
    }

    // Optionally call external client verification handler
    if (this.options.verifyClient) {
      const info: VerifyClientInfoArg = {
        origin: headers['origin'],
        req: pseudoReq,
        secure: !!(stream.session.socket as TLSSocket).encrypted // is TLS / SSL secured
      }

      const verifyClientFn = this.options.verifyClient
      if (verifyClientFn.length === 2) {
        ;(verifyClientFn as VerifyClientAsync)(info, (verified, code, message, responseHeaders) => {
          if (!verified) {
            return this.abortConnect(stream, code || 401, message, responseHeaders)
          }
          this.completeConnect(extensions, protocols, pseudoReq, stream, callback)
        })
        return
      }

      if (!(verifyClientFn as VerifyClientSync)(info)) {
        return this.abortConnect(stream, 401, 'Client verification failed')
      }
    }

    this.completeConnect(extensions, protocols, pseudoReq, stream, callback)
  }

  /**
   * Finalize WebSocket connection over HTTP/2 after successful validation
   *
   * Send 200 OK response and set up WebSocket instance
   *
   * @param extensions - Accepted extensions
   * @param protocols - Available subprotocols
   * @param req - HTTP/2 pseudo-request object
   * @param stream - HTTP/2 stream
   * @param callback - Callback to emit connection
   */
  private completeConnect(
    extensions: { [key: string]: PerMessageDeflate },
    protocols: Set<string>,
    req: Http2IncomingRequest,
    stream: http2.ServerHttp2Stream,
    callback: (ws: WebSocket, req: Http2IncomingRequest) => void
  ): void {
    if (stream.destroyed || stream.closed) {
      // Stream already closed, can't proceed
      return
    }

    if (stream[this.kWebSocketAttached]) {
      throw new Error(
        'server.handleConnect() was called more than once with the same stream, possibly due to a misconfiguration'
      )
    }

    if (this.state === 'CLOSING' || this.state === 'CLOSED') {
      this.abortConnect(stream, 503, 'Service Unavailable')
      return
    }

    stream[this.kWebSocketAttached] = true

    const responseHeaders: http.OutgoingHttpHeaders = {
      ':status': 200
    }

    const wsOptions: WebSocketOptions = {
      allowSynchronousEvents: this.options.allowSynchronousEvents,
      autoPong: this.options.autoPong,
      maxPayload: this.options.maxPayload,
      skipUTF8Validation: this.options.skipUTF8Validation
    }

    const ws = new WebSocket(wsOptions)

    if (protocols.size) {
      const selectedProtocol: string | false = this.options.handleProtocols
        ? this.options.handleProtocols(protocols, req)
        : protocols.values().next().value

      if (selectedProtocol) {
        responseHeaders['sec-websocket-protocol'] = selectedProtocol
        ws.protocol = selectedProtocol
      }
    }

    const pmdExtension = extensions[PerMessageDeflate.extensionName]
    if (pmdExtension) {
      const params = pmdExtension.params
      const value = extFormat({ [PerMessageDeflate.extensionName]: [params as ExtensionValue] })
      responseHeaders['sec-websocket-extensions'] = value
      ws.extensions = extensions
    }

    // Allow external modification / inspection of response headers
    this.emit('headers', responseHeaders, req)

    stream.respond(responseHeaders)

    // Set stream as socket
    ws.setSocket(stream, EMPTY_BUFFER, wsOptions)

    ws.once('close', () => {
      delete stream[this.kWebSocketAttached]
    })

    if (this.clients) {
      this.clients.add(ws)
      ws.on('close', () => {
        this.clients.delete(ws)
        if (this.shouldEmitClose && !this.clients.size) {
          process.nextTick(() => this.emitClose())
        }
      })
    }

    callback(ws, req)
  }

  /**
   * Emit 'wsClientError' event on a WebSocketServer if there is at least one
   * listener for it, otherwise call abortConnect()
   *
   * @param req - HTTP/2 pseudo-request object
   * @param stream - HTTP/2 stream
   * @param code - HTTP response status code
   * @param message - Error message
   * @param headers - Additional HTTP response headers
   */
  private abortConnectOrEmitwsClientError(
    req: Http2IncomingRequest,
    stream: http2.ServerHttp2Stream,
    code: number,
    message: string,
    headers?: http.OutgoingHttpHeaders
  ): void {
    if (this.listenerCount('wsClientError')) {
      const err = new Error(message)
      Error.captureStackTrace(err, this.abortConnectOrEmitwsClientError)

      this.emit('wsClientError', err, stream, req)
    } else {
      this.abortConnect(stream, code, message, headers)
    }
  }

  /**
   * Abort WebSocket connection attempt over HTTP/2 by sending error response
   *
   * @param stream - HTTP/2 stream
   * @param code - HTTP response status code
   * @param message - Optional reason phrase (may not be sent over HTTP/2)
   * @param headers - Additional HTTP response headers
   */
  private abortConnect(
    stream: http2.ServerHttp2Stream,
    code: number,
    message?: string,
    headers?: http.OutgoingHttpHeaders
  ): void {
    if (stream.destroyed || stream.closed || stream.headersSent) {
      return // cannot send response if already closed or headers sent
    }

    const responseHeaders: http.OutgoingHttpHeaders = {
      ...headers,
      ':status': code
    }
    const responseMessage = message || http.STATUS_CODES[code] || String(code)

    stream.respond(responseHeaders)
    stream.end(responseMessage)
  }

  /**
   * Add event listeners on EventEmitter using map of <event, listener> pairs
   *
   * @param server - Event emitter
   * @param map - Listeners to add
   * @returns function that will remove added listeners when called
   */
  private addListeners(emitter: EventEmitter, map: Record<string, (...args: any[]) => void>): () => void {
    for (const [event, listener] of Object.entries(map)) {
      emitter.on(event, listener)
    }

    return () => {
      for (const [event, listener] of Object.entries(map)) {
        emitter.removeListener(event, listener)
      }
    }
  }

  /**
   * Emit 'close' event on WebSocketServer and set state to CLOSED
   */
  private emitClose(): void {
    this.state = 'CLOSED'
    this.emit('close')
  }

  /**
   * Handle premature socket errors during upgrade
   */
  private static socketOnError(this: Duplex): void {
    this.destroy()
  }
}

/**
 * Perform minimal check to identify if HTTP/1.1 headers suggest WebSocket
 * connection request by examining 'Upgrade' header (RFC 6455)
 *
 * @param headers - Incoming HTTP/1.1 request headers
 * @returns true for upgrade request for WebSocket connection, false otherwise
 */
export function isWebSocketUpgrade(headers: http.IncomingHttpHeaders): boolean {
  return headers.upgrade?.toLowerCase() === 'websocket'
}

/**
 * Perform minimal check to identify if HTTP/2 headers suggest WebSocket
 * connection request using Extended CONNECT method (RFC 8441)
 *
 * @param headers - Incoming HTTP/2 request headers
 * @returns true for CONNECT request for WebSocket connection, false otherwise
 */
export function isWebSocketConnect(headers: http2.IncomingHttpHeaders): boolean {
  return headers[':method'] === 'CONNECT' && headers[':protocol'] === 'websocket'
}
