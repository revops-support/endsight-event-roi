// Cloudflare Worker behind the Endsight Event ROI page's Refresh data button.
//
//   POST /   starts the refresh workflow, or joins one already running, and returns the run
//   GET  /   ?run=<id> returns that run's status; with no id, the newest run
//
// Settings > Variables and Secrets on the Worker:
//   GITHUB_TOKEN    (secret, required) fine-grained token: this repository only, Actions read and write
//   ALLOWED_ORIGIN  (text, recommended) the page's origin, e.g. https://www.endsight.net; '*' if unset
//   REPO, WORKFLOW, REF (text, optional) default revops-support/endsight-event-roi, refresh.yml, main
//
// The token never leaves the Worker. Callers only get a run's id, status, conclusion and timestamps.
// The endpoint is public, so it never starts a second run while one is queued or running,
// and never starts one within COOLDOWN_MS of the last.

const COOLDOWN_MS = 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shape(run) {
  if (!run) return null;
  return {id: run.id, status: run.status, conclusion: run.conclusion, createdAt: run.created_at, updatedAt: run.updated_at};
}

export default {
  async fetch(request, env) {
    const repo = env.REPO || 'revops-support/endsight-event-roi';
    const workflow = env.WORKFLOW || 'refresh.yml';
    const ref = env.REF || 'main';
    const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    const reply = (status, body) => new Response(JSON.stringify(body), {
      status,
      headers: {...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store'}
    });

    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
    if (!allowed.includes('*') && origin && !allowed.includes(origin)) return reply(403, {error: 'origin_not_allowed'});
    if (!env.GITHUB_TOKEN) return reply(503, {error: 'not_configured'});

    const api = `https://api.github.com/repos/${repo}/actions`;
    async function gh(path, options = {}) {
      const res = await fetch(api + path, {
        method: options.method || 'GET',
        body: options.body ? JSON.stringify(options.body) : undefined,
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'endsight-event-roi-refresh',
          ...(options.body ? {'Content-Type': 'application/json'} : {})
        }
      });
      if (!res.ok) {
        const err = new Error(`GitHub ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.status === 204 ? null : res.json();
    }
    const listRuns = async (extra = '') => (await gh(`/workflows/${workflow}/runs?per_page=5${extra}`)).workflow_runs || [];

    try {
      const url = new URL(request.url);

      if (request.method === 'GET') {
        const id = url.searchParams.get('run') || '';
        if (!id) return reply(200, {run: shape((await listRuns())[0])});
        if (!/^\d{1,20}$/.test(id)) return reply(400, {error: 'bad_run_id'});
        const run = await gh(`/runs/${id}`);
        // Only report on runs of this workflow.
        if (!String(run.path || '').endsWith(`/${workflow}`)) return reply(404, {error: 'not_found'});
        return reply(200, {run: shape(run)});
      }

      if (request.method !== 'POST') return reply(405, {error: 'method_not_allowed'});

      const before = await listRuns();
      const active = before.find((r) => r.status !== 'completed');
      if (active) return reply(200, {run: shape(active), started: false});
      const last = before[0];
      if (last && Date.now() - Date.parse(last.created_at) < COOLDOWN_MS) return reply(200, {run: shape(last), started: false});

      // The dispatch call does not return the run, so look for a run that was not there before.
      const seen = new Set(before.map((r) => r.id));
      const dispatchedAt = new Date().toISOString();
      await gh(`/workflows/${workflow}/dispatches`, {method: 'POST', body: {ref}});
      for (let i = 0; i < 4; i++) {
        await sleep(2000);
        const fresh = (await listRuns('&event=workflow_dispatch')).find((r) => !seen.has(r.id));
        if (fresh) return reply(202, {run: shape(fresh), started: true, dispatchedAt});
      }
      return reply(202, {run: null, started: true, dispatchedAt});
    } catch (err) {
      return reply(err.status ? 502 : 500, {error: err.status ? `github_${err.status}` : 'failed'});
    }
  }
};
