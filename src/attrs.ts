import type { Attrs } from '@markup-carve/carve'
import type { Properties } from 'hast'
import { find, html } from 'property-information'

// Ported from carve-js render-html.ts, which does not export these helpers.
const DANGEROUS_URL_SCHEMES = [
  'javascript', 'vbscript', 'data', 'file', 'ms-msdt', 'ms-office', 'ms-word',
  'ms-excel', 'ms-powerpoint', 'ms-access', 'ms-visio', 'ms-project',
  'ms-publisher', 'ms-infopath', 'ms-spd', 'ms-search', 'search-ms', 'ms-cxh',
  'ms-cxh-full', 'shell', 'vscode', 'vscode-insiders', 'jar',
]
const DANGEROUS_SCHEMES = new Set(DANGEROUS_URL_SCHEMES)
const SCHEME_PROBE_STRIP_RE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\s]+/gu
const HTML_ATTR_NAME_RE = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/
const WS = '\\t\\n\\f\\r '
const URL_LIST_SEPARATORS = new Map([
  ['srcset', new RegExp(`[,${WS}]+`)],
  ['imagesrcset', new RegExp(`[,${WS}]+`)],
  ['ping', new RegExp(`[${WS}]+`)],
  ['attributionsrc', new RegExp(`[${WS}]+`)],
])

export function sanitizeUrl(url: string): string {
  const probe = url.replace(SCHEME_PROBE_STRIP_RE, '')
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(probe)
  if (!scheme) return url
  return DANGEROUS_SCHEMES.has(scheme[1]!.toLowerCase()) ? '' : url
}

function isDangerousAttrName(name: string): boolean {
  const n = name.toLowerCase()
  return n.startsWith('on') || n === 'srcdoc' || n === 'formaction'
}

function hasDeniedValueScheme(value: string): boolean {
  const colon = value.indexOf(':')
  if (colon === -1) return false
  return DANGEROUS_SCHEMES.has(value.slice(0, colon).replace(SCHEME_PROBE_STRIP_RE, '').toLowerCase())
}

function decodedStyleValue(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\\([0-9a-f]{1,6}\s?|[\s\S])/gi, (_m, esc: string) => {
    if (/^[0-9a-f]/i.test(esc)) {
      const cp = Number.parseInt(esc.trim(), 16)
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
    }
    return esc
  })
}

function hasDangerousCss(value: string): boolean {
  const compact = decodedStyleValue(value).toLowerCase().replace(/\s+/g, '')
  return ['expression(', 'url(', '@import', 'behavior:', '-moz-binding'].some((needle) => compact.includes(needle))
}

function sanitizeAttrValue(name: string, value: string): string {
  const n = name.toLowerCase()
  if (hasDeniedValueScheme(value)) return ''
  const separator = URL_LIST_SEPARATORS.get(n)
  if (separator && value.split(separator).some((token) => token !== '' && hasDeniedValueScheme(token))) return ''
  if (n === 'style' && hasDangerousCss(value)) return ''
  return value
}

/** HTML attributes in render order, before they become hast properties. */
export type AttrList = Array<[string, string]>

const TEXT_ALIGN_ELEMENTS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

function withTextAlignDeclaration(attrs: Attrs, tag: string | undefined): Attrs {
  if (tag === undefined || !TEXT_ALIGN_ELEMENTS.has(tag) || !attrs.keyValues) return attrs
  const keyValues = attrs.keyValues
  const alignKey = Object.keys(keyValues).find((k) => k.toLowerCase() === 'align')
  if (alignKey === undefined) return attrs
  const value = (keyValues[alignKey] ?? '').trim().toLowerCase()
  if (!['left', 'right', 'center'].includes(value)) return attrs
  const declaration = `text-align: ${value};`
  const styleKey = Object.keys(keyValues).find((k) => k.toLowerCase() === 'style')
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(keyValues)) {
    if (k === alignKey) {
      if (styleKey === undefined) next['style'] = declaration
      continue
    }
    if (k === styleKey) {
      const trimmed = v.trim()
      next[k] = trimmed === '' ? declaration : trimmed.endsWith(';') ? `${trimmed} ${declaration}` : `${trimmed}; ${declaration}`
    } else {
      next[k] = v
    }
  }
  const result: Attrs = { ...attrs, keyValues: next }
  if (attrs.order) {
    result.order = styleKey === undefined
      ? attrs.order.map((slot) => (slot === alignKey ? 'style' : slot))
      : attrs.order.filter((slot) => slot !== alignKey)
  }
  return result
}

