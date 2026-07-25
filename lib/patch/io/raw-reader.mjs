import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

function validateRange(offset, length, size, path) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || !Number.isSafeInteger(offset + length)) {
    throw new Error(`reader.slice offset and length must be safe integers — ${path ?? 'buffer'}`)
  }
  if (offset < 0 || length < 0 || offset + length > size) {
    throw new Error(`reader.slice out of bounds [${offset}, ${offset + length}) (size ${size}) — ${path ?? 'buffer'}`)
  }
}

function preadInto(fd, length, position, path) {
  const out = Buffer.allocUnsafe(length)
  let got = 0
  while (got < length) {
    const read = readSync(fd, out, got, length - got, position + got)
    if (read === 0) {
      throw new Error(
        `openFileReader: short read (wanted ${length} @ ${position}, got ${got}) — out of bounds or truncated? ${path}`,
      )
    }
    got += read
  }
  return out
}

class PreadReader {
  constructor(fd, size, path) {
    this.fd = fd
    this.size = size
    this._path = path
  }

  slice(offset, length) {
    if (this.fd == null) throw new Error(`reader used after close() — ${this._path}`)
    validateRange(offset, length, this.size, this._path)
    if (length === 0) return Buffer.alloc(0)
    return preadInto(this.fd, length, offset, this._path)
  }

  u8(offset) { return this.slice(offset, 1)[0] }
  u16(offset) { return this.slice(offset, 2).readUInt16LE(0) }
  u32(offset) { return this.slice(offset, 4).readUInt32LE(0) }
  u64(offset) { return Number(this.slice(offset, 8).readBigUInt64LE(0)) }

  toString(encoding, start, end) { return this.slice(start, end - start).toString(encoding) }

  lastIndexOf(needle, from, to) {
    const window = this.slice(from, to - from)
    const index = window.lastIndexOf(needle)
    return index < 0 ? -1 : from + index
  }

  close() {
    if (this.fd != null) {
      closeSync(this.fd)
      this.fd = null
    }
  }
}

class BufferBackedReader {
  constructor(buffer, path) {
    this._buffer = buffer
    this.size = buffer.length
    this._path = path
  }

  _view() {
    if (this._buffer == null) throw new Error(`reader used after close() — ${this._path ?? 'buffer'}`)
    return this._buffer
  }

  slice(offset, length) {
    const buffer = this._view()
    validateRange(offset, length, buffer.length, this._path)
    if (length === 0) return Buffer.alloc(0)
    return buffer.subarray(offset, offset + length)
  }

  u8(offset) { return this.slice(offset, 1)[0] }
  u16(offset) { return this.slice(offset, 2).readUInt16LE(0) }
  u32(offset) { return this.slice(offset, 4).readUInt32LE(0) }
  u64(offset) { return Number(this.slice(offset, 8).readBigUInt64LE(0)) }

  toString(encoding, start, end) { return this.slice(start, end - start).toString(encoding) }

  lastIndexOf(needle, from, to) {
    const window = this.slice(from, to - from)
    const index = window.lastIndexOf(needle)
    return index < 0 ? -1 : from + index
  }

  close() {
    this._buffer = null
  }
}

function openPreadReader(path) {
  const fd = openSync(path, 'r')
  try {
    return new PreadReader(fd, fstatSync(fd).size, path)
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

export function bufferReader(buffer) {
  return new BufferBackedReader(buffer ?? Buffer.alloc(0), null)
}

export function openFileReader(path) {
  try {
    const mapped = Bun.mmap(path)
    const buffer = Buffer.from(mapped.buffer, mapped.byteOffset, mapped.length)
    return new BufferBackedReader(buffer, path)
  } catch (error) {
    if (process.env.UNBUN_DEBUG) {
      console.error(`[openFileReader] mmap failed (${error.code ?? error.message}), falling back to pread — ${path}`)
    }
    return openPreadReader(path)
  }
}