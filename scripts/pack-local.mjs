#!/usr/bin/env node
// Packs every package into a directory for local installation tests. Workspace
// dependencies become file: links to the sibling tarballs, since alphas are not published.
// Usage: node scripts/pack-local.mjs <outDir>
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(process.argv[2] ?? join(tmpdir(), 'dsh-capability-catalog-packs'))
mkdirSync(out, { recursive: true })
execFileSync('pnpm', ['--dir', 'packages/capability-catalog', 'build'], { cwd: root, stdio: 'inherit' })
execFileSync(process.execPath, ['scripts/sync-patches.mjs'], { cwd: root, stdio: 'inherit' })
const tarballs = {}
for (const name of ['capability-catalog', 'rea', 're-kit']) {
  const source = join(root, 'packages', name)
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  const stage = mkdtempSync(join(tmpdir(), `pack-${name}-`))
  cpSync(source, stage, { recursive: true, filter: (path) => !path.includes('node_modules') })
  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    if (String(range).startsWith('workspace:')) manifest.dependencies[dep] = `file:${tarballs[dep]}`
  }
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const file = execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', out], { cwd: stage, encoding: 'utf8' }).trim().split('\n').pop()
  tarballs[manifest.name] = join(out, file)
  console.log(tarballs[manifest.name])
}
