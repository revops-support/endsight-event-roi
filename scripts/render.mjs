// Builds the dashboard from src/template.html and data/data.json.
// The data is gzipped and base64-encoded so the page stays small, then split into chunks.
// Writes:
//   dist/index.html                     standalone page for any web server, chunks inline
//   dist/hubspot/<name>.html            HubSpot coded page template that includes the chunk partials
//   dist/hubspot/<name>-data-<stamp>-<n>.html  one partial per chunk, each well under HubSpot's 1.5 MiB limit
//   dist/hubspot/manifest.json          upload order for publish-hubspot.mjs
// Optional: DATA (default data/data.json), OUT_DIR (default dist), OUTPUT_PATH (also copy index.html here),
// HUBSPOT_TEMPLATE_PATH (default endsight/endsight-event-roi.html), REFRESH_ENDPOINT (shows the Refresh button).

import {readFile, writeFile, mkdir, copyFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';

const DATA = process.env.DATA || 'data/data.json';
const OUT_DIR = process.env.OUT_DIR || 'dist';
const TEMPLATE_PATH = process.env.HUBSPOT_TEMPLATE_PATH || 'endsight/endsight-event-roi.html';
const CHUNK_CHARS = Number(process.env.CHUNK_CHARS || 1_000_000); // HubSpot rejects coded files over 1.5 MiB

const template = await readFile('src/template.html', 'utf8');
const logo = (await readFile('src/logo.png')).toString('base64');
const data = JSON.parse(await readFile(DATA, 'utf8'));

// Escape so nothing can close the script tag or end HubL's raw block.
// These characters only ever appear inside JSON strings, where \u escapes are valid.
const safe = (v) => JSON.stringify(v)
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026')
  .replace(/%/g, '\\u0025')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

// Base64 uses only A-Z a-z 0-9 + / =, so the chunks are safe in HTML and in HubL.
const packed = gzipSync(Buffer.from(JSON.stringify(data)), {level: 9}).toString('base64');
const chunks = [];
for (let i = 0; i < packed.length; i += CHUNK_CHARS) chunks.push(packed.slice(i, i + CHUNK_CHARS));
const chunkTag = (c) => `<script type="text/plain" class="es-chunk">${c}</script>`;

// Refresh button: only built in when REFRESH_ENDPOINT is set. It is the URL of the Cloudflare Worker
// (cloudflare-worker/), which holds the GitHub token. The page itself never carries a credential.
const refresh = process.env.REFRESH_ENDPOINT ? {endpoint: process.env.REFRESH_ENDPOINT} : null;
const meta = {generatedAt: data.generatedAt || null};

// Function replacements, so a "$&" or "$'" inside the content is not read as a replacement pattern.
const page = template
  .replace('/*__LOGO__*/', () => logo)
  .replace('/*__META__*/', () => safe(meta))
  .replace('/*__REFRESH__*/', () => safe(refresh));
for (const p of ['/*__LOGO__*/', '/*__META__*/', '/*__REFRESH__*/', '<!--__DATA__-->']) {
  if (!page.includes(p) && p === '<!--__DATA__-->') throw new Error('template is missing the data marker');
  if (page.includes(p) && p !== '<!--__DATA__-->') throw new Error(`template placeholder ${p} not replaced`);
}

const standalone = page
  .replace('<!--__DATA__-->', () => chunks.map(chunkTag).join('\n'))
  .replace('<!--HUBSPOT_HEAD-->\n', () => '').replace('<!--HUBSPOT_FOOTER-->\n', () => '');

// HubSpot: each chunk becomes a partial. A new stamp per build means the live template never mixes
// chunks from two different runs while an upload is in progress.
const dir = TEMPLATE_PATH.split('/').slice(0, -1).join('/');
const base = TEMPLATE_PATH.split('/').pop().replace(/\.html$/, '');
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const parts = chunks.map((c, n) => ({path: `${dir ? dir + '/' : ''}${base}-data-${stamp}-${n}.html`, content: [
  '<!--\n    templateType: page\n    isAvailableForNewContent: false\n-->',
  chunkTag(c)
].join('\n')}));
const hubspot = [
  '<!--\n    templateType: page\n    isAvailableForNewContent: true\n    label: Endsight Event ROI\n-->',
  '{% raw %}',
  page
    .replace('<!--__DATA__-->', () => '{% endraw %}' + parts.map((p) => `{% include "/${p.path}" %}`).join('\n') + '{% raw %}')
    .replace('<!--HUBSPOT_HEAD-->', () => '{% endraw %}{{ standard_header_includes }}{% raw %}')
    .replace('<!--HUBSPOT_FOOTER-->', () => '{% endraw %}{{ standard_footer_includes }}{% raw %}'),
  '{% endraw %}'
].join('\n');

await mkdir(OUT_DIR, {recursive: true});
await rm(join(OUT_DIR, 'hubspot'), {recursive: true, force: true});
await mkdir(join(OUT_DIR, 'hubspot'), {recursive: true});
await writeFile(join(OUT_DIR, 'index.html'), standalone);
const files = [];
for (const p of parts) {
  const local = join(OUT_DIR, 'hubspot', p.path.split('/').pop());
  await writeFile(local, p.content);
  files.push({local, path: p.path});
}
const mainLocal = join(OUT_DIR, 'hubspot', TEMPLATE_PATH.split('/').pop());
await writeFile(mainLocal, hubspot);
files.push({local: mainLocal, path: TEMPLATE_PATH});
// Chunks first, then the template that includes them; publish deletes older chunks afterwards.
await writeFile(join(OUT_DIR, 'hubspot', 'manifest.json'), JSON.stringify({files, chunkPrefix: `${base}-data-`, keep: parts.map((p) => p.path)}, null, 2));
if (process.env.OUTPUT_PATH) await copyFile(join(OUT_DIR, 'index.html'), process.env.OUTPUT_PATH);

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log(`[render] data ${kb(JSON.stringify(data).length)} raw, ${kb(packed.length)} packed in ${chunks.length} chunk(s); ` +
  `page ${kb(standalone.length)}, HubSpot template ${kb(hubspot.length)}; refresh button ${refresh ? 'on' : 'off'}`);
