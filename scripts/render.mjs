// Builds the dashboard from src/template.html and data/data.json.
// Writes two files:
//   dist/index.html            standalone page for any web server
//   dist/hubspot-template.html the same page as a HubSpot coded page template
// Optional: DATA (default data/data.json), OUT_DIR (default dist), OUTPUT_PATH (also copy index.html here).

import {readFile, writeFile, mkdir, copyFile} from 'node:fs/promises';
import {join} from 'node:path';

const DATA = process.env.DATA || 'data/data.json';
const OUT_DIR = process.env.OUT_DIR || 'dist';

const template = await readFile('src/template.html', 'utf8');
const logo = (await readFile('src/logo.png')).toString('base64');
const data = JSON.parse(await readFile(DATA, 'utf8'));

// Escape so nothing in the data can close the script tag or end HubL's raw block.
// These characters only ever appear inside JSON strings, where \u escapes are valid.
const safe = (v) => JSON.stringify(v)
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026')
  .replace(/%/g, '\\u0025')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');
const json = safe(data);

// Refresh button: only built in when REFRESH_ENDPOINT is set. It is the URL of the Cloudflare Worker
// (cloudflare-worker/), which holds the GitHub token. The page itself never carries a credential.
const refresh = process.env.REFRESH_ENDPOINT ? {endpoint: process.env.REFRESH_ENDPOINT} : null;

// Function replacements, so a "$&" or "$'" inside the data is not read as a replacement pattern.
const page = template.replace('/*__LOGO__*/', () => logo).replace('/*__DATA__*/', () => json).replace('/*__REFRESH__*/', () => safe(refresh));
if (page.includes('/*__DATA__*/') || page.includes('/*__LOGO__*/') || page.includes('/*__REFRESH__*/')) throw new Error('template placeholders not replaced');

const standalone = page.replace('<!--HUBSPOT_HEAD-->\n', () => '').replace('<!--HUBSPOT_FOOTER-->\n', () => '');

const hubspot = [
  '<!--\n    templateType: page\n    isAvailableForNewContent: true\n    label: Endsight Event ROI\n-->',
  '{% raw %}',
  page
    .replace('<!--HUBSPOT_HEAD-->', () => '{% endraw %}{{ standard_header_includes }}{% raw %}')
    .replace('<!--HUBSPOT_FOOTER-->', () => '{% endraw %}{{ standard_footer_includes }}{% raw %}'),
  '{% endraw %}'
].join('\n');

await mkdir(OUT_DIR, {recursive: true});
await writeFile(join(OUT_DIR, 'index.html'), standalone);
await writeFile(join(OUT_DIR, 'hubspot-template.html'), hubspot);
if (process.env.OUTPUT_PATH) await copyFile(join(OUT_DIR, 'index.html'), process.env.OUTPUT_PATH);
console.log(`[render] wrote ${OUT_DIR}/index.html and ${OUT_DIR}/hubspot-template.html (${(standalone.length / 1024).toFixed(0)} KB), refresh button ${refresh ? 'on' : 'off'}`);
