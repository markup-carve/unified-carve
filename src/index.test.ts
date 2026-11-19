import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { Root } from 'mdast'
import { unified } from 'unified'
import { parse } from '@markup-carve/carve'
import { carveParse, carveToMdast, toMdast } from './index.js'
import {
  canonicalHtml,
  CODE_ATTRIBUTES_ON_CODE,
  TASK_CHECKBOX_NAME,
  URL_ENCODING,
  viaCarve,
  viaUnified,
  type AcceptedDifference,
} from './normalize.test.util.js'

const demo = readFileSync(new URL('../test/fixtures/demo.crv', import.meta.url), 'utf8')

function assertEquivalent(source: string, accepted: AcceptedDifference[] = [], sections = true, rawHtml = false): void {
  assert.equal(
    canonicalHtml(viaUnified(source, { sections, rawHtml })),
    canonicalHtml(viaCarve(source, { sections, rawHtml }), accepted),
  )
}

test('the feature demo renders as carve-js renders it', () => {
  assertEquivalent(demo, [TASK_CHECKBOX_NAME, CODE_ATTRIBUTES_ON_CODE])
})

test('the feature demo without sections matches carve-js with sections off', () => {
  assertEquivalent(demo, [TASK_CHECKBOX_NAME, CODE_ATTRIBUTES_ON_CODE], false)
})

const cases: Array<[string, string, AcceptedDifference[]?]> = [
  // U-065, U-066, U-067, U-068: braced underline, strike and highlight; strong outside emphasis.
  ['inline formatting', '/em/ *strong* */both/* {_u_} {~s~} {=mark=} x{^2^} H{,2,}O `code` !`lit`\n'],
  // U-069: the substitution arrow is a deletion and an insertion.
  ['editorial markup', '{+in+} {-out-} {-old-}{+new+} {#note#}\n'],
  ['escapes and smart punctuation', '\\*no\\* "quoted" it\'s --- -- ... (tm) 10\\ kg\n'],
  ['hard break and soft break', 'a \\\nb\nc\n'],
  ['links', '[a](https://e.com "T") <https://e.com> <mailto:a@b.c> [r][] [missing][nope]\n\n[r]: /r "R"\n'],
  ['nested links unwrap', '[a [b](/b) c](/a)\n'],
  ['dangerous destinations are blanked', '[x](javascript:alert(1)) ![y](data:x)\n'],
  ['percent-encoded destinations', '[x](a\\b)\n', [URL_ENCODING]],
  ['images', '![alt](a.png "t"){.big}\n\nText ![inline](b.png) here.\n'],
  ['figure with a numbered caption', '![a](a.png)\n^ Figure #: Cap\n\n> q\n^ Who\n'],
  ['headings, ids and sections', '{#top .lead}\n# One\n\ntext\n\n## Two\n\n### Three\n\n# Four\n\nsee </#top>\n'],
  // The upgrade tool escapes `a.`, which 0.1 read as text.
  ['lists', '- a\n- b\n\n. one\n. two\n\n3) three\n4) four\n\na\\. x\nb. y\n'],
  // U-018: a blank line between items makes the list loose.
  ['loose list', '- a\n\n  b\n\n- c\n'],
  ['task list', '- [ ] todo\n- [x] done\n- [-] dropped\n', [TASK_CHECKBOX_NAME]],
  ['task item with its own class', '-{.c} [ ] todo\n- [x] done\n', [TASK_CHECKBOX_NAME]],
  ['definition lists', ':: Term\n: one\n:: Two\n: a\n\n  b\n'],
  ['block quote', '> a\n>\n> b\n'],
  // U-056: alignment marks in braces.
  ['GFM-shaped table', '|= A |={>} B |={~} C |\n| 1 | 2 | 3 |\n'],
  // The upgrade tool writes a first-column `<`, which 0.1 read as an empty cell, as an empty cell.
  ['table with spans and no header', '| a | b |\n| ^ | c |\n|  | d |\n'],
  ['table with a header span', '|= H |= G |\n| 1 | 2 |\n| ^ | 3 |\n'],
  ['table with a caption and widths', '{widths=0.3,0.7}\n|= a |= b |\n| 1 | 2 |\n^ Table #: t\n'],
  ['table attributes', '{.wide #t}\n|= a |\n| 1 |\n'],
  ['admonitions and directives', '::: note\nplain\n:::\n\n::: tip "Title"\nbody\n:::\n\n{.x}\n::: custom [lbl]\nz\n:::\n'],
  ['generic div', '{#c .k}\n:::\ninside\n:::\n'],
  ['line block', '::: |\nline one\n  line two\n:::\n'],
  ['composite figure', '::: figure\n![one](a.png)\n^ (a) One\n\n![two](b.png)\n^ (b) Two\n:::\n^ Figure #: Both\n'],
  ['code blocks', '```js\nlet a = 1\n```\n\n```\nplain\n```\n'],
  ['code block with a header', '```js "a.js"\nx\n```\n', [CODE_ATTRIBUTES_ON_CODE]],
  ['raw passthrough', '`<b>b</b>`{=html} `x`{=latex}\n\n```=html\n<div>raw</div>\n```\n\n```=latex\n\\x\n```\n'],
  ['math', '$`a+b` and $$`c`\n'],
  ['semantic spans', '[Ctrl]{kbd} [HTML]{abbr="HyperText"} [x]{.c #i k=v} [d]{time="2026-01-01"}\n'],
  ['abbreviations', '*[HTML]: HyperText Markup Language\n\nHTML here.\n'],
  ['mentions, tags and extensions', '@alice #tag :spoiler[hidden] [x]{:tada:}\n'],
  ['comments', '%% gone\ntext %% trailing\n'],
  ['frontmatter', '---\ntitle: x\n---\n\nbody\n'],
  ['footnotes', 'a[^n] b[^n] c^[inline]\n\n[^n]: note\n'],
  ['inline note beside a label that looks generated', 'x^[inline] y[^carve-inline-1]\n\n[^carve-inline-1]: authored\n'],
  ['footnote ending in a block', 'a[^n]\n\n[^n]: note\n\n    > quoted\n'],
  ['thematic break with attributes', '{.sep}\n***\n'],
  ['bidi controls are stripped', 'a‮b `c‮d`\n'],
]

