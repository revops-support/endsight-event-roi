// Uploads dist/hubspot-template.html as a coded page template in the hosting HubSpot portal.
// A password-protected website page built on this template shows the new data as soon as the upload lands.
// Needs HUBSPOT_PUBLISH_TOKEN: a private app token on the hosting portal with the `content` scope.
// Optional: HUBSPOT_TEMPLATE_PATH (default endsight/endsight-event-roi.html).

import {readFile} from 'node:fs/promises';

const TOKEN = process.env.HUBSPOT_PUBLISH_TOKEN;
const PATH = process.env.HUBSPOT_TEMPLATE_PATH || 'endsight/endsight-event-roi.html';
const BASE = process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com';

if (!TOKEN) { console.error('[publish] HUBSPOT_PUBLISH_TOKEN is not set'); process.exit(1); }

const html = await readFile('dist/hubspot-template.html', 'utf8');
const form = new FormData();
form.append('file', new Blob([html], {type: 'text/html'}), PATH.split('/').pop());

const url = `${BASE}/cms/v3/source-code/published/content/${PATH.split('/').map(encodeURIComponent).join('/')}`;
for (let attempt = 0; attempt < 5; attempt++) {
  const res = await fetch(url, {method: 'PUT', headers: {Authorization: `Bearer ${TOKEN}`}, body: form});
  if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
  const text = await res.text();
  if (!res.ok) { console.error(`[publish] ${res.status}: ${text.slice(0, 500)}`); process.exit(1); }
  console.log(`[publish] uploaded ${PATH} (${(html.length / 1024).toFixed(0)} KB)`);
  process.exit(0);
}
console.error('[publish] HubSpot kept failing after retries');
process.exit(1);