function renderedClasses(classes: string[]): string[] {
  return [...new Set(classes.map((c) => sanitizeAttrValue('class', c)).filter((c) => c !== ''))]
}

function slot(attrs: Attrs, name: string): [string, string] | undefined {
  if (name === '.class') {
    return attrs.classes?.length ? ['class', renderedClasses(attrs.classes).join(' ')] : undefined
  }
  if (name === '#id') return attrs.id !== undefined ? ['id', attrs.id] : undefined
  if (isDangerousAttrName(name) || !HTML_ATTR_NAME_RE.test(name)) return undefined
  const value = attrs.keyValues?.[name]
  return value !== undefined ? [name, sanitizeAttrValue(name, value)] : undefined
}

/** Carve attributes as carve-js renders them on an element named `tag`. */
export function attrList(raw: Attrs | undefined, tag?: string): AttrList {
  if (!raw) return []
  const attrs = withTextAlignDeclaration(raw, tag)
  const out: AttrList = []
  const push = (entry: [string, string] | undefined) => {
    if (entry && !(entry[0] === 'class' && entry[1] === '')) out.push(entry)
  }
  const seen = new Set(attrs.order ?? [])
  for (const name of attrs.order ?? []) push(slot(attrs, name))
  if (!seen.has('.class')) push(slot(attrs, '.class'))
  if (!seen.has('#id')) push(slot(attrs, '#id'))
  for (const key of Object.keys(attrs.keyValues ?? {})) {
    if (!seen.has(key)) push(slot(attrs, key))
  }
  return out
}

export interface AttrOptions {
  tag?: string
  baseClass?: string
  trailingClass?: string
  dropId?: boolean
}

/** carve-js `renderAttrs2`: a structural class merged with the authored attributes. */
export function attrList2(attrs: Attrs | undefined, opts: AttrOptions): AttrList {
  const a: Attrs = attrs ? { ...attrs } : {}
  if (opts.baseClass) {
    a.classes = [opts.baseClass, ...(a.classes ?? [])]
    if (a.order && !a.order.includes('.class')) a.order = ['.class', ...a.order]
  }
  if (opts.trailingClass) {
    a.classes = [...(a.classes ?? []), opts.trailingClass]
    if (a.order && !a.order.includes('.class')) a.order = [...a.order, '.class']
  }
  if (opts.dropId) {
    delete a.id
    if (a.order) a.order = a.order.filter((s) => s !== '#id')
  }
  return attrList(a, opts.tag)
}

/** Copy of `attrs` without the given key-value (case-insensitive). */
export function stripKeyValue(attrs: Attrs | undefined, key: string): Attrs | undefined {
  if (!attrs?.keyValues) return attrs
  const lower = key.toLowerCase()
  const matches = (k: string) => k.toLowerCase() === lower
  if (!Object.keys(attrs.keyValues).some(matches)) return attrs
  const keyValues: Record<string, string> = {}
  for (const [k, v] of Object.entries(attrs.keyValues)) if (!matches(k)) keyValues[k] = v
  const result: Attrs = { ...attrs, keyValues }
  if (attrs.order) result.order = attrs.order.filter((s) => !matches(s))
  return result
}

/** Copy of `attrs` without the class slot, for callers that render the class themselves. */
export function withoutClassSlot(attrs: Attrs | undefined): Attrs {
  const rest: Attrs = {}
  if (attrs?.id !== undefined) rest.id = attrs.id
  if (attrs?.keyValues) rest.keyValues = attrs.keyValues
  if (attrs?.order) rest.order = attrs.order.filter((s) => s !== '.class')
  return rest
}

/** Turn an attribute list into hast properties; a later duplicate does not replace an earlier one. */
export function toProperties(list: AttrList): Properties {
  const properties: Properties = {}
  for (const [name, value] of list) {
    if (name === 'class') {
      if (properties['className'] === undefined) properties['className'] = value.split(' ').filter(Boolean)
      continue
    }
    const info = find(html, name)
    if (properties[info.property] !== undefined) continue
    properties[info.property] = (info.boolean || info.overloadedBoolean) && value === '' ? true : value
  }
  return properties
}
