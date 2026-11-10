import {
  CANONICAL_ADMONITION_KINDS,
  SMART_PUNCTUATION_GLYPHS,
  parse,
  resolve,
  type Attrs,
  type BlockNode,
  type Document,
  type InlineNode,
  type Position as CarvePosition,
  type Table,
  type TableCell,
  type TableRow,
} from '@markup-carve/carve'
import type { Properties } from 'hast'
import type { Root } from 'mdast'
import type { Position } from 'unist'
import {
  attrList,
  attrList2,
  sanitizeUrl,
  stripKeyValue,
  toProperties,
  withoutClassSlot,
  type AttrList,
} from './attrs.js'

export interface ToMdastOptions {
  /**
   * Wrap each top-level heading and the content it opens in a `carveSection`
   * node, with the heading id on the section, as carve-js renders by default.
   * With `false` the tree stays flat and the id stays on the heading.
   */
  sections?: boolean
}

/** A node of the produced tree, kept loose internally and typed at the boundary. */
interface MdNode {
  type: string
  children?: MdNode[]
  value?: string
  data?: { hName?: string; hProperties?: Properties; hChildren?: unknown[] }
  position?: Position
  [key: string]: unknown
}

interface Context {
  sections: boolean
  admonitionCount: number
  insideLink: boolean
  suppressAbbreviation: boolean
  footnoteDefs: Record<string, BlockNode[]>
  footnoteOrder: string[]
  inlineNotes: Map<string, InlineNode[]>
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
const SEMANTIC_VALUE_ATTRIBUTE: Record<string, string> = { abbr: 'title', dfn: 'title', time: 'datetime' }

/** Convert a resolved Carve document (`resolve(parse(source))`) to mdast. */
export function toMdast(doc: Document, options: ToMdastOptions = {}): Root {
  const ctx: Context = {
    sections: options.sections !== false,
    admonitionCount: 0,
    insideLink: false,
    suppressAbbreviation: false,
    footnoteDefs: doc.footnoteDefs ?? {},
    footnoteOrder: [],
    inlineNotes: new Map(),
  }

  const children: MdNode[] = []
  if (doc.frontmatter && (doc.frontmatter.format === 'yaml' || doc.frontmatter.format === 'toml')) {
    children.push(withPosition({ type: doc.frontmatter.format, value: doc.frontmatter.content }, doc.frontmatter.pos))
  }

  const stack: Array<{ level: number; node: MdNode }> = []
  const target = () => (stack.length ? stack[stack.length - 1]!.node.children! : children)
  for (const block of doc.children) {
    if (block.type === 'heading' && ctx.sections) {
      while (stack.length && stack[stack.length - 1]!.level >= block.level) extendPosition(stack.pop()!.node)
      const props: AttrList = block.attrs?.id !== undefined ? [['id', block.attrs.id]] : []
      const section = custom('carveSection', 'section', props, [], block.pos)
      target().push(section)
      stack.push({ level: block.level, node: section })
      section.children!.push(...convertBlock(block, ctx, true))
      continue
    }
    target().push(...convertBlock(block, ctx, false))
  }
  while (stack.length) extendPosition(stack.pop()!.node)

  children.push(...footnoteDefinitions(ctx))
  return { type: 'root', children: children as Root['children'] }
}

/** Parse Carve source with carve-js, resolve it, and convert it to mdast. */
export function carveToMdast(source: string, options: ToMdastOptions = {}): Root {
  return toMdast(resolve(parse(source, { positions: true })), options)
}

function normalizeLabel(label: string): string {
  return label.replace(/[\t\n\r ]+/g, ' ').trim().toLowerCase()
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

function toPosition(pos: CarvePosition | undefined): Position | undefined {
  if (!pos || pos.startColumn === undefined || pos.endColumn === undefined) return undefined
  const position: Position = {
    start: { line: pos.startLine, column: pos.startColumn },
    end: { line: pos.endLine, column: pos.endColumn },
  }
  if (pos.startOffset !== undefined) position.start.offset = pos.startOffset
  if (pos.endOffset !== undefined) position.end.offset = pos.endOffset
  return position
}

function withPosition(node: MdNode, pos: CarvePosition | undefined): MdNode {
  const position = toPosition(pos)
  if (position) node.position = position
  return node
}

function extendPosition(section: MdNode): void {
  const last = section.children?.[section.children.length - 1]
  if (section.position && last?.position) section.position = { start: section.position.start, end: last.position.end }
}

function withProps(node: MdNode, list: AttrList): MdNode {
  if (list.length) node.data = { ...node.data, hProperties: { ...node.data?.hProperties, ...toProperties(list) } }
  return node
}

function custom(type: string, hName: string, list: AttrList, children: MdNode[], pos?: CarvePosition): MdNode {
  return withPosition({ type, data: { hName, hProperties: toProperties(list) }, children }, pos)
}

// carve-js strips bidi override and isolate controls from rendered text and code (Trojan Source).
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g

function clean(value: string): string {
  return value.replace(BIDI_CONTROLS, '')
}

function text(value: string, pos?: CarvePosition): MdNode {
  return withPosition({ type: 'text', value: clean(value) }, pos)
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

function convertBlocks(blocks: BlockNode[], ctx: Context): MdNode[] {
  return blocks.flatMap((block) => convertBlock(block, ctx, false))
}

function isLoneImage(block: BlockNode): boolean {
  return block.type === 'paragraph' && block.children.length === 1 && block.children[0]!.type === 'image' &&
    !isUnresolved(block.children[0]!)
}

function convertBlock(block: BlockNode, ctx: Context, sectioned: boolean): MdNode[] {
  switch (block.type) {
    case 'heading': {
      const attrs = sectioned ? stripId(block.attrs) : block.attrs
      const node = withPosition({ type: 'heading', depth: block.level, children: inlines(block.children, ctx) }, block.pos)
      return [withProps(node, attrList(attrs, `h${block.level}`))]
    }
    case 'section':
      return [custom('carveSection', 'section', attrList(block.attrs), convertBlocks(block.children, ctx), block.pos)]
    case 'paragraph': {
      if (isLoneImage(block)) return inlines(block.children, ctx)
      const node = withPosition({ type: 'paragraph', children: inlines(block.children, ctx) }, block.pos)
      return [withProps(node, attrList(block.attrs, 'p'))]
    }
    case 'thematic_break':
      return [withProps(withPosition({ type: 'thematicBreak' }, block.pos), attrList(block.attrs))]
    case 'code_block':
      return [codeBlock(block, ctx)]
    case 'block_quote':
      return [withProps(
        withPosition({ type: 'blockquote', children: convertBlocks(block.children, ctx) }, block.pos),
        attrList(block.attrs),
      )]
    case 'list':
      return [list(block, ctx)]
    case 'image':
      return inlines([block], ctx)
    case 'table':
      return [table(block, ctx)]
    case 'admonition':
    case 'directive':
      return [admonition(block, ctx)]
    case 'div': {
      const children = [...labelFloor(block.label, ctx), ...convertBlocks(block.children, ctx)]
      return [custom('carveDiv', 'div', attrList(block.attrs, 'div'), children, block.pos)]
    }
    case 'line_block':
      return [custom(
        'carveLineBlock',
        'div',
        attrList2(block.attrs, { trailingClass: 'line-block', tag: 'div' }),
        convertBlocks(block.children, ctx),
        block.pos,
      )]
    case 'definition_list':
      return [definitionList(block, ctx)]
    case 'figure':
      return [figure(block, ctx)]
    case 'figure_group':
      return [figureGroup(block, ctx)]
    case 'link_reference_definition': {
      const node: MdNode = { type: 'definition', identifier: normalizeLabel(block.label), label: block.label, url: block.href, title: block.title ?? null }
      return [withPosition(node, block.pos)]
    }
    case 'raw_block':
      if (block.format !== 'html') return []
      return [withPosition({ type: 'html', value: rawSource(block.content) }, block.pos)]
    case 'abbreviation_def':
    case 'citation_definition':
    case 'comment':
      return []
    default:
      return []
  }
}

function stripId(attrs: Attrs | undefined): Attrs | undefined {
  if (!attrs || attrs.id === undefined) return attrs
  const { id: _id, ...rest } = attrs
  return rest
}

function rawSource(content: string): string {
  return content.endsWith('\n') && !/^\n+$/.test(content) ? content.slice(0, -1) : content
}

function codeBlock(block: Extract<BlockNode, { type: 'code_block' }>, _ctx: Context): MdNode {
  const content = clean(block.content)
  const value = content.endsWith('\n') ? content.slice(0, -1) : content
  const node: MdNode = { type: 'code', lang: block.lang ?? null, meta: block.header ?? null, value }
  const list = attrList(block.attrs)
  if (list.length) {
    // remark-rehype applies node data to the inner <code>, so its language class must be kept here.
    const props = toProperties(list)
    if (block.lang) props['className'] = [`language-${block.lang}`, ...((props['className'] as string[] | undefined) ?? [])]
    node.data = { hProperties: props }
  }
  return withPosition(node, block.pos)
}

function list(block: Extract<BlockNode, { type: 'list' }>, ctx: Context): MdNode {
  const head: AttrList = []
  if (block.ordered && block.olType) head.push(['type', block.olType])
  if (block.ordered && block.delim === ')') head.push(['data-delim', ')'])
  const isTaskList = !block.ordered && block.items.length > 0 && block.items.every((it) => it.checked !== undefined)
  const own = isTaskList ? attrList2(block.attrs, { baseClass: 'task-list' }) : attrList(block.attrs)
  const items = block.items.map((item) => {
    const node: MdNode = {
      type: 'listItem',
      spread: !block.tight,
      checked: item.checked ?? null,
      children: convertBlocks(item.children, ctx),
    }
    const taskState = item.checked === true ? 'x' : item.taskState
    const itemAttrs = item.checked || item.taskState !== undefined ? stripKeyValue(item.attrs, 'data-task-state') : item.attrs
    const props: AttrList = taskState === undefined ? [] : [['data-task-state', taskState]]
    withProps(node, [...props, ...attrList(itemAttrs)])
    // remark-rehype marks task items with a class carve-js does not emit.
    if (item.checked !== undefined && node.data?.hProperties?.['className'] === undefined) {
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, className: undefined } }
    }
    return withPosition(node, item.pos)
  })
  const node: MdNode = {
    type: 'list',
    ordered: block.ordered,
    start: block.ordered ? (block.start ?? 1) : null,
    spread: !block.tight,
    children: items,
  }
  withProps(node, [...head, ...own])
  return withPosition(node, block.pos)
}

function labelFloor(label: string | undefined, ctx: Context): MdNode[] {
  if (label === undefined) return []
  return [custom('carveContainerLabel', 'p', [['class', 'div-label']], labelInlines(label, ctx))]
}

function labelInlines(label: string, ctx: Context): MdNode[] {
  // carve-js parses a container label as a reference-label inline run; a one-paragraph parse is the closest public API.
  const first = parse(label).children[0]
  return first?.type === 'paragraph' ? stripPositions(inlines(first.children, ctx)) : []
}

function stripPositions(nodes: MdNode[]): MdNode[] {
  for (const node of nodes) {
    delete node.position
    if (node.children) stripPositions(node.children)
  }
  return nodes
}

function admonition(block: Extract<BlockNode, { type: 'admonition' | 'directive' }>, ctx: Context): MdNode {
  const canonical = CANONICAL_ADMONITION_KINDS.has(block.kind)
  const authoredName = Object.keys(block.attrs?.keyValues ?? {}).some((name) => {
    const folded = name.toLowerCase()
    return folded === 'aria-label' || folded === 'aria-labelledby'
  })
  let titleId: string | undefined
  const accessible: AttrList = []
  if (canonical && !authoredName) {
    if (block.title !== undefined) {
      titleId = `adm-${++ctx.admonitionCount}`
      accessible.push(['aria-labelledby', titleId])
    } else if (ADMONITION_LABELS[block.kind]) {
      accessible.push(['aria-label', ADMONITION_LABELS[block.kind]!])
    }
  }
  const tag = canonical ? 'aside' : 'div'
  const baseClass = canonical ? `admonition ${block.kind}` : block.kind
  const classes = [baseClass, ...attrList({ classes: block.attrs?.classes ?? [] }).map(([, v]) => v)].join(' ')
  const rest = withoutClassSlot(block.attrs)
  const props: AttrList = [['class', classes], ...attrList(rest, tag), ...accessible]
  const children: MdNode[] = []
  if (block.title !== undefined) {
    const titleProps: AttrList = [['class', 'admonition-title']]
    if (titleId) titleProps.push(['id', titleId])
    children.push(custom('carveContainerTitle', 'p', titleProps, inlines(block.title, ctx)))
  }
  children.push(...labelFloor(block.label, ctx), ...convertBlocks(block.children, ctx))
  const type = block.type === 'admonition' ? 'carveAdmonition' : 'carveDirective'
  const node = custom(type, tag, props, children, block.pos)
  node['kind'] = block.kind
  return node
}

function definitionList(block: Extract<BlockNode, { type: 'definition_list' }>, ctx: Context): MdNode {
  const children: MdNode[] = []
  for (const item of block.items) {
    for (const term of item.terms) children.push(custom('carveDefinitionTerm', 'dt', [], inlines(term, ctx)))
    for (const definition of item.definitions) {
      const visible = definition.filter((child) => child.type !== 'comment')
      let body: MdNode[]
      if (visible.length === 1 && visible[0]!.type === 'paragraph') {
        const para = visible[0]
        body = block.loose ? convertBlock(para, ctx, false) : inlines(para.children, ctx)
      } else {
        body = convertBlocks(definition, ctx)
      }
      children.push(custom('carveDefinitionDescription', 'dd', [], body))
    }
  }
  return custom('carveDefinitionList', 'dl', attrList(block.attrs), children, block.pos)
}

function figure(block: Extract<BlockNode, { type: 'figure' }>, ctx: Context, leadClass?: string): MdNode {
  const target = block.target.type === 'image' ? inlines([block.target], ctx) : convertBlock(block.target, ctx, false)
  const caption = custom('carveFigureCaption', 'figcaption', [], inlines(block.caption, ctx))
  const props: AttrList = leadClass === undefined
    ? attrList(block.attrs)
    : [['class', [...new Set([leadClass, ...(block.attrs?.classes ?? [])])].join(' ')], ...attrList(withoutClassSlot(block.attrs))]
  return custom('carveFigure', 'figure', props, [...target, caption], block.pos)
}

function figureGroup(block: Extract<BlockNode, { type: 'figure_group' }>, ctx: Context): MdNode {
  const classes = [...new Set(['carve-figure-group', ...(block.attrs?.classes ?? [])])].join(' ')
  const children: MdNode[] = []
  for (const child of block.children) {
    if (child.type === 'figure') children.push(figure(child, ctx, 'carve-figure-panel'))
    else if (child.type === 'table') children.push(custom('carveFigure', 'figure', [['class', 'carve-figure-panel']], [table(child, ctx)]))
    else children.push(...convertBlock(child, ctx, false))
  }
  if (block.caption !== undefined) children.push(custom('carveFigureCaption', 'figcaption', [], inlines(block.caption, ctx)))
  return custom('carveFigureGroup', 'figure', [['class', classes], ...attrList(withoutClassSlot(block.attrs))], children, block.pos)
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

interface GridEntry {
  row: TableRow
  cell: TableCell
  rowspan: number
  colspan: number
  skip: boolean
  align?: string
  valign?: string
}

// Port of carve-js resolveTableSpans (PART 9 section 13 T5), which is not exported.
function resolveTableSpans(rows: TableRow[]): GridEntry[][] {
  const grid: GridEntry[][] = rows.map((row) => row.cells.map((cell) => ({ row, cell, rowspan: 1, colspan: 1, skip: false })))
  const markerOf = (entry: GridEntry) => (entry.cell.span === 'rowspan' ? '^' : entry.cell.span === 'colspan' ? '<' : null)
  const cover: Array<Array<[number, number] | undefined>> = []
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r]!
    const own: Array<[number, number] | undefined> = (cover[r] = [])
    for (let c = 0; c < row.length; c++) {
      const entry = row[c]!
      if (entry.skip) continue
      const marker = markerOf(entry)
      if (marker === '<' && c > 0) {
        const at = own[c - 1]
        if (at && at[0] === r) {
          grid[r]![at[1]]!.colspan++
          entry.skip = true
          own[c] = at
          continue
        }
      } else if (marker === '^' && r > 0) {
        const at = cover[r - 1]?.[c]
        const src = at && at[1] === c ? grid[at[0]]![at[1]] : undefined
        if (src && stripIsFree(row, c, src.colspan, markerOf)) {
          src.rowspan++
          for (let k = c; k < c + src.colspan; k++) {
            own[k] = at
            const strip = row[k]
            if (strip) strip.skip = true
          }
          continue
        }
      }
      own[c] = [r, c]
    }
  }
  return grid
}