for (const [name, source, accepted] of cases) {
  test(`HTML equivalence: ${name}`, () => assertEquivalent(source, accepted ?? []))
}

// U-076, U-077: raw HTML passes through only when the host sets rawHtml.
test('raw HTML passes through with rawHtml, as carve-js renders it', () => {
  assertEquivalent('`<b>b</b>`{=html}\n\n```=html\n<div>raw</div>\n```\n', [], true, true)
})

test('raw HTML is escaped by default', () => {
  const html = viaUnified('`<b>b</b>`{=html}\n\n```=html\n<div>raw</div>\n```\n')
  assert.ok(!html.includes('<b>') && !html.includes('<div>'), html)
  assert.ok(html.includes('&#x3C;b>b&#x3C;/b>'), html)
})

test('the URL policy blanks a denied destination', () => {
  const tree = carveToMdast('[a](ftp://x/y) [b](/ok)\n', { urlPolicy: { deny: ['ftp'] } })
  const paragraph = tree.children[0]!
  assert.ok(paragraph.type === 'paragraph')
  const urls = paragraph.children.flatMap((node) => (node.type === 'link' ? [node.url] : []))
  assert.deepEqual(urls, ['', '/ok'])
})

test('offsets count string positions, not UTF-8 bytes', () => {
  const tree = carveToMdast('ä\n\nb\n', { sections: false })
  assert.deepEqual(tree.children[1]!.position?.start, { line: 3, column: 1, offset: 3 })
})

