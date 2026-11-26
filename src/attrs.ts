import { isUrlAllowed, type Attrs, type UrlPolicy } from '@markup-carve/carve'
import type { Properties } from 'hast'
import { find, html } from 'property-information'

// Ported from carve-js html-attributes.ts, which does not export these helpers.
const HTML_ATTR_NAME_RE = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/
const WS = '\\t\\n\\f\\r '
const URL_LIST_SEPARATORS = new Map([
  ['srcset', new RegExp(`[,${WS}]+`)],
  ['imagesrcset', new RegExp(`[,${WS}]+`)],
  ['ping', new RegExp(`[${WS}]+`)],
  ['attributionsrc', new RegExp(`[${WS}]+`)],
])

/** A destination the URL policy denies is written as the empty string, as carve-js does. */
export function sanitizeUrl(url: string | undefined, policy: UrlPolicy | undefined): string {
  if (url === undefined) return ''
  return isUrlAllowed(url, policy) ? url : ''
}

function isDangerousAttrName(name: string): boolean {
  const n = name.toLowerCase()
  return n.startsWith('on') || n === 'srcdoc' || n === 'formaction'
}

function hasDeniedValueScheme(value: string, policy: UrlPolicy | undefined): boolean {
  return value.includes(':') && !isUrlAllowed(value, policy)
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

function sanitizeAttrValue(name: string, value: string, policy: UrlPolicy | undefined): string {
  const n = name.toLowerCase()
  if (hasDeniedValueScheme(value, policy)) return ''
  const separator = URL_LIST_SEPARATORS.get(n)
  if (separator && value.split(separator).some((token) => token !== '' && hasDeniedValueScheme(token, policy))) return ''
  if (n === 'style' && hasDangerousCss(value)) return ''
  return value
}

/** HTML attributes in render order, before they become hast properties. */
export type AttrList = Array<[string, string]>

const TEXT_ALIGN_ELEMENTS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

/** `align=left|right|center` on a paragraph, div or heading becomes a `text-align` declaration. */
function withTextAlignDeclaration(pairs: Array<[string, string]>, tag: string | undefined): Array<[string, string]> {
  if (tag === undefined || !TEXT_ALIGN_ELEMENTS.has(tag)) return pairs
  const alignAt = pairs.findIndex(([k]) => k.toLowerCase() === 'align')
  if (alignAt === -1) return pairs
  const value = pairs[alignAt]![1].trim().toLowerCase()
  if (!['left', 'right', 'center'].includes(value)) return pairs
  const declaration = `text-align: ${value};`
  const styleAt = pairs.findIndex(([k]) => k.toLowerCase() === 'style')
  if (styleAt === -1) return pairs.map((pair, i) => (i === alignAt ? ['style', declaration] : pair))
  return pairs.flatMap((pair, i): Array<[string, string]> => {
    if (i === alignAt) return []
    if (i !== styleAt) return [pair]
    const trimmed = pair[1].trim()
    return [[pair[0], trimmed === '' ? declaration : trimmed.endsWith(';') ? `${trimmed} ${declaration}` : `${trimmed}; ${declaration}`]]
  })
}

export interface AttrOptions {
  tag?: string
  /** Classes the renderer puts before the authored ones. */
  baseClasses?: string[]
  /** Classes the renderer puts after the authored ones. */
  trailingClasses?: string[]
  dropId?: boolean
  /** Key-value names a structural attribute already wrote. */
  drop?: string[]
}

/** Carve attributes as carve-js renders them on an element named `tag`: id, classes, then the pairs. */
export function attrList(attrs: Attrs | undefined, policy: UrlPolicy | undefined, opts: AttrOptions = {}, node?: { lang?: string; dir?: string }): AttrList {
  const out: AttrList = []
  if (attrs?.id !== undefined && !opts.dropId) out.push(['id', attrs.id])
  const classes = [...new Set([...(opts.baseClasses ?? []), ...(attrs?.classes ?? []), ...(opts.trailingClasses ?? [])]
    .map((c) => sanitizeAttrValue('class', c, policy)).filter((c) => c !== ''))]
  if (classes.length) out.push(['class', classes.join(' ')])
  const dropped = new Set([...(opts.drop ?? []), ...INTERNAL_KEYS].map((name) => name.toLowerCase()))
  const pairs: Array<[string, string]> = []
  for (const [name, value] of attrs?.keyValues ?? []) {
    if (dropped.has(name.toLowerCase()) || isDangerousAttrName(name) || !HTML_ATTR_NAME_RE.test(name)) continue
    pairs.push([name, sanitizeAttrValue(name, value, policy)])
  }
  out.push(...withTextAlignDeclaration(pairs, opts.tag))
  if (node?.lang !== undefined) out.push(['lang', node.lang])
  if (node?.dir !== undefined) out.push(['dir', node.dir])
  return out
}

/** Keys carve-js reads itself and never writes as attributes. */
const INTERNAL_KEYS = ['data-carve-raw']

/** Whether `attrs` carries the key `name` (case-insensitive). */
export function hasKey(attrs: Attrs | undefined, name: string): boolean {
  const lower = name.toLowerCase()
  return (attrs?.keyValues ?? []).some(([k]) => k.toLowerCase() === lower)
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
