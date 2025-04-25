import { EMPTY_BUFFER, FIN, NOOP, RSV1, WebSocketOpcode } from '../constants.js'
import type { WebSocket } from '../core/websocket.js'
import { PerMessageDeflate } from '../extensions/permessage-deflate.js'
import { type BufferLike, toBuffer } from '../util/buffer.js'
import { isValidStatusCode } from './validation.js'

export interface SendOptions {
  /** Is data binary or text? */
  binary?: boolean

  /** Should data be compressed? */
  compress?: boolean

  /** Is fragment the last one? */
  fin?: boolean
}

interface FrameOptions {
  /** Set FIN bit? */
  fin: boolean

  /** Opcode */
  opcode: WebSocketOpcode

  /** Set RSV1 bit? */
  rsv1: boolean

  byteLength?: number
}

type EnqueueParamsTuple = [
  /** params[0]: Function to call */
  (
    data: Buffer | string,
    compress: boolean,
    options: FrameOptions,
    callback: ((err?: Error | null) => void) | undefined
  ) => void,
  /** params[1]: Data payload */
  Buffer | string,
  /** params[2]: Compress flag */
  boolean,
  /** params[3]: Options object */
  FrameOptions,
  /** params[4]: Callback */
  ((err?: Error | null) => void) | undefined
]

type SenderState = 'DEFAULT' | 'DEFLATING'

/**
 * HyBi Sender implementation
 */
export class Sender {
  onerror: (err: Error) => void
  bufferedBytes: number

  private state: SenderState
  private queue: EnqueueParamsTuple[]
  private firstFragment: boolean
  private compress: boolean

  /**
   * @param webSocket - WebSocket instance Sender belongs to
   */
  constructor(private readonly webSocket: WebSocket) {
    this.state = 'DEFAULT'
    this.queue = []
    this.bufferedBytes = 0
    this.firstFragment = true
    this.compress = false
    this.onerror = NOOP
  }

  /**
   * Frame piece of data according to HyBi WebSocket protocol
   *
   * @param data - Data to frame
   * @param options - Frame options
   * @return framed data
   */
  static frame(data: Buffer | string, options: FrameOptions): (Buffer | string)[] {
    let dataLength: number

    if (typeof data === 'string') {
      if (options.byteLength !== undefined) {
        dataLength = options.byteLength
      } else {
        data = Buffer.from(data)
        dataLength = data.length
      }
    } else {
      dataLength = data.length
    }

    let offset = 2
    let payloadLength = dataLength

    if (dataLength >= 65536) {
      offset += 8
      payloadLength = 127
    } else if (dataLength > 125) {
      offset += 2
      payloadLength = 126
    }

    const header = Buffer.allocUnsafe(offset)

    header[0] = options.fin ? options.opcode | FIN : options.opcode
    if (options.rsv1) header[0] |= RSV1

    header[1] = payloadLength

    if (payloadLength === 126) {
      header.writeUInt16BE(dataLength, 2)
    } else if (payloadLength === 127) {
      header[2] = header[3] = 0
      header.writeUIntBE(dataLength, 4, 6)
    }

    return [header, data]
  }

  /**
   * Send close message to other peer
   *
   * @param code - Status code component of body
   * @param data - Message component of body
   * @param callback - Callback
   */
  close(
    code: number | undefined,
    data: string | Buffer | undefined,
    callback: ((err?: Error | null) => void) | undefined
  ): void {
    let buf: Buffer

    if (code === undefined) {
      buf = EMPTY_BUFFER
    } else if (typeof code !== 'number' || !isValidStatusCode(code)) {
      throw new TypeError('First argument must be a valid error code number')
    } else if (data === undefined || !data.length) {
      buf = Buffer.allocUnsafe(2)
      buf.writeUInt16BE(code, 0)
    } else {
      const length = Buffer.byteLength(data)

      if (length > 123) {
        throw new RangeError('The message must not be greater than 123 bytes')
      }

      buf = Buffer.allocUnsafe(2 + length)
      buf.writeUInt16BE(code, 0)

      if (typeof data === 'string') {
        buf.write(data, 2)
      } else {
        buf.set(data, 2)
      }
    }

    const opts: FrameOptions = {
      byteLength: buf.length,
      fin: true,
      opcode: WebSocketOpcode.CLOSE,
      rsv1: false
    }

    if (this.state !== 'DEFAULT') {
      this.enqueue([this.dispatch, buf, false, opts, callback])
    } else {
      this.sendFrame(Sender.frame(buf, opts), callback)
    }
  }

  /**
   * Send ping message to other peer
   *
   * @param data - Message to send
   * @param callback - Callback
   */
  ping(data: BufferLike | undefined, callback: ((err?: Error | null) => void) | undefined): void {
    let byteLength: number

    if (typeof data === 'string') {
      byteLength = Buffer.byteLength(data)
    } else {
      data = toBuffer(data)
      byteLength = (data as Buffer).length
    }

    if (byteLength > 125) {
      throw new RangeError('The data size must not be greater than 125 bytes')
    }

    const opts: FrameOptions = {
      byteLength,
      fin: true,
      opcode: WebSocketOpcode.PING,
      rsv1: false
    }

    if (this.state !== 'DEFAULT') {
      this.enqueue([this.dispatch, data as Buffer | string, false, opts, callback])
    } else {
      this.sendFrame(Sender.frame(data as Buffer | string, opts), callback)
    }
  }