test('an included file reaches mdast through the include resolver', () => {
  const files: Record<string, string> = { 'part.crv': 'Included *text*.\n' }
  const resolver = ({ path }: { path: string }) =>
    Object.hasOwn(files, path) ? { text: files[path]!, id: path } : { error: 'not_found' as const }
  const source = '{{ part.crv }}\n'
  const tree = toMdast(parse(source, { includes: resolver, positions: true }), { sections: false, source })
  assert.deepEqual(types(tree), ['root', 'paragraph', 'text', 'strong', 'text', 'text'])
  // Offsets of an included file are not offsets of the including source.
  assert.equal(tree.children[0]!.position?.start.offset, undefined)
})

function types(tree: Root): string[] {
  const out: string[] = []
  const walk = (node: { type: string; children?: unknown[] }) => {
    out.push(node.type)
    for (const child of (node.children ?? []) as Array<{ type: string }>) walk(child)
  }
  walk(tree)
  return out
}

test('carveParse is a unified parser', () => {
  const tree = unified().use(carveParse).parse('/a/ *b*') as Root
  assert.equal(tree.type, 'root')
  assert.deepEqual(types(tree), ['root', 'paragraph', 'emphasis', 'text', 'text', 'strong', 'text'])
})

// U-056, U-066: 0.2 spells alignment and strike in braces.
test('standard constructs map to mdast nodes', () => {
  const tree = carveToMdast('---\nt: 1\n---\n\n# H\n\n- [x] a\n\n|= A |={>} B |\n| 1 | 2 |\n\nx[^n] [l](/u) {~s~}\n\n[^n]: note\n', { sections: false })
  const seen = new Set(types(tree))
  for (const type of ['yaml', 'heading', 'list', 'listItem', 'table', 'tableRow', 'tableCell', 'footnoteReference', 'footnoteDefinition', 'link', 'delete']) {
    assert.ok(seen.has(type), `missing ${type}`)
  }
  const table = tree.children.find((node) => node.type === 'table')
  assert.ok(table?.type === 'table')
  assert.deepEqual(table.align, [null, 'right'])
  const list = tree.children.find((node) => node.type === 'list')
  assert.ok(list?.type === 'list')
  assert.equal(list.children[0]!.checked, true)
})

// U-065, U-067: 0.2 spells underline and highlight in braces.
test('constructs without an mdast node become carve* nodes', () => {
  const tree = carveToMdast('::: note\n{_u_} {=m=} x{^2^}\n:::\n\n:: T\n: d\n')
  const seen = types(tree)
  for (const type of ['carveAdmonition', 'carveUnderline', 'carveHighlight', 'carveSuperscript', 'carveDefinitionList', 'carveDefinitionTerm', 'carveDefinitionDescription']) {
    assert.ok(seen.includes(type), `missing ${type}`)
  }
})

test('top-level headings open carveSection nodes unless sections are off', () => {
  const sectioned = carveToMdast('# A\n\n## B\n\ntext\n')
  assert.deepEqual(types(sectioned), ['root', 'carveSection', 'heading', 'text', 'carveSection', 'heading', 'text', 'paragraph', 'text'])
  const flat = carveToMdast('# A\n\n## B\n\ntext\n', { sections: false })
  assert.deepEqual(types(flat), ['root', 'heading', 'text', 'heading', 'text', 'paragraph', 'text'])
  const heading = flat.children[0]!
  assert.deepEqual(heading.data?.hProperties, { id: 'A' })
})

test('nodes keep the source positions carve-js reports', () => {
  const tree = carveToMdast('para\n\n# Head\n', { sections: false })
  assert.deepEqual(tree.children[0]!.position, {
    start: { line: 1, column: 1, offset: 0 },
    end: { line: 1, column: 5, offset: 4 },
  })
  assert.equal(tree.children[1]!.position?.start.line, 3)
})

test('a section ends where its last block ends', () => {
  const tree = carveToMdast('# A\n\n## B\n\nunder b\n\n## C\n\nunder c\n')
  const a = tree.children[0]!
  assert.ok(a.type === 'carveSection')
  const [, b, c] = a.children
  assert.equal(b?.position?.end.line, 5)
  assert.equal(c?.position?.end.line, 9)
  assert.equal(a.position?.end.line, 9)
})
