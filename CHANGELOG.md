# Changelog

Notable changes to `unified-carve`.

Parsing is done by the Carve engine (`@markup-carve/carve`), so an engine
change can alter the tree with no plugin diff. Engine bumps therefore get an
entry of their own.

## Unreleased

### Added

- `carveParse`, a unified parser plugin that turns Carve source into mdast
  through the carve-js AST, with `carve*` nodes for constructs mdast has no
  node for. `carveToMdast` and `toMdast` expose the same conversion without a
  processor.
- A `sections` option, on by default, that wraps top-level headings in
  `carveSection` nodes as carve-js renders them.
- Engine: carve-js `next2` at `eb2ffc1`, the Milestone 6 engine.

### Changed

- Ported to Carve 0.2: the plugin reads the carve-js 0.2 tree (AST contract
  2.0) and follows its HTML. The engine is pinned to the carve-js `next2`
  branch by commit until 0.2 is published.
- Raw HTML is escaped unless the new `rawHtml` option is on, as in carve-js 0.2.
- New `urlPolicy` option, the carve-js URL policy for link and image
  destinations.
- mdast offsets are string offsets; carve-js 0.2 positions count UTF-8 bytes.
