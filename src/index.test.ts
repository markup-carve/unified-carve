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
import { cases } from './cases.test.util.js'

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

const partResolver = ({ path }: { path: string }) =>
  path === 'part.crv'
    ? { text: 'Included text.\n\nSecond *part*.\n', id: path }
    : { error: 'not_found' as const }

test('carveToMdast expands includes through the includes option', () => {
  const tree = carveToMdast('{{ part.crv }}\n', { includes: partResolver, sections: false })
  const first = tree.children[0]!
  assert.ok(first.type === 'paragraph')
  assert.deepEqual(first.children, [
    { type: 'text', value: 'Included text.', position: { start: { line: 1, column: 1 }, end: { line: 1, column: 15 } } },
  ])
})

test('the plugin passes an IncludeConfig to the parse and renders as carve-js does', () => {
  const includes = { resolver: partResolver, file: 'main.crv' }
  assert.equal(
    canonicalHtml(viaUnified('Intro.\n\n{{ part.crv }}\n\nOutro.\n', { includes })),
    canonicalHtml(viaCarve('Intro.\n\n{{ part.crv }}\n\nOutro.\n', { includes })),
  )
})

test('included nodes keep lines and columns of their file and main-source offsets after the include', () => {
  const tree = carveToMdast('{{ part.crv }}\n\nOutro.\n', { includes: partResolver, sections: false })
  const [included, second, outro] = tree.children
  assert.deepEqual(included!.position, { start: { line: 1, column: 1 }, end: { line: 1, column: 15 } })
  assert.equal(second!.position?.start.line, 3)
  assert.equal(second!.position?.start.offset, undefined)
  assert.deepEqual(outro!.position?.start, { line: 3, column: 1, offset: 16 })
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
