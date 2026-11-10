import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const consumer = mkdtempSync(join(tmpdir(), 'unified-carve-consumer-'))
mkdirSync(join(consumer, 'node_modules', '@markup-carve'), { recursive: true })
symlinkSync(root, join(consumer, 'node_modules', '@markup-carve', 'unified-carve'), 'dir')
after(() => rmSync(consumer, { recursive: true, force: true }))

const codeOf = (specifier: string): string =>
  execFileSync(process.execPath, ['-e', `import(${JSON.stringify(specifier)}).then(() => console.log('RESOLVED'), (e) => console.log(e.code ?? String(e)))`], {
    cwd: consumer,
    encoding: 'utf8',
  }).trim()

test('the installed package resolves its entry point and nothing past the exports map', () => {
  assert.equal(codeOf('@markup-carve/unified-carve'), 'RESOLVED')
  assert.equal(codeOf('@markup-carve/unified-carve/dist/to-mdast.js'), 'ERR_PACKAGE_PATH_NOT_EXPORTED')
})

test('the tarball carries no compiled test files', () => {
  const output = execFileSync(process.execPath, [process.env.npm_execpath ?? 'npm', 'pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  // npm 12 prints notices before the JSON and keys it by package name.
  const parsed = JSON.parse(output.slice(output.search(/^[[{]/m))) as
    | Array<{ files: Array<{ path: string }> }>
    | Record<string, { files: Array<{ path: string }> }>
  const packed = Array.isArray(parsed) ? parsed : Object.values(parsed)
  const paths = packed[0]?.files.map((file) => file.path) ?? []
  assert.ok(paths.includes('dist/index.js'))
  assert.deepEqual(paths.filter((path) => /\.test\./.test(path)), [])
})
