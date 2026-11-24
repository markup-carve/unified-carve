import {
  headingId,
  writeWithDiagnostics,
  type Attrs,
  type Block,
  type CaptionNode,
  type Diagnostic,
  type DocumentNode,
  type Inline,
  type TableCellNode,
  type TableNode,
  type TableRowNode,
  type WriteOutput,
} from '@markup-carve/carve'
import type { Root } from 'mdast'
import type { Position } from 'unist'
import { find, html } from 'property-information'

export interface StringifyOptions {
  /** Pad the cells of each column of a pipe table to one display width, as carve-js `write` does. */
  alignTables?: boolean
}

/** The Carve tree of an mdast tree, and an entry for each node that has no Carve counterpart. */
export interface FromMdastResult {
  document: DocumentNode
  diagnostics: Diagnostic[]
}

/** A node of the input tree, read loosely: mdast nodes and the `carve*` nodes of `toMdast`. */
interface MdNode {
  type: string
  children?: MdNode[]
  value?: string
  data?: { hName?: string; hProperties?: Record<string, unknown> }
  position?: Position
  [key: string]: unknown
}

interface Context {
  diagnostics: Diagnostic[]
  places: Map<Diagnostic, Position>
  definitions: DocumentNode['children']
  abbreviations: Map<string, string>
  inlineNotes: Map<string, MdNode[]>
}

type TopLevel = DocumentNode['children'][number]

