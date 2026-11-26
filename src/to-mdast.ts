import {
  parse,
  type Attrs,
  type Block,
  type CaptionNode,
  type DocumentNode,
  type Inline,
  type IncludeConfig,
  type IncludeResolver,
  type Position as CarvePosition,
  type TableCellNode,
  type TableNode,
  type TableRowNode,
  type UrlPolicy,
} from '@markup-carve/carve'
import type { Properties } from 'hast'
import type { Root } from 'mdast'
import type { Position } from 'unist'
import { attrList, hasKey, sanitizeUrl, toProperties, type AttrList, type AttrOptions } from './attrs.js'

export interface ToMdastOptions {
  /**
   * Wrap each top-level heading and the content it opens in a `carveSection`
   * node, with the heading id on the section, as carve-js renders by default.
   * With `false` the tree stays flat and the id stays on the heading.
   */
  sections?: boolean
  /**
   * Pass raw HTML (`` `<b>x</b>`{=html} `` and `` ```=html `` blocks) through as
   * mdast `html` nodes. Off by default, as in carve-js: raw HTML then becomes
   * escaped text and a code block.
   */
  rawHtml?: boolean
  /** The carve-js URL policy; a denied destination is written as the empty string. */
  urlPolicy?: UrlPolicy
  /**
   * The carve-js `includes` option, a resolver or an `IncludeConfig`, passed to
   * `parse` by `carveToMdast` and the plugin. `toMdast` reads a tree that is
   * already parsed and ignores it.
   */
  includes?: IncludeConfig | IncludeResolver
  /**
   * The source the tree was parsed from. Carve positions count UTF-8 bytes;
   * with the source, mdast offsets are string offsets. Without it, positions
   * carry lines and columns only.
   */
  source?: string
}

/** A node of the produced tree, kept loose internally and typed at the boundary. */
interface MdNode {
  type: string
  children?: MdNode[]
  value?: string
  data?: { hName?: string; hProperties?: Properties; hChildren?: unknown[]; carveInlineNote?: boolean }
  position?: Position
  [key: string]: unknown
}

interface Context {
  sections: boolean
  rawHtml: boolean
  policy: UrlPolicy | undefined
  offsets: ((byte: number) => number | undefined) | undefined
  admonitionCount: number
  insideLink: boolean
  suppressAbbreviation: boolean
  footnoteDefs: Map<string, Block[]>
  footnoteOrder: string[]
  inlineNotes: Map<string, Inline[]>
  headings: Map<string, Inline[]>
  linkTitles: Map<string, string>
  linkAttrs: Map<string, Attrs>
}

const ADMONITION_LABELS: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  warning: 'Warning',
  danger: 'Danger',
  info: 'Info',
  success: 'Success',
  example: 'Example',
  quote: 'Quote',
}

const SEMANTIC_SPAN_ORDER = ['abbr', 'time', 'kbd']
const SEMANTIC_VALUE_ATTRIBUTE: Record<string, string> = { abbr: 'title', time: 'datetime' }

type TopLevel = DocumentNode['children'][number]

/** Convert a resolved Carve 0.2 tree (`parse(source)`) to mdast. */
export function toMdast(doc: DocumentNode, options: ToMdastOptions = {}): Root {
  const ctx: Context = {
    sections: options.sections !== false,
    rawHtml: options.rawHtml === true,
    policy: options.urlPolicy,
    offsets: options.source === undefined ? undefined : byteOffsets(options.source),
    admonitionCount: 0,
    insideLink: false,
    suppressAbbreviation: false,
    footnoteDefs: new Map(),
    footnoteOrder: [],
    inlineNotes: new Map(),
    headings: new Map(),
    linkTitles: new Map(),
    linkAttrs: new Map(),
  }
  collectTargets(doc.children, ctx)

  const children: MdNode[] = []
  const stack: Array<{ level: number; node: MdNode }> = []
  const target = () => (stack.length ? stack[stack.length - 1]!.node.children! : children)
  for (const block of doc.children) {
    if (block.type === 'heading' && ctx.sections) {
      while (stack.length && stack[stack.length - 1]!.level >= block.level) extendPosition(stack.pop()!.node)
      const id = headingId(block)
      const section = custom('carveSection', 'section', id === undefined ? [] : [['id', id]], [], block.pos, ctx)
      target().push(section)
      stack.push({ level: block.level, node: section })
      section.children!.push(heading(block, ctx, true))
      continue
    }
    target().push(...topLevel(block, ctx))
  }
  while (stack.length) extendPosition(stack.pop()!.node)

  children.push(...footnoteDefinitions(ctx))
  return { type: 'root', children: children as Root['children'] }
}

/** Parse Carve source with carve-js and convert it to mdast. */
export function carveToMdast(source: string, options: ToMdastOptions = {}): Root {
  const includes = options.includes === undefined ? {} : { includes: options.includes }
  return toMdast(parse(source, { positions: true, ...includes }), { ...options, source })
}

function collectTargets(nodes: readonly unknown[], ctx: Context): void {
  for (const node of nodes as Array<{ type?: string; [key: string]: unknown }>) {
    if (!node || typeof node !== 'object') continue
    if (node.type === 'footnote' && !ctx.footnoteDefs.has(node['key'] as string)) {
      ctx.footnoteDefs.set(node['key'] as string, node['children'] as Block[])
    }
    if (node.type === 'link_reference_definition') {
      const key = node['key'] as string
      if (typeof node['tooltip'] === 'string' && !ctx.linkTitles.has(key)) ctx.linkTitles.set(key, node['tooltip'])
      if (node['attrs'] && !ctx.linkAttrs.has(key)) ctx.linkAttrs.set(key, node['attrs'] as Attrs)
    }
    if (node.type === 'heading') {
      const id = headingId(node as unknown as Extract<Block, { type: 'heading' }>)
      if (id !== undefined && !ctx.headings.has(id)) ctx.headings.set(id, node['children'] as Inline[])
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) collectTargets(value, ctx)
    }
  }
}

