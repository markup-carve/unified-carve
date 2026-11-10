import type { Data, Parent, PhrasingContent, RootContent } from 'mdast'

/** Flow-level nodes for Carve constructs mdast has no node for. */
export type CarveBlockType =
  | 'carveSection' | 'carveAdmonition' | 'carveDirective' | 'carveDiv' | 'carveLineBlock'
  | 'carveContainerTitle' | 'carveContainerLabel'
  | 'carveDefinitionList' | 'carveDefinitionTerm' | 'carveDefinitionDescription'
  | 'carveFigure' | 'carveFigureGroup' | 'carveFigureCaption'
  | 'carveTable' | 'carveTableCaption' | 'carveTableSection' | 'carveTableRow' | 'carveTableCell'

/** Phrasing nodes for Carve constructs mdast has no node for. */
export type CarveInlineType =
  | 'carveUnderline' | 'carveSuperscript' | 'carveSubscript' | 'carveHighlight'
  | 'carveInsert' | 'carveDelete' | 'carveCriticComment' | 'carveSpan' | 'carveSmallCaps'
  | 'carveRuby' | 'carveRubyText' | 'carveMention' | 'carveTag' | 'carveExtension' | 'carveAbbreviation'

/** Every custom node carries `data.hName` and `data.hProperties` for remark-rehype. */
export interface CarveBlockNode extends Parent {
  type: CarveBlockType
  children: RootContent[]
  data?: Data
  /** The admonition or directive kind, on `carveAdmonition` and `carveDirective`. */
  kind?: string
}

export interface CarveInlineNode extends Parent {
  type: CarveInlineType
  children: PhrasingContent[]
  data?: Data
  /** The extension name, on `carveExtension`. */
  name?: string
}

/** Internal structure inside a custom node (`<rp>`, `<colgroup>`, `<col>`, an equation number). */
export interface CarveElementNode extends Parent {
  type: 'carveElement'
  children: RootContent[]
  data?: Data
}

declare module 'mdast' {
  interface RootContentMap {
    carveBlock: CarveBlockNode
    carveInline: CarveInlineNode
    carveElement: CarveElementNode
  }
  interface PhrasingContentMap {
    carveInline: CarveInlineNode
  }
}
