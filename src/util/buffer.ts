import { EMPTY_BUFFER } from '../constants.js'

export type BufferLike = Buffer | ArrayBuffer | ArrayBufferView | string

/**
 * Merge array of buffers into new buffer
 *
 * NOTE: This function creates new Buffer by copying data
 *
 * @param list - Array of buffers to concat
 * @param totalLength - Total length of buffers in list
 * @return resulting buffer
 */
export function concat(list: Buffer[], totalLength: number): Buffer {
  if (list.length === 0) return EMPTY_BUFFER
  if (list.length === 1) return list[0]

  return Buffer.concat(list, totalLength)
}

/**
 * Unmask buffer using given mask
 *
 * @param buffer - Buffer to unmask
 * @param mask - Mask to use
 */
export function unmask(buffer: Buffer, mask: Buffer): void {
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] ^= mask[i & 3]
  }
}

/**
 * Convert buffer to ArrayBufferLike
 *
 * @param buf - Buffer to convert
 * @return converted buffer
 */
export function toArrayBuffer(buf: Buffer): ArrayBufferLike {
  if (buf.length === buf.buffer.byteLength) {
    return buf.buffer
  }

  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)
}

/**
 * Convert data to Buffer
 *
 * @param data - Data to convert
 * @return buffer
 * @throws {TypeError}
 */
export function toBuffer(data: BufferLike): Buffer {
  let buf: Buffer

  if (Buffer.isBuffer(data)) {
    buf = data
  } else if (data instanceof ArrayBuffer) {
    buf = Buffer.from(data) // zero-copy view
  } else if (ArrayBuffer.isView(data)) {
    // Create Buffer view sharing the same underlying ArrayBuffer
    buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  } else {
    buf = Buffer.from(data) // create new Buffer with copied data
  }

  return buf
}
