import { isUtf8 } from 'node:buffer'
import { Writable } from 'node:stream'

import {
  EMPTY_BUFFER,
  FIN,
  kStatusCode,
  MASK,
  OpcodeMask,
  PayloadLengthMask,
  RSV1,
  RSV2,
  RSV3,
  type WebSocketBinaryType,
  WebSocketOpcode
} from '../constants.js'
import type { WebSocket } from '../core/websocket.js'
import { PerMessageDeflate } from '../extensions/permessage-deflate.js'
import { concat, toArrayBuffer, unmask } from '../util/buffer.js'
import { isValidStatusCode } from './validation.js'

type ReceiverState =
  | 'GET_INFO'
  | 'GET_PAYLOAD_LENGTH_16'
  | 'GET_PAYLOAD_LENGTH_64'
  | 'GET_MASK'
  | 'GET_DATA'
  | 'INFLATING'
  | 'DEFER_EVENT'

interface ReceiverOptions {
  /**
   * Control whether 'message', 'ping', and 'pong' events can be emitted
   * multiple times in same tick
   */
  allowSynchronousEvents?: boolean

  /** Binary data type */
  binaryType?: WebSocketBinaryType

  /** WebSocket extensions negotiated during handshake */
  extensions?: {
    [PerMessageDeflate.extensionName]?: PerMessageDeflate
  }

  /** Max allowed message length in bytes */
  maxPayload?: number

  /** Skip UTF-8 validation for text and close messages? */
  skipUTF8Validation?: boolean
}

/**
 * HyBi Receiver implementation
 */
export class Receiver extends Writable {
  binaryType: WebSocketBinaryType

  /** Errored */
  error: boolean

  private allowSynchronousEvents: boolean
  private extensions: {
    [PerMessageDeflate.extensionName]?: PerMessageDeflate
  }
  private maxPayload: number
  private skipUTF8Validation: boolean

  private bufferedBytes: number
  private buffers: Buffer[]

  private compressed: boolean
  private payloadLength: number
  private mask: Buffer | undefined
  private fragmented: number
  private masked: boolean
  private fin: boolean
  private opcode: number

  private totalPayloadLength: number
  private messageLength: number
  private fragments: Buffer[]

  private loop: boolean
  private state: ReceiverState

  /**
   * @param webSocket - WebSocket instance Receiver belongs to
   * @param options - Receiver options
   */
  constructor(
    private readonly webSocket: WebSocket,
    options: ReceiverOptions
  ) {
    super()

    this.allowSynchronousEvents = options.allowSynchronousEvents ?? true
    this.binaryType = options.binaryType ?? 'nodebuffer'
    this.extensions = options.extensions ?? {}
    this.maxPayload = options.maxPayload | 0
    this.skipUTF8Validation = options.skipUTF8Validation ?? false

    this.bufferedBytes = 0
    this.buffers = []

    this.compressed = false
    this.payloadLength = 0
    this.mask = undefined
    this.fragmented = 0
    this.masked = false
    this.fin = false
    this.opcode = 0

    this.totalPayloadLength = 0
    this.messageLength = 0
    this.fragments = []

    this.error = false
    this.loop = false
    this.state = 'GET_INFO'
  }

  /**
   * Implements Writable._write()
   *
   * @param chunk - Chunk of data to write
   * @param encoding - Character encoding of `chunk`
   * @param callback - Callback
   */
  _write(chunk: Buffer, encoding: string, callback: (error?: Error | null) => void): void {
    if (this.opcode === WebSocketOpcode.CLOSE && this.state === 'GET_INFO') return callback()

    this.bufferedBytes += chunk.length
    this.buffers.push(chunk)
    this.startLoop(callback)
  }

  /**
   * Consume `n` bytes from buffered data
   *
   * @param n - Number of bytes to consume
   * @return consumed bytes
   */
  private consume(n: number): Buffer {
    this.bufferedBytes -= n

    if (n === this.buffers[0].length) return this.buffers.shift()

    if (n < this.buffers[0].length) {
      const buf = this.buffers[0]
      this.buffers[0] = buf.subarray(n)

      return buf.subarray(0, n)
    }

    const dst = Buffer.allocUnsafe(n)

    do {
      const buf = this.buffers[0]
      const offset = dst.length - n

      if (n >= buf.length) {
        dst.set(this.buffers.shift(), offset)
      } else {
        buf.copy(dst, offset, 0, n)
        this.buffers[0] = buf.subarray(n)
      }

      n -= buf.length
    } while (n > 0)

    return dst
  }