function stripIsFree(row: GridEntry[], c: number, colspan: number, markerOf: (e: GridEntry) => string | null): boolean {
  for (let k = c + 1; k < c + colspan; k++) {
    const entry = row[k]
    if (entry && (entry.skip || markerOf(entry) === null)) return false
  }
  return true
}

const TABLE_CONSUMED = ['aligns', 'valigns', 'widths']
const TABLE_GROUP_KEYS = ['header-rows', 'footer-rows', 'body-rows', 'body-header-rows', 'body-header-cols']

function tableAttrs(node: Table): Attrs | undefined {
  if (!node.attrs) return undefined
  const consumed = [...TABLE_CONSUMED]
  const hasBodyMetadata = ['body-rows', 'body-header-rows', 'body-header-cols'].some((key) => node.attrs?.keyValues?.[key] !== undefined)
  if (!hasBodyMetadata || node.rowGroups) consumed.push(...TABLE_GROUP_KEYS)
  return {
    ...node.attrs,
    keyValues: Object.fromEntries(Object.entries(node.attrs.keyValues ?? {}).filter(([key]) => !consumed.includes(key))),
    ...(node.attrs.order ? { order: node.attrs.order.filter((key) => !consumed.includes(key)) } : {}),
  }
}

function emptyContinuation(cell: TableCell): TableCell {
  const result: TableCell = { ...cell, children: [] }
  delete result.span
  delete result.blocks
  return result
}

