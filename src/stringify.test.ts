import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { Root } from 'mdast'
import { unified } from 'unified'
import { render, validateTree } from '@markup-carve/carve'
import { carveParse, carveStringify, carveToMdast, fromMdast, mdastToCarve, mdastToCarveWithDiagnostics } from './index.js'
import { cases } from './cases.test.util.js'
import { canonicalHtml } from './normalize.test.util.js'

const demo = readFileSync(new URL('../test/fixtures/demo.crv', import.meta.url), 'utf8')

function assertRoundTrip(source: string, sections: boolean): void {
  const root = carveToMdast(source, { sections })
  validateTree(fromMdast(root))
  const written = mdastToCarveWithDiagnostics(root)
  assert.deepEqual(written.diagnostics, [])
  assert.equal(canonicalHtml(render(written.source)), canonicalHtml(render(source)))
}

for (const sections of [true, false]) {
  const label = sections ? '' : ' without sections'
  test(`round trip renders as the input: the feature demo${label}`, () => assertRoundTrip(demo, sections))
  for (const [name, source] of cases) {
    test(`round trip renders as the input: ${name}${label}`, () => assertRoundTrip(source, sections))
  }
}

test('an authored note whose label looks generated stays a note', () => {
  const source = 'x^[inline] y[^carve-inline-1]\n\n[^carve-inline-1]: authored\n'
  assert.equal(mdastToCarve(carveToMdast(source)), source)
})

test('carveParse and carveStringify process a document end to end', () => {
  const file = unified().use(carveParse).use(carveStringify).processSync('= Title\n\nSome /em/ and *strong*.\n')
  assert.equal(String(file), '= Title\n\nSome /em/ and *strong*.\n')
  assert.deepEqual(file.messages, [])
})

const t = (value: string) => ({ type: 'text' as const, value })
const paragraph = (...children: Root['children'][number][]) => ({ type: 'paragraph', children }) as Root['children'][number]

test('plain mdast writes canonical Carve', () => {
  const root = {
    type: 'root',
    children: [
      { type: 'heading', depth: 2, children: [t('Title')] },
      paragraph(t('Some '), { type: 'emphasis', children: [t('em')] }, t(', '), { type: 'strong', children: [t('strong')] }, t(', '), { type: 'inlineCode', value: 'code' }, t(' and '), { type: 'link', url: 'https://e.com', title: null, children: [t('a link')] }, t('.')),
      {
        type: 'list', ordered: false, spread: false, children: [
          { type: 'listItem', spread: false, checked: null, children: [paragraph(t('one'))] },
          { type: 'listItem', spread: false, checked: true, children: [paragraph(t('done'))] },
        ],
      },
      { type: 'code', lang: 'js', meta: null, value: 'let a = 1' },
      { type: 'blockquote', children: [paragraph(t('quoted'))] },
      {
        type: 'table', align: ['left', 'right'], children: [
          { type: 'tableRow', children: [{ type: 'tableCell', children: [t('A')] }, { type: 'tableCell', children: [t('B')] }] },
          { type: 'tableRow', children: [{ type: 'tableCell', children: [t('1')] }, { type: 'tableCell', children: [t('2')] }] },
        ],
      },
      { type: 'thematicBreak' },
      paragraph({ type: 'linkReference', identifier: 'ref', label: 'ref', referenceType: 'full', children: [t('see')] }, t(' '), { type: 'delete', children: [t('gone')] }, { type: 'break' }, t('next'), { type: 'footnoteReference', identifier: 'n', label: 'n' }),
      { type: 'definition', identifier: 'ref', label: 'ref', url: '/r', title: 'R' },
      { type: 'footnoteDefinition', identifier: 'n', children: [paragraph(t('note'))] },
    ],
  } as Root
  assert.equal(mdastToCarve(root), [
    '== Title',
    '',
    'Some /em/, *strong*, `code` and [a link](https://e.com).',
    '',
    '- one',
    '- [x] done',
    '',
    '```js',
    'let a = 1',
    '```',
    '',
    '> quoted',
    '',
    '|={<} A |={>} B |',
    '| 1 | 2 |',
    '',
    '***',
    '',
    '[see][ref] {~gone~}\\',
    'next[^n]',
    '',
    '[ref]: /r "R"',
    '',
    '[^n]: note',
    '',
  ].join('\n'))
})

test('a node with no Carve counterpart is reported, not dropped silently', () => {
  const place = { start: { line: 1, column: 1 }, end: { line: 1, column: 4 } }
  const root = { type: 'root', children: [paragraph(t('kept')), { type: 'leafDirective', name: 'x', children: [], position: place }] } as unknown as Root
  const written = mdastToCarveWithDiagnostics(root)
  assert.equal(written.source, 'kept\n')
  assert.deepEqual(written.diagnostics.map((entry) => entry.code), ['mdast-unmapped'])
  const file = unified()
    .use(function () {
      this.parser = () => root
    })
    .use(carveStringify)
    .processSync('')
  assert.equal(String(file), 'kept\n')
  assert.deepEqual(file.messages.map((message) => [message.ruleId, message.source, message.place]), [['mdast-unmapped', 'unified-carve', place]])
})
