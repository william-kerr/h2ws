import { EventEmitter } from 'node:events'
import { Duplex, Readable } from 'node:stream'

import { EMPTY_BUFFER, kStatusCode, NOOP, READY_STATES, type WebSocketBinaryType } from '../constants.js'
import { PerMessageDeflate, type PerMessageDeflateOptions } from '../extensions/permessage-deflate.js'
import { Receiver } from '../protocol/receiver.js'
import { Sender, type SendOptions } from '../protocol/sender.js'
import type { BufferLike } from '../util/buffer.js'

type WebSocketExtensions = {
  [PerMessageDeflate.extensionName]?: PerMessageDeflate
}

const closeTimeout = 30 * 1000

export interface WebSocketOptions {
  /**
   * Control whether 'message', 'ping', and 'pong' events can be emitted
   * multiple times in same tick
   *
   * @default true
   */
  allowSynchronousEvents?: boolean

  /**
   * Automatically send pong in response to ping?
   *
   * @default true
   */
  autoPong?: boolean

  /**
   * Max allowed message length in bytes
   *
   * @default 104857600 (100 MiB)
   */
  maxPayload?: number

  /**
   * Enable permessage-deflate?
   *
   * @default false for server
   */
  perMessageDeflate?: boolean | PerMessageDeflateOptions

  /**
   * Skip UTF-8 validation for text and close messages?
   *
   * @default false
   */
  skipUTF8Validation?: boolean
}

export class WebSocket extends EventEmitter {
  /** Unused */
  static readonly CONNECTING = 0

  /** Connection is open and ready to communicate */
  static readonly OPEN = 1

  /** Connection is in process of closing */
  static readonly CLOSING = 2

  /** Connection is closed (or not yet open) */
  static readonly CLOSED = 3

  /**
   * On Receiver 'resume' event
   *
   * @param stream - Readable stream to resume
   */
  private static resumeStream(stream: Readable): void {
    stream.resume()
  }

  get binaryType(): WebSocketBinaryType {
    return this._binaryType
  }

  set binaryType(type: WebSocketBinaryType) {
    this._binaryType = type

    // Allow to change `binaryType` on the fly
    if (this.receiver) this.receiver.binaryType = type
  }

  get extensions(): WebSocketExtensions {
    return this._extensions
  }

  set extensions(extensions: WebSocketExtensions) {
    this._extensions = extensions
  }

  get isPaused(): boolean {
    return this._paused
  }

  get protocol() {
    return this._protocol
  }

  set protocol(protocol: string) {
    this._protocol = protocol
  }

  get readyState(): number {
    return this._readyState
  }

  get socket(): Duplex | null {
    return this._socket
  }

  get waitingForDrain(): boolean {
    return this._waitingForDrain
  }

  private _readyState: typeof WebSocket.OPEN | typeof WebSocket.CLOSING | typeof WebSocket.CLOSED
  private _protocol: string
  private _binaryType: WebSocketBinaryType
  private _extensions: WebSocketExtensions
  private autoPong: boolean
  private _socket: Duplex | null
  private receiver: Receiver | null
  private sender: Sender | null
  private _paused: boolean
  private _waitingForDrain: boolean
  private closeCode: number
  private closeMessage: Buffer
  private closeFrameReceived: boolean
  private closeFrameSent: boolean
  private closeTimer: NodeJS.Timeout | null
  private errorEmitted: boolean

  private boundSocketOnClose: () => void
  private boundSocketOnData: (chunk: Buffer) => void
  private boundSocketOnDrain: () => void
  private boundSocketOnEnd: () => void
  private boundSocketOnError: (err: Error) => void

  /**
   * @param options - Connection options
   */
  constructor(options: WebSocketOptions = {}) {
    super()

    this._readyState = WebSocket.CLOSED
    this._protocol = ''
    this._binaryType = 'nodebuffer'
    this._extensions = {}
    this._socket = null
    this.receiver = null
    this.sender = null
    this._paused = false
    this._waitingForDrain = false
    this.closeCode = 1006
    this.closeMessage = EMPTY_BUFFER
    this.closeFrameReceived = false
    this.closeFrameSent = false
    this.closeTimer = null
    this.errorEmitted = false
    this.autoPong = options.autoPong ?? true
  }