function table(node: Table, ctx: Context): MdNode {
  let spanRows = node.rows
  const groups = node.rowGroups
  const explicitAttrs = groups && (groups.headAttrs !== undefined || groups.footAttrs !== undefined || groups.bodies.some((b) => b.attrs !== undefined))
  if (explicitAttrs && groups) {
    const boundaries = new Set([groups.headRows])
    let end = groups.headRows
    for (const body of groups.bodies) {
      end += body.headRows + body.bodyRows
      boundaries.add(end)
    }
    for (const index of boundaries) {
      const row = node.rows[index]
      if (!row?.cells.some((cell) => cell.span === 'rowspan')) continue
      if (spanRows === node.rows) spanRows = node.rows.slice()
      spanRows[index] = { ...row, cells: row.cells.map((cell) => (cell.span === 'rowspan' ? emptyContinuation(cell) : cell)) }
    }
  }
  const grid = resolveTableSpans(spanRows)

  let headerEnd = groups ? groups.headRows : 0
  if (!groups) {
    while (headerEnd < grid.length && grid[headerEnd]!.some((e) => !e.skip) && grid[headerEnd]!.every((e) => e.cell.header || e.skip)) headerEnd++
  }
  const footerStart = groups ? grid.length - groups.footRows : grid.length

  const columnAlign: string[] = []
  const columnValign: string[] = []
  for (let r = 0; r < headerEnd; r++) {
    const hr = grid[r]!
    for (let c = 0; c < hr.length; c++) {
      const entry = hr[c]!
      if ((!entry.cell.header || !entry.cell.align) || (entry.skip && entry.cell.span !== 'colspan')) continue
      columnAlign[c] = entry.cell.align
    }
    for (let c = 0; c < hr.length; c++) {
      const entry = hr[c]!
      if (entry.skip || !entry.cell.header || !entry.cell.valign) continue
      columnValign[c] = entry.cell.valign
    }
  }
  for (const row of grid) {
    for (let c = 0; c < row.length; c++) {
      const entry = row[c]!
      const a = entry.cell.align ?? columnAlign[c] ?? node.columns?.[c]?.align
      if (a) entry.align = a
      const v = entry.cell.valign ?? columnValign[c] ?? node.columns?.[c]?.valign
      if (v) entry.valign = v
    }
  }

  const ownAttrs = attrList(tableAttrs(node))
  if (isGfmTable(node, grid, headerEnd)) return gfmTable(node, grid, ownAttrs, ctx)

  const sectionEnds = new Set([headerEnd, footerStart])
  let sectionEnd = headerEnd
  for (const body of groups?.bodies ?? []) {
    sectionEnd += body.headRows + body.bodyRows
    sectionEnds.add(sectionEnd)
  }
  let nextBoundary = Infinity
  let crossesSection = false
  for (let r = grid.length - 1; r >= 0; r--) {
    if (sectionEnds.has(r + 1)) nextBoundary = r + 1
    if (grid[r]!.some((entry) => !entry.skip && entry.rowspan > 1 && r + entry.rowspan > nextBoundary)) {
      crossesSection = true
      break
    }
  }

  const children: MdNode[] = []
  if (node.caption) children.push(custom('carveTableCaption', 'caption', [], inlines(node.caption, ctx)))
  if (node.columns?.some((column) => column.width !== undefined)) {
    const cols = node.columns.map((column) => custom(
      'carveElement',
      'col',
      column.width === undefined ? [] : [['style', `width: ${widthPercentage(column.width)}%;`]],
      [],
    ))
    children.push(custom('carveElement', 'colgroup', [], cols))
  }
  const section = (hName: string, attrs: Attrs | undefined, rows: MdNode[]) =>
    custom('carveTableSection', hName, attrList(attrs), rows)

  if (crossesSection) {
    const rowContexts = grid.map((_, row) => ({ header: row < headerEnd, columns: 0 }))
    let contextStart = headerEnd
    for (const body of groups?.bodies ?? []) {
      const end = contextStart + body.headRows + body.bodyRows
      for (let row = contextStart; row < end; row++) rowContexts[row] = { header: row < contextStart + body.headRows, columns: body.rowHeadColumns ?? 0 }
      contextStart = end
    }
    children.push(section('tbody', undefined, grid.map((row, r) => tableRow(row, ctx, rowContexts[r]!.header, rowContexts[r]!.header, rowContexts[r]!.columns))))
  } else {
    if (headerEnd > 0 || groups?.headAttrs !== undefined) {
      children.push(section('thead', groups?.headAttrs, grid.slice(0, headerEnd).map((row) => tableRow(row, ctx, true, true))))
    }
    const bodies = groups?.bodies ?? (headerEnd < footerStart ? [{ headRows: 0, bodyRows: footerStart - headerEnd, rowHeadColumns: 0, attrs: undefined }] : [])
    let bodyStart = headerEnd
    for (const body of bodies) {
      const end = bodyStart + body.headRows + body.bodyRows
      const rows: MdNode[] = []
      for (let r = bodyStart; r < end; r++) {
        const head = r < bodyStart + body.headRows
        rows.push(tableRow(grid[r]!, ctx, head, head, body.rowHeadColumns ?? 0))
      }
      children.push(section('tbody', body.attrs, rows))
      bodyStart = end
    }
    if (footerStart < grid.length || groups?.footAttrs !== undefined) {
      children.push(section('tfoot', groups?.footAttrs, grid.slice(footerStart).map((row) => tableRow(row, ctx))))
    }
  }
  return custom('carveTable', 'table', ownAttrs, children, node.pos)
}