  /**
   * Start parsing loop
   *
   * @param callback - Callback
   */
  private startLoop(callback: (error?: Error | null) => void): void {
    this.loop = true

    do {
      switch (this.state) {
        case 'GET_INFO':
          this.getInfo(callback)
          break
        case 'GET_PAYLOAD_LENGTH_16':
          this.getPayloadLength16(callback)
          break
        case 'GET_PAYLOAD_LENGTH_64':
          this.getPayloadLength64(callback)
          break
        case 'GET_MASK':
          this.getMask()
          break
        case 'GET_DATA':
          this.getData(callback)
          break
        case 'INFLATING':
        case 'DEFER_EVENT':
          this.loop = false
          return
      }
    } while (this.loop)

    if (!this.error) callback()
  }

  /**
   * Read first two bytes of frame
   *
   * @param callback - Callback
   */
  private getInfo(callback: (error?: Error | null) => void): void {
    if (this.bufferedBytes < 2) {
      this.loop = false
      return
    }

    const buf = this.consume(2)

    if ((buf[0] & (RSV2 | RSV3)) !== 0x00) {
      const error = this.createError(RangeError, 'RSV2 and RSV3 must be clear', true, 1002, 'WS_ERR_UNEXPECTED_RSV_2_3')

      callback(error)
      return
    }

    const compressed = (buf[0] & RSV1) === RSV1
    if (compressed && !this.extensions[PerMessageDeflate.extensionName]) {
      const error = this.createError(RangeError, 'RSV1 must be clear', true, 1002, 'WS_ERR_UNEXPECTED_RSV_1')

      callback(error)
      return
    }

    this.fin = (buf[0] & FIN) === FIN
    this.opcode = buf[0] & OpcodeMask
    this.payloadLength = buf[1] & PayloadLengthMask

    if (this.opcode === WebSocketOpcode.CONTINUATION) {
      if (compressed) {
        const error = this.createError(RangeError, 'RSV1 must be clear', true, 1002, 'WS_ERR_UNEXPECTED_RSV_1')

        callback(error)
        return
      }

      if (!this.fragmented) {
        const error = this.createError(RangeError, 'invalid opcode 0', true, 1002, 'WS_ERR_INVALID_OPCODE')

        callback(error)
        return
      }

      this.opcode = this.fragmented
    } else if (this.opcode === WebSocketOpcode.TEXT || this.opcode === WebSocketOpcode.BINARY) {
      if (this.fragmented) {
        const error = this.createError(RangeError, `invalid opcode ${this.opcode}`, true, 1002, 'WS_ERR_INVALID_OPCODE')

        callback(error)
        return
      }

      this.compressed = compressed
    } else if (
      this.opcode === WebSocketOpcode.CLOSE ||
      this.opcode === WebSocketOpcode.PING ||
      this.opcode === WebSocketOpcode.PONG
    ) {
      if (!this.fin) {
        const error = this.createError(RangeError, 'FIN must be set', true, 1002, 'WS_ERR_EXPECTED_FIN')

        callback(error)
        return
      }

      if (compressed) {
        const error = this.createError(RangeError, 'RSV1 must be clear', true, 1002, 'WS_ERR_UNEXPECTED_RSV_1')

        callback(error)
        return
      }

      if (this.payloadLength > 125 || (this.opcode === WebSocketOpcode.CLOSE && this.payloadLength === 1)) {
        const error = this.createError(
          RangeError,
          `invalid payload length ${this.payloadLength}`,
          true,
          1002,
          'WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH'
        )

        callback(error)
        return
      }
    } else {
      const error = this.createError(RangeError, `invalid opcode ${this.opcode}`, true, 1002, 'WS_ERR_INVALID_OPCODE')

      callback(error)
      return
    }

    if (!this.fin && !this.fragmented) this.fragmented = this.opcode
    this.masked = (buf[1] & MASK) === MASK

    if (!this.masked) {
      const error = this.createError(RangeError, 'MASK must be set', true, 1002, 'WS_ERR_EXPECTED_MASK')

      callback(error)
      return
    }

    if (this.payloadLength === 126) this.state = 'GET_PAYLOAD_LENGTH_16'
    else if (this.payloadLength === 127) this.state = 'GET_PAYLOAD_LENGTH_64'
    else this.haveLength(callback)
  }

