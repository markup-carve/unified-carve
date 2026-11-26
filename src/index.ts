import type { Root } from 'mdast'
import type { Plugin } from 'unified'
import { writeWithDiagnostics } from '@markup-carve/carve'
import { diagnosticPlace, fromMdastWithDiagnostics, writeOptions, type StringifyOptions } from './from-mdast.js'
import { carveToMdast, type ToMdastOptions } from './to-mdast.js'

export { carveToMdast, toMdast, type ToMdastOptions } from './to-mdast.js'
export {
  fromMdast,
  fromMdastWithDiagnostics,
  mdastToCarve,
  mdastToCarveWithDiagnostics,
  type FromMdastResult,
  type StringifyOptions,
} from './from-mdast.js'
export type { Diagnostic, WriteOutput } from '@markup-carve/carve'

export type Options = Omit<ToMdastOptions, 'source'>

/**
 * unified parser plugin: Carve source to mdast, through the carve-js AST.
 *
 * Constructs mdast has no node for become `carve*` nodes whose `data.hName`
 * and `data.hProperties` make remark-rehype render carve-js's HTML.
 */
export const carveParse: Plugin<[(Options | undefined)?], string, Root> = function (options) {
  this.parser = (document) => carveToMdast(String(document), options ?? {})
}

/**
 * unified compiler plugin: mdast to Carve source, through the Carve tree and
 * carve-js's `write`. Unmapped nodes and writer losses become file messages.
 */
export const carveStringify: Plugin<[(StringifyOptions | undefined)?], Root, string> = function (options) {
  this.compiler = (tree, file) => {
    const { document, diagnostics } = fromMdastWithDiagnostics(tree as Root)
    const written = writeWithDiagnostics(document, writeOptions(options ?? {}))
    for (const entry of [...diagnostics, ...written.diagnostics]) {
      const place = diagnosticPlace(entry)
      file.message(entry.message, { ruleId: entry.code, source: 'unified-carve', ...(place ? { place } : {}) })
    }
    return written.source
  }
}

export default carveParse
export type { CarveBlockNode, CarveBlockType, CarveElementNode, CarveInlineNode, CarveInlineType } from './types.js'
