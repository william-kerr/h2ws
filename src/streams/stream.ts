import { Duplex, type DuplexOptions } from 'node:stream'

import { WebSocket } from '../core/websocket.js'

/**
 * Emit 'close' event on stream
 *
 * @param stream - Stream
 */
function emitClose(stream: Duplex): void {
  stream.emit('close')
}

/**
 * On 'end' event
 */
function duplexOnEnd(this: Duplex): void {
  if (!this.destroyed && this.writableFinished) {
    this.destroy()
  }
}

/**
 * On 'error' event
 *
 * @param err - Error
 */
function duplexOnError(this: Duplex, err: Error): void {
  this.removeListener('error', duplexOnError)
  this.destroy()
  if (this.listenerCount('error') === 0) {
    // Do not suppress throwing behavior
    this.emit('error', err)
  }
}

/**
 * Wrap WebSocket in duplex stream
 *
 * @param ws - WebSocket to wrap
 * @param options - Options for Duplex constructor
 * @return duplex stream
 */
export function createWebSocketStream(ws: WebSocket, options?: DuplexOptions): Duplex {
  let terminateOnDestroy = true

  const duplex = new Duplex({
    ...options,
    autoDestroy: false,
    emitClose: false,
    objectMode: false,
    writableObjectMode: false
  })

  ws.on('message', function message(msg: Buffer | ArrayBuffer | Buffer[], binary: boolean) {
    const data = !binary && duplex.readableObjectMode ? msg.toString() : msg

    if (!duplex.push(data)) ws.pause()
  })

  ws.once('error', function error(err: Error) {
    if (duplex.destroyed) return

    /**
     * Prevent ws.destroy() from being called by duplex._destroy()
     *
     * - If the 'error' event is emitted before the 'open' event, then
     *   ws.destroy() is a noop as no socket is assigned
     * - Otherwise, error is re-emitted by listener of 'error' event of the
     *   Receiver object. Listener already closes connection by calling
     *   ws.close(). This allows close frame to be sent to other peer. If
     *   ws.destroy() is called right after this, then close frame might not be
     *   sent.
     */
    terminateOnDestroy = false
    duplex.destroy(err)
  })

  ws.once('close', function close() {
    if (duplex.destroyed) return

    duplex.push(null)
  })

  duplex._destroy = function (err: Error | null, callback: (err: Error | null) => void): void {
    if (ws.readyState === WebSocket.CLOSED) {
      callback(err)
      process.nextTick(emitClose, duplex)
      return
    }

    let called = false

    ws.once('error', function error(err: Error) {
      called = true
      callback(err)
    })

    ws.once('close', function close() {
      if (!called) callback(err)
      process.nextTick(emitClose, duplex)
    })

    if (terminateOnDestroy) ws.destroy()
  }

  duplex._final = function (callback: (err?: Error | null) => void): void {
    if (ws.socket.writableFinished) {
      callback()
      if (duplex.readableEnded) duplex.destroy()
    } else {
      ws.socket.once('finish', function finish() {
        /*
         * `duplex` is not destroyed here because 'end' event will be emitted on
         * `duplex` after this 'finish' event. EOF signaling null chunk is, in
         * fact, pushed when WebSocket emits 'close'
         */
        callback()
      })
      ws.close()
    }
  }

  duplex._read = function (): void {
    if (ws.isPaused) ws.resume()
  }

  duplex._write = function (chunk: any, encoding: BufferEncoding, callback: (err?: Error | null) => void): void {
    ws.send(chunk, {}, callback)
  }

  duplex.on('end', duplexOnEnd)
  duplex.on('error', duplexOnError)
  return duplex
}
