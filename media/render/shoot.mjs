import { createRequire } from 'node:module'
const require = createRequire('/home/misaka/.hermes/hermes-agent/node_modules/')
const { chromium } = require('playwright-core')
const [,, file, out, w, h, scale] = process.argv
const browser = await chromium.launch({ executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--no-proxy-server', '--allow-file-access-from-files'] })
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: +(scale || 1) })
await page.goto('file://' + process.cwd() + '/' + file)
await page.waitForTimeout(800)
await page.screenshot({ path: out })
await browser.close()
