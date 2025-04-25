/**
 * Allowed token characters according to RFC 7230, section 3.2.6:
 *
 * '!', '#', '$', '%', '&', ''', '*', '+', '-',
 * '.', 0-9, A-Z, '^', '_', '`', a-z, '|', '~'
 *
 * tokenChars[32] === 0 // ' '
 * tokenChars[33] === 1 // '!'
 * tokenChars[34] === 0 // '"'
 * ...
 */
// prettier-ignore
export const tokenChars: ReadonlyArray<number> = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0 - 15
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16 - 31
  0, 1, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 1, 0, // 32 - 47
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, // 48 - 63
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 64 - 79
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, // 80 - 95
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 96 - 111
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0  // 112 - 127
];

/**
 * Check if status code is allowed in WebSocket close frame according to
 * RFC 6455 Section 7.4.1 and IANA WebSocket Close Code Number Registry
 *
 * @param code - Status code to check
 * @returns true if status code is valid for close frame, otherwise false
 */
export function isValidStatusCode(code: number): boolean {
  return (
    // Standard codes (RFC 6455 & IANA): 1000-1014 RESERVED, excluding 1004, 1005, 1006
    (code >= 1000 &&
      code <= 1014 &&
      code !== 1004 && // reserved
      code !== 1005 && // no status recvd (MUST NOT be set in close frame)
      code !== 1006) || // abnormal closure (MUST NOT be set in close frame)
    // Application specific codes: 3000-3999 (defined by IANA registry as available for frameworks / applications)
    // Private use codes: 4000-4999 (defined by IANA registry as available for private use)
    (code >= 3000 && code <= 4999)
  )
}