  /**
   * Get extended payload length (7+16)
   *
   * @param callback - Callback
   */
  private getPayloadLength16(callback: (error?: Error | null) => void): void {
    if (this.bufferedBytes < 2) {
      this.loop = false
      return
    }

    this.payloadLength = this.consume(2).readUInt16BE(0)

    if (this.payloadLength < 126) {
      const error = this.createError(
        RangeError,
        'Payload length must be >= 126 for 16-bit length encoding',
        true,
        1002, // protocol error
        'WS_ERR_NON_MINIMAL_PAYLOAD_LENGTH_16'
      )
      callback(error)
      return
    }

    this.haveLength(callback)
  }

  /**
   * Get extended payload length (7+64)
   *
   * @param callback - Callback
   */
  private getPayloadLength64(callback: (error?: Error | null) => void): void {
    if (this.bufferedBytes < 8) {
      this.loop = false
      return
    }

    const buf = this.consume(8)
    const num = buf.readUInt32BE(0)

    // Max safe integer in JavaScript is 2^53 - 1
    // An error is returned if payload length is greater than this number
    if (num > Math.pow(2, 53 - 32) - 1) {
      const error = this.createError(
        RangeError,
        'Unsupported WebSocket frame: payload length > 2^53 - 1',
        false,
        1009,
        'WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH'
      )

      callback(error)
      return
    }

    this.payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4)

    if (this.payloadLength < 65536) {
      const error = this.createError(
        RangeError,
        'Payload length must be >= 65536 for 64-bit length encoding',
        true,
        1002, // protocol error
        'WS_ERR_NON_MINIMAL_PAYLOAD_LENGTH_64'
      )
      callback(error)
      return
    }

