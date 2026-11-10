# unified-carve

A [unified](https://unifiedjs.com) parser plugin for [Carve](https://github.com/markup-carve/carve).
It turns Carve source into [mdast](https://github.com/syntax-tree/mdast), so a
Carve document can go through remark and rehype plugins.

Parsing is done by the Carve engine, [`@markup-carve/carve`](https://github.com/markup-carve/carve-js).
The plugin converts the engine's resolved AST to mdast; it does not render HTML
and parse it back.

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

`allowDangerousHtml` is only needed for Carve raw HTML (`` `<b>x</b>`{=html} ``
and `` ```=html `` blocks). Without it remark-rehype drops those nodes.

To get the tree without a processor, use `carveToMdast(source, options)`, or
`toMdast(document, options)` for a document you already parsed and resolved
with carve-js.

### Options

- `sections` (default `true`): wrap each top-level heading and the content it
  opens in a `carveSection` node rendering `<section>`, with the heading id on
  the section, as carve-js does. With `false` the tree stays flat and the id
  stays on the heading, which matches carve-js with `sections: false`.

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
| `strike` (`~x~`)                                     | `delete` with `hName: 's'`                                                       |
| `code` (inline)                                      | `inlineCode`                                                                     |
| `code_block`                                         | `code` (`lang`, header in `meta`)                                                |
| `list`, `list_item`                                  | `list`, `listItem` (`checked` for task items, `spread` from tightness)           |
| `block_quote`                                        | `blockquote`                                                                     |
| `link`, `autolink`, resolved `heading_ref`           | `link`                                                                           |
| `image`                                              | `image`                                                                          |
| `table` with one header row and no spans or caption  | `table`, `tableRow`, `tableCell` (`align` per column)                            |
| other `table`                                        | `carveTable`, `carveTableCaption`, `carveTableSection`, `carveTableRow`, `carveTableCell` |
| `footnote_ref`, `inline_footnote`, footnote bodies   | `footnoteReference`, `footnoteDefinition`                                        |
| `thematic_break`                                     | `thematicBreak`                                                                  |
| `hard_break`                                         | `break`                                                                          |
| `raw_inline`, `raw_block` for `html`                 | `html`                                                                           |
| `link_reference_definition`                          | `definition`                                                                     |
| frontmatter (`yaml`, `toml`)                         | `yaml`, `toml`                                                                   |
| `text`, `escaped_text`, `smart_punctuation`, `non_breaking_space`, `soft_break`, `caption_number`, `citation_group` | `text` |
| `math`                                               | `inlineMath`, rendered as carve-js's `span.math`                                 |
| `underline`, `superscript`, `subscript`, `highlight` | `carveUnderline`, `carveSuperscript`, `carveSubscript`, `carveHighlight`         |
| `insert`, `delete`, `substitution`, `critic_comment` | `carveInsert`, `carveDelete`, `carveCriticComment`                               |
| `span` (incl. `kbd`, `abbr`, `time`), `literal_inline` and `symbol` with attributes | `carveSpan`                                       |
| `abbreviation`                                       | `carveAbbreviation`                                                              |
| `small_caps`, `ruby`                                 | `carveSmallCaps`, `carveRuby` / `carveRubyText`                                  |
| `mention`, `tag`, `inline_extension`                 | `carveMention`, `carveTag`, `carveExtension` (`name`)                            |
| `admonition`, `directive`                            | `carveAdmonition`, `carveDirective` (`kind`), with `carveContainerTitle` and `carveContainerLabel` |
| `div`, `line_block`, `section`                       | `carveDiv`, `carveLineBlock`, `carveSection`                                     |
| `definition_list`                                    | `carveDefinitionList`, `carveDefinitionTerm`, `carveDefinitionDescription`       |
| `figure`, `figure_group`                             | `carveFigure`, `carveFigureGroup`, `carveFigureCaption`                          |
| `comment`, `abbreviation_def`, `citation_definition`, non-HTML raw | dropped (carve-js renders nothing for them)                        |

`carveElement` nodes hold internal structure (`<rp>`, `<colgroup>`, an
equation number). TypeScript types for the custom nodes are exported and added
to mdast's content maps.

## Differences from carve-js HTML

The tests render real documents both ways and compare the HTML, ignoring
attribute order and whitespace between blocks. Run over the Carve spec corpus,
2334 of 2401 cases come out equivalent (footnotes compared by content, see
below); the other 67 fall into these known differences:

- **Footnotes** use remark-rehype's GFM footnote markup
  (`section.footnotes`, `user-content-` ids) instead of carve-js endnotes. The
  notes, their order and their content are the same.
- **Task checkboxes** have no `aria-label`. remark-rehype builds the checkbox
  from `listItem.checked`, and node data cannot reach it.
- **Code block attributes**, including the header title, land on `<code>`
  instead of `<pre>`, because remark-rehype applies a `code` node's data to the
  inner element.
- **URLs** are percent-encoded by remark-rehype (`a\b` becomes `a%5Cb`).
- **A tight list item with a second paragraph** loses that paragraph's `<p>`:
  remark-rehype unwraps every paragraph of a tight item, carve-js only the
  first.
- **A footnote reference inside link text** renders as a nested link.
- **The `::: footnotes` placement directive** renders as a plain directive;
  the notes stay at the end.
- **An empty code block** renders `<code></code>` where carve-js keeps one
  newline.

carve-js extensions (`mermaid`, `codeGroup`, `listTable` and the rest) are not
run. Their constructs reach mdast as carve-js parses them without the
extension, which is also how carve-js renders them by default.

## Not included

There is no `carveStringify` (mdast to Carve) yet. Going through Markdown and
carve-js's `markdownToCarve` would drop every `carve*` node and re-read
Markdown ambiguities, so it cannot round-trip. The sound route is mdast to the
Carve AST and then carve-js's `renderCarve`, which needs an inverse for every
mapping above plus a place to keep fields that only shape HTML (task states,
list markers, table spans). That is planned as its own change.

There is no rehype plugin either: the HTML side is plain remark-rehype.

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
