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
- Tested against `@markup-carve/carve` 0.1.15.