interface AttrOptions {
  /** Classes the renderer adds itself, which the source does not spell. */
  classes?: string[]
  /** Attributes the renderer derives from structure. */
  keys?: string[]
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

const places = new WeakMap<Diagnostic, Position>()

/** The mdast position of the node an `mdast-unmapped` entry is about. */
export function diagnosticPlace(diagnostic: Diagnostic): Position | undefined {
  return places.get(diagnostic)
}

/** Convert mdast, including the `carve*` nodes `toMdast` writes, to a Carve 0.2 tree. */
export function fromMdastWithDiagnostics(root: Root): FromMdastResult {
  const ctx: Context = { diagnostics: [], places: new Map(), definitions: [], abbreviations: new Map(), inlineNotes: new Map() }
  const nodes = root.children as unknown as MdNode[]
  for (const node of nodes) {
    if (node.type === 'footnoteDefinition' && String(node['identifier']).startsWith('carve-inline-')) {
      ctx.inlineNotes.set(String(node['identifier']), node.children ?? [])
    }
  }
  const front: TopLevel[] = []
  const body: TopLevel[] = []
  for (const node of nodes) {
    if (node.type === 'yaml' || node.type === 'toml') front.push({ type: 'frontmatter', format: node.type, value: `${node.value ?? ''}\n` })
    else body.push(...blocks([node], ctx))
  }
  const abbreviations: TopLevel[] = [...ctx.abbreviations].map(([key, expansion]) => ({ type: 'abbreviation_def', key, expansion, namespace: 'abbr' }))
  const document: DocumentNode = { type: 'document', astVersion: '2.0', children: [...front, ...abbreviations, ...body, ...ctx.definitions] }
  return { document, diagnostics: ctx.diagnostics }
}

export function fromMdast(root: Root): DocumentNode {
  return fromMdastWithDiagnostics(root).document
}

/** Carve source for mdast, with the unmapped nodes first and then the writer's own entries. */
export function mdastToCarveWithDiagnostics(root: Root, options: StringifyOptions = {}): WriteOutput {
  const { document, diagnostics } = fromMdastWithDiagnostics(root)
  const written = writeWithDiagnostics(document, writeOptions(options))
  return { source: written.source, diagnostics: [...diagnostics, ...written.diagnostics] }
}

export function mdastToCarve(root: Root, options: StringifyOptions = {}): string {
  return mdastToCarveWithDiagnostics(root, options).source
}

export function writeOptions(options: StringifyOptions): { alignTables?: boolean } {
  return options.alignTables === undefined ? {} : { alignTables: options.alignTables }
}

function unmapped(node: MdNode, ctx: Context): void {
  const entry: Diagnostic = {
    code: 'mdast-unmapped',
    severity: 'warning',
    channel: 'render-loss',
    message: `The mdast node ${node.type} has no Carve counterpart and was left out.`,
  }
  ctx.diagnostics.push(entry)
  if (node.position) places.set(entry, node.position)
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

/** hast properties back to Carve attributes, without what the renderer adds itself. */
function attrsOf(node: MdNode, opts: AttrOptions = {}): Attrs | undefined {
  const props = node.data?.hProperties
  if (!props) return undefined
  const out: Attrs = {}
  const dropped = new Set((opts.keys ?? []).map((key) => key.toLowerCase()))
  const keyValues: Array<[string, string]> = []
  for (const [property, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (property === 'id') {
      if (!dropped.has('id')) out.id = String(value)
      continue
    }
    if (property === 'className') {
      const classes = (value as unknown[]).map(String).filter((name) => !(opts.classes ?? []).includes(name))
      if (classes.length) out.classes = classes
      continue
    }
    const name = find(html, property).attribute
    if (dropped.has(name.toLowerCase())) continue
    keyValues.push([name, value === true ? '' : Array.isArray(value) ? value.join(' ') : String(value)])
  }
  if (keyValues.length) out.keyValues = keyValues
  return out.id === undefined && out.classes === undefined && out.keyValues === undefined ? undefined : out
}

function prop(node: MdNode, name: string): string | undefined {
  const value = node.data?.hProperties?.[name]
  return value === undefined || value === null ? undefined : Array.isArray(value) ? value.join(' ') : String(value)
}

function hasClass(node: MdNode, name: string): boolean {
  const value = node.data?.hProperties?.['className']
  return Array.isArray(value) && value.includes(name)
}

/** Adds an attribute-less field only when it has a value, so the tree carries no `undefined` members. */
function withAttrs<T extends object>(node: T, attrs: Attrs | undefined): T {
  return attrs === undefined ? node : { ...node, attrs }
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function blocks(nodes: readonly MdNode[] | undefined, ctx: Context): Block[] {
  return (nodes ?? []).flatMap((node) => block(node, ctx))
}

function block(node: MdNode, ctx: Context): Block[] {
  switch (node.type) {
    case 'carveSection':
      return section(node, ctx)
    case 'heading':
      return [heading(node, undefined, ctx)]
    case 'paragraph':
      return [paragraph(inlines(node.children, ctx), attrsOf(node))]
    case 'image':
    case 'imageReference':
      return [paragraph(inline(node, ctx), undefined)]
    case 'thematicBreak':
      return [withAttrs({ type: 'thematic_break' }, attrsOf(node))]
    case 'code':
      return [codeBlock(node)]
    case 'html':
      return [{ type: 'raw_block', format: 'html', value: `${node.value ?? ''}\n` }]
    case 'math':
      return [paragraph([{ type: 'math', display: true, value: node.value ?? '' }], undefined)]
    case 'blockquote':
      return [withAttrs({ type: 'block_quote', children: blocks(node.children, ctx) }, attrsOf(node))]
    case 'list':
      return [list(node, ctx)]
    case 'table':
      return [gfmTable(node, ctx)]
    case 'carveTable':
      return [carveTable(node, ctx)]
    case 'carveAdmonition':
    case 'carveDirective':
    case 'carveDiv':
      return [container(node, ctx)]
    case 'carveLineBlock':
      return [lineBlock(node, ctx)]
    case 'carveDefinitionList':
      return [definitionList(node, ctx)]
    case 'carveFigure':
      return figure(node, ctx)
    case 'carveFigureGroup':
      return [figureGroup(node, ctx)]
    case 'definition':
      ctx.definitions.push(withAttrs({
        type: 'link_reference_definition',
        key: String(node['identifier'] ?? node['label'] ?? ''),
        namespace: 'link',
        href: String(node['url'] ?? ''),
        ...(typeof node['title'] === 'string' ? { tooltip: node['title'] } : {}),
      }, undefined))
      return []
    case 'footnoteDefinition':
      if (!ctx.inlineNotes.has(String(node['identifier']))) {
        ctx.definitions.push({ type: 'footnote', key: String(node['identifier']), namespace: 'footnote', children: blocks(node.children, ctx) })
      }
      return []
    case 'yaml':
    case 'toml':
      unmapped(node, ctx)
      return []
    default:
      unmapped(node, ctx)
      return []
  }
}

/** A paragraph holding only an image or display math has that role, which a caption needs. */
function paragraph(content: Inline[], attrs: Attrs | undefined): Block {
  // A line `toMdast` dropped (a comment) leaves the soft break before it behind.
  const children = content.slice(0, content.length - trailingBreaks(content))
  const [only, ...rest] = children
  const role = rest.length ? undefined : only?.type === 'image' ? 'image' : only?.type === 'math' && only.display ? 'math' : undefined
  return withAttrs({ type: 'paragraph', children, ...(role === undefined ? {} : { role }) }, attrs)
}

function trailingBreaks(nodes: Inline[]): number {
  let count = 0
  while (nodes[nodes.length - 1 - count]?.type === 'soft_break') count++
  return count
}

/** A section unwraps to its blocks; its id goes back on the heading that opened it. */
function section(node: MdNode, ctx: Context): Block[] {
  const [first, ...rest] = node.children ?? []
  if (first?.type !== 'heading') return blocks(node.children, ctx)
  return [heading(first, prop(node, 'id'), ctx), ...blocks(rest, ctx)]
}

function heading(node: MdNode, sectionId: string | undefined, ctx: Context): Block {
  const children = inlines(node.children, ctx)
  const attrs = attrsOf(node) ?? {}
  const id = sectionId ?? attrs.id
  // An id the heading text generates anyway is not written back.
  if (id === undefined || id === headingId(plain(node))) delete attrs.id
  else attrs.id = id
  const hasAttrs = attrs.id !== undefined || attrs.classes !== undefined || attrs.keyValues !== undefined
  return withAttrs({ type: 'heading', level: Number(node['depth'] ?? 1), children }, hasAttrs ? attrs : undefined)
}

function codeBlock(node: MdNode, caption?: CaptionNode, figureAttrs?: Attrs): Block {
  const lang = typeof node['lang'] === 'string' ? node['lang'] : undefined
  const meta = typeof node['meta'] === 'string' ? node['meta'] : undefined
  const attrs = figureAttrs ?? attrsOf(node, { classes: lang === undefined ? [] : [`language-${lang}`], keys: meta === undefined ? [] : ['title'] })
  return withAttrs({
    type: 'code_block',
    value: `${node.value ?? ''}\n`,
    ...(lang === undefined ? {} : { syntax: lang }),
    ...(meta === undefined ? {} : { title: [{ type: 'text', value: meta }] }),
    ...(caption === undefined ? {} : { caption }),
  }, attrs) as Block
}

function list(node: MdNode, ctx: Context): Block {
  const ordered = node['ordered'] === true
  const items = node.children ?? []
  const start = Number(node['start'] ?? 1)
  const style = prop(node, 'type')
  const marker = ordered
    ? { kind: 'ordered' as const, delimiter: prop(node, 'dataDelim') ?? '.', style: style ?? '1', ...(start === 1 ? {} : { start }) }
    : { kind: 'bullet' as const, char: '-' }
  const spread = node['spread'] === true || items.some((item) => item['spread'] === true)
  return withAttrs({
    type: 'list',
    marker,
    spacing: spread ? 'loose' : 'tight',
    children: items.map((item) => {
      const checked = item['checked']
      const task = checked === true || checked === false ? { mark: prop(item, 'dataTaskState') ?? (checked ? 'x' : ' ') } : undefined
      const attrs = task === undefined ? attrsOf(item) : attrsOf(item, { classes: ['task'], keys: ['data-task-state', 'style'] })
      return withAttrs({ type: 'list_item' as const, children: blocks(item.children, ctx), ...(task === undefined ? {} : { task }) }, attrs)
    }),
  }, attrsOf(node, { classes: ['task-list'], keys: ['type', 'data-delim'] }))
}

function container(node: MdNode, ctx: Context): Block {
  const rest = [...(node.children ?? [])]
  const titleNode = rest[0]?.type === 'carveContainerTitle' ? rest.shift() : undefined
  const labelNode = rest[0]?.type === 'carveContainerLabel' ? rest.shift() : undefined
  const head = {
    ...(titleNode === undefined ? {} : { title: inlines(titleNode.children, ctx) }),
    ...(labelNode === undefined ? {} : { groupLabel: plain(labelNode) }),
  }
  const children = blocks(rest, ctx)
  const kind = String(node['kind'] ?? '')
  if (node.type === 'carveAdmonition') {
    const keys = [...(titleNode === undefined ? [] : ['aria-labelledby'])]
    if (titleNode === undefined && prop(node, 'ariaLabel') === ADMONITION_LABELS[kind]) keys.push('aria-label')
    return withAttrs({ type: 'admonition', kind: kind as 'note', ...head, children }, attrsOf(node, { classes: ['admonition', kind], keys }))
  }
  if (node.type === 'carveDirective') {
    return withAttrs({ type: 'directive', kind: kind as 'toc', ...head, children }, attrsOf(node, { classes: [kind] }))
  }
  return withAttrs({ type: 'div', ...head, children }, attrsOf(node))
}

function lineBlock(node: MdNode, ctx: Context): Block {
  const lines: Array<{ type: 'line'; children: Inline[] }> = []
  ;(node.children ?? []).forEach((stanza, i) => {
    if (i > 0) lines.push({ type: 'line', children: [] })
    let current: MdNode[] = []
    const flush = () => {
      const first = current[0]
      // carve-js renders a line's leading spaces as no-break spaces.
      if (first?.type === 'text') current[0] = { ...first, value: first.value!.replace(/^ +/, (run) => ' '.repeat(run.length)) }
      lines.push({ type: 'line', children: inlines(current, ctx) })
      current = []
    }
    for (const child of stanza.children ?? []) {
      if (child.type === 'break') flush()
      else current.push(child)
    }
    flush()
  })
  return withAttrs({ type: 'line_block', children: lines }, attrsOf(node, { classes: ['line-block'] }))
}

function definitionList(node: MdNode, ctx: Context): Block {
  type Entry = { type: 'definition_term'; children: Inline[]; attrs?: Attrs } | { type: 'definition_description'; children: Block[]; attrs?: Attrs }
  const children = (node.children ?? []).flatMap((child): Entry[] => {
    if (child.type === 'carveDefinitionTerm') return [withAttrs({ type: 'definition_term' as const, children: inlines(child.children, ctx) }, attrsOf(child))]
    if (child.type === 'carveDefinitionDescription') return [withAttrs({ type: 'definition_description' as const, children: flowOrParagraph(child.children, ctx) }, attrsOf(child))]
    unmapped(child, ctx)
    return []
  })
  return withAttrs({ type: 'definition_list', children }, attrsOf(node))
}

/** Content `toMdast` flattened to phrasing when it was one paragraph. */
function flowOrParagraph(nodes: MdNode[] | undefined, ctx: Context): Block[] {
  const list = nodes ?? []
  if (list.length && list.every(isPhrasing)) return [paragraph(inlines(list, ctx), undefined)]
  return blocks(list, ctx)
}

const FLOW_TYPES = new Set([
  'paragraph', 'heading', 'thematicBreak', 'blockquote', 'list', 'table', 'code', 'math', 'definition', 'footnoteDefinition', 'yaml', 'toml',
  'carveSection', 'carveAdmonition', 'carveDirective', 'carveDiv', 'carveLineBlock', 'carveDefinitionList', 'carveFigure', 'carveFigureGroup', 'carveTable',
])

function isPhrasing(node: MdNode): boolean {
  if (node.type === 'html') return !/\n/.test(node.value ?? '')
  return !FLOW_TYPES.has(node.type)
}

function caption(node: MdNode, ctx: Context): CaptionNode {
  return { type: 'caption', children: flowOrParagraph(node.children, ctx) }
}

/** A figure holds one captioned block, or one table panel of a figure group. */
function figure(node: MdNode, ctx: Context, panel = false): Block[] {
  const content = [...(node.children ?? [])]
  const captionNode = content[content.length - 1]?.type === 'carveFigureCaption' ? content.pop() : undefined
  const attrs = attrsOf(node, { classes: panel ? ['carve-figure-panel'] : [] })
  const [only] = content
  if (content.length !== 1 || only === undefined) {
    unmapped(node, ctx)
    return blocks(content, ctx)
  }
  const cap = captionNode === undefined ? undefined : caption(captionNode, ctx)
  if (only.type === 'code') return [codeBlock(only, cap, attrs)]
  const [inner] = block(only, ctx)
  if (inner === undefined) return []
  if (!('caption' in inner) && !['paragraph', 'block_quote', 'table', 'code_block'].includes(inner.type)) {
    unmapped(node, ctx)
    return [inner]
  }
  const out = { ...inner, ...(cap === undefined ? {} : { caption: cap }) } as Block & { attrs?: Attrs }
  if (attrs !== undefined) out.attrs = attrs
  else delete out.attrs
  return [out]
}

function figureGroup(node: MdNode, ctx: Context): Block {
  const content = [...(node.children ?? [])]
  const captionNode = content[content.length - 1]?.type === 'carveFigureCaption' ? content.pop() : undefined
  const children = content.flatMap((child) => (child.type === 'carveFigure' ? figure(child, ctx, hasClass(child, 'carve-figure-panel')) : block(child, ctx)))
  return withAttrs({
    type: 'figure_group',
    children,
    ...(captionNode === undefined ? {} : { caption: caption(captionNode, ctx) }),
  }, attrsOf(node, { classes: ['carve-figure-group'] }))
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

type Align = 'left' | 'right' | 'center'
type Valign = 'top' | 'middle' | 'bottom' | 'baseline'

/** Splits the alignment declarations `toMdast` derives off a cell's style. */
function cellAlignment(node: MdNode): { align?: Align; valign?: Valign; style?: string } {
  const style = prop(node, 'style')
  if (style === undefined) return {}
  let align: Align | undefined
  let valign: Valign | undefined
  const rest = style.replace(/(^|\s)text-align: (left|right|center);/, (_m, _s, value: Align) => {
    align = value
    return ''
  }).replace(/(^|\s)vertical-align: (top|middle|bottom|baseline);/, (_m, _s, value: Valign) => {
    valign = value
    return ''
  }).trim()
  return { ...(align ? { align } : {}), ...(valign ? { valign } : {}), ...(rest ? { style: rest } : {}) }
}

function cellNode(node: MdNode, header: boolean, ctx: Context, columnAlign?: Align | null): TableCellNode {
  const { align, valign, style } = cellAlignment(node)
  let ownAttrs = attrsOf(node, { keys: ['style', 'scope', 'rowspan', 'colspan', 'headers'] })
  if (style !== undefined) ownAttrs = { ...ownAttrs, keyValues: [...(ownAttrs?.keyValues ?? []), ['style', style]] }
  const scope = prop(node, 'scope')
  const defaultScope = header ? 'col' : 'row'
  const rowspan = Number(prop(node, 'rowSpan') ?? 1)
  const colspan = Number(prop(node, 'colSpan') ?? 1)
  const headers = prop(node, 'headers')
  const children = node.children ?? []
  const cellAlign = align ?? columnAlign ?? undefined
  return withAttrs({
    type: 'table_cell',
    header: node.data?.hName === 'th' || (node.data?.hName === undefined && header),
    children: children.length && children.every(isPhrasing)
      ? [{ type: 'cell_paragraph', children: inlines(children, ctx) }]
      : children.length === 0 ? [{ type: 'cell_paragraph', children: [] }] : blocks(children, ctx),
    ...(cellAlign ? { align: cellAlign } : {}),
    ...(valign ? { valign } : {}),
    ...(scope !== undefined && scope !== defaultScope ? { scope: scope as 'row' } : {}),
    ...(rowspan > 1 ? { rowspan } : {}),
    ...(colspan > 1 ? { colspan } : {}),
    ...(headers ? { headerIds: headers.split(' ') } : {}),
  }, ownAttrs)
}

function gfmTable(node: MdNode, ctx: Context): Block {
  const rows = node.children ?? []
  const align = (Array.isArray(node['align']) ? node['align'] : []) as Array<Align | null>
  const width = Math.max(align.length, ...rows.map((row) => row.children?.length ?? 0))
  const tableRows = rows.map((row, r): TableRowNode => withAttrs({
    type: 'table_row',
    children: (row.children ?? []).map((cell, c) => cellNode(cell, r === 0, ctx, r === 0 ? align[c] : undefined)),
  }, attrsOf(row)))
  const [head, ...body] = tableRows
  const table: TableNode = {
    type: 'table',
    columns: Array.from({ length: width }, () => ({ type: 'table_column' as const })),
    children: [
      { type: 'table_head', children: head ? [head] : [] },
      ...(body.length ? [{ type: 'table_body' as const, children: body }] : []),
    ],
  }
  return withAttrs(table, attrsOf(node))
}

/** Rows with the span continuation cells `toMdast` leaves out put back, so every row has one cell per column. */
function withContinuations(rows: TableCellNode[][]): TableCellNode[][] {
  const covered: Array<Array<TableCellNode | undefined>> = []
  return rows.map((cells, r) => {
    const out: TableCellNode[] = []
    const taken = covered[r] ?? []
    let column = 0
    const fill = () => {
      while (taken[column]) {
        out.push({ type: 'table_cell', header: taken[column]!.header, span: 'rowspan', children: [] })
        column++
      }
    }
    for (const cell of cells) {
      fill()
      out.push(cell)
      const colspan = cell.colspan ?? 1
      const rowspan = cell.rowspan ?? 1
      for (let dr = 1; dr < rowspan; dr++) {
        const next = (covered[r + dr] ??= [])
        for (let dc = 0; dc < colspan; dc++) next[column + dc] = cell
      }
      for (let dc = 1; dc < colspan; dc++) out.push({ type: 'table_cell', header: cell.header, span: 'colspan', children: [] })
      column += colspan
    }
    fill()
    return out
  })
}

function carveTable(node: MdNode, ctx: Context): Block {
  let cap: CaptionNode | undefined
  let widths: Array<number | undefined> = []
  const groups: Array<{ type: 'table_head' | 'table_body' | 'table_foot'; attrs?: Attrs; rows: Array<{ attrs?: Attrs; cells: TableCellNode[] }> }> = []
  for (const child of node.children ?? []) {
    if (child.type === 'carveTableCaption') cap = caption(child, ctx)
    else if (child.type === 'carveElement' && child.data?.hName === 'colgroup') {
      widths = (child.children ?? []).map((col) => {
        const match = /width: ([\d.]+)%;/.exec(prop(col, 'style') ?? '')
        return match ? Number(match[1]) / 100 : undefined
      })
    } else if (child.type === 'carveTableSection') {
      const hName = child.data?.hName
      const type = hName === 'thead' ? 'table_head' : hName === 'tfoot' ? 'table_foot' : 'table_body'
      groups.push({
        type,
        attrs: attrsOf(child),
        rows: (child.children ?? []).map((row) => ({ attrs: attrsOf(row), cells: (row.children ?? []).map((cell) => cellNode(cell, type === 'table_head', ctx)) })),
      })
    } else {
      unmapped(child, ctx)
    }
  }
  const placed = withContinuations(groups.flatMap((group) => group.rows.map((row) => row.cells)))
  const width = Math.max(widths.length, ...placed.map((row) => row.length))
  let offset = 0
  const children = groups.map((group) => {
    const rows = group.rows.map((row, i): TableRowNode => withAttrs({ type: 'table_row', children: placed[offset + i]! }, row.attrs))
    offset += rows.length
    return withAttrs({ type: group.type, children: rows }, group.attrs)
  }) as TableNode['children']
  const table: TableNode = {
    type: 'table',
    columns: Array.from({ length: width }, (_, c) => ({ type: 'table_column' as const, ...(widths[c] === undefined ? {} : { width: widths[c]! }) })),
    children,
    ...(cap === undefined ? {} : { caption: cap }),
  }
  return withAttrs(table, attrsOf(node))
}

// ---------------------------------------------------------------------------
// Inlines
// ---------------------------------------------------------------------------

function inlines(nodes: readonly MdNode[] | undefined, ctx: Context): Inline[] {
  const list = nodes ?? []
  const out: Inline[] = []
  for (let i = 0; i < list.length; i++) {
    const node = list[i]!
    const next = list[i + 1]
    // An equation number follows its math after a space; carve-js numbers the equation itself.
    if (node.type === 'text' && node.value === ' ' && next?.type === 'carveElement' && hasClass(next, 'equation-number')) continue
    if (node.type === 'carveElement' && hasClass(node, 'equation-number')) continue
    out.push(...inline(node, ctx))
  }
  return out
}

function text(value: string): Inline[] {
  const out: Inline[] = []
  value.split('\n').forEach((part, i) => {
    if (i > 0) out.push({ type: 'soft_break' })
    if (part !== '') out.push({ type: 'text', value: part })
  })
  return out
}

function plain(node: MdNode): string {
  if (typeof node.value === 'string') return node.value
  return (node.children ?? []).map(plain).join('')
}

const WRAPPERS: Record<string, 'underline' | 'superscript' | 'subscript' | 'highlight' | 'insert' | 'delete'> = {
  carveUnderline: 'underline',
  carveSuperscript: 'superscript',
  carveSubscript: 'subscript',
  carveHighlight: 'highlight',
  carveInsert: 'insert',
  carveDelete: 'delete',
}

function inline(node: MdNode, ctx: Context): Inline[] {
  const children = () => inlines(node.children, ctx)
  const title = typeof node['title'] === 'string' ? { tooltip: node['title'] } : {}
  switch (node.type) {
    case 'text':
      return text(node.value ?? '')
    case 'emphasis':
    case 'strong':
      return [withAttrs({ type: node.type, children: children() }, attrsOf(node))]
    case 'delete':
      return [withAttrs({ type: 'strike', children: children() }, attrsOf(node))]
    case 'inlineCode':
      return [withAttrs({ type: 'code', value: node.value ?? '' }, attrsOf(node))]
    case 'break':
      return [{ type: 'hard_break' }]
    case 'link':
      return [withAttrs({ type: 'link', href: String(node['url'] ?? ''), ...title, children: children() }, attrsOf(node))]
    case 'image':
      return [withAttrs({ type: 'image', src: String(node['url'] ?? ''), alt: String(node['alt'] ?? ''), ...title }, attrsOf(node))]
    case 'linkReference':
      return [withAttrs({ type: 'link', key: String(node['identifier']), namespace: 'link', refForm: referenceForm(node), children: children() }, attrsOf(node))]
    case 'imageReference':
      return [withAttrs({ type: 'image', key: String(node['identifier']), namespace: 'link', refForm: referenceForm(node), alt: String(node['alt'] ?? '') }, attrsOf(node))]
    case 'footnoteReference': {
      const identifier = String(node['identifier'])
      const note = ctx.inlineNotes.get(identifier)
      if (note === undefined) return [{ type: 'footnote_ref', key: identifier, namespace: 'footnote' }]
      const [paragraph] = note
      return [{ type: 'inline_footnote', children: paragraph?.type === 'paragraph' ? inlines(paragraph.children, ctx) : [] }]
    }
    case 'inlineMath':
      return [withAttrs({ type: 'math', display: hasClass(node, 'display'), value: node.value ?? '' }, attrsOf(node, { classes: ['math', 'inline', 'display'], keys: ['role'] }))]
    case 'html':
      return [{ type: 'raw_inline', format: 'html', value: node.value ?? '' }]
    case 'carveCriticComment':
      return [{ type: 'critic_comment', value: plain(node) }]
    case 'carveSpan':
      return [semanticSpan(node, ctx)]
    case 'carveSmallCaps':
      return [withAttrs({ type: 'small_caps', children: children() }, attrsOf(node, { classes: ['smallcaps'] }))]
    case 'carveRuby':
      return [ruby(node, ctx)]
    case 'carveMention':
      return [withAttrs({ type: 'mention', target: plain(node).replace(/^@/, ''), kind: 'user' }, attrsOf(node, { classes: ['mention'] }))]
    case 'carveTag':
      return [withAttrs({ type: 'tag', name: plain(node).replace(/^#/, '') }, attrsOf(node, { classes: ['tag'] }))]
    case 'carveExtension': {
      const name = String(node['name'] ?? '')
      return [withAttrs({ type: 'inline_extension', name, children: children() }, attrsOf(node, { classes: [`ext-${name}`] }))]
    }
    case 'carveAbbreviation': {
      const key = plain(node)
      const expansion = prop(node, 'title') ?? ''
      if (!ctx.abbreviations.has(key)) ctx.abbreviations.set(key, expansion)
      return [{ type: 'abbreviation', key, namespace: 'abbr', expansion }]
    }
    default: {
      const wrapper = WRAPPERS[node.type]
      if (wrapper) return [withAttrs({ type: wrapper, children: children() }, attrsOf(node))]
      unmapped(node, ctx)
      return node.children ? children() : []
    }
  }
}

function referenceForm(node: MdNode): 'full' | 'collapsed' | 'shortcut' {
  const form = node['referenceType']
  return form === 'collapsed' || form === 'shortcut' ? form : 'full'
}

/** `abbr`, `time` and `kbd` spans nest one element per key; they fold back into one span. */
function semanticSpan(node: MdNode, ctx: Context): Inline {
  const keys: Array<[string, string]> = []
  let current = node
  let outer: MdNode | undefined
  for (;;) {
    const name = current.data?.hName ?? 'span'
    if (!SEMANTIC_SPAN_ORDER.includes(name)) break
    outer ??= current
    const mapsTo = SEMANTIC_VALUE_ATTRIBUTE[name]
    keys.unshift([name, mapsTo === undefined ? '' : (prop(current, find(html, mapsTo).property) ?? '')])
    const [only, ...more] = current.children ?? []
    if (more.length || only?.type !== 'carveSpan' || !SEMANTIC_SPAN_ORDER.includes(only.data?.hName ?? 'span')) {
      current = { type: 'carveSpan', children: current.children ?? [] }
      break
    }
    current = only
  }
  if (outer === undefined) return withAttrs({ type: 'span', children: inlines(node.children, ctx) }, attrsOf(node))
  const riding = attrsOf(outer, { keys: Object.values(SEMANTIC_VALUE_ATTRIBUTE) })
  const keyValues = [...keys, ...(riding?.keyValues ?? [])]
  return { type: 'span', children: inlines(current.children, ctx), attrs: { ...riding, keyValues } }
}

function ruby(node: MdNode, ctx: Context): Inline {
  const pairs: Array<{ type: 'ruby_pair'; base: Inline[]; annotation: Inline[] }> = []
  let base: MdNode[] = []
  for (const child of node.children ?? []) {
    if (child.type === 'carveElement' && child.data?.hName === 'rp') continue
    if (child.type === 'carveRubyText') {
      pairs.push({ type: 'ruby_pair', base: inlines(base, ctx), annotation: inlines(child.children, ctx) })
      base = []
    } else {
      base.push(child)
    }
  }
  return withAttrs({ type: 'ruby', pairs }, attrsOf(node))
}
