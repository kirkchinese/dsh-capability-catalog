// Render media/render/promo.html frame by frame and encode with ffmpeg.
// Usage: node render.mjs <out.mp4> [fps] [from] [to]   (set PREVIEW=1 for 960x540 drafts)
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire('/home/misaka/.hermes/hermes-agent/node_modules/')
const { chromium } = require('playwright-core')
const here = dirname(fileURLToPath(import.meta.url))
const [,, out = join(here, '../out/promo-video.mp4'), fpsArg = '30', fromArg = '0', toArg] = process.argv
const fps = Number(fpsArg)

// Inline the real REA tool names so the page needs no fetch.
const html = readFileSync(join(here, 'promo.html'), 'utf8')
  .replace('<script>', `<script>const TOOL_NAMES = ${readFileSync(join(here, 'tool-names.json'), 'utf8')};\n`)
const page_ = join(here, '.promo.build.html')
writeFileSync(page_, html)

const preview = process.env.PREVIEW === '1'
const browser = await chromium.launch({ executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--no-proxy-server', '--allow-file-access-from-files'] })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: preview ? .5 : 1 })
await page.goto('file://' + page_)
await page.evaluate(() => document.fonts.ready)
await page.waitForTimeout(1500)
const duration = await page.evaluate(() => window.DURATION)
const from = Number(fromArg), to = toArg === undefined ? duration : Number(toArg)
const total = Math.round((to - from) * fps)

const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
  '-c:v', 'libx264', '-preset', preview ? 'veryfast' : 'slow', '-crf', preview ? '28' : '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] })
const started = Date.now()
for (let i = 0; i < total; i++) {
  const t = from + i / fps
  await page.evaluate((time) => window.render(time), t)
  const frame = await page.screenshot({ type: 'jpeg', quality: preview ? 80 : 94 })
  if (!ff.stdin.write(frame)) await new Promise((r) => ff.stdin.once('drain', r))
  if (i % (fps * 5) === 0) process.stderr.write(`t=${t.toFixed(1)}s ${((Date.now() - started) / 1000).toFixed(0)}s elapsed\n`)
}
ff.stdin.end()
await new Promise((r) => ff.on('close', r))
await browser.close()
console.log('wrote', out, total, 'frames')