    this.haveLength(callback)
  }

  /**
   * Payload length has been read
   *
   * @param callback - Callback
   */
  private haveLength(callback: (error?: Error | null) => void): void {
    if (this.payloadLength && this.opcode < WebSocketOpcode.CLOSE) {
      this.totalPayloadLength += this.payloadLength
      if (this.totalPayloadLength > this.maxPayload && this.maxPayload > 0) {
        const error = this.createError(
          RangeError,
          'Max payload size exceeded',
          false,
          1009,
          'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
        )

        callback(error)
        return
      }
    }

    if (this.masked) this.state = 'GET_MASK'
    else this.state = 'GET_DATA'
  }

  /**
   * Read mask bytes
   */
  private getMask(): void {
    if (this.bufferedBytes < 4) {
      this.loop = false
      return
    }

    this.mask = this.consume(4)
    this.state = 'GET_DATA'
  }

  /**
   * Read data bytes
   *
   * @param callback - Callback
   */
  private getData(callback: (error?: Error | null) => void): void {
    let data: Buffer = EMPTY_BUFFER

    if (this.payloadLength) {
      if (this.bufferedBytes < this.payloadLength) {
        this.loop = false
        return
      }

      data = this.consume(this.payloadLength)

      if (this.masked && (this.mask[0] | this.mask[1] | this.mask[2] | this.mask[3]) !== 0) {
        unmask(data, this.mask)
      }
    }

    if (this.opcode >= WebSocketOpcode.CLOSE) {
      this.controlMessage(data, callback)
      return
    }

    if (this.compressed) {
      this.state = 'INFLATING'
      this.decompress(data, callback)
      return
    }

    if (data.length) {
      // This message is not compressed, so its length is sum of payload length of all fragments
      this.messageLength = this.totalPayloadLength
      this.fragments.push(data)
    }

    this.dataMessage(callback)
  }

  /**
   * Decompress data
   *
   * @param data - Compressed data
   * @param callback - Callback
   */
  private decompress(data: Buffer, callback: (error?: Error | null) => void): void {
    const perMessageDeflate = this.extensions[PerMessageDeflate.extensionName]

    perMessageDeflate.decompress(data, this.fin, (err, buf) => {
      if (err) return callback(err)

      if (buf.length) {
        this.messageLength += buf.length
        if (this.messageLength > this.maxPayload && this.maxPayload > 0) {
          const error = this.createError(
            RangeError,
            'Max payload size exceeded',
            false,
            1009,
            'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
          )

          callback(error)
          return
        }

        this.fragments.push(buf)
      }

      this.dataMessage(callback)
      if (this.state === 'GET_INFO') this.startLoop(callback)
    })
  }

  /**
   * Handle data message
   *
   * @param callback - Callback
   */
  private dataMessage(callback: (error?: Error | null) => void): void {
    if (!this.fin) {
      this.state = 'GET_INFO'
      return
    }

    const messageLength = this.messageLength
    const fragments = this.fragments

    this.totalPayloadLength = 0
    this.messageLength = 0
    this.fragmented = 0
    this.fragments = []

    if (this.opcode === WebSocketOpcode.BINARY) {
      let data: Buffer | ArrayBufferLike | Buffer[]

      if (this.binaryType === 'nodebuffer') {
        data = concat(fragments, messageLength)
      } else if (this.binaryType === 'arraybuffer') {
        data = toArrayBuffer(concat(fragments, messageLength))
      } else {
        data = fragments
      }

      if (this.allowSynchronousEvents) {
        this.webSocket.emit('message', data, true)
        this.state = 'GET_INFO'
      } else {
        this.state = 'DEFER_EVENT'
        setImmediate(() => {
          this.webSocket.emit('message', data, true)
          this.state = 'GET_INFO'
          this.startLoop(callback)
        })
      }
    } else {
      const buf = concat(fragments, messageLength)

      if (!this.skipUTF8Validation && !isUtf8(buf)) {
        const error = this.createError(Error, 'invalid UTF-8 sequence', true, 1007, 'WS_ERR_INVALID_UTF8')

        callback(error)
        return
      }

      if (this.state === 'INFLATING' || this.allowSynchronousEvents) {
        this.webSocket.emit('message', buf, false)
        this.state = 'GET_INFO'
      } else {
        this.state = 'DEFER_EVENT'
        setImmediate(() => {
          this.webSocket.emit('message', buf, false)
          this.state = 'GET_INFO'
          this.startLoop(callback)
        })
      }
    }
  }

  /**
   * Handle control message
   *
   * @param data - Data to handle
   * @param callback - Callback with possible error
   */
  private controlMessage(data: Buffer, callback: (error?: Error | null) => void): void {
    if (this.opcode === WebSocketOpcode.CLOSE) {
      if (data.length === 0) {
        this.loop = false
        this.emit('conclude', 1005, EMPTY_BUFFER)
        this.end()
      } else {
        const code = data.readUInt16BE(0)

        if (!isValidStatusCode(code)) {
          const error = this.createError(
            RangeError,
            `invalid status code ${code}`,
            true,
            1002,
            'WS_ERR_INVALID_CLOSE_CODE'
          )

          callback(error)
          return
        }

        const buf = data.subarray(2)

        if (!this.skipUTF8Validation && !isUtf8(buf)) {
          const error = this.createError(Error, 'invalid UTF-8 sequence', true, 1007, 'WS_ERR_INVALID_UTF8')

          callback(error)
          return
        }

        this.loop = false
        this.emit('conclude', code, buf)
        this.end()
      }

      this.state = 'GET_INFO'
      return
    }

    const eventName = this.opcode === WebSocketOpcode.PING ? 'ping' : 'pong'
    if (this.allowSynchronousEvents) {
      this.webSocket.emit(eventName, data)
      this.state = 'GET_INFO'
    } else {
      this.state = 'DEFER_EVENT'
      setImmediate(() => {
        this.webSocket.emit(eventName, data)
        this.state = 'GET_INFO'
        this.startLoop(callback)
      })
    }
  }

  /**
   * Build error object
   *
   * @param ErrorCtor - Error constructor
   * @param message - Error message
   * @param prefix - Add default prefix to `message`?
   * @param statusCode - Status code
   * @param errorCode - Exposed error code
   * @return error
   */
  private createError(
    ErrorCtor: new (message: string) => Error | RangeError,
    message: string,
    prefix: boolean,
    statusCode: number,
    errorCode: string
  ): Error | RangeError {
    this.loop = false
    this.error = true

    const err = new ErrorCtor(prefix ? `Invalid WebSocket frame: ${message}` : message)

    Error.captureStackTrace(err, this.createError)
    ;(err as any).code = errorCode
    err[kStatusCode] = statusCode
    return err
  }
}
