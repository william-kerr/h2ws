import type { DeflateRaw, InflateRaw, ZlibOptions } from 'node:zlib'
import { constants as zlibConstants, createDeflateRaw, createInflateRaw } from 'node:zlib'

import { kStatusCode } from '../constants.js'
import { concat } from '../util/buffer.js'
import { Limiter } from '../util/limiter.js'
import type { ExtensionValue } from './extension.js'

export interface PerMessageDeflateOptions {
  /** Advertise support for (or request) custom client window size */
  clientMaxWindowBits?: boolean | number

  /** Advertise / acknowledge disabling of client context takeover */
  clientNoContextTakeover?: boolean

  /** Number of concurrent calls to zlib */
  concurrencyLimit?: number

  /** Request / confirm use of custom server window size */
  serverMaxWindowBits?: boolean | number

  /** Request / accept disabling of server context takeover */
  serverNoContextTakeover?: boolean

  /**
   * Size (in bytes) below which messages should not be compressed if context
   * takeover is disabled
   */
  threshold?: number

  /** Options to pass to zlib on deflate */
  zlibDeflateOptions?: ZlibOptions

  /** Options to pass to zlib on inflate */
  zlibInflateOptions?: ZlibOptions
}

interface AcceptedParams {
  client_max_window_bits?: number | boolean
  server_max_window_bits?: number
  client_no_context_takeover?: boolean
  server_no_context_takeover?: boolean
}

interface InflateStream extends InflateRaw {
  [kPerMessageDeflate]?: PerMessageDeflate
  [kTotalLength]?: number
  [kBuffers]?: Buffer[]
  [kCallback]?: (err: Error | null, result?: Buffer) => void
  [kError]?: (Error & { code?: string; [kStatusCode]?: number }) | null
}

interface DeflateStream extends DeflateRaw {
  [kTotalLength]?: number
  [kBuffers]?: Buffer[]
  [kCallback]?: (err: Error | null, result?: Buffer) => void
}

const TRAILER = Buffer.from([0x00, 0x00, 0xff, 0xff])
const kPerMessageDeflate = Symbol('permessage-deflate')
const kTotalLength = Symbol('total-length')
const kCallback = Symbol('callback')
const kBuffers = Symbol('buffers')
const kError = Symbol('error')

/**
 * Limit zlib concurrency, which prevents severe memory fragmentation as
 * documented in:
 * https://github.com/nodejs/node/issues/8871#issuecomment-250915913 and
 * https://github.com/websockets/ws/issues/1202
 *
 * Intentionally global; it's the global thread pool that's an issue
 */
let zlibLimiter: Limiter | undefined

/**
 * permessage-deflate implementation.
 */
export class PerMessageDeflate {
  static readonly extensionName: 'permessage-deflate' = 'permessage-deflate'
  params: AcceptedParams | null
  threshold: number

  private maxPayload: number
  private options: PerMessageDeflateOptions
  private deflate: DeflateStream | null
  private inflate: InflateStream | null

  /**
   * @param options - Configuration options
   * @param maxPayload - Max allowed message length
   */
  constructor(options: PerMessageDeflateOptions | undefined, maxPayload: number) {
    this.maxPayload = maxPayload | 0
    this.options = options || {}
    this.threshold = this.options.threshold ?? 1024
    this.deflate = null
    this.inflate = null

    this.params = null

    if (!zlibLimiter) {
      const concurrency = this.options.concurrencyLimit ?? 10
      zlibLimiter = new Limiter(concurrency)
    }
  }

  /**
   * Create extension negotiation offer
   *
   * @return extension parameters
   */
  offer(): ExtensionValue {
    const params: ExtensionValue = {}

    if (this.options.serverNoContextTakeover) {
      params.server_no_context_takeover = true
    }
    if (this.options.clientNoContextTakeover) {
      params.client_no_context_takeover = true
    }
    if (typeof this.options.serverMaxWindowBits === 'number') {
      params.server_max_window_bits = String(this.options.serverMaxWindowBits)
    }
    if (typeof this.options.clientMaxWindowBits === 'number') {
      params.client_max_window_bits = String(this.options.clientMaxWindowBits)
    } else if (this.options.clientMaxWindowBits === true || this.options.clientMaxWindowBits === undefined) {
      params.client_max_window_bits = true
    }

    return params
  }

  /**
   * Accept extension negotiation offer / response
   *
   * @param configurations - Extension negotiation offers / reponse
   * @return accepted configuration
   */
  accept(configurations: ExtensionValue[]): AcceptedParams {
    const normalized = this.normalizeParams(configurations)
    this.params = this.acceptAsServer(normalized)

    return this.params
  }