  /**
   * Set up socket and internal resources
   *
   * @param socket - Network socket between server and client
   * @param head - First packet of upgraded stream
   * @param options - WebSocket options
   */
  setSocket(socket: Duplex, head: Buffer, options: WebSocketOptions): void {
    const receiver = new Receiver(this, {
      allowSynchronousEvents: options.allowSynchronousEvents,
      binaryType: this.binaryType,
      extensions: this._extensions,
      maxPayload: options.maxPayload,
      skipUTF8Validation: options.skipUTF8Validation
    })
    const sender = new Sender(this)

    this._socket = socket
    this.receiver = receiver
    this.sender = sender

    receiver.on('conclude', this.receiverOnConclude.bind(this))
    receiver.on('drain', this.receiverOnDrain.bind(this))
    receiver.on('error', this.receiverOnError.bind(this))
    receiver.on('message', this.receiverOnMessage.bind(this))
    receiver.on('ping', this.receiverOnPing.bind(this))
    receiver.on('pong', this.receiverOnPong.bind(this))

    sender.onerror = this.senderOnError.bind(this)

    // These methods may not be available if `socket` is just a Duplex
    if ((socket as any).setTimeout) (socket as any).setTimeout(0)
    if ((socket as any).setNoDelay) (socket as any).setNoDelay()

    if (head.length > 0) socket.unshift(head)

    this.boundSocketOnClose = this.socketOnClose.bind(this)
    this.boundSocketOnData = this.socketOnData.bind(this)
    this.boundSocketOnDrain = this.socketOnDrain.bind(this)
    this.boundSocketOnEnd = this.socketOnEnd.bind(this)
    this.boundSocketOnError = this.socketOnError.bind(this)

    socket.on('close', this.boundSocketOnClose)
    socket.on('data', this.boundSocketOnData)
    socket.on('drain', this.boundSocketOnDrain)
    socket.on('end', this.boundSocketOnEnd)
    socket.on('error', this.boundSocketOnError)

    this._readyState = WebSocket.OPEN
    this.emit('open')
  }

  /**
   * Mark WebSocket as waiting for underlying socket to drain
   */
  markWaitingForDrain(): void {
    this._waitingForDrain = true
  }

  /**
   * Send data message
   *
   * @param data - Message to send
   * @param options - Send options
   * @param callback - Callback
   */
  send(data: BufferLike | number, options: SendOptions = {}, callback?: (err?: Error) => void): void {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }

    if (typeof data === 'number') data = data.toString()

    if (this._readyState !== WebSocket.OPEN) {
      if (callback) {
        const err = new Error(
          `WebSocket is not open: readyState ${this._readyState} (${READY_STATES[this._readyState]})`
        )
        process.nextTick(callback, err)
      }

      return
    }

    const opts: SendOptions = {
      binary: typeof data !== 'string',
      compress: true,
      fin: true,
      ...options
    }

    if (!this._extensions[PerMessageDeflate.extensionName]) {
      opts.compress = false
    }

    this.sender.send(data || EMPTY_BUFFER, opts, callback)
  }

  /**
   * Send ping
   *
   * @param data - Data to send
   * @param callback - Callback
   */
  ping(data?: BufferLike | number, callback?: () => void): void {
    if (typeof data === 'function') {
      callback = data
      data = undefined
    }

    if (typeof data === 'number') data = data.toString()

    if (this._readyState !== WebSocket.OPEN) {
      if (callback) {
        const err = new Error(
          `WebSocket is not open: readyState ${this._readyState} (${READY_STATES[this._readyState]})`
        )
        process.nextTick(callback, err)
      }

      return
    }

    this.sender.ping(data || EMPTY_BUFFER, callback)
  }

  /**
   * Send pong
   *
   * @param data - Data to send
   * @param callback - Callback
   */
  pong(data?: BufferLike | number, callback?: () => void): void {
    if (typeof data === 'function') {
      callback = data
      data = undefined
    }

    if (typeof data === 'number') data = data.toString()

    if (this._readyState !== WebSocket.OPEN) {
      if (callback) {
        const err = new Error(
          `WebSocket is not open: readyState ${this._readyState} (${READY_STATES[this._readyState]})`
        )
        process.nextTick(callback, err)
      }

      return
    }

    this.sender.pong(data || EMPTY_BUFFER, callback)
  }

  /**
   * Pause socket
   */
  pause(): void {
    if (this._readyState === WebSocket.CLOSED) {
      return
    }

    this._paused = true
    this._socket.pause()
  }

  /**
   * Resume socket
   */
  resume(): void {
    if (this._readyState === WebSocket.CLOSED) {
      return
    }

    this._paused = false
    if (!this.receiver.writableNeedDrain) this._socket.resume()
  }

  /**
   * Start closing handshake
   *
   *          +----------+   +-----------+   +----------+
   *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
   *    |     +----------+   +-----------+   +----------+     |
   *          +----------+   +-----------+         |
   * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
   *          +----------+   +-----------+   |
   *    |           |                        |   +---+        |
   *                +------------------------+-->|fin| - - - -
   *    |         +---+                      |   +---+
   *     - - - - -|fin|<---------------------+
   *              +---+
   *
   * @param code - Status code explaining why connection is closing
   * @param data - Reason why connection is closing
   */
  close(code?: number, data?: string | Buffer): void {
    if (this._readyState === WebSocket.CLOSED) return

    if (this._readyState === WebSocket.CLOSING) {
      if (this.closeFrameSent && (this.closeFrameReceived || this.receiver.error)) {
        this._socket.end()
      }

      return
    }

    this._readyState = WebSocket.CLOSING
    this.sender.close(code, data, (err?: Error | null) => {
      // This error is handled by 'error' listener on socket; only want to know if close frame has been sent here
      if (err) return

      this.closeFrameSent = true

      if (this.closeFrameReceived || this.receiver.error) {
        this._socket.end()
      }
    })

    this.setCloseTimer()
  }

  /**
   * Forcibly close connection
   */
  destroy(): void {
    if (this._readyState === WebSocket.CLOSED) return

    if (this._socket) {
      this._readyState = WebSocket.CLOSING
      this._socket.destroy()
    }
  }

  /**
   * Emit 'close' event
   */
  private emitClose(): void {
    if (!this._socket) {
      this._readyState = WebSocket.CLOSED
      this.emit('close', this.closeCode, this.closeMessage)
      return
    }

    if (this._extensions[PerMessageDeflate.extensionName]) {
      this._extensions[PerMessageDeflate.extensionName].cleanup()
    }

    this.receiver.removeAllListeners()
    this._readyState = WebSocket.CLOSED
    this.emit('close', this.closeCode, this.closeMessage)
  }

  /**
   * Set timer to destroy underlying raw socket of WebSocket
   */
  private setCloseTimer(): void {
    this.closeTimer = setTimeout(this._socket.destroy.bind(this._socket), closeTimeout)
  }

  /**
   * LISTENER CALLBACKS
   */

  /**
   * On Receiver 'conclude' event
   *
   * @param code - Status code
   * @param reason - Reason for closing
   */
  private receiverOnConclude(code: number, reason: Buffer): void {
    this.closeFrameReceived = true
    this.closeMessage = reason
    this.closeCode = code

    this._socket.removeListener('data', this.boundSocketOnData)
    process.nextTick(WebSocket.resumeStream, this._socket)

    if (code === 1005) this.close()
    else this.close(code, reason)
  }

  /**
   * On Receiver 'drain' event
   */
  private receiverOnDrain() {
    if (!this._paused) this._socket.resume()
  }

  /**
   * On Receiver 'error' event
   *
   * @param err - Emitted error
   */
  private receiverOnError(err: RangeError | Error): void {
    this._socket.removeListener('data', this.boundSocketOnData)

    // Node.js < 14.0.0 'error' event is emitted synchronously
    // https://github.com/websockets/ws/issues/1940
    process.nextTick(WebSocket.resumeStream, this._socket)

    this.close(err[kStatusCode])

    if (!this.errorEmitted) {
      this.errorEmitted = true
      this.emit('error', err)
    }
  }

  /**
   * On Receiver 'message' event
   *
   * @param data - Message
   * @param binary - Is message binary?
   */
  private receiverOnMessage(data: Buffer | ArrayBuffer | Buffer[], binary: boolean): void {
    this.emit('message', data, binary)
  }

  /**
   * On Receiver 'ping' event
   *
   * @param data - Data included in ping frame
   */
  private receiverOnPing(data: Buffer): void {
    if (this.autoPong) this.pong(data, NOOP)
    this.emit('ping', data)
  }

  /**
   * On Receiver 'pong' event
   *
   * @param data - Data included in pong frame
   */
  private receiverOnPong(data: Buffer): void {
    this.emit('pong', data)
  }

  /**
   * On Receiver 'finish' event
   */
  private receiverOnFinish() {
    this.emitClose()
  }

  /**
   * On Sender 'error' event
   *
   * @param err - Error
   */
  private senderOnError(err: Error): void {
    if (this._readyState === WebSocket.CLOSED) return
    if (this._readyState === WebSocket.OPEN) {
      this._readyState = WebSocket.CLOSING
      this.setCloseTimer()
    }

    /**
     * socket.end() is used instead of socket.destroy() to allow other peer
     * to finish sending queued data. There is no need to set a timer here
     * because CLOSING means that it is already set or not needed.
     */
    this._socket.end()

    if (!this.errorEmitted) {
      this.errorEmitted = true
      this.emit('error', err)
    }
  }

  /**
   * On socket 'close' event
   */
  private socketOnClose(): void {
    this._socket.removeListener('close', this.boundSocketOnClose)
    this._socket.removeListener('data', this.boundSocketOnData)
    this._socket.removeListener('drain', this.boundSocketOnDrain)
    this._socket.removeListener('end', this.boundSocketOnEnd)

    this._readyState = WebSocket.CLOSING

    let chunk: Buffer | null = null

    /**
     * The close frame might not have been received or the 'end' event emitted,
     * for example, if the socket was destroyed due to an error. Ensure that
     * the receiver stream is closed after writing any remaining buffered data
     * to it. If the readable side of the socket is in flowing mode then there
     * is no buffered data as everything has been already written and
     * readable.read() will return null. If instead, the socket is paused, any
     * possible buffered data will be read as a single chunk.
     */
    if (
      !this._socket.readableEnded &&
      !this.closeFrameReceived &&
      !this.receiver.error &&
      (chunk = this._socket.read()) !== null
    ) {
      this.receiver.write(chunk)
    }

    this.receiver.end()

    clearTimeout(this.closeTimer)

    if (this.receiver.writableFinished || this.receiver.error) {
      this.emitClose()
    } else {
      this.receiver.on('error', this.receiverOnFinish.bind(this))
      this.receiver.on('finish', this.receiverOnFinish.bind(this))
    }
  }

  /**
   * On socket 'data' event
   *
   * @param chunk - Chunk of data
   */
  private socketOnData(chunk: Buffer): void {
    if (!this.receiver.write(chunk)) {
      this._socket.pause()
    }
  }

  /**
   * On socket 'drain' event
   */
  private socketOnDrain(): void {
    this._waitingForDrain = false
    this.sender.dequeue()
  }

  /**
   * On socket 'end' event
   */
  private socketOnEnd(): void {
    this._readyState = WebSocket.CLOSING
    this.receiver.end()
    this._socket.end()
  }

  /**
   * On socket 'error' event
   */
  private socketOnError(_err: Error): void {
    this._socket.removeListener('error', this.boundSocketOnError)
    this._socket.on('error', NOOP)

    this._readyState = WebSocket.CLOSING
    this._socket.destroy()
  }
}