  /**
   * Send pong message to other peer
   *
   * @param data - Message to send
   * @param callback - Callback
   */
  pong(data: BufferLike | undefined, callback: ((err?: Error | null) => void) | undefined): void {
    let byteLength: number

    if (typeof data === 'string') {
      byteLength = Buffer.byteLength(data)
    } else {
      data = toBuffer(data)
      byteLength = (data as Buffer).length
    }

    if (byteLength > 125) {
      throw new RangeError('The data size must not be greater than 125 bytes')
    }

    const opts: FrameOptions = {
      byteLength,
      fin: true,
      opcode: WebSocketOpcode.PONG,
      rsv1: false
    }

    if (this.state !== 'DEFAULT') {
      this.enqueue([this.dispatch, data as Buffer | string, false, opts, callback])
    } else {
      this.sendFrame(Sender.frame(data as Buffer | string, opts), callback)
    }
  }

  /**
   * Send data message to other peer
   *
   * @param data - Message to send
   * @param options - Send options
   * @param callback - Callback
   */
  send(data: BufferLike, options: SendOptions = {}, callback: ((err?: Error | null) => void) | undefined): void {
    const perMessageDeflate = this.webSocket.extensions[PerMessageDeflate.extensionName]
    let opcode = options.binary ? WebSocketOpcode.BINARY : WebSocketOpcode.TEXT
    let rsv1 = options.compress

    let byteLength: number

    if (typeof data === 'string') {
      byteLength = Buffer.byteLength(data)
    } else {
      data = toBuffer(data)
      byteLength = (data as Buffer).length
    }

    if (this.firstFragment) {
      this.firstFragment = false
      if (rsv1 && perMessageDeflate && perMessageDeflate.params['server_no_context_takeover']) {
        rsv1 = byteLength >= perMessageDeflate.threshold
      }
      this.compress = rsv1
    } else {
      rsv1 = false
      opcode = WebSocketOpcode.CONTINUATION
    }

    if (options.fin) this.firstFragment = true

    const opts: FrameOptions = {
      byteLength,
      fin: options.fin,
      opcode,
      rsv1
    }

    if (this.state !== 'DEFAULT') {
      this.enqueue([this.dispatch, data as Buffer | string, this.compress, opts, callback])
    } else {
      this.dispatch(data as Buffer | string, this.compress, opts, callback)
    }
  }

  /**
   * Dispatch message
   *
   * @param data - Message to send
   * @param compress - Compress data?
   * @param options - Frame options
   * @param callback - Callback
   */
  private dispatch(
    data: Buffer | string,
    compress = false,
    options: FrameOptions,
    callback: ((err?: Error | null) => void) | undefined
  ): void {
    if (!compress) {
      this.sendFrame(Sender.frame(data, options), callback)
      return
    }

    const perMessageDeflate = this.webSocket.extensions[PerMessageDeflate.extensionName]

    this.bufferedBytes += options.byteLength
    this.state = 'DEFLATING'
    perMessageDeflate.compress(data, options.fin, (_, buf: Buffer) => {
      if (this.webSocket.socket.destroyed) {
        const err = new Error('The socket was closed while data was being compressed')

        this.callCallbacks(err, callback)
        return
      }

      this.bufferedBytes -= options.byteLength
      this.state = 'DEFAULT'
      this.sendFrame(Sender.frame(buf, options), callback)
      this.dequeue()
    })
  }

  /**
   * Execute queued send operations
   */
  dequeue(): void {
    while (this.state === 'DEFAULT' && !this.webSocket.waitingForDrain && this.queue.length) {
      const params = this.queue.shift()

      this.bufferedBytes -= params[3].byteLength
      params[0].apply(this, params.slice(1))
    }
  }

  /**
   * Enqueue send operation
   *
   * @param params - Send operation parameters
   */
  private enqueue(params: EnqueueParamsTuple): void {
    this.bufferedBytes += params[3].byteLength
    this.queue.push(params)
  }

  /**
   * Send frame
   *
   * Handle back pressure for HTTP/2 by checking return value of socket.write()
   * and relying on WebSocket's 'drain' event listener to resume
   *
   * @param list - Frame to send
   * @param callback - Callback
   */
  private sendFrame(list: (Buffer | string)[], callback: ((err?: Error | null) => void) | undefined): void {
    let flushed = true

    if (list.length === 2) {
      if (this.webSocket.socket.cork) this.webSocket.socket.cork()

      // Write header first (usually small, less likely to cause backpressure itself)
      this.webSocket.socket.write(list[0])

      // Write payload and check return value for backpressure
      flushed = this.webSocket.socket.write(list[1], callback)

      if (this.webSocket.socket.uncork) this.webSocket.socket.uncork()
    } else {
      flushed = this.webSocket.socket.write(list[0], callback)
    }

    if (!flushed) {
      this.webSocket.markWaitingForDrain()
    } else if (this.state === 'DEFAULT') {
      process.nextTick(() => this.dequeue())
    }
  }

  /**
   * Call queued callbacks with error
   *
   * @param err - Error to call callbacks with
   * @param callback - First callback
   */
  private callCallbacks(err: Error, callback?: (err?: Error | null) => void): void {
    if (typeof callback === 'function') callback(err)

    for (let i = 0; i < this.queue.length; i++) {
      const params = this.queue[i]
      const callback = params[params.length - 1] as ((err?: Error | null) => void) | undefined
      if (typeof callback === 'function') callback(err)
    }
  }
}