function headingId(block: Extract<Block, { type: 'heading' }>): string | undefined {
  return block.attrs?.id ?? block.generatedId
}

function topLevel(node: TopLevel, ctx: Context): MdNode[] {
  switch (node.type) {
    case 'frontmatter':
      return node.format === 'yaml' || node.format === 'toml'
        ? [withPosition({ type: node.format, value: node.value.replace(/\n$/, '') }, node.pos, ctx)]
        : []
    case 'link_reference_definition':
      return [withPosition({ type: 'definition', identifier: node.key, label: node.key, url: node.href, title: node.tooltip ?? null }, node.pos, ctx)]
    case 'footnote':
    case 'abbreviation_def':
    case 'citation_definition':
      return []
    default:
      return convertBlock(node, ctx)
  }
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

/** A map from UTF-8 byte offsets to string offsets of `source`. */
function byteOffsets(source: string): (byte: number) => number | undefined {
  const encoder = new TextEncoder()
  const map = new Map<number, number>()
  let bytes = 0
  for (let at = 0; at < source.length;) {
    map.set(bytes, at)
    const codePoint = source.codePointAt(at)!
    const units = codePoint > 0xffff ? 2 : 1
    bytes += encoder.encode(source.slice(at, at + units)).length
    at += units
  }
  map.set(bytes, source.length)
  return (byte) => map.get(byte)
}

function toPosition(pos: CarvePosition | undefined, ctx: Context): Position | undefined {
  if (!pos) return undefined
  const position: Position = {
    start: { line: pos.startLine, column: pos.startColumn },
    end: { line: pos.endLine, column: pos.endColumn },
  }
  // A position in an included file counts bytes of that file, which the map does not cover.
  if (ctx.offsets && pos.file === undefined) {
    const start = ctx.offsets(pos.startOffset)
    const end = ctx.offsets(pos.endOffset)
    if (start !== undefined && end !== undefined) {
      position.start.offset = start
      position.end.offset = end
    }
  }
  return position
}

function withPosition(node: MdNode, pos: CarvePosition | undefined, ctx: Context): MdNode {
  const position = toPosition(pos, ctx)
  if (position) node.position = position
  return node
}

function extendPosition(section: MdNode): void {
  const last = section.children?.[section.children.length - 1]
  if (section.position && last?.position) section.position = { start: section.position.start, end: last.position.end }
}

/** Add attributes to a node; with `before`, they come first and win a clash, as a block's attributes do over its image's. */
function withProps(node: MdNode, list: AttrList, before = false): MdNode {
  if (!list.length) return node
  const added = toProperties(list)
  const merged = before ? mergeProperties(added, node.data?.hProperties ?? {}) : { ...node.data?.hProperties, ...added }
  node.data = { ...node.data, hProperties: merged }
  return node
}

function mergeProperties(first: Properties, second: Properties): Properties {
  const out: Properties = { ...second, ...first }
  const a = first['className'] as string[] | undefined
  const b = second['className'] as string[] | undefined
  if (a && b) out['className'] = [...new Set([...a, ...b])]
  return out
}

function custom(type: string, hName: string, list: AttrList, children: MdNode[], pos: CarvePosition | undefined, ctx: Context): MdNode {
  return withPosition({ type, data: { hName, hProperties: toProperties(list) }, children }, pos, ctx)
}

function attrs(node: { attrs?: Attrs; lang?: string; dir?: string }, ctx: Context, opts?: AttrOptions): AttrList {
  return attrList(node.attrs, ctx.policy, opts, node)
}

// carve-js strips bidi override and isolate controls from rendered text and code (Trojan Source).
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g
// carve-js writes the other control characters, form feed aside, as U+FFFD.
const CONTROLS = /[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/g

function clean(value: string): string {
  return value.replace(BIDI_CONTROLS, '').replace(CONTROLS, '�')
}

function text(value: string, pos: CarvePosition | undefined, ctx: Context): MdNode {
  return withPosition({ type: 'text', value: clean(value) }, pos, ctx)
}

function mergeText(nodes: MdNode[]): MdNode[] {
  const out: MdNode[] = []
  for (const node of nodes) {
    const prev = out[out.length - 1]
    if (node.type === 'text' && prev?.type === 'text') {
      const merged: MdNode = { type: 'text', value: prev.value! + node.value! }
      if (prev.position && node.position) merged.position = { start: prev.position.start, end: node.position.end }
      out[out.length - 1] = merged
    } else {
      out.push(node)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function convertBlocks(blocks: readonly Block[], ctx: Context): MdNode[] {
  return blocks.flatMap((block) => convertBlock(block, ctx))
}

/** A captioned block renders as a figure holding the block and a figcaption. */
/** A captioned block renders as a figure holding the block and a figcaption; the block's attributes go on the figure. */
function captioned(content: MdNode[], caption: CaptionNode | undefined, figureAttrs: AttrList, pos: CarvePosition | undefined, ctx: Context): MdNode[] {
  if (caption === undefined) return content
  return [custom('carveFigure', 'figure', figureAttrs, [...content, figcaption(caption, ctx)], pos, ctx)]
}

function captionContent(caption: CaptionNode, ctx: Context): MdNode[] {
  const visible = caption.children.filter((child) => child.type !== 'comment')
  if (visible.length === 1 && visible[0]!.type === 'paragraph') return inlines(visible[0].children, ctx)
  return convertBlocks(caption.children, ctx)
}

function figcaption(caption: CaptionNode, ctx: Context): MdNode {
  return custom('carveFigureCaption', 'figcaption', [], captionContent(caption, ctx), caption.pos, ctx)
}

function heading(block: Extract<Block, { type: 'heading' }>, ctx: Context, sectioned: boolean): MdNode {
  const node = withPosition({ type: 'heading', depth: block.level, children: inlines(block.children, ctx) }, block.pos, ctx)
  const list = attrs(block, ctx, { tag: `h${block.level}`, dropId: true })
  const id = headingId(block)
  return withProps(node, sectioned || id === undefined ? list : [['id', id], ...list])
}

function paragraph(block: Extract<Block, { type: 'paragraph' }>, ctx: Context, panel?: boolean): MdNode[] {
  const visible = block.children.filter((child) => child.type !== 'comment')
  if (visible.every((child) => child.type === 'soft_break')) return []
  const lone = visible.length === 1 && visible[0]!.type === 'image' && visible[0].src !== undefined ? visible[0] : undefined
  const captionedHere = block.caption !== undefined
  const own = attrs(block, ctx, { tag: captionedHere ? 'figure' : 'p', baseClasses: panel && captionedHere ? ['carve-figure-panel'] : [] })
  let content: MdNode[]
  if (lone) {
    // A paragraph holding one image renders as the bare image, which takes the paragraph's attributes.
    content = inlines(visible, ctx)
    if (!captionedHere) withProps(content[0]!, own, true)
  } else {
    content = [withProps(withPosition({ type: 'paragraph', children: inlines(block.children, ctx) }, block.pos, ctx), captionedHere ? [] : own)]
  }
  return captioned(content, block.caption, own, block.pos, ctx)
}

function convertBlock(block: Block, ctx: Context): MdNode[] {
  switch (block.type) {
    case 'heading':
      return [heading(block, ctx, false)]
    case 'section':
      return [custom('carveSection', 'section', attrs(block, ctx), convertBlocks(block.children, ctx), block.pos, ctx)]
    case 'paragraph':
      return paragraph(block, ctx)
    case 'thematic_break':
      return [withProps(withPosition({ type: 'thematicBreak' }, block.pos, ctx), attrs(block, ctx))]
    case 'code_block':
      return captioned([codeBlock(block, ctx, block.caption === undefined)], block.caption, attrs(block, ctx), block.pos, ctx)
    case 'block_quote': {
      const quote = withPosition({ type: 'blockquote', children: convertBlocks(block.children, ctx) }, block.pos, ctx)
      if (block.caption === undefined) withProps(quote, attrs(block, ctx))
      return captioned([quote], block.caption, attrs(block, ctx), block.pos, ctx)
    }
    case 'list':
      return [list(block, ctx)]
    case 'table':
      return [table(block, ctx)]
    case 'admonition':
      return [admonition(block, ctx)]
    case 'directive': {
      const children = [...titleFloor(block.title, undefined, ctx), ...labelFloor(block.groupLabel, ctx), ...convertBlocks(block.children, ctx)]
      const node = custom('carveDirective', 'div', attrs(block, ctx, { tag: 'div', baseClasses: [block.kind] }), children, block.pos, ctx)
      node['kind'] = block.kind
      return [node]
    }
    case 'div': {
      const children = [...titleFloor(block.title, undefined, ctx), ...labelFloor(block.groupLabel, ctx), ...convertBlocks(block.children, ctx)]
      return [custom('carveDiv', 'div', attrs(block, ctx, { tag: 'div' }), children, block.pos, ctx)]
    }
    case 'line_block':
      return [lineBlock(block, ctx)]
    case 'definition_list':
      return [definitionList(block, ctx)]
    case 'figure_group':
      return [figureGroup(block, ctx)]
    case 'include':
      return block.children ? block.children.flatMap((child) => topLevel(child, ctx)) : []
    case 'raw_block':
      if (block.format !== 'html') return []
      if (ctx.rawHtml) return [withPosition({ type: 'html', value: rawSource(block.value) }, block.pos, ctx)]
      return [withPosition({ type: 'code', lang: 'html', meta: null, value: trimNewline(clean(block.value)) }, block.pos, ctx)]
    case 'block_extension':
      return convertBlocks(block.fallback.length ? block.fallback : block.children, ctx)
    case 'comment':
      return []
    default:
      return []
  }
}

function rawSource(content: string): string {
  return content.endsWith('\n') && !/^\n+$/.test(content) ? content.slice(0, -1) : content
}

function trimNewline(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value
}

function plainText(nodes: readonly Inline[]): string {
  return nodes.map((node) => {
    if ('value' in node && typeof node.value === 'string' && node.type !== 'comment') return node.value
    if ('children' in node && Array.isArray(node.children)) return plainText(node.children as Inline[])
    return ''
  }).join('')
}

function codeBlock(block: Extract<Block, { type: 'code_block' }>, ctx: Context, ownAttrs: boolean): MdNode {
  const node: MdNode = {
    type: 'code',
    lang: block.syntax ?? null,
    meta: block.title === undefined ? null : plainText(block.title),
    value: trimNewline(clean(block.value)),
  }
  const list = ownAttrs ? attrs(block, ctx) : []
  if (block.title !== undefined) list.push(['title', plainText(block.title)])
  if (list.length) {
    // remark-rehype applies node data to the inner <code>, so its language class must be kept here.
    const props = toProperties(list)
    if (block.syntax) props['className'] = [`language-${block.syntax}`, ...((props['className'] as string[] | undefined) ?? [])]
    node.data = { hProperties: props }
  }
  return withPosition(node, block.pos, ctx)
}

function list(block: Extract<Block, { type: 'list' }>, ctx: Context): MdNode {
  const ordered = block.marker.kind === 'ordered'
  const head: AttrList = []
  if (ordered && block.marker.style && block.marker.style !== '1') head.push(['type', block.marker.style])
  if (ordered && block.marker.delimiter === ')') head.push(['data-delim', ')'])
  const isTaskList = block.children.some((item) => item.task !== undefined)
  const own = attrs(block, ctx, isTaskList ? { baseClasses: ['task-list'] } : {})
  const items = block.children.map((item) => {
    const checked = item.task === undefined ? null : item.task.mark.toLowerCase() === 'x'
    const node: MdNode = {
      type: 'listItem',
      spread: block.spacing === 'loose',
      checked,
      children: convertBlocks(item.children, ctx),
    }
    if (item.task === undefined) return withPosition(withProps(node, attrs(item, ctx)), item.pos, ctx)
    const mark = item.task.mark === ' ' ? undefined : item.task.mark.toLowerCase() === 'x' ? 'x' : item.task.mark
    const props: AttrList = mark === undefined ? [] : [['data-task-state', mark]]
    props.push(...attrs(item, ctx, { baseClasses: ['task'], drop: ['data-task-state'] }))
    if (!ordered) props.push(['style', 'list-style: none'])
    return withPosition(withProps(node, props), item.pos, ctx)
  })
  const node: MdNode = {
    type: 'list',
    ordered,
    start: ordered ? (block.marker.start ?? 1) : null,
    spread: block.spacing === 'loose',
    children: items,
  }
  withProps(node, [...head, ...own])
  return withPosition(node, block.pos, ctx)
}

function labelFloor(label: string | undefined, ctx: Context): MdNode[] {
  if (label === undefined) return []
  return [custom('carveContainerLabel', 'p', [['class', 'div-label']], [text(label, undefined, ctx)], undefined, ctx)]
}

function titleFloor(title: Inline[] | undefined, id: string | undefined, ctx: Context): MdNode[] {
  if (title === undefined) return []
  const props: AttrList = [['class', 'admonition-title']]
  if (id !== undefined) props.push(['id', id])
  return [custom('carveContainerTitle', 'p', props, inlines(title, ctx), undefined, ctx)]
}

function admonition(block: Extract<Block, { type: 'admonition' }>, ctx: Context): MdNode {
  const authoredName = hasKey(block.attrs, 'aria-label') || hasKey(block.attrs, 'aria-labelledby')
  let titleId: string | undefined
  const accessible: AttrList = []
  if (!authoredName) {
    if (block.title !== undefined) {
      titleId = `adm-${++ctx.admonitionCount}`
      accessible.push(['aria-labelledby', titleId])
    } else if (ADMONITION_LABELS[block.kind]) {
      accessible.push(['aria-label', ADMONITION_LABELS[block.kind]!])
    }
  }
  const props: AttrList = [...attrs(block, ctx, { tag: 'aside', baseClasses: ['admonition', block.kind] }), ...accessible]
  const children = [...titleFloor(block.title, titleId, ctx), ...labelFloor(block.groupLabel, ctx), ...convertBlocks(block.children, ctx)]
  const node = custom('carveAdmonition', 'aside', props, children, block.pos, ctx)
  node['kind'] = block.kind
  return node
}

function lineBlock(block: Extract<Block, { type: 'line_block' }>, ctx: Context): MdNode {
  // An empty line ends a stanza: each stanza is one paragraph whose lines are joined by breaks.
  const stanzas: MdNode[] = []
  let content: MdNode[] = []
  const flush = () => {
    if (content.length) stanzas.push({ type: 'paragraph', children: content })
    content = []
  }
  const lines = block.children.filter((child) => child.type === 'line')
  let brokenAlready = false
  lines.forEach((line) => {
    if (line.children.length === 0) {
      flush()
      brokenAlready = false
      return
    }
    if (content.length && !brokenAlready) content.push({ type: 'break' })
    const converted = inlines(line.children, ctx)
    // A line ending in a hard break needs no second break before the next line.
    brokenAlready = line.children[line.children.length - 1]?.type === 'hard_break'
    const first = converted[0]
    if (first?.type === 'text') {
      // carve-js keeps a line's leading spaces as no-break spaces.
      first.value = first.value!.replace(/^ +/, (spaces) => ' '.repeat(spaces.length))
    }
    content.push(...converted)
  })
  flush()
  return custom('carveLineBlock', 'div', attrs(block, ctx, { tag: 'div', trailingClasses: ['line-block'] }), stanzas, block.pos, ctx)
}

function definitionList(block: Extract<Block, { type: 'definition_list' }>, ctx: Context): MdNode {
  const children: MdNode[] = []
  for (const child of block.children) {
    if (child.type === 'definition_term') {
      children.push(custom('carveDefinitionTerm', 'dt', attrs(child, ctx), inlines(child.children, ctx), child.pos, ctx))
    } else if (child.type === 'definition_description') {
      const visible = child.children.filter((node) => node.type !== 'comment')
      const only = visible.length === 1 ? visible[0] : undefined
      const body = only?.type === 'paragraph' && only.caption === undefined ? inlines(only.children, ctx) : convertBlocks(child.children, ctx)
      children.push(custom('carveDefinitionDescription', 'dd', attrs(child, ctx), body, child.pos, ctx))
    }
  }
  return custom('carveDefinitionList', 'dl', attrs(block, ctx), children, block.pos, ctx)
}

function figureGroup(block: Extract<Block, { type: 'figure_group' }>, ctx: Context): MdNode {
  const children: MdNode[] = []
  for (const child of block.children) {
    if (child.type === 'paragraph') children.push(...paragraph(child, ctx, child.caption !== undefined))
    else if (child.type === 'table') children.push(custom('carveFigure', 'figure', [['class', 'carve-figure-panel']], [table(child, ctx)], undefined, ctx))
    else children.push(...convertBlock(child, ctx))
  }
  if (block.caption !== undefined) children.push(figcaption(block.caption, ctx))
  return custom('carveFigureGroup', 'figure', attrs(block, ctx, { baseClasses: ['carve-figure-group'] }), children, block.pos, ctx)
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

interface PlacedCell {
  cell: TableCellNode
  column: number
}

type RowGroup = Extract<TableNode['children'][number], { type: 'table_head' | 'table_body' | 'table_foot' }>

/** The cells a row renders, with the first column each one covers; span continuations render nothing. */
function placeRows(rows: TableRowNode[]): PlacedCell[][] {
  const covered: number[][] = []
  return rows.map((row, r) => {
    const taken = covered[r] ?? []
    const placed: PlacedCell[] = []
    let column = 0
    for (const cell of row.children) {
      while (taken[column]) column++
      if (cell.span !== undefined) {
        column++
        continue
      }
      const colspan = cell.colspan ?? 1
      const rowspan = cell.rowspan ?? 1
      for (let dr = 1; dr < rowspan; dr++) {
        const next = (covered[r + dr] ??= [])
        for (let dc = 0; dc < colspan; dc++) next[column + dc] = 1
      }
      placed.push({ cell, column })
      column += colspan
    }
    return placed
  })
}

function rowsOf(group: RowGroup): TableRowNode[] {
  return group.children.filter((row): row is TableRowNode => row.type === 'table_row')
}

function cellStyle(cell: TableCellNode, column: number, node: TableNode): string | undefined {
  const align = cell.align ?? node.columns[column]?.resolvedAlign
  const valign = cell.valign ?? node.columns[column]?.resolvedValign
  if (!align && !valign) return undefined
  return [align ? `text-align: ${align};` : '', valign ? `vertical-align: ${valign};` : ''].filter(Boolean).join(' ')
}

function cellProps(placed: PlacedCell, node: TableNode, inHead: boolean, ctx: Context): AttrList {
  const { cell } = placed
  const out: AttrList = []
  if (cell.header && !hasKey(cell.attrs, 'scope')) out.push(['scope', cell.scope ?? (inHead ? 'col' : 'row')])
  const structural: AttrList = []
  if ((cell.rowspan ?? 1) > 1) structural.push(['rowspan', String(cell.rowspan)])
  if ((cell.colspan ?? 1) > 1) structural.push(['colspan', String(cell.colspan)])
  if (cell.headerIds?.length) structural.push(['headers', cell.headerIds.join(' ')])
  // Spans are structure, never authored attributes; an authored style comes before the alignment.
  const own = attrs(cell, ctx, { drop: ['rowspan', 'colspan', ...structural.map(([name]) => name)] })
  const authoredStyle = own.find(([name]) => name.toLowerCase() === 'style')
  const style = cellStyle(cell, placed.column, node)
  if (style) {
    if (authoredStyle) authoredStyle[1] = authoredStyle[1].trim() === '' ? style : `${authoredStyle[1].trim()} ${style}`
    else structural.push(['style', style])
  }
  return [...out, ...own, ...structural]
}

/** Table attributes carve-js reads as table configuration and does not write. */
const TABLE_CONFIG_KEYS = ['aligns', 'valigns', 'widths', 'header-rows', 'footer-rows', 'body-rows', 'body-header-rows', 'body-header-cols']

function cellContent(cell: TableCellNode, ctx: Context): MdNode[] {
  const children = cell.children.filter((child) => child.type !== 'comment')
  if (children.length === 1 && children[0]!.type === 'cell_paragraph') return inlines(children[0].children, ctx)
  return children.flatMap((child) => child.type === 'cell_paragraph'
    ? [{ type: 'paragraph', children: inlines(child.children, ctx) }]
    : convertBlock(child, ctx))
}

function widthPercentage(width: number): string {
  return String(Number((width * 100).toFixed(10)))
}

function isGfmTable(node: TableNode, groups: RowGroup[]): boolean {
  if (node.caption || node.columns.some((column) => column.width !== undefined)) return false
  if (groups.some((group) => group.attrs !== undefined || group.type === 'table_foot')) return false
  const [head, body, ...rest] = groups
  if (head?.type !== 'table_head' || rest.length || (body !== undefined && body.type !== 'table_body')) return false
  if (body?.type === 'table_body' && body.rowHeadColumns) return false
  const headRows = rowsOf(head)
  if (headRows.length !== 1) return false
  const rows = [...headRows, ...(body ? rowsOf(body) : [])]
  const width = node.columns.length
  return rows.every((row, r) => row.children.length === width && row.children.every((cell) =>
    cell.span === undefined && (cell.rowspan ?? 1) === 1 && (cell.colspan ?? 1) === 1 && cell.header === (r === 0) &&
    cell.children.length === 1 && cell.children[0]!.type === 'cell_paragraph'))
}

function table(node: TableNode, ctx: Context): MdNode {
  const groups = node.children.filter((child): child is RowGroup => child.type !== 'comment')
  const ownAttrs = attrs(node, ctx, { drop: TABLE_CONFIG_KEYS })
  if (isGfmTable(node, groups)) return gfmTable(node, groups, ownAttrs, ctx)

  const children: MdNode[] = []
  if (node.caption) children.push(custom('carveTableCaption', 'caption', [], captionContent(node.caption, ctx), node.caption.pos, ctx))
  if (node.columns.some((column) => column.width !== undefined)) {
    const cols = node.columns.map((column) => custom(
      'carveElement',
      'col',
      column.width === undefined ? [] : [['style', `width: ${widthPercentage(column.width)}%;`]],
      [],
      undefined,
      ctx,
    ))
    children.push(custom('carveElement', 'colgroup', [], cols, undefined, ctx))
  }
  const allRows = groups.flatMap(rowsOf)
  const placed = placeRows(allRows)
  let offset = 0
  for (const group of groups) {
    const rows = rowsOf(group)
    const hName = group.type === 'table_head' ? 'thead' : group.type === 'table_foot' ? 'tfoot' : 'tbody'
    const rowNodes = rows.map((row, i) => {
      const cells = placed[offset + i]!.map((entry) => {
        const tag = entry.cell.header ? 'th' : 'td'
        return custom('carveTableCell', tag, cellProps(entry, node, group.type === 'table_head', ctx), cellContent(entry.cell, ctx), entry.cell.pos, ctx)
      })
      return custom('carveTableRow', 'tr', attrs(row, ctx), cells, row.pos, ctx)
    })
    offset += rows.length
    children.push(custom('carveTableSection', hName, attrs(group, ctx), rowNodes, group.pos, ctx))
  }
  return custom('carveTable', 'table', ownAttrs, children, node.pos, ctx)
}

function gfmTable(node: TableNode, groups: RowGroup[], ownAttrs: AttrList, ctx: Context): MdNode {
  const rows = groups.flatMap(rowsOf)
  const placed = placeRows(rows)
  const children = rows.map((row, r) => {
    const cells = placed[r]!.map((entry) => {
      const cell = withPosition({ type: 'tableCell', children: cellContent(entry.cell, ctx) }, entry.cell.pos, ctx)
      cell.data = { hProperties: { align: undefined, ...toProperties(cellProps(entry, node, r === 0, ctx)) } }
      return cell
    })
    return withProps(withPosition({ type: 'tableRow', children: cells }, row.pos, ctx), attrs(row, ctx))
  })
  const align = node.columns.map((column, c) => rows[0]!.children[c]?.align ?? column.resolvedAlign ?? null)
  return withProps(withPosition({ type: 'table', align, children }, node.pos, ctx), ownAttrs)
}

// ---------------------------------------------------------------------------
// Inlines
// ---------------------------------------------------------------------------

function inlines(nodes: readonly Inline[], ctx: Context): MdNode[] {
  return mergeText(nodes.flatMap((node) => inline(node, ctx)))
}

function within<T>(ctx: Context, key: 'insideLink' | 'suppressAbbreviation', value: boolean, fn: () => T): T {
  const previous = ctx[key]
  ctx[key] = value
  try {
    return fn()
  } finally {
    ctx[key] = previous
  }
}

/** The source spelling of an unresolved reference, which carve-js renders as text. */
function referenceText(node: { key?: string; refForm?: string; attrs?: Attrs }, label: MdNode[], ctx: Context, bang = ''): MdNode[] {
  const tail = node.refForm === 'collapsed' ? '[]' : node.refForm === 'shortcut' ? '' : `[${node.key ?? ''}]`
  return [text(`${bang}[`, undefined, ctx), ...label, text(`]${tail}${attrSource(node.attrs)}`, undefined, ctx)]
}

function attrSource(attrs: Attrs | undefined): string {
  if (!attrs) return ''
  const parts = [
    ...(attrs.id === undefined ? [] : [`#${attrs.id}`]),
    ...(attrs.classes ?? []).map((c) => `.${c}`),
    ...(attrs.keyValues ?? []).map(([k, v]) => (/^[^\s"'{}]+$/.test(v) ? `${k}=${v}` : `${k}="${v.replace(/"/g, '\\"')}"`)),
  ]
  return parts.length ? `{${parts.join(' ')}}` : ''
}

/** A resolved reference takes its definition's attributes; its own come first in a clash, its classes last. */
function referenceAttrs(node: { key?: string; attrs?: Attrs }, ctx: Context): Attrs | undefined {
  const def = node.key === undefined ? undefined : ctx.linkAttrs.get(node.key)
  if (!def) return node.attrs
  const own = node.attrs ?? {}
  const merged: Attrs = {}
  const id = own.id ?? def.id
  if (id !== undefined) merged.id = id
  const classes = [...(def.classes ?? []), ...(own.classes ?? [])]
  if (classes.length) merged.classes = classes
  const keyValues = [...(own.keyValues ?? []), ...(def.keyValues ?? [])]
  if (keyValues.length) merged.keyValues = keyValues
  return merged
}

function wrap(type: string, hName: string, node: { attrs?: Attrs; pos?: CarvePosition; children: Inline[] }, ctx: Context): MdNode {
  return custom(type, hName, attrs(node, ctx), inlines(node.children, ctx), node.pos, ctx)
}

function link(url: string | undefined, title: string | null, children: MdNode[], list: AttrList, pos: CarvePosition | undefined, ctx: Context): MdNode {
  const node: MdNode = { type: 'link', url: sanitizeUrl(url, ctx.policy), title, children }
  return withProps(withPosition(node, pos, ctx), list)
}

function inline(node: Inline, ctx: Context): MdNode[] {
  switch (node.type) {
    case 'text':
      return [text(node.value, node.pos, ctx)]
    case 'soft_break':
      return [text('\n', node.pos, ctx)]
    case 'smart_punctuation':
      return [text(node.glyph, node.pos, ctx)]
    case 'non_breaking_space':
      return node.attrs
        ? [custom('carveSpan', 'span', attrs(node, ctx), [text(' ', undefined, ctx)], node.pos, ctx)]
        : [text(' ', node.pos, ctx)]
    case 'emphasis':
    case 'strong':
      return [withProps(withPosition({ type: node.type, children: inlines(node.children, ctx) }, node.pos, ctx), attrs(node, ctx))]
    case 'strike': {
      const del = withProps(withPosition({ type: 'delete', children: inlines(node.children, ctx) }, node.pos, ctx), attrs(node, ctx))
      del.data = { ...del.data, hName: 's' }
      return [del]
    }
    case 'underline':
      return [wrap('carveUnderline', 'u', node, ctx)]
    case 'superscript':
      return [wrap('carveSuperscript', 'sup', node, ctx)]
    case 'subscript':
      return [wrap('carveSubscript', 'sub', node, ctx)]
    case 'highlight':
      return [wrap('carveHighlight', 'mark', node, ctx)]
    case 'insert':
      return [wrap('carveInsert', 'ins', node, ctx)]
    case 'delete':
      return [wrap('carveDelete', 'del', node, ctx)]
    case 'critic_comment':
      return [custom('carveCriticComment', 'span', [['class', 'critic-comment']], [text(node.value, undefined, ctx)], node.pos, ctx)]
    case 'code':
      return [withProps(withPosition({ type: 'inlineCode', value: clean(node.value) }, node.pos, ctx), attrs(node, ctx))]
    case 'link': {
      if (node.href === undefined) return referenceText(node, inlines(node.children, ctx), ctx)
      if (ctx.insideLink) return inlines(node.children, ctx)
      const children = within(ctx, 'insideLink', true, () => inlines(node.children, ctx))
      const title = node.tooltip ?? (node.key === undefined ? undefined : ctx.linkTitles.get(node.key))
      const list = attrs({ ...node, attrs: referenceAttrs(node, ctx) }, ctx, { drop: ['href', ...(title === undefined ? [] : ['title'])] })
      return [link(node.href, title ?? null, children, list, node.pos, ctx)]
    }
    case 'image': {
      if (node.src === undefined) return referenceText(node, [text(node.alt ?? '', undefined, ctx)], ctx, '!')
      const title = node.tooltip ?? (node.key === undefined ? undefined : ctx.linkTitles.get(node.key))
      const list = attrs({ ...node, attrs: referenceAttrs(node, ctx) }, ctx, { drop: ['src', 'alt', ...(title === undefined ? [] : ['title'])] })
      const image: MdNode = { type: 'image', url: sanitizeUrl(node.src, ctx.policy), alt: node.alt ?? '', title: title ?? null }
      return [withProps(withPosition(image, node.pos, ctx), list)]
    }
    case 'autolink': {
      const display = node.text ?? node.href
      if (ctx.insideLink) return [text(display, node.pos, ctx)]
      return [link(node.href, null, [text(display, undefined, ctx)], attrs(node, ctx, { drop: ['href'] }), node.pos, ctx)]
    }
    case 'xref': {
      const resolved = node.namespace === 'heading' ? ctx.headings.get(node.key) : undefined
      if (node.href === undefined || resolved === undefined) return [text(`</#${node.key}>`, node.pos, ctx)]
      if (ctx.insideLink) return inlines(resolved, ctx).map(stripPosition)
      const children = within(ctx, 'insideLink', true, () => inlines(resolved, ctx).map(stripPosition))
      return [link(node.href, null, children, attrs(node, ctx, { drop: ['href'] }), node.pos, ctx)]
    }
    case 'span':
      return [semanticSpan(node, ctx)]
    case 'ruby': {
      const children: MdNode[] = []
      for (const pair of node.pairs) {
        children.push(
          ...inlines(pair.base, ctx),
          custom('carveElement', 'rp', [], [text('(', undefined, ctx)], undefined, ctx),
          custom('carveRubyText', 'rt', [], inlines(pair.annotation, ctx), undefined, ctx),
          custom('carveElement', 'rp', [], [text(')', undefined, ctx)], undefined, ctx),
        )
      }
      return [custom('carveRuby', 'ruby', attrs(node, ctx), children, node.pos, ctx)]
    }
    case 'small_caps':
      return [custom('carveSmallCaps', 'span', attrs(node, ctx, { baseClasses: ['smallcaps'] }), inlines(node.children, ctx), node.pos, ctx)]
    case 'math': {
      const props: AttrList = attrs(node, ctx, { baseClasses: ['math', node.display ? 'display' : 'inline'] })
      if (!hasKey(node.attrs, 'role')) props.push(['role', 'math'])
      const body = clean(node.display ? `\\[${node.value}\\]` : `\\(${node.value}\\)`)
      const math: MdNode = withPosition({
        type: 'inlineMath',
        value: node.value,
        data: { hName: 'span', hProperties: toProperties(props), hChildren: [{ type: 'text', value: body }] },
      }, node.pos, ctx)
      if (node.number === undefined) return [math]
      const label = `${node.numberPrefix ?? ''}${node.number}`
      return [math, text(' ', undefined, ctx), custom('carveElement', 'span', [['class', 'equation-number']], [text(`(${label})`, undefined, ctx)], undefined, ctx)]
    }
    case 'raw_inline':
      if (node.format !== 'html') return []
      return ctx.rawHtml ? [withPosition({ type: 'html', value: node.value }, node.pos, ctx)] : [text(node.value, node.pos, ctx)]
    case 'literal_inline': {
      const props = attrs(node, ctx)
      return props.length ? [custom('carveSpan', 'span', props, [text(node.value, undefined, ctx)], node.pos, ctx)] : [text(node.value, node.pos, ctx)]
    }
    case 'symbol': {
      const value = `:${node.name}:`
      return node.attrs ? [custom('carveSpan', 'span', attrs(node, ctx), [text(value, undefined, ctx)], node.pos, ctx)] : [text(value, node.pos, ctx)]
    }
    case 'mention':
    case 'tag': {
      const value = node.type === 'mention' ? `@${node.target}` : `#${node.name}`
      const strong: MdNode = { type: 'strong', children: [text(value, undefined, ctx)] }
      const type = node.type === 'mention' ? 'carveMention' : 'carveTag'
      return [custom(type, 'span', attrs(node, ctx, { baseClasses: [node.type] }), [strong], node.pos, ctx)]
    }
    case 'inline_extension': {
      const ext = custom('carveExtension', 'span', attrs(node, ctx, { baseClasses: [`ext-${node.name}`] }), inlines(node.fallback ?? node.children, ctx), node.pos, ctx)
      ext['name'] = node.name
      return [ext]
    }
    case 'abbreviation':
      if (ctx.suppressAbbreviation || node.expansion === undefined) return [text(node.key, node.pos, ctx)]
      return [custom('carveAbbreviation', 'abbr', [['title', node.expansion]], [text(node.key, undefined, ctx)], node.pos, ctx)]
    case 'footnote_ref': {
      if (node.number === undefined || !ctx.footnoteDefs.has(node.key)) return [text(`[^${node.key}]`, node.pos, ctx)]
      noteFootnote(ctx, node.key)
      return [withPosition({ type: 'footnoteReference', identifier: node.key, label: node.key }, node.pos, ctx)]
    }
    case 'inline_footnote': {
      if (node.number === undefined) return [text('[^]', node.pos, ctx)]
      let identifier = `carve-inline-${node.number}`
      while (ctx.footnoteDefs.has(identifier) || ctx.inlineNotes.has(identifier)) identifier += '-'
      ctx.inlineNotes.set(identifier, node.children)
      noteFootnote(ctx, identifier)
      return [withPosition({ type: 'footnoteReference', identifier, label: identifier }, node.pos, ctx)]
    }
    case 'hard_break':
      return [withPosition({ type: 'break' }, node.pos, ctx)]
    case 'caption_number':
      return [text(node.n === undefined ? '#' : String(node.n), node.pos, ctx)]
    case 'citation_group':
      return [text(node.raw, node.pos, ctx)]
    case 'comment':
      return []
    default:
      return []
  }
}

function stripPosition(node: MdNode): MdNode {
  delete node.position
  node.children?.forEach(stripPosition)
  return node
}

function semanticSpan(node: Extract<Inline, { type: 'span' }>, ctx: Context): MdNode {
  const pairs = node.attrs?.keyValues ?? []
  const valueOf = (name: string) => pairs.find(([key]) => key === name)?.[1]
  const names = SEMANTIC_SPAN_ORDER.filter((name) => valueOf(name) !== undefined)
  const body = within(ctx, 'suppressAbbreviation', ctx.suppressAbbreviation || valueOf('abbr') !== undefined, () => inlines(node.children, ctx))
  if (names.length === 0) return custom('carveSpan', 'span', attrs(node, ctx), body, node.pos, ctx)
  const riding: Attrs = { ...node.attrs, keyValues: pairs.filter(([key]) => !SEMANTIC_SPAN_ORDER.includes(key)) }
  const outermost = names[names.length - 1]
  let children = body
  let result: MdNode | undefined
  for (const name of names) {
    const value = valueOf(name)!
    const mapsTo = value !== '' ? SEMANTIC_VALUE_ATTRIBUTE[name] : undefined
    const own: Attrs = name === outermost ? riding : {}
    const derived: AttrList = mapsTo !== undefined && !hasKey(own, mapsTo) ? [[mapsTo, value]] : []
    result = custom('carveSpan', name, [...derived, ...attrList(own, ctx.policy)], children, name === outermost ? node.pos : undefined, ctx)
    children = [result]
  }
  return result!
}

// ---------------------------------------------------------------------------
// Footnotes
// ---------------------------------------------------------------------------

function noteFootnote(ctx: Context, identifier: string): void {
  if (!ctx.footnoteOrder.includes(identifier)) ctx.footnoteOrder.push(identifier)
}

function footnoteDefinitions(ctx: Context): MdNode[] {
  const out: MdNode[] = []
  // A note body can reference further notes, which grows the order while this loop runs.
  for (let i = 0; i < ctx.footnoteOrder.length; i++) {
    const identifier = ctx.footnoteOrder[i]!
    const inlineBody = ctx.inlineNotes.get(identifier)
    const children = within(ctx, 'insideLink', false, () => inlineBody
      ? [{ type: 'paragraph', children: inlines(inlineBody, ctx) }]
      : convertBlocks(ctx.footnoteDefs.get(identifier) ?? [], ctx))
    const definition: MdNode = { type: 'footnoteDefinition', identifier, label: identifier, children }
    // Marks the notes `inline_footnote` produced, which `fromMdast` writes back inline.
    if (inlineBody) definition.data = { carveInlineNote: true }
    out.push(definition)
  }
  return out
}
