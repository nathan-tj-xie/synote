import { describe, expect, it } from 'vitest'
import { parseLfsPointer } from './lfs'

const oid = 'a'.repeat(64)
const enc = (s: string) => new TextEncoder().encode(s)
const ptr = (body: string) => enc(`version https://git-lfs.github.com/spec/v1\n${body}`)

describe('parseLfsPointer', () => {
  it('识别标准指针和旧版 hawser 指针', () => {
    expect(parseLfsPointer(ptr(`oid sha256:${oid}\nsize 12345\n`))).toEqual({ oid, size: 12345 })
    expect(parseLfsPointer(enc(`version https://hawser.github.com/spec/v1\noid sha256:${oid}\nsize 0\n`))).toEqual({ oid, size: 0 })
    // 扩展字段（ext-*）按字母序排在 oid 前面
    expect(parseLfsPointer(ptr(`ext-0-foo sha256:${'b'.repeat(64)}\noid sha256:${oid}\nsize 1\n`))).toEqual({ oid, size: 1 })
  })

  it('格式不严格符合的一律不是指针', () => {
    const bad = [
      '',
      `oid sha256:${oid}\nsize 1\n`, // 缺 version
      `version https://example.com/spec/v1\noid sha256:${oid}\nsize 1\n`, // 未知 version
    ].map(enc)
    bad.push(
      ptr(`oid sha256:${oid}\nsize 1`), // 末尾没有 LF
      ptr(`size 1\noid sha256:${oid}\n`), // 没按字母序
      ptr(`oid sha256:${oid}\noid sha256:${oid}\nsize 1\n`), // 重复 key
      ptr(`oid sha256:${oid.toUpperCase()}\nsize 1\n`), // hex 必须小写
      ptr(`oid sha256:${oid.slice(1)}\nsize 1\n`), // 长度不对
      ptr(`oid md5:${oid}\nsize 1\n`),
      ptr(`oid sha256:${oid}\nsize -1\n`),
      ptr(`oid sha256:${oid}\n`), // 缺 size
      ptr(`oid sha256:${oid}\r\nsize 1\r\n`), // CRLF
      ptr(`oid sha256:${oid}\nsize 1\n\n`), // 多余空行
      ptr(`oid sha256:${oid}\nsize 1\nzz ${'x'.repeat(1024)}\n`), // ≥ 1024 字节
      new Uint8Array([...ptr(`oid sha256:${oid}\nsize 1\n`), 0xff]), // 不是 UTF-8
    )
    for (const b of bad) expect(parseLfsPointer(b)).toBeNull()
  })
})
