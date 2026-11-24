# unified-carve

[unified](https://unifiedjs.com) plugins for [Carve](https://github.com/markup-carve/carve).
`carveParse` turns Carve source into [mdast](https://github.com/syntax-tree/mdast), so a
Carve document can go through remark and rehype plugins; `carveStringify`
writes mdast back as Carve.

Parsing is done by the Carve 0.2 engine, [`@markup-carve/carve`](https://github.com/markup-carve/carve-js).
The plugin converts the engine's resolved tree (AST contract 2.0) to mdast; it
does not render HTML and parse it back.

This `next2` line targets Carve 0.2. The engine has no 0.2 npm release yet, so
`package.json` pins the carve-js `next2` branch by commit; npm builds it from
git on install.

The package is not published to npm yet.

## Usage

```js
import { unified } from 'unified'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import { carveParse } from '@markup-carve/unified-carve'

const file = await unified()
  .use(carveParse)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeStringify, { allowDangerousHtml: true })
  .process('/Hello/, *Carve*.')

console.log(String(file))
// <p><em>Hello</em>, <strong>Carve</strong>.</p>
```

`allowDangerousHtml` only matters for Carve raw HTML (`` `<b>x</b>`{=html} ``
and `` ```=html `` blocks) under the `rawHtml` option below. Without it
remark-rehype drops those nodes.

To get the tree without a processor, use `carveToMdast(source, options)`, or
`toMdast(document, options)` for a tree you already parsed with carve-js
(`parse(source)`, which resolves references and expands includes when given an
`includes` resolver).

### Options

- `sections` (default `true`): wrap each top-level heading and the content it
  opens in a `carveSection` node rendering `<section>`, with the heading id on
  the section, as carve-js does. With `false` the tree stays flat and the id
  stays on the heading, which matches carve-js with `sections: false`.
- `rawHtml` (default `false`): pass raw HTML through as mdast `html` nodes, as
  carve-js does with `rawHtml: true`. Off, raw HTML inlines become escaped text
  and raw HTML blocks become `html` code blocks, which is carve-js's default.
- `urlPolicy` (default: carve-js's deny list): the carve-js URL policy,
  `{ deny: [...] }` or `{ allow: [...] }`. A denied link or image destination
  is written as the empty string.
- `includes` (`carveToMdast` and the plugin): the carve-js `includes` option,
  a resolver or an `IncludeConfig` (`{ resolver, file, depth, bytes }`),
  passed to the parse so include directives expand. Included nodes keep the
  lines and columns of their own file and carry no offsets. `toMdast` reads a
  tree that is already parsed and ignores it.
- `source` (`toMdast` only): the source the tree was parsed from. Carve
  positions count UTF-8 bytes; with the source, mdast offsets are string
  offsets. `carveToMdast` and the plugin pass it themselves.

## Node mapping

Carve constructs with an mdast equivalent become that node. Attributes travel
in `data.hProperties`. Everything else becomes a `carve*` node with
`data.hName` and `data.hProperties`, so remark-rehype renders the element
carve-js renders. Source positions are kept wherever the Carve AST has them.

| Carve node                                           | mdast node                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `heading`                                            | `heading`                                                                        |
| `paragraph`                                          | `paragraph` (a paragraph holding only an image becomes the `image`)              |
| `emphasis` (`/x/`), `strong` (`*x*`)                 | `emphasis`, `strong`                                                             |
| `strike` (`{~x~}`)                                   | `delete` with `hName: 's'`                                                       |
| `code` (inline)                                      | `inlineCode`                                                                     |
| `code_block`                                         | `code` (`lang` from `syntax`, the title text in `meta`)                          |
| `list`, `list_item`                                  | `list`, `listItem` (`checked` for task items, `spread` from `spacing`)           |
| `block_quote`                                        | `blockquote`                                                                     |
| `link`, `autolink`, resolved heading `xref`          | `link`                                                                           |
| `image`                                              | `image`                                                                          |
| `table` with one header row and no spans or caption  | `table`, `tableRow`, `tableCell` (`align` per column)                            |
| other `table`                                        | `carveTable`, `carveTableCaption`, `carveTableSection`, `carveTableRow`, `carveTableCell` |
| `footnote_ref`, `inline_footnote`, `footnote`        | `footnoteReference`, `footnoteDefinition`                                        |
| `thematic_break`                                     | `thematicBreak`                                                                  |
| `hard_break`                                         | `break`                                                                          |
| `raw_inline`, `raw_block` for `html` with `rawHtml`  | `html`                                                                           |
| `link_reference_definition`                          | `definition`                                                                     |
| `frontmatter` (`yaml`, `toml`)                       | `yaml`, `toml`                                                                   |
| `text`, `smart_punctuation`, `non_breaking_space`, `soft_break`, `caption_number`, `citation_group` | `text` |
| `math`                                               | `inlineMath`, rendered as carve-js's `span.math`                                 |
| `underline`, `superscript`, `subscript`, `highlight` | `carveUnderline`, `carveSuperscript`, `carveSubscript`, `carveHighlight`         |
| `insert`, `delete`, `critic_comment`                 | `carveInsert`, `carveDelete`, `carveCriticComment`                               |
| `span` (incl. `kbd`, `abbr`, `time`), `literal_inline` and `symbol` with attributes | `carveSpan`                                       |
| `abbreviation`                                       | `carveAbbreviation`                                                              |
| `small_caps`, `ruby`                                 | `carveSmallCaps`, `carveRuby` / `carveRubyText`                                  |
| `mention`, `tag`, `inline_extension`                 | `carveMention`, `carveTag`, `carveExtension` (`name`)                            |
| `admonition`, `directive`                            | `carveAdmonition`, `carveDirective` (`kind`), with `carveContainerTitle` and `carveContainerLabel` |
| `div`, `line_block`, `section`                       | `carveDiv`, `carveLineBlock`, `carveSection`                                     |
| `definition_list`                                    | `carveDefinitionList`, `carveDefinitionTerm`, `carveDefinitionDescription`       |
| a block with a `caption`, `figure_group`             | `carveFigure`, `carveFigureGroup`, `carveFigureCaption`                          |
| expanded `include`                                   | the included blocks                                                              |
| `block_extension`                                    | its fallback blocks                                                              |
| `comment`, `abbreviation_def`, `citation_definition`, non-HTML raw | dropped (carve-js renders nothing for them)                        |

`carveElement` nodes hold internal structure (`<rp>`, `<colgroup>`, an
equation number). TypeScript types for the custom nodes are exported and added
to mdast's content maps.

## Writing Carve

`carveStringify` is the compiler side: mdast to the Carve tree, then
carve-js's `write`. It inverts every mapping of the table above, so the
`carve*` nodes of `carveParse` come back as the constructs they came from, and
it reads plain remark mdast (`linkReference` with `definition`, `html`,
`math`, `inlineMath`, `yaml`, `toml`) too.

```js
import { unified } from 'unified'
import { carveParse, carveStringify } from '@markup-carve/unified-carve'

const file = await unified()
  .use(carveParse)
  .use(carveStringify)
  .process('= Hello\n\n/Hello/, *Carve*.\n')

console.log(String(file))
// = Hello
//
// /Hello/, *Carve*.
```

Without a processor, `mdastToCarve(root, options)` returns the source and
`mdastToCarveWithDiagnostics(root, options)` returns `{ source, diagnostics }`.
`fromMdast(root)` returns the Carve tree itself, and
`fromMdastWithDiagnostics(root)` returns `{ document, diagnostics }`. The one
option is `alignTables`, which pads table columns as carve-js `write` does.

A node with no Carve counterpart (a remark directive, for example) is left out
and reported as an `mdast-unmapped` warning, followed by any loss the writer
reports. `carveStringify` turns each entry into a message on the file, placed
at the mdast node when it has a position.

The round trip `carveParse` then `carveStringify` renders the same HTML as the
input for the feature demo and every test case, with and without sections. The
source is not kept byte for byte: the writer's canonical spelling replaces the
author's, ids a heading generates anyway are not written, comments are gone,
and caption numbers come back as the numbers they rendered.

## Differences from carve-js HTML

The tests render real documents both ways and compare the HTML, ignoring
attribute order and whitespace between blocks. Run over the render examples of
the Carve 0.2 spec (`spec/0.2/conformance/examples.json`, the 477 without
options), 449 come out equivalent (footnotes compared by content, see below);
the other 28 fall into these known differences:

- **Footnotes** use remark-rehype's GFM footnote markup
  (`section.footnotes`, `user-content-` ids) instead of carve-js endnotes. The
  notes, their order and their content are the same.
- **Task checkboxes** have no `aria-label`. remark-rehype builds the checkbox
  from `listItem.checked`, and node data cannot reach it.
- **Code block attributes**, including the title, land on `<code>` instead of
  `<pre>`, because remark-rehype applies a `code` node's data to the inner
  element.
- **URLs** are percent-encoded by remark-rehype (`a\b` becomes `a%5Cb`).
- **A tight list item with a second block** loses that block's `<p>` (12
  examples): remark-rehype unwraps every paragraph of a tight item, carve-js
  only the first.
- **An include directive when no `includes` option is given** renders
  nothing; carve-js writes its source as a paragraph (7 examples). With
  `includes`, both expand it the same way.
- **A footnote reference inside link text** renders as a nested link.
- **The `::: footnotes` placement directive** renders as a plain directive;
  the notes stay at the end.
- **Cross-references to figures, listings and equations** (`</#fig-sun>`)
  stay as text; only heading references become links.
- **Body header rows and columns** (`body-header-rows`, `body-header-cols`) are
  not applied.

carve-js extensions (`mermaid`, `codeGroup`, `tabs` and the rest, which are
provisional in 0.2) are not run. Their constructs reach mdast as carve-js
parses them without the extension, which is also how carve-js renders them by
default. A `block_extension` node from a tree parsed with extensions maps to its
fallback blocks.

## Not included

There is no rehype plugin: the HTML side is plain remark-rehype.

## Development

```sh
npm ci
npm run build
npm test
npm run typecheck
```

`npm test` runs the compiled tests in `dist`. The demo fixture in
`test/fixtures/demo.crv` is a copy of the Carve feature demo.

## License

MIT
