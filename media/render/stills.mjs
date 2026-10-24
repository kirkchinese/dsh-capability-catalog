import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire('/home/misaka/.hermes/hermes-agent/node_modules/')
const { chromium } = require('playwright-core')
const here = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(here, 'promo.html'), 'utf8').replace('<script>', `<script>const TOOL_NAMES = ${readFileSync(join(here, 'tool-names.json'), 'utf8')};\n`)
writeFileSync(join(here, '.promo.build.html'), html)
const browser = await chromium.launch({ executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--no-proxy-server', '--allow-file-access-from-files'] })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: .5 })
const errs = []; page.on('pageerror', e => errs.push(e.message))
await page.goto('file://' + join(here, '.promo.build.html')); await page.waitForTimeout(1500)
const times = process.argv.slice(2).map(Number)
for (const t of times) { await page.evaluate(x => window.render(x), t); await page.screenshot({ path: join(here, `../out/still-${t}.jpg`), type: 'jpeg', quality: 80 }) }
console.log(errs.join('\n') || 'no page errors')
await browser.close()