  /**
   * Release all resources used by extension
   */
  cleanup(): void {
    if (this.inflate) {
      const callback = this.inflate[kCallback]

      this.inflate.close()
      this.inflate = null

      if (callback) {
        // Use process.nextTick to ensure callback is called outside current stack
        process.nextTick(callback, new Error('The inflate stream was closed while data was being processed'))
      }
    }

    if (this.deflate) {
      const callback = this.deflate[kCallback]

      this.deflate.close()
      this.deflate = null

      if (callback) {
        // Use process.nextTick to ensure callback is called outside current stack
        process.nextTick(callback, new Error('The deflate stream was closed while data was being processed'))
      }
    }
  }

  /**
   * Accept extension negotiation offer as server
   *
   * @param offers - Extension negotiation offers
   * @return accepted configuration
   * @private
   */
  private acceptAsServer(offers: AcceptedParams[]): AcceptedParams {
    const opts = this.options
    const accepted = offers.find((params) => {
      if (
        (opts.serverNoContextTakeover === false && params.server_no_context_takeover) ||
        (params.server_max_window_bits &&
          (opts.serverMaxWindowBits === false ||
            (typeof opts.serverMaxWindowBits === 'number' &&
              opts.serverMaxWindowBits > params.server_max_window_bits))) ||
        (typeof opts.clientMaxWindowBits === 'number' && !params.client_max_window_bits)
      ) {
        return false
      }

      return true
    })

    if (!accepted) {
      throw new Error('None of the extension offers can be accepted')
    }

    if (opts.serverNoContextTakeover) {
      accepted.server_no_context_takeover = true
    }
    if (opts.clientNoContextTakeover) {
      accepted.client_no_context_takeover = true
    }
    if (typeof opts.serverMaxWindowBits === 'number') {
      accepted.server_max_window_bits = opts.serverMaxWindowBits
    }
    if (typeof opts.clientMaxWindowBits === 'number') {
      accepted.client_max_window_bits = opts.clientMaxWindowBits
    } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
      delete accepted.client_max_window_bits
    }

