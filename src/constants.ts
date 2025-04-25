export type WebSocketBinaryType = 'nodebuffer' | 'arraybuffer' | 'fragments'
export type ReadyState = 'CONNECTING' | 'OPEN' | 'CLOSING' | 'CLOSED'

export const READY_STATES: readonly ReadyState[] = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']
export const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Frame opcodes */
export enum WebSocketOpcode {
  CONTINUATION = 0x00,
  TEXT = 0x01,
  BINARY = 0x02,
  // 0x03-0x07 reserved for non-control frames
  CLOSE = 0x08,
  PING = 0x09,
  PONG = 0x0a
  // 0x0B-0x0F reserved for control frames
}

/** Frame header bits / masks */
export const FIN = 0x80
export const RSV1 = 0x40
export const RSV2 = 0x20
export const RSV3 = 0x10
export const OpcodeMask = 0x0f
export const MASK = 0x80
export const PayloadLengthMask = 0x7f
export const EMPTY_BUFFER = Buffer.alloc(0)
export const NOOP = (): void => {}
export const kStatusCode = Symbol('status-code')