function widthPercentage(width: number): string {
  return String(Number((width * 100).toFixed(10)))
}

function isGfmTable(node: Table, grid: GridEntry[][], headerEnd: number): boolean {
  if (node.caption || node.rowGroups || headerEnd !== 1) return false
  if (node.columns?.some((column) => column.width !== undefined)) return false
  const width = grid[0]!.length
  return grid.every((row, r) => row.length === width && row.every((entry) =>
    !entry.skip && entry.rowspan === 1 && entry.colspan === 1 && entry.cell.blocks === undefined &&
    entry.cell.header === (r === 0)))
}

function cellProps(entry: GridEntry, tag: string, inHeaderRun: boolean): AttrList {
  const out: AttrList = []
  if (tag === 'th' && !Object.keys(entry.cell.attrs?.keyValues ?? {}).some((key) => key.toLowerCase() === 'scope')) {
    out.push(['scope', inHeaderRun ? 'col' : 'row'])
  }
  const structural: AttrList = []
  if (entry.rowspan > 1) structural.push(['rowspan', String(entry.rowspan)])
  if (entry.colspan > 1) structural.push(['colspan', String(entry.colspan)])
  if (entry.align || entry.valign) {
    const style = `${entry.align ? `text-align: ${entry.align};` : ''}${entry.align && entry.valign ? ' ' : ''}${entry.valign ? `vertical-align: ${entry.valign};` : ''}`
    structural.push(['style', style])
  }
  const emitted = new Set(structural.map(([name]) => name))
  let attrs = entry.cell.attrs
  for (const name of emitted) attrs = stripKeyValue(attrs, name)
  return [...out, ...attrList(attrs), ...structural]
}