    return accepted
  }

  /**
   * Normalize parameters
   *
   * @param configurations - Extension negotiation offers / response
   * @return offers / response with normalized parameters
   */
  private normalizeParams(configurations: ExtensionValue[]): AcceptedParams[] {
    const normalized: AcceptedParams[] = []

    for (const params of configurations) {
      const currentParams: Partial<AcceptedParams> = {}

      for (const key of Object.keys(params)) {
        const rawValue = params[key]

        if (key === 'client_max_window_bits') {
          if (typeof rawValue === 'string') {
            const num = +rawValue
            if (!Number.isInteger(num) || num < 8 || num > 15) {
              throw new TypeError(`Invalid value for parameter "${key}": ${rawValue}`)
            }
            currentParams.client_max_window_bits = num
          } else if (rawValue === true) {
            currentParams.client_max_window_bits = true
          } else {
            throw new TypeError(`Invalid value type for parameter "${key}": Expected string or true`)
          }
        } else if (key === 'server_max_window_bits') {
          if (typeof rawValue === 'string') {
            const num = +rawValue
            if (!Number.isInteger(num) || num < 8 || num > 15) {
              throw new TypeError(`Invalid value for parameter "${key}": ${rawValue}`)
            }
            currentParams.server_max_window_bits = num
          } else if (rawValue === true) {
            throw new TypeError(`Invalid parameter "${key}": Must have a numeric value if present`)
          } else {
            throw new TypeError(`Invalid value type for parameter "${key}": Expected string or true`)
          }
        } else if (key === 'client_no_context_takeover' || key === 'server_no_context_takeover') {
          if (rawValue !== true) {
            throw new TypeError(`Invalid value for parameter "${key}": Expected true`)
          }
          currentParams[key] = true
        } else {
          throw new Error(`Unknown parameter "${key}"`)
        }
      }
      normalized.push(currentParams as AcceptedParams)
    }

    return normalized
  }

  /**
   * Decompress data
   *
   * @param data - Compressed data
   * @param fin - Is last fragment?
   * @param callback - Callback (takes error or null, and the decompressed buffer)
   */
  decompress(data: Buffer, fin: boolean, callback: (err: Error | null, result?: Buffer) => void): void {
    zlibLimiter.add((done) => {
      this._decompress(data, fin, (err, result) => {
        done()
        callback(err, result)
      })
    })
  }

  /**
   * Compress data
   *
   * @param data - Data to compress
   * @param fin - Is last fragment?
   * @param callback - Callback (takes error or null, and compressed buffer)
   */
  compress(data: Buffer | string, fin: boolean, callback: (err: Error | null, result?: Buffer) => void): void {
    zlibLimiter.add((done) => {
      this._compress(data, fin, (err, result) => {
        done()
        callback(err, result)
      })
    })
  }

  /**
   * Decompress data
   *
   * @param data - Compressed data
   * @param fin - Is last fragment?
   * @param callback - Callback (takes error or null, and decompressed buffer)
   */
  private _decompress(data: Buffer, fin: boolean, callback: (err: Error | null, result?: Buffer) => void): void {
    const endpoint = 'client'

    if (!this.inflate) {
      const paramsWindowBits = this.params[`${endpoint}_max_window_bits`]
      const windowBits = typeof paramsWindowBits === 'number' ? paramsWindowBits : zlibConstants.Z_DEFAULT_WINDOWBITS

      this.inflate = createInflateRaw({
        ...this.options.zlibInflateOptions,
        windowBits
      }) as InflateStream

      this.inflate[kPerMessageDeflate] = this
      this.inflate[kTotalLength] = 0
      this.inflate[kBuffers] = []
      this.inflate.on('error', inflateOnError)
      this.inflate.on('data', inflateOnData)
    }

    this.inflate[kCallback] = callback

    this.inflate.write(data)
    if (fin) this.inflate.write(TRAILER)

    this.inflate.flush(() => {
      const err = this.inflate[kError]

      if (err) {
        this.inflate.close()
        this.inflate = null
        callback(err)
        return
      }

      const data = concat(this.inflate[kBuffers], this.inflate[kTotalLength])

      if (this.inflate.readableEnded) {
        this.inflate.close()
        this.inflate = null
      } else {
        this.inflate[kTotalLength] = 0
        this.inflate[kBuffers] = []

        if (fin && this.params[`${endpoint}_no_context_takeover`]) {
          this.inflate.reset()
        }
      }

      callback(null, data)
    })
  }

  /**
   * Compress data
   *
   * @param data - Data to compress
   * @param fin - Is last fragment?
   * @param callback - Callback (takes error or null, and compressed buffer)
   */
  private _compress(data: Buffer | string, fin: boolean, callback: (err: Error | null, result?: Buffer) => void): void {
    const endpoint = 'server'

    // Do not compress data messages smaller than threshold, if context takeover is disabled
    if (this.params[`${endpoint}_no_context_takeover`] && Buffer.byteLength(data) < this.threshold) {
      process.nextTick(callback, null, typeof data === 'string' ? Buffer.from(data) : data) // ensure Buffer is passed
      return
    }

    if (!this.deflate) {
      const paramsWindowBits = this.params[`${endpoint}_max_window_bits`]
      const windowBits = typeof paramsWindowBits === 'number' ? paramsWindowBits : zlibConstants.Z_DEFAULT_WINDOWBITS

      this.deflate = createDeflateRaw({
        ...this.options.zlibDeflateOptions,
        windowBits
      }) as DeflateStream

      this.deflate[kTotalLength] = 0
      this.deflate[kBuffers] = []

      this.deflate.on('data', deflateOnData)
    }

    this.deflate[kCallback] = callback

    this.deflate.write(data)
    this.deflate.flush(zlibConstants.Z_SYNC_FLUSH, () => {
      if (!this.deflate) {
        // Deflate stream was closed while data was being processed
        return
      }

      let data = concat(this.deflate[kBuffers], this.deflate[kTotalLength])

      if (fin) {
        data = data.subarray(0, data.length - 4)
      }

      // Ensure that callback will not be called again in PerMessageDeflate.cleanup()
      this.deflate[kCallback] = undefined

      this.deflate[kTotalLength] = 0
      this.deflate[kBuffers] = []

      if (fin && this.params[`${endpoint}_no_context_takeover`]) {
        this.deflate.reset()
      }

      callback(null, data)
    })
  }
}

/**
 * On zlib.DeflateRaw stream 'data' event
 *
 * @param chunk - Chunk of data
 */
function deflateOnData(this: DeflateStream, chunk: Buffer): void {
  this[kBuffers]!.push(chunk)
  this[kTotalLength]! += chunk.length
}

/**
 * On zlib.InflateRaw stream 'data' event
 *
 * @param chunk - Chunk of data
 */
function inflateOnData(this: InflateStream, chunk: Buffer): void {
  const currentTotalLength = (this[kTotalLength]! += chunk.length)
  const pmd = this[kPerMessageDeflate]!

  if (pmd['maxPayload'] < 1 || currentTotalLength <= pmd['maxPayload']) {
    this[kBuffers]!.push(chunk)
    return
  }

  const err = new RangeError('Max payload size exceeded') as Error & { code?: string; [kStatusCode]?: number }
  err.code = 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
  err[kStatusCode] = 1009
  this[kError] = err
  this.removeListener('data', inflateOnData)

  // Do not reset here, flush callback will handle closing
}

/**
 * On zlib.InflateRaw stream 'error' event
 *
 * @param err - The emitted error
 */
function inflateOnError(this: InflateStream, err: Error & { [kStatusCode]?: number }): void {
  // No need to call Zlib.close() as handle is automatically closed when error is emitted
  const pmd = this[kPerMessageDeflate]!
  pmd['inflate'] = null
  err[kStatusCode] = 1007
  if (this[kCallback]) {
    this[kCallback](err)
    this[kCallback] = undefined
  }
}
