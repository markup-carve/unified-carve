import { parse, resolve } from '@markup-carve/carve'
import type { Root } from 'mdast'
import type { Plugin } from 'unified'
import { toMdast, type ToMdastOptions } from './to-mdast.js'

export { carveToMdast, toMdast, type ToMdastOptions } from './to-mdast.js'

export type Options = ToMdastOptions

/**
 * unified parser plugin: Carve source to mdast, through the carve-js AST.
 *
 * Constructs mdast has no node for become `carve*` nodes whose `data.hName`
 * and `data.hProperties` make remark-rehype render carve-js's HTML.
 */
export const carveParse: Plugin<[(Options | undefined)?], string, Root> = function (options) {
  this.parser = (document) => toMdast(resolve(parse(String(document), { positions: true })), options ?? {})
}

export default carveParse
export type { CarveBlockNode, CarveBlockType, CarveElementNode, CarveInlineNode, CarveInlineType } from './types.js'
