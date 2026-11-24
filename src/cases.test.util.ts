import { CODE_ATTRIBUTES_ON_CODE, TASK_CHECKBOX_NAME, URL_ENCODING, type AcceptedDifference } from './normalize.test.util.js'

/** Carve sources the HTML equivalence and round-trip tests share: a name, the source, accepted differences. */
export const cases: Array<[string, string, AcceptedDifference[]?]> = [
  // U-065, U-066, U-067, U-068: braced underline, strike and highlight; strong outside emphasis.
  ['inline formatting', '/em/ *strong* */both/* {_u_} {~s~} {=mark=} x{^2^} H{,2,}O `code` !`lit`\n'],
  // U-069: the substitution arrow is a deletion and an insertion.
  ['editorial markup', '{+in+} {-out-} {-old-}{+new+} {#note#}\n'],
  ['escapes and smart punctuation', '\\*no\\* "quoted" it\'s --- -- ... (tm) 10\\ kg\n'],
  ['hard break and soft break', 'a \\\nb\nc\n'],
  ['links', '[a](https://e.com "T") <https://e.com> <mailto:a@b.c> [r][] [missing][nope]\n\n[r]: /r "R"\n'],
  ['nested links unwrap', '[a [b](/b) c](/a)\n'],
  ['dangerous destinations are blanked', '[x](javascript:alert(1)) ![y](data:x)\n'],
  ['percent-encoded destinations', '[x](a\\b)\n', [URL_ENCODING]],
  ['images', '![alt](a.png "t"){.big}\n\nText ![inline](b.png) here.\n'],
  ['figure with a numbered caption', '![a](a.png)\n^ Figure #: Cap\n\n> q\n^ Who\n'],
  ['headings, ids and sections', '{#top .lead}\n# One\n\ntext\n\n## Two\n\n### Three\n\n# Four\n\nsee </#top>\n'],
  // The upgrade tool escapes `a.`, which 0.1 read as text.
  ['lists', '- a\n- b\n\n. one\n. two\n\n3) three\n4) four\n\na\\. x\nb. y\n'],
  // U-018: a blank line between items makes the list loose.
  ['loose list', '- a\n\n  b\n\n- c\n'],
  ['task list', '- [ ] todo\n- [x] done\n- [-] dropped\n', [TASK_CHECKBOX_NAME]],
  ['task item with its own class', '-{.c} [ ] todo\n- [x] done\n', [TASK_CHECKBOX_NAME]],
  ['definition lists', ':: Term\n: one\n:: Two\n: a\n\n  b\n'],
  ['block quote', '> a\n>\n> b\n'],
  // U-056: alignment marks in braces.
  ['GFM-shaped table', '|= A |={>} B |={~} C |\n| 1 | 2 | 3 |\n'],
  // The upgrade tool writes a first-column `<`, which 0.1 read as an empty cell, as an empty cell.
  ['table with spans and no header', '| a | b |\n| ^ | c |\n|  | d |\n'],
  ['table with a header span', '|= H |= G |\n| 1 | 2 |\n| ^ | 3 |\n'],
  ['table with a caption and widths', '{widths=0.3,0.7}\n|= a |= b |\n| 1 | 2 |\n^ Table #: t\n'],
  ['table attributes', '{.wide #t}\n|= a |\n| 1 |\n'],
  ['admonitions and directives', '::: note\nplain\n:::\n\n::: tip "Title"\nbody\n:::\n\n{.x}\n::: custom [lbl]\nz\n:::\n'],
  ['generic div', '{#c .k}\n:::\ninside\n:::\n'],
  ['line block', '::: |\nline one\n  line two\n:::\n'],
  ['composite figure', '::: figure\n![one](a.png)\n^ (a) One\n\n![two](b.png)\n^ (b) Two\n:::\n^ Figure #: Both\n'],
  ['code blocks', '```js\nlet a = 1\n```\n\n```\nplain\n```\n'],
  ['code block with a header', '```js "a.js"\nx\n```\n', [CODE_ATTRIBUTES_ON_CODE]],
  ['raw passthrough', '`<b>b</b>`{=html} `x`{=latex}\n\n```=html\n<div>raw</div>\n```\n\n```=latex\n\\x\n```\n'],
  ['math', '$`a+b` and $$`c`\n'],
  ['semantic spans', '[Ctrl]{kbd} [HTML]{abbr="HyperText"} [x]{.c #i k=v} [d]{time="2026-01-01"}\n'],
  ['abbreviations', '*[HTML]: HyperText Markup Language\n\nHTML here.\n'],
  ['mentions, tags and extensions', '@alice #tag :spoiler[hidden] [x]{:tada:}\n'],
  ['comments', '%% gone\ntext %% trailing\n'],
  ['frontmatter', '---\ntitle: x\n---\n\nbody\n'],
  ['footnotes', 'a[^n] b[^n] c^[inline]\n\n[^n]: note\n'],
  ['inline note beside a label that looks generated', 'x^[inline] y[^carve-inline-1]\n\n[^carve-inline-1]: authored\n'],
  ['footnote ending in a block', 'a[^n]\n\n[^n]: note\n\n    > quoted\n'],
  ['thematic break with attributes', '{.sep}\n***\n'],
  ['bidi controls are stripped', 'a‮b `c‮d`\n'],
]
