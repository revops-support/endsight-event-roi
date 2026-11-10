// Public endpoint behind the page's Refresh data button: /hs/serverless/endsight-event-roi/refresh
//
//   POST  starts the refresh workflow, or joins one already running, and returns the run
//   GET   ?run=<id> returns that run's status; with no id, the newest run
//
// The GitHub token lives in the HubSpot secret ENDSIGHT_GITHUB_TOKEN and never leaves this
// function. Callers only ever get a run's id, status, conclusion and timestamps.
// The endpoint is public, so it never starts a second run while one is queued or running,
// and never starts one within COOLDOWN_MS of the last.

const REPO = 'revops-support/endsight-event-roi';
const WORKFLOW = 'refresh.yml';
const REF = 'main';
const COOLDOWN_MS = 60 * 1000;
const API = `https://api.github.com/repos/${REPO}/actions`;

const reply = (statusCode, body) => ({
  statusCode,
  headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
  body
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const one = (v) => (Array.isArray(v) ? v[0] : v);

function shape(run) {
  if (!run) return null;
  return {id: run.id, status: run.status, conclusion: run.conclusion, createdAt: run.created_at, updatedAt: run.updated_at};
}

exports.main = async (context) => {
  const token = process.env.ENDSIGHT_GITHUB_TOKEN;
  if (!token) return reply(503, {error: 'not_configured'});

  async function gh(path, options = {}) {
    const res = await fetch(API + path, {
      method: options.method || 'GET',
      body: options.body ? JSON.stringify(options.body) : undefined,
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
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
  const listRuns = async (extra = '') => (await gh(`/workflows/${WORKFLOW}/runs?per_page=5${extra}`)).workflow_runs || [];

  try {
    const method = String(context.method || 'GET').toUpperCase();
    const query = context.query || context.params || {};

    if (method === 'GET') {
      const id = String(one(query.run) || '');
      if (!id) return reply(200, {run: shape((await listRuns())[0])});
      if (!/^\d{1,20}$/.test(id)) return reply(400, {error: 'bad_run_id'});
      const run = await gh(`/runs/${id}`);
      // Only report on runs of this workflow.
      if (!String(run.path || '').endsWith(`/${WORKFLOW}`)) return reply(404, {error: 'not_found'});
      return reply(200, {run: shape(run)});
    }

    if (method !== 'POST') return reply(405, {error: 'method_not_allowed'});

    const before = await listRuns();
    const active = before.find((r) => r.status !== 'completed');
    if (active) return reply(200, {run: shape(active), started: false});
    const last = before[0];
    if (last && Date.now() - Date.parse(last.created_at) < COOLDOWN_MS) return reply(200, {run: shape(last), started: false});

    // The dispatch call does not return the run, so look for a run that was not there before.
    const seen = new Set(before.map((r) => r.id));
    const dispatchedAt = new Date().toISOString();
    await gh(`/workflows/${WORKFLOW}/dispatches`, {method: 'POST', body: {ref: REF}});
    for (let i = 0; i < 4; i++) {
      await sleep(2000);
      const fresh = (await listRuns('&event=workflow_dispatch')).find((r) => !seen.has(r.id));
      if (fresh) return reply(202, {run: shape(fresh), started: true, dispatchedAt});
    }
    return reply(202, {run: null, started: true, dispatchedAt});
  } catch (err) {
    const status = err.status === 401 || err.status === 403 ? 502 : err.status === 404 ? 502 : 500;
    return reply(status, {error: err.status ? `github_${err.status}` : 'failed'});
  }
};
