import { tokenChars } from './validation.js'

/**
 * Parse 'Sec-WebSocket-Protocol' header into set of subprotocol names
 *
 * According to RFC 6455 Section 4.2.1:
 * Sec-WebSocket-Protocol = 1#token
 * Where #token is defined in RFC 7230 Section 7.
 *
 * @param header - Field value of the Sec-WebSocket-Protocol header
 * @returns set containing unique subprotocol names
 * @throws {SyntaxError} if header format is invalid or protocols are duplicated
 */
export function parse(header: string): Set<string> {
  const protocols = new Set<string>()
  let start = -1
  let end = -1
  let i = 0

  for (; i < header.length; i++) {
    const code = header.charCodeAt(i)
    if (end === -1 && tokenChars[code] === 1) {
      if (start === -1) start = i
    } else if (i !== 0 && (code === 0x20 /* ' ' */ || code === 0x09) /* '\t' */) {
      if (end === -1 && start !== -1) end = i
    } else if (code === 0x2c /* ',' */) {
      if (start === -1) {
        throw new SyntaxError(`Unexpected character at index ${i}`)
      }

      if (end === -1) end = i

      const protocol = header.slice(start, end)
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`)
      }
      protocols.add(protocol)

      start = end = -1
    } else {
      throw new SyntaxError(`Unexpected character at index ${i}`)
    }
  }

  if (start === -1 || end !== -1) {
    throw new SyntaxError('Unexpected end of input')
  }

  const protocol = header.slice(start, i)
  if (protocols.has(protocol)) {
    throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`)
  }
  protocols.add(protocol)

  return protocols
}
