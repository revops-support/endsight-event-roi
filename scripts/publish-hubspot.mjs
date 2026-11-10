// Uploads the files render.mjs wrote to dist/hubspot/ into the hosting portal's Design Manager:
// the data chunk partials first, then the page template that includes them, then deletes
// chunk partials left over from earlier builds.
// Needs HUBSPOT_PUBLISH_TOKEN: a token on the hosting portal with the `content` scope.
// Optional: HUBSPOT_TEMPLATE_PATH (default endsight/endsight-event-roi.html), HUBSPOT_API_BASE.

import {readFile} from 'node:fs/promises';

const TOKEN = process.env.HUBSPOT_PUBLISH_TOKEN;
const BASE = process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com';
const OUT_DIR = process.env.OUT_DIR || 'dist';
if (!TOKEN) { console.error('[publish] HUBSPOT_PUBLISH_TOKEN is not set'); process.exit(1); }

const manifest = JSON.parse(await readFile(`${OUT_DIR}/hubspot/manifest.json`, 'utf8'));
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

async function call(method, url, body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {method, headers: {Authorization: `Bearer ${TOKEN}`}, body});
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
    return res;
  }
  throw new Error(`${method} ${url}: HubSpot kept failing after retries`);
}

try {
  for (const f of manifest.files) {
    const content = await readFile(f.local, 'utf8');
    const form = new FormData();
    form.append('file', new Blob([content], {type: 'text/html'}), f.path.split('/').pop());
    const res = await call('PUT', `${BASE}/cms/v3/source-code/published/content/${enc(f.path)}`, form);
    const text = await res.text();
    if (!res.ok) throw new Error(`upload ${f.path} -> ${res.status}: ${text.slice(0, 500)}`);
    console.log(`[publish] uploaded ${f.path} (${(content.length / 1024).toFixed(0)} KB)`);
  }

  // Clean up chunk partials from earlier builds. Failure here leaves stale files but no broken page.
  const dir = manifest.files[manifest.files.length - 1].path.split('/').slice(0, -1).join('/');
  const keep = new Set(manifest.keep);
  try {
    const res = await call('GET', `${BASE}/cms/v3/source-code/published/metadata/${enc(dir)}`);
    const meta = res.ok ? await res.json() : null;
    const children = (meta && meta.children) || [];
    for (const name of children) {
      const childName = typeof name === 'string' ? name : name.name;
      const path = `${dir}/${childName}`;
      if (!childName || !childName.startsWith(manifest.chunkPrefix) || keep.has(path)) continue;
      const del = await call('DELETE', `${BASE}/cms/v3/source-code/published/content/${enc(path)}`);
      console.log(`[publish] ${del.ok ? 'deleted' : `could not delete (${del.status})`} old ${path}`);
    }
  } catch (e) {
    console.log(`[publish] skipped cleanup: ${e.message}`);
  }
} catch (e) {
  console.error(`[publish] ${e.message}`);
  process.exit(1);
}
