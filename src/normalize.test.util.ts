import { render } from '@markup-carve/carve'
import type { Element, ElementContent, Root, RootContent } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import { normalizeUri } from 'micromark-util-sanitize-uri'
import rehypeStringify from 'rehype-stringify'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { carveParse, type Options } from './index.js'

const BLOCK = new Set([
  'fn-notes', 'address', 'aside', 'blockquote', 'caption', 'col', 'colgroup', 'dd', 'details', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'nav', 'ol', 'p', 'pre',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])

type Node = Root | RootContent

function isBlock(node: Node | undefined): boolean {
  return node?.type === 'element' && BLOCK.has(node.tagName)
}

function normalizeChildren(parent: Root | Element): void {
  const merged: Array<RootContent> = []
  for (const child of parent.children as RootContent[]) {
    const prev = merged[merged.length - 1]
    if (child.type === 'comment') continue
    if (child.type === 'text' && prev?.type === 'text') prev.value += child.value
    else merged.push(child.type === 'text' ? { ...child } : child)
  }
  const blockParent = parent.type === 'root' || isBlock(parent)
  const out: RootContent[] = []
  merged.forEach((child, index) => {
    if (child.type === 'text') {
      let value = child.value.replace(/[ \t\n\r\f]+/g, ' ')
      if (isBlock(merged[index - 1]) || (index === 0 && blockParent)) value = value.replace(/^ /, '')
      if (isBlock(merged[index + 1]) || (index === merged.length - 1 && blockParent)) value = value.replace(/ $/, '')
      if (value !== '') out.push({ type: 'text', value })
      return
    }
    if (child.type === 'element' && child.tagName !== 'pre') normalizeChildren(child)
    out.push(child)
  })
  parent.children = out as ElementContent[]
}

function serialize(node: Node): string {
  if (node.type === 'root') return node.children.map(serialize).join('')
  if (node.type === 'text') return node.value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  if (node.type !== 'element') return ''
  const props = Object.entries(node.properties)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => `${k}=${JSON.stringify(Array.isArray(v) ? v.join(' ') : v)}`)
    .sort()
  const children = node.tagName === 'template' ? '' : node.children.map(serialize).join('')
  return `<${node.tagName}${props.length ? ' ' + props.join(' ') : ''}>${children}</${node.tagName}>`
}

function textOf(node: Node): string {
  if (node.type === 'text') return node.value
  return 'children' in node ? node.children.map(textOf).join('') : ''
}

/**
 * Rewrite both footnote shapes, carve-js endnotes and remark-rehype's GFM
 * footnotes, to `<fn-ref>` and `<fn-notes>` so the notes themselves compare.
 */
function abstractFootnotes(parent: Root | Element): void {
  parent.children = parent.children.flatMap((child): ElementContent[] => {
    if (child.type !== 'element') return [child as ElementContent]
    const p = child.properties
    if (child.tagName === 'a' && p['role'] === 'doc-noteref') return [fnRef(textOf(child))]
    if (child.tagName === 'sup' && child.children.length === 1) {
      const a = child.children[0]!
      if (a.type === 'element' && a.properties['dataFootnoteRef'] !== undefined) return [fnRef(textOf(a))]
    }
    if (child.tagName === 'a' && (p['role'] === 'doc-backlink' || p['dataFootnoteBackref'] !== undefined)) return []
    if (child.tagName === 'section' && (p['role'] === 'doc-endnotes' || p['dataFootnotes'] !== undefined)) {
      const list = child.children.find((c): c is Element => c.type === 'element' && c.tagName === 'ol')
      const notes = (list?.children ?? []).filter((c): c is Element => c.type === 'element' && c.tagName === 'li')
      for (const note of notes) {
        note.properties = {}
        abstractFootnotes(note)
        // carve-js gives a backlink its own paragraph when the note ends in another block.
        const last = note.children.filter((c) => c.type !== 'text' || c.value.trim() !== '').at(-1)
        if (last?.type === 'element' && last.tagName === 'p' && textOf(last).trim() === '' && last.children.every((c) => c.type === 'text')) {
          note.children = note.children.filter((c) => c !== last)
        }
      }
      return [{ type: 'element', tagName: 'fn-notes', properties: {}, children: notes }]
    }
    abstractFootnotes(child)
    return [child]
  })
}

function fnRef(n: string): Element {
  return { type: 'element', tagName: 'fn-ref', properties: { n }, children: [] }
}

/** A known, documented way the unified output differs from carve-js, applied to the carve-js side. */
export interface AcceptedDifference {
  reason: string
  apply(tree: Root): void
}

function visitElements(parent: Root | Element, fn: (element: Element) => void): void {
  for (const child of parent.children) {
    if (child.type !== 'element') continue
    fn(child)
    visitElements(child, fn)
  }
}

export const TASK_CHECKBOX_NAME: AcceptedDifference = {
  reason: 'remark-rehype builds the task checkbox from mdast `checked`, and node data cannot reach it, so it has no aria-label',
  apply(tree) {
    visitElements(tree, (el) => {
      if (el.tagName === 'input' && el.properties['type'] === 'checkbox') delete el.properties['ariaLabel']
    })
  },
}

export const CODE_ATTRIBUTES_ON_CODE: AcceptedDifference = {
  reason: 'remark-rehype applies a code node\'s data to the inner <code>, so block attributes and the header title land there instead of on <pre>',
  apply(tree) {
    visitElements(tree, (el) => {
      const code = el.children[0]
      if (el.tagName !== 'pre' || code?.type !== 'element' || code.tagName !== 'code') return
      const { className, ...rest } = el.properties
      const own = (code.properties['className'] as string[] | undefined) ?? []
      code.properties = { ...code.properties, ...rest }
      if (className) code.properties['className'] = [...own, ...(className as string[])]
      el.properties = {}
    })
  },
}

export const URL_ENCODING: AcceptedDifference = {
  reason: 'remark-rehype percent-encodes link and image destinations (micromark normalizeUri); carve-js writes them as authored',
  apply(tree) {
    visitElements(tree, (el) => {
      for (const key of ['href', 'src']) {
        const value = el.properties[key]
        if (typeof value === 'string') el.properties[key] = normalizeUri(value)
      }
    })
  },
}

/** A canonical form of an HTML fragment: attribute order and inter-block whitespace do not count. */
export function canonicalHtml(html: string, accepted: AcceptedDifference[] = []): string {
  const tree = fromHtml(html, { fragment: true })
  for (const difference of accepted) difference.apply(tree)
  abstractFootnotes(tree)
  normalizeChildren(tree)
  return serialize(tree)
}

/** HTML from the unified pipeline the README documents. */
export function viaUnified(source: string, options?: Options): string {
  return String(
    unified()
      .use(carveParse, options)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeStringify, { allowDangerousHtml: true })
      .processSync(source),
  )
}

export function viaCarve(source: string, options: Options = {}): string {
  const includes = options.includes === undefined ? {} : { includes: options.includes }
  return render(source, { sections: options.sections !== false, rawHtml: options.rawHtml === true, ...includes })
}