function cellContent(cell: TableCell, ctx: Context): MdNode[] {
  if (cell.blocks !== undefined) return convertBlocks(cell.blocks, ctx)
  const children = cell.children ?? []
  return inlines(children[0]?.type === 'cell_wrap' ? children.slice(1) : children, ctx)
}

function tableRow(cells: GridEntry[], ctx: Context, inHeaderRun = false, promote = false, rowHeadColumns = 0): MdNode {
  const children: MdNode[] = []
  cells.forEach((entry, column) => {
    if (entry.skip) return
    const tag = entry.cell.header || promote || column < rowHeadColumns ? 'th' : 'td'
    children.push(custom('carveTableCell', tag, cellProps(entry, tag, inHeaderRun), cellContent(entry.cell, ctx), entry.cell.pos))
  })
  return custom('carveTableRow', 'tr', attrList(cells[0]?.row.attrs), children, cells[0]?.row.pos)
}

function gfmTable(node: Table, grid: GridEntry[][], ownAttrs: AttrList, ctx: Context): MdNode {
  const rows = grid.map((row, r) => {
    const cells = row.map((entry) => {
      const tag = r === 0 ? 'th' : 'td'
      const cell = withPosition({ type: 'tableCell', children: cellContent(entry.cell, ctx) }, entry.cell.pos)
      cell.data = { hProperties: { align: undefined, ...toProperties(cellProps(entry, tag, r === 0)) } }
      return cell
    })
    return withProps(withPosition({ type: 'tableRow', children: cells }, row[0]?.row.pos), attrList(row[0]?.row.attrs))
  })
  const align = grid[0]!.map((entry, c) => entry.cell.align ?? node.columns?.[c]?.align ?? null)
  return withProps(withPosition({ type: 'table', align, children: rows }, node.pos), ownAttrs)
}

