import GithubSlugger from 'github-slugger'
import { describe, expect, it } from 'vitest'
import { anchorLine, destination, headingAnchors, linkTarget, parseWiki, pickWiki, relativeLink, slug, slugger } from './url'

describe('linkTarget 路径解析', () => {
  it('子目录与 ..', () => {
    expect(linkTarget('b.md', '日记/a.md')).toEqual({ path: '日记/b.md', anchor: null })
    expect(linkTarget('sub/b.md', 'a.md')).toEqual({ path: 'sub/b.md', anchor: null })
    expect(linkTarget('../笔记/b.md', '日记/2024/a.md')).toEqual({ path: '日记/笔记/b.md', anchor: null })
    expect(linkTarget('../../b.md', 'x/y/a.md')).toEqual({ path: 'b.md', anchor: null })
    expect(linkTarget('./b.md', 'x/a.md')).toEqual({ path: 'x/b.md', anchor: null })
    expect(linkTarget('/根/b.md', 'x/a.md')).toEqual({ path: '根/b.md', anchor: null })
  })
  it('越出笔记库、外链为 null', () => {
    expect(linkTarget('../b.md', 'a.md')).toBeNull()
    expect(linkTarget('https://x.com/a.md', 'a.md')).toBeNull()
    expect(linkTarget('mailto:a@b', 'a.md')).toBeNull()
  })
  it('空格（%20、尖括号）与中文', () => {
    expect(linkTarget('我的%20笔记.md', 'a.md')).toEqual({ path: '我的 笔记.md', anchor: null })
    expect(linkTarget(destination('<我的 笔记.md>'), 'a.md')).toEqual({ path: '我的 笔记.md', anchor: null })
    expect(linkTarget('%E4%B8%AD%E6%96%87.md', 'a.md')).toEqual({ path: '中文.md', anchor: null })
  })
  it('锚点：解码，只有锚点时指向自身', () => {
    expect(linkTarget('b.md#第二节', 'a.md')).toEqual({ path: 'b.md', anchor: '第二节' })
    expect(linkTarget('b.md#%E7%AC%AC%E4%BA%8C%E8%8A%82', 'a.md')).toEqual({ path: 'b.md', anchor: '第二节' })
    expect(linkTarget('sub/b%23c.md#h-1', 'a.md')).toEqual({ path: 'sub/b#c.md', anchor: 'h-1' })
    expect(linkTarget('#标题', 'x/a.md')).toEqual({ path: 'x/a.md', anchor: '标题' })
    expect(linkTarget('b.md#', 'a.md')).toEqual({ path: 'b.md', anchor: null })
  })
  it('relativeLink 写出的链接解析回原路径', () => {
    for (const [note, p] of [['日记/今天.md', '笔记/目标 笔记.md'], ['a b/c.md', 'a b/d e.md'], ['x.md', '深/层/(1)#.md']])
      expect(linkTarget(relativeLink(note, p), note)?.path).toBe(p)
  })
})

describe('[[...]]', () => {
  it('名字、路径、锚点与别名', () => {
    expect(parseWiki('同名')).toEqual({ path: null, name: '同名', anchor: null, text: '同名' })
    expect(parseWiki('b.md#标题|别名')).toEqual({ path: null, name: 'b', anchor: '标题', text: '别名' })
    expect(parseWiki('dir/sub|显示')).toEqual({ path: 'dir/sub.md', name: null, anchor: null, text: '显示' })
    expect(parseWiki('../x')).toBeNull()
    expect(parseWiki(' |别名')).toBeNull()
  })
  it('同名取路径最小的那篇', () => {
    expect(pickWiki('n', ['z/n.md', 'a/n.md', 'n.txt', 'a/nn.md'])).toBe('a/n.md')
    expect(pickWiki('无', ['a.md'])).toBeNull()
  })
})

describe('GitHub slug', () => {
  it('小写、去标点、空格换 -，中文保留', () => {
    expect(slug('Hello World!')).toBe('hello-world')
    expect(slug('第二节 小结')).toBe('第二节-小结')
    expect(slug('C++ 入门：基础')).toBe('c-入门基础')
    expect(slug('A & B')).toBe('a--b')
    expect(slug('foo_bar-baz')).toBe('foo_bar-baz')
    expect(slug('Ünïcödé 😀')).toBe('ünïcödé-')
  })
  it('与 github-slugger 一致', () => {
    const samples = ['Hello  World', 'Hello World!', '第二节 小结', 'C++ 入门：基础', 'A & B', 'foo_bar-baz', 'Ünïcödé 😀', '  前后空格  ', 'Tab\there', '«引号» “中文”', 'a.b/c', '日本語の見出し', 'Ελληνικά', '100% 完成?', 'emoji 🎉 end', '—破折号—']
    const ours = slugger()
    const theirs = new GithubSlugger()
    for (const s of [...samples, ...samples]) expect(ours(s)).toBe(theirs.slug(s))
  })
  it('重复标题加 -1、-2，已占用的后缀跳过', () => {
    const next = slugger()
    expect(['a', 'a', 'a-1', 'a', 'A'].map(next)).toEqual(['a', 'a-1', 'a-1-1', 'a-2', 'a-3'])
  })
  it('按渲染后的文字算，带所在行', () => {
    const text = ['# 标题', '', '## **粗** `码` [链](x.md)', '段落', '', '标题', '===', '> ### 引用里', '```', '# 不是标题', '```'].join('\n')
    expect(headingAnchors(text)).toEqual([
      { slug: '标题', line: 1 },
      { slug: '粗-码-链', line: 3 },
      { slug: '标题-1', line: 6 },
      { slug: '引用里', line: 8 },
    ])
    expect(anchorLine(text, '标题-1')).toBe(6)
    expect(anchorLine(text, 'Hello')).toBeNull()
    expect(anchorLine('## Hello World', 'Hello World')).toBe(1) // 手写的未转换锚点按 slug 再比一次
    expect(headingAnchors('# Hello  <b>World</b>\n## a <span class="x">b</span>').map((h) => h.slug)).toEqual(['hello--world', 'a-b'])
  })
})
