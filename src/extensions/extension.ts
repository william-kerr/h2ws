import { tokenChars } from '../protocol/validation.js'

export interface ExtensionValue {
  [parameter: string]: string | true
}

export interface Offers {
  [extensionName: string]: ExtensionValue[]
}

/**
 * Add parameter to map of parameters
 *
 * @param params - Parameter map
 * @param name - Parameter name
 * @param value - Parameter value; true is used if parameter appeared without value
 */
function pushParam(params: ExtensionValue, name: string, value: string | true): void {
  params[name] = value // last value wins
}

/**
 * Add offer to map of extension offers
 *
 * @param dest - Map of extension offers
 * @param name - Extension name
 * @param elem - Extension parameters or parameter value for associated token identifier
 */
function pushOffer(dest: Offers, name: string, elem: ExtensionValue): void {
  if (!dest[name]) {
    dest[name] = [elem]
  } else {
    dest[name].push(elem)
  }
}

/**
 * Parse 'Sec-WebSocket-Extensions' header into object
 *
 * @param header - Field value of header
 * @return parsed object
 */
export function parse(header: string): Offers {
  const offers: Offers = Object.create(null)
  let params: ExtensionValue = Object.create(null)
  let mustUnescape = false
  let isEscaping = false
  let inQuotes = false
  let extensionName = ''
  let paramName = ''
  let start = -1
  let code = -1
  let end = -1
  let i = 0

  for (; i < header.length; i++) {
    code = header.charCodeAt(i)

    if (extensionName === '') {
      if (end === -1 && tokenChars[code] === 1) {
        if (start === -1) start = i
      } else if (code === 0x20 /* ' ' */ || code === 0x09 /* '\t' */) {
        if (end === -1 && start !== -1) end = i
      } else if (code === 0x3b /* ';' */ || code === 0x2c /* ',' */) {
        if (start === -1) {
          throw new SyntaxError(`Unexpected character at index ${i}`)
        }

        if (end === -1) end = i
        extensionName = header.slice(start, end)

        if (code === 0x2c) {
          pushOffer(offers, extensionName, params)
          params = Object.create(null)
          extensionName = ''
        }

        start = end = -1
      } else {
        throw new SyntaxError(`Unexpected character at index ${i}`)
      }
    } else if (paramName === '') {
      if (end === -1 && tokenChars[code] === 1) {
        if (start === -1) start = i
      } else if (code === 0x20 || code === 0x09) {
        if (end === -1 && start !== -1) end = i
      } else if (code === 0x3b || code === 0x2c) {
        if (start === -1) {
          throw new SyntaxError(`Unexpected character at index ${i}`)
        }

        if (end === -1) end = i
        pushParam(params, header.slice(start, end), true)
        if (code === 0x2c) {
          pushOffer(offers, extensionName, params)
          params = Object.create(null)
          extensionName = ''
        }

        start = end = -1
      } else if (code === 0x3d /* '=' */ && start !== -1 && end === -1) {
        paramName = header.slice(start, i)
        start = end = -1
      } else {
        throw new SyntaxError(`Unexpected character at index ${i}`)
      }
    } else {
      /**
       * Value of quoted-string after unescaping must conform to token ABNF, so
       * only token characters are valid according to RFC 6455 Section 9.1
       */
      if (isEscaping) {
        if (tokenChars[code] !== 1) {
          throw new SyntaxError(`Unexpected character at index ${i}`)
        }
        if (start === -1) start = i
        else if (!mustUnescape) mustUnescape = true
        isEscaping = false
      } else if (inQuotes) {
        if (tokenChars[code] === 1) {
          if (start === -1) start = i
        } else if (code === 0x22 /* '"' */ && start !== -1) {
          inQuotes = false
          end = i
        } else if (code === 0x5c /* '\' */) {
          isEscaping = true
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`)
        }
      } else if (code === 0x22 && header.charCodeAt(i - 1) === 0x3d) {
        inQuotes = true
      } else if (end === -1 && tokenChars[code] === 1) {
        if (start === -1) start = i
      } else if (start !== -1 && (code === 0x20 || code === 0x09)) {
        if (end === -1) end = i
      } else if (code === 0x3b || code === 0x2c) {
        if (start === -1) {
          throw new SyntaxError(`Unexpected character at index ${i}`)
        }

        if (end === -1) end = i
        let value = header.slice(start, end)
        if (mustUnescape) {
          value = value.replace(/\\/g, '')
          mustUnescape = false
        }
        pushParam(params, paramName, value)

        if (code === 0x2c) {
          pushOffer(offers, extensionName, params)
          params = Object.create(null)
          extensionName = ''
        }

        paramName = ''
        start = end = -1
      } else {
        throw new SyntaxError(`Unexpected character at index ${i}`)
      }
    }
  }

  if (start === -1 || inQuotes || code === 0x20 || code === 0x09) {
    throw new SyntaxError('Unexpected end of input')
  }

  if (end === -1) end = i
  const token = header.slice(start, end)
  if (extensionName === '') {
    pushOffer(offers, token, params)
  } else {
    if (paramName === '') {
      pushParam(params, token, true)
    } else if (mustUnescape) {
      pushParam(params, paramName, token.replace(/\\/g, ''))
    } else {
      pushParam(params, paramName, token)
    }
    pushOffer(offers, extensionName, params)
  }

  return offers
}

/**
 * Convert extension map into 'Sec-WebSocket-Extensions' header string
 *
 * @param extensions - Map of extensions and parameters to format
 * @return string representing given object
 */
export function format(extensions: Record<string, ExtensionValue | ExtensionValue[]>): string {
  return Object.keys(extensions)
    .map((extension) => {
      let configurations = extensions[extension]
      if (!Array.isArray(configurations)) {
        configurations = [configurations]
      }

      return configurations
        .map((params) => {
          const paramStrings = Object.keys(params).map((k) => {
            const value = params[k]
            return value === true ? k : `${k}=${value}`
          })
          return [extension].concat(paramStrings).join('; ')
        })
        .join(', ')
    })
    .join(', ')
}