// ---------------------------------------------------------------------------
// Inlines
// ---------------------------------------------------------------------------

function inlines(nodes: InlineNode[] | BlockNode[], ctx: Context): MdNode[] {
  return mergeText((nodes as InlineNode[]).flatMap((node) => inline(node, ctx)))
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

function isUnresolved(node: InlineNode): boolean {
  if (node.type === 'link') return node.ref !== undefined && !node.href
  if (node.type === 'image') return node.ref !== undefined && !node.src
  return false
}

function referenceSourceText(rawRef: string | undefined): string {
  if (rawRef === undefined) return ''
  if (!rawRef.includes('%%')) return rawRef
  return rawRef.split('\n').map((line) => (/^[ \t]*%%/.test(line) ? '' : line)).join('\n')
}

function wrap(type: string, hName: string, node: { attrs?: Attrs; pos?: CarvePosition; children: InlineNode[] }, ctx: Context): MdNode {
  return custom(type, hName, attrList(node.attrs), inlines(node.children, ctx), node.pos)
}

function inline(node: InlineNode, ctx: Context): MdNode[] {
  switch (node.type) {
    case 'text':
    case 'escaped_text':
      return [text(node.value, node.pos)]
    case 'cell_wrap':
      return [text(' ', node.pos)]
    case 'soft_break':
      return [text('\n', node.pos)]
    case 'smart_punctuation':
      return [text(node.glyph ?? SMART_PUNCTUATION_GLYPHS[node.kind] ?? node.value, node.pos)]
    case 'non_breaking_space':
      return node.attrs
        ? [custom('carveSpan', 'span', attrList(node.attrs), [text(' ')], node.pos)]
        : [text(' ', node.pos)]
    case 'emphasis':
    case 'strong':
      return [withProps(withPosition({ type: node.type, children: inlines(node.children, ctx) }, node.pos), attrList(node.attrs))]
    case 'strike': {
      const del = withProps(withPosition({ type: 'delete', children: inlines(node.children, ctx) }, node.pos), attrList(node.attrs))
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
    case 'substitution':
      return [
        custom('carveDelete', 'del', [], inlines(node.old, ctx), node.pos),
        custom('carveInsert', 'ins', [], inlines(node.new, ctx), node.pos),
      ]
    case 'critic_comment':
      return [custom('carveCriticComment', 'span', [['class', 'critic-comment']], [text(node.text)], node.pos)]
    case 'code':
      return [withProps(withPosition({ type: 'inlineCode', value: clean(node.value) }, node.pos), attrList(node.attrs))]
    case 'link': {
      if (isUnresolved(node)) return [text(referenceSourceText(node.rawRef), node.pos)]
      if (ctx.insideLink) return inlines(node.children, ctx)
      let attrs = stripKeyValue(node.attrs, 'href')
      if (node.title !== undefined) attrs = stripKeyValue(attrs, 'title')
      const children = within(ctx, 'insideLink', true, () => inlines(node.children, ctx))
      const link: MdNode = { type: 'link', url: sanitizeUrl(node.href), title: node.title ?? null, children }
      return [withProps(withPosition(link, node.pos), attrList(attrs))]
    }
    case 'image': {
      if (isUnresolved(node)) return [text(referenceSourceText(node.rawRef), node.pos)]
      let attrs = stripKeyValue(node.attrs, 'src')
      if (node.title !== undefined) attrs = stripKeyValue(attrs, 'title')
      const image: MdNode = { type: 'image', url: sanitizeUrl(node.src), alt: node.alt, title: node.title ?? null }
      return [withProps(withPosition(image, node.pos), attrList(attrs))]
    }
    case 'autolink': {
      const display = node.text ?? (node.href.startsWith('mailto:') ? node.href.slice(7) : node.href)
      if (ctx.insideLink) return [text(node.href.startsWith('mailto:') ? node.href.slice(7) : display, node.pos)]
      const link: MdNode = { type: 'link', url: sanitizeUrl(node.href), title: null, children: [text(display)] }
      return [withProps(withPosition(link, node.pos), attrList(stripKeyValue(node.attrs, 'href')))]
    }
    case 'heading_ref': {
      if (!node.href) return [text(`</#${node.target}>`, node.pos)]
      if (ctx.insideLink) return inlines(node.resolvedText ?? [], ctx)
      const children = within(ctx, 'insideLink', true, () => inlines(node.resolvedText ?? [], ctx))
      const link: MdNode = { type: 'link', url: sanitizeUrl(node.href), title: null, children }
      return [withProps(withPosition(link, node.pos), attrList(stripKeyValue(node.attrs, 'href')))]
    }
    case 'span':
      return [semanticSpan(node, ctx)]
    case 'ruby': {
      const children: MdNode[] = []
      for (const pair of node.pairs) {
        children.push(
          ...inlines(pair.base, ctx),
          custom('carveElement', 'rp', [], [text('(')]),
          custom('carveRubyText', 'rt', [], inlines(pair.annotation, ctx)),
          custom('carveElement', 'rp', [], [text(')')]),
        )
      }
      return [custom('carveRuby', 'ruby', attrList(node.attrs), children, node.pos)]
    }
    case 'small_caps':
      return [custom('carveSmallCaps', 'span', attrList2(node.attrs, { baseClass: 'smallcaps' }), inlines(node.children, ctx), node.pos)]
    case 'math': {
      const authoredRole = Object.keys(node.attrs?.keyValues ?? {}).some((name) => name.toLowerCase() === 'role')
      const props: AttrList = [...attrList2(node.attrs, { baseClass: node.display ? 'math display' : 'math inline' })]
      if (!authoredRole) props.push(['role', 'math'])
      const body = clean(node.display ? `\\[${node.content}\\]` : `\\(${node.content}\\)`)
      const math: MdNode = withPosition({
        type: 'inlineMath',
        value: node.content,
        data: { hName: 'span', hProperties: toProperties(props), hChildren: [{ type: 'text', value: body }] },
      }, node.pos)
      if (node.number === undefined) return [math]
      return [math, text(' '), custom('carveElement', 'span', [['class', 'equation-number']], [text(`${node.label ?? ''} ${node.number}`)])]
    }
    case 'raw_inline':
      return node.format === 'html' ? [withPosition({ type: 'html', value: node.content }, node.pos)] : []
    case 'literal_inline': {
      const props = attrList(node.attrs)
      return props.length ? [custom('carveSpan', 'span', props, [text(node.content)], node.pos)] : [text(node.content, node.pos)]
    }
    case 'symbol': {
      const props = attrList(node.attrs)
      const value = `:${node.name}:`
      return node.attrs ? [custom('carveSpan', 'span', props, [text(value)], node.pos)] : [text(value, node.pos)]
    }
    case 'mention':
    case 'tag': {
      const baseClass = node.type
      const value = node.type === 'mention' ? `@${node.user}` : `#${node.name}`
      const attrs = node.attrs?.order?.includes('.class')
        ? { ...node.attrs, order: ['.class', ...node.attrs.order.filter((s) => s !== '.class')] }
        : node.attrs
      const strong: MdNode = { type: 'strong', children: [text(value)] }
      const type = node.type === 'mention' ? 'carveMention' : 'carveTag'
      return [custom(type, 'span', attrList2(attrs, { baseClass }), [strong], node.pos)]
    }
    case 'inline_extension': {
      const ext = custom('carveExtension', 'span', attrList2(node.attrs, { baseClass: `ext-${node.name}` }), inlines(node.content, ctx), node.pos)
      ext['name'] = node.name
      return [ext]
    }
    case 'abbreviation':
      if (ctx.suppressAbbreviation) return [text(node.abbr, node.pos)]
      return [custom('carveAbbreviation', 'abbr', [['title', node.expansion]], [text(node.abbr)], node.pos)]
    case 'footnote_ref': {
      if (node.number === undefined || node.label === undefined) return [text(`[^${node.label ?? ''}]`, node.pos)]
      noteFootnote(ctx, node.label)
      return [withPosition({ type: 'footnoteReference', identifier: node.label, label: node.label }, node.pos)]
    }
    case 'inline_footnote': {
      if (node.number === undefined) return [text('[^]', node.pos)]
      let identifier = `carve-inline-${node.number}`
      while (Object.hasOwn(ctx.footnoteDefs, identifier)) identifier += '-'
      ctx.inlineNotes.set(identifier, node.inline)
      noteFootnote(ctx, identifier)
      return [withPosition({ type: 'footnoteReference', identifier, label: identifier }, node.pos)]
    }
    case 'hard_break':
      return [withPosition({ type: 'break' }, node.pos)]
    case 'caption_number':
      return [text(node.n === undefined ? '#' : String(node.n), node.pos)]
    case 'citation_group':
      return [text(node.raw, node.pos)]
    case 'comment':
      return []
    default:
      return []
  }
}

function semanticSpan(node: Extract<InlineNode, { type: 'span' }>, ctx: Context): MdNode {
  const values = node.attrs?.keyValues
  const names = SEMANTIC_SPAN_ORDER.filter((name) => values?.[name] !== undefined)
  const body = within(ctx, 'suppressAbbreviation', ctx.suppressAbbreviation || values?.['abbr'] !== undefined, () => inlines(node.children, ctx))
  if (names.length === 0) return custom('carveSpan', 'span', attrList(node.attrs), body, node.pos)
  const keyValues = Object.fromEntries(Object.entries(values ?? {}).filter(([key]) => !SEMANTIC_SPAN_ORDER.includes(key)))
  const riding: Attrs = { ...node.attrs, keyValues }
  if (riding.order) riding.order = riding.order.filter((key) => !SEMANTIC_SPAN_ORDER.includes(key))
  const outermost = names[names.length - 1]
  let children = body
  let result: MdNode | undefined
  for (const name of names) {
    const value = values![name]!
    const mapsTo = value !== '' ? SEMANTIC_VALUE_ATTRIBUTE[name] : undefined
    const attrs: Attrs = name === outermost ? riding : {}
    const derived: AttrList = mapsTo !== undefined && attrs.keyValues?.[mapsTo] === undefined ? [[mapsTo, value]] : []
    result = custom('carveSpan', name, [...derived, ...attrList(attrs)], children, name === outermost ? node.pos : undefined)
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
      : convertBlocks(Object.hasOwn(ctx.footnoteDefs, identifier) ? ctx.footnoteDefs[identifier]! : [], ctx))
    out.push({ type: 'footnoteDefinition', identifier, label: identifier, children })
  }
  return out
}
