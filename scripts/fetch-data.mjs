// Pulls event ROI data from Endsight's HubSpot account and writes data/data.json.
// Needs HUBSPOT_TOKEN: a private app token on the Endsight portal (scopes in README).
// Optional: TIME_ZONE (default America/Los_Angeles), OUT (default data/data.json),
// HUBSPOT_PORTAL_ID (used if the account-info call is not allowed), INFLUENCED_LOOKBACK_DAYS (default 365),
// REPORT_BLINQ_TAGS / REPORT_CONTACTS_BY_STAGE (saved report ids the page links to).

import {mkdir, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

const TOKEN = process.env.HUBSPOT_TOKEN;
const TIME_ZONE = process.env.TIME_ZONE || 'America/Los_Angeles';
const OUT = process.env.OUT || 'data/data.json';
const BASE = process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com';
const LOOKBACK = Number(process.env.INFLUENCED_LOOKBACK_DAYS || 365);

const KNOWN_TAGS = ['Wants To Meet', 'Client', 'Referral Partner', 'Good Conversation', 'Participated In Draw'];
const CONTACT_PROPS = ['firstname', 'lastname', 'email', 'company', 'associatedcompanyid', 'lifecyclestage', 'type', 'blinq_campaigns', 'blinq_workspace_tags'];
// Meeting types that are not customer-facing; these never earn event credit.
const INTERNAL_MEETING_TYPES = (process.env.INTERNAL_MEETING_TYPES || 'Administrative / Internal / Interview;Personal').split(';').map((s) => s.trim().toLowerCase());

function log(...a) { console.log('[fetch]', ...a); }

async function hs(path, {method = 'GET', body, allow404 = false} = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers: {Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json'},
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (allow404 && res.status === 404) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : null;
  }
  throw new Error(`${method} ${path} kept failing after retries`);
}

function toMs(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  const ms = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}
// A date-only property (event date, campaign start/end) is stored as midnight UTC: its day is the UTC day.
function toDate(v) {
  if (v != null && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) return String(v);
  const ms = toMs(v);
  return ms == null ? null : new Date(ms).toISOString().slice(0, 10);
}
// A timestamp as the calendar day in the account's time zone.
function toDay(v) {
  const ms = toMs(v);
  if (ms == null) return null;
  return new Intl.DateTimeFormat('en-CA', {timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(ms));
}
function plusDays(d, n) { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isNaN(n) ? null : n; }
function yes(v) { return v === true || /^(true|yes)$/i.test(String(v)); }
function list(v) { return v == null ? [] : String(v).split(';').map((s) => s.trim()).filter(Boolean); }
function chunk(a, n) { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; }
function pick(o, keys) { for (const k of keys) { if (o && o[k] != null) return num(o[k]); } return null; }

async function propertyOptions(objectType, property) {
  const p = await hs(`/crm/v3/properties/${objectType}/${property}`, {allow404: true});
  return ((p && p.options) || []).slice().sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
}

async function portalInfo() {
  try {
    const a = await hs('/account-info/v3/details', {allow404: true});
    return {portalId: a && a.portalId ? String(a.portalId) : null, currency: a && a.companyCurrency};
  } catch (e) {
    log(`account info unavailable (${e.message.slice(0, 80)}); using HUBSPOT_PORTAL_ID`);
    return {portalId: null, currency: null};
  }
}

async function eventCampaigns() {
  const props = 'hs_name,event_date,hs_start_date,hs_end_date,hs_spend_items_sum_amount,hs_budget_items_sum_amount';
  const out = [];
  let after;
  do {
    const q = new URLSearchParams({limit: '100', properties: props});
    if (after) q.set('after', after);
    const page = await hs(`/marketing/v3/campaigns?${q}`);
    for (const c of page.results || []) {
      const p = c.properties || {};
      if (!p.event_date) continue;
      out.push({id: c.id, name: p.hs_name, eventDate: toDate(p.event_date), startDate: toDate(p.hs_start_date), endDate: toDate(p.hs_end_date),
        spend: num(p.hs_spend_items_sum_amount), budget: num(p.hs_budget_items_sum_amount)});
    }
    after = page.paging && page.paging.next && page.paging.next.after;
  } while (after);
  return out;
}

async function campaignAssets(guid, type, startDate, endDate) {
  const out = [];
  let after;
  do {
    const q = new URLSearchParams({limit: '100', startDate, endDate});
    if (after) q.set('after', after);
    const page = await hs(`/marketing/v3/campaigns/${guid}/assets/${type}?${q}`, {allow404: true});
    if (!page) break;
    // The list sits in `results`, or under assets.<TYPE>.paging.results in some responses.
    const block = page.assets && page.assets[type];
    const rows = page.results || (block && block.paging && block.paging.results) || [];
    for (const r of rows) out.push({id: String(r.id), name: r.name || null, metrics: r.metrics || {}});
    const paging = page.paging || (block && block.paging);
    after = paging && paging.next && paging.next.after;
  } while (after);
  return out;
}

async function campaignMetrics(guid, startDate, endDate) {
  try {
    const q = new URLSearchParams({startDate, endDate});
    const m = await hs(`/marketing/v3/campaigns/${guid}/reports/metrics?${q}`, {allow404: true});
    if (!m) return {sessions: null, influencedContacts: null};
    return {sessions: num(m.sessions), influencedContacts: num(m.influencedContacts)};
  } catch (e) {
    log(`campaign metrics unavailable for ${guid}: ${e.message.slice(0, 120)}`);
    return {sessions: null, influencedContacts: null};
  }
}

// Contacts the campaign influenced in the window (what HubSpot's "Associated Contacts by Stage" counts).
async function influencedContactIds(guid, startDate, endDate) {
  for (const type of ['influencedContacts', 'INFLUENCED_CONTACTS']) {
    try {
      const ids = [];
      let after;
      let found = false;
      do {
        const q = new URLSearchParams({startDate, endDate, limit: '100'});
        if (after) q.set('after', after);
        const page = await hs(`/marketing/v3/campaigns/${guid}/reports/contacts/${type}?${q}`, {allow404: true});
        if (!page) break;
        found = true;
        for (const r of page.results || []) ids.push(String(r.id != null ? r.id : r.contactId));
        after = page.paging && page.paging.next && page.paging.next.after;
      } while (after);
      if (found) return ids;
    } catch (e) {
      log(`influenced contacts (${type}) unavailable for ${guid}: ${e.message.slice(0, 120)}`);
    }
  }
  return null;
}

async function emailDetail(asset) {
  const m = asset.metrics || {};
  const base = {id: asset.id, name: asset.name, subject: null, sentOn: null, sent: num(m.SENT), delivered: null, opens: num(m.OPEN), clicks: num(m.CLICKS),
    bounces: null, unsubscribes: null, spam: null, replies: null};
  try {
    const e = await hs(`/marketing/v3/emails/${asset.id}?includeStats=true`, {allow404: true});
    if (!e) return base;
    const c = (e.stats && e.stats.counters) || {};
    const bounces = pick(c, ['bounce']) ?? ((pick(c, ['hardbounced']) ?? 0) + (pick(c, ['softbounced']) ?? 0));
    return {
      id: asset.id,
      name: e.name || asset.name,
      sendIds: (e.allEmailCampaignIds || (e.emailCampaignId ? [e.emailCampaignId] : [])).map(String),
      subject: e.subject || null,
      sentOn: toDay(e.publishDate || e.publishedAt),
      sent: pick(c, ['sent']) ?? base.sent,
      delivered: pick(c, ['delivered']),
      opens: pick(c, ['open']) ?? base.opens,
      clicks: pick(c, ['click']) ?? base.clicks,
      bounces,
      unsubscribes: pick(c, ['unsubscribed']),
      spam: pick(c, ['spamreport']),
      replies: pick(c, ['reply'])
    };
  } catch (err) {
    log(`email ${asset.id} details unavailable: ${err.message.slice(0, 120)}`);
    return base;
  }
}

async function pageUrl(type, id) {
  const path = type === 'LANDING_PAGE' ? 'landing-pages' : 'site-pages';
  try {
    const p = await hs(`/cms/v3/pages/${path}/${id}`, {allow404: true});
    return (p && (p.url || p.absoluteUrl)) || null;
  } catch (e) {
    log(`page ${id} url unavailable: ${e.message.slice(0, 80)}`);
    return null;
  }
}

async function searchAll(objectType, filterGroups, properties) {
  const out = [];
  let after;
  do {
    const page = await hs(`/crm/v3/objects/${objectType}/search`, {method: 'POST', body: {filterGroups, properties, limit: 200, after}});
    out.push(...(page.results || []));
    after = page.paging && page.paging.next && page.paging.next.after;
  } while (after && out.length < 10000);
  return out;
}

async function batchRead(objectType, ids, properties) {
  const out = [];
  for (const part of chunk([...new Set(ids)], 100)) {
    const r = await hs(`/crm/v3/objects/${objectType}/batch/read`, {method: 'POST', body: {inputs: part.map((id) => ({id})), properties}});
    out.push(...((r && r.results) || []));
  }
  return out;
}

// ---- Timestamped touches ----

// Members of a list with the time each joined (lists v3 join-order); falls back to members without times.
async function listMembers(listId) {
  const out = [];
  try {
    let after;
    do {
      const q = new URLSearchParams({limit: '250'});
      if (after) q.set('after', after);
      const page = await hs(`/crm/v3/lists/${listId}/memberships/join-order?${q}`, {allow404: true});
      if (!page) break;
      for (const r of page.results || []) out.push({id: String(r.recordId), at: r.membershipTimestamp ? toDay(r.membershipTimestamp) : null});
      after = page.paging && page.paging.next && page.paging.next.after;
    } while (after);
    if (out.length) return out;
  } catch (e) {
    log(`list ${listId} join times unavailable: ${e.message.slice(0, 100)}`);
  }
  try {
    let after;
    do {
      const q = new URLSearchParams({limit: '250'});
      if (after) q.set('after', after);
      const page = await hs(`/crm/v3/lists/${listId}/memberships?${q}`, {allow404: true});
      if (!page) break;
      for (const r of page.results || []) out.push({id: String(r.recordId != null ? r.recordId : r), at: null});
      after = page.paging && page.paging.next && page.paging.next.after;
    } while (after);
  } catch (e) {
    log(`list ${listId} members unavailable: ${e.message.slice(0, 100)}`);
  }
  return out;
}

// Opens and clicks on one send of a marketing email, as {email, type, at}.
async function emailEvents(sendId) {
  const out = [];
  for (const type of ['OPEN', 'CLICK']) {
    try {
      let offset;
      let guard = 0;
      do {
        const q = new URLSearchParams({campaignId: sendId, eventType: type, limit: '1000'});
        if (offset) q.set('offset', offset);
        const page = await hs(`/email/public/v1/events?${q}`, {allow404: true});
        if (!page) break;
        for (const e of page.events || []) if (e.recipient) out.push({email: String(e.recipient).toLowerCase(), type, at: toDay(e.created)});
        offset = page.hasMore ? page.offset : null;
      } while (offset && ++guard < 50);
    } catch (e) {
      log(`email events (${type}) unavailable for send ${sendId}: ${e.message.slice(0, 100)}`);
    }
  }
  return out;
}

// Submissions of one form, as {email, at}.
async function formSubmissions(formId) {
  const out = [];
  try {
    let after;
    let guard = 0;
    do {
      const q = new URLSearchParams({limit: '50'});
      if (after) q.set('after', after);
      const page = await hs(`/form-integrations/v1/submissions/forms/${formId}?${q}`, {allow404: true});
      if (!page) break;
      for (const s of page.results || []) {
        const email = ((s.values || []).find((v) => v.name === 'email') || {}).value;
        if (email) out.push({email: String(email).toLowerCase(), at: toDay(s.submittedAt)});
      }
      after = page.paging && page.paging.next && page.paging.next.after;
    } while (after && ++guard < 200);
  } catch (e) {
    log(`form ${formId} submissions unavailable: ${e.message.slice(0, 100)}`);
  }
  return out;
}

async function associations(from, to, ids) {
  const map = {};
  for (const part of chunk([...new Set(ids)], 1000)) {
    const r = await hs(`/crm/v4/associations/${from}/${to}/batch/read`, {method: 'POST', body: {inputs: part.map((id) => ({id}))}});
    for (const row of (r && r.results) || []) {
      const fromId = String(row.from && row.from.id);
      for (const t of row.to || []) {
        const toId = String(t.toObjectId);
        (map[toId] = map[toId] || new Set()).add(fromId);
      }
    }
  }
  return map; // to-object id -> Set of from-object ids
}

async function main() {
  if (!TOKEN) throw new Error('HUBSPOT_TOKEN is not set');
  const today = toDay(new Date().toISOString());
  const info = await portalInfo();
  const portalId = info.portalId || process.env.HUBSPOT_PORTAL_ID || null;
  if (!portalId) log('no portal id: HubSpot links will be missing. Set HUBSPOT_PORTAL_ID.');

  log('event campaigns');
  const events = await eventCampaigns();
  log(`${events.length} event(s): ${events.map((e) => e.name).join(', ') || 'none'}`);

  // Touches are kept as raw facts with emails; emails are swapped for contact ids once contacts are loaded.
  const touches = []; // {c, id?, email?, k, at, d}
  const universe = new Set();
  for (const ev of events) {
    const start = ev.startDate || ev.eventDate;
    let end = ev.endDate && ev.endDate < today ? ev.endDate : today;
    if (end < start) end = start;
    const infStart = plusDays(today, -LOOKBACK);
    const [site, landing, emails, lists, forms, mevents, metrics, influenced] = await Promise.all([
      campaignAssets(ev.id, 'SITE_PAGE', start, end),
      campaignAssets(ev.id, 'LANDING_PAGE', start, end),
      campaignAssets(ev.id, 'MARKETING_EMAIL', start, end),
      campaignAssets(ev.id, 'OBJECT_LIST', start, end),
      campaignAssets(ev.id, 'FORM', start, end),
      campaignAssets(ev.id, 'MARKETING_EVENT', start, end),
      campaignMetrics(ev.id, start, end),
      influencedContactIds(ev.id, infStart, today)
    ]);
    ev.metricsWindow = {start, end};
    ev.pages = [];
    for (const a of site) ev.pages.push({id: a.id, name: a.name, type: 'Website page', url: await pageUrl('SITE_PAGE', a.id), views: num(a.metrics.VIEWS), submissions: num(a.metrics.SUBMISSIONS)});
    for (const a of landing) ev.pages.push({id: a.id, name: a.name, type: 'Landing page', url: await pageUrl('LANDING_PAGE', a.id), views: num(a.metrics.VIEWS), submissions: num(a.metrics.SUBMISSIONS)});
    ev.emails = [];
    for (const a of emails) ev.emails.push(await emailDetail(a));
    ev.sessions = metrics.sessions;
    ev.influencedContacts = metrics.influencedContacts;
    ev.influencedIds = influenced;
    ev.influencedWindow = {start: infStart, end: today};
    (influenced || []).forEach((id) => universe.add(id));
    ev.registrations = mevents.reduce((s, m) => s + (num(m.metrics.REGISTRATIONS ?? m.metrics.hs_registrations) || 0), 0);
    ev.attendees = mevents.reduce((s, m) => s + (num(m.metrics.ATTENDEES ?? m.metrics.hs_attendees) || 0), 0);

    // Lists: each member is a targeted touch, except the Blinq list, whose join time dates the scan.
    ev.lists = [];
    for (const l of lists) {
      const blinq = /^blinq/i.test(l.name || '');
      const members = await listMembers(l.id);
      ev.lists.push({id: l.id, name: l.name, size: members.length, blinq});
      for (const m of members) {
        touches.push({c: ev.id, id: m.id, k: blinq ? 'scan-list' : 'list', at: m.at, d: l.name});
        universe.add(m.id);
      }
    }
    // Email opens and clicks.
    for (const em of ev.emails) {
      for (const sendId of em.sendIds || []) {
        for (const e of await emailEvents(sendId)) touches.push({c: ev.id, email: e.email, k: e.type === 'CLICK' ? 'click' : 'open', at: e.at, d: em.name});
      }
    }
    // Form submissions.
    ev.forms = forms.map((f) => ({id: f.id, name: f.name}));
    for (const f of forms) for (const s of await formSubmissions(f.id)) touches.push({c: ev.id, email: s.email, k: 'form', at: s.at, d: f.name});
    log(`${ev.name}: ${ev.pages.length} page(s), ${ev.emails.length} email(s), ${ev.lists.length} list(s), ${ev.forms.length} form(s), ${influenced ? influenced.length : 'n/a'} influenced`);
  }

  log('captured contacts');
  const eventNames = new Set(events.map((e) => e.name));
  const rawCaptured = await searchAll('contacts', [{filters: [{propertyName: 'blinq_campaigns', operator: 'HAS_PROPERTY'}]}], CONTACT_PROPS);
  const captured = rawCaptured.filter((c) => list(c.properties.blinq_campaigns).some((n) => eventNames.has(n)));
  log(`${captured.length} captured contact(s) on event campaigns`);
  const capturedIds = new Set(captured.map((c) => String(c.id)));
  const otherIds = [...universe].filter((id) => !capturedIds.has(id));
  const rawOther = otherIds.length ? await batchRead('contacts', otherIds, CONTACT_PROPS) : [];

  // Email and form touches name a recipient by email; find the contacts behind any we don't hold yet.
  const allRawSoFar = [...captured, ...rawOther];
  const byEmail = {};
  for (const c of allRawSoFar) if (c.properties.email) byEmail[String(c.properties.email).toLowerCase()] = String(c.id);
  const missingEmails = [...new Set(touches.filter((t) => t.email && !byEmail[t.email]).map((t) => t.email))];
  const rawByEmail = [];
  for (const part of chunk(missingEmails, 100)) {
    const r = await hs('/crm/v3/objects/contacts/batch/read', {method: 'POST', body: {idProperty: 'email', inputs: part.map((id) => ({id})), properties: CONTACT_PROPS}});
    for (const c of (r && r.results) || []) { rawByEmail.push(c); if (c.properties.email) byEmail[String(c.properties.email).toLowerCase()] = String(c.id); }
  }

  const [stageOptions, companyTypeOptions, contactTypeOptions] = await Promise.all([
    propertyOptions('contacts', 'lifecyclestage'), propertyOptions('companies', 'type'), propertyOptions('contacts', 'type')]);
  const stageLabels = Object.fromEntries(stageOptions.map((o) => [o.value, o.label.trim()]));
  const companyTypeLabels = Object.fromEntries(companyTypeOptions.map((o) => [o.value, o.label.trim()]));
  const contactTypeLabels = Object.fromEntries(contactTypeOptions.map((o) => [o.value, o.label.trim()]));

  const allRaw = [...allRawSoFar, ...rawByEmail];
  const companyIds = allRaw.map((c) => c.properties.associatedcompanyid).filter(Boolean);
  const companies = companyIds.length ? await batchRead('companies', companyIds, ['name', 'type']) : [];
  const companyById = {};
  for (const co of companies) companyById[String(co.id)] = {name: co.properties.name || null, type: co.properties.type ? (companyTypeLabels[co.properties.type] || co.properties.type) : null};

  const contacts = {};
  for (const c of allRaw) {
    const p = c.properties;
    const co = p.associatedcompanyid ? companyById[String(p.associatedcompanyid)] : null;
    const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim();
    contacts[String(c.id)] = {
      name: name || p.email || null,
      company: (co && co.name) || p.company || null,
      companyId: p.associatedcompanyid ? String(p.associatedcompanyid) : null,
      companyType: co ? co.type : null,
      type: p.type ? (contactTypeLabels[p.type] || p.type) : null,
      stage: p.lifecyclestage ? (stageLabels[p.lifecyclestage] || p.lifecyclestage).trim() : null,
      tags: list(p.blinq_workspace_tags).map((t) => KNOWN_TAGS.find((k) => k.toLowerCase() === t.toLowerCase()) || t),
      campaigns: list(p.blinq_campaigns).filter((n) => eventNames.has(n))
    };
  }

  // Influenced ids that no longer exist (deleted or merged) drop out, as they do in HubSpot's own report.
  for (const ev of events) if (Array.isArray(ev.influencedIds)) ev.influencedIds = ev.influencedIds.filter((id) => contacts[id]);

  // Resolve touches to contact ids and add a scan touch for every Blinq capture, dated by the Blinq list join.
  const resolved = [];
  for (const t of touches) {
    const id = t.id || (t.email && byEmail[t.email]);
    if (!id || !contacts[id]) continue;
    if (t.k === 'scan-list') continue;
    resolved.push({c: t.c, id, k: t.k, at: t.at, d: t.d});
  }
  for (const ev of events) {
    const joined = {};
    for (const t of touches) if (t.c === ev.id && t.k === 'scan-list' && t.id) joined[t.id] = t.at;
    for (const [id, c] of Object.entries(contacts)) {
      if (c.campaigns.indexOf(ev.name) < 0) continue;
      resolved.push({c: ev.id, id, k: 'scan', at: joined[id] || ev.eventDate, d: 'Blinq scan'});
    }
  }

  // Deals and meetings for every contact the events touched.
  const contactIds = Object.keys(contacts);
  let deals = [];
  let meetings = [];
  if (contactIds.length) {
    log(`deals and meetings for ${contactIds.length} contact(s)`);
    const [dealContacts, meetingContacts] = await Promise.all([associations('contacts', 'deals', contactIds), associations('contacts', 'meetings', contactIds)]);

    const stageLabel = {};
    const pipes = await hs('/crm/v3/pipelines/deals');
    for (const p of (pipes && pipes.results) || []) for (const s of p.stages || []) stageLabel[s.id] = s.label;

    const dealRecords = Object.keys(dealContacts).length
      ? await batchRead('deals', Object.keys(dealContacts), ['dealname', 'dealstage', 'amount_in_home_currency', 'hs_is_closed_won', 'hs_is_closed', 'createdate', 'closedate'])
      : [];
    deals = dealRecords.map((d) => {
      const closed = yes(d.properties.hs_is_closed);
      return {
        id: String(d.id),
        name: d.properties.dealname || '(no name)',
        stage: stageLabel[d.properties.dealstage] || d.properties.dealstage || null,
        amount: num(d.properties.amount_in_home_currency),
        isClosedWon: yes(d.properties.hs_is_closed_won),
        isClosed: closed,
        createdate: toDay(d.properties.createdate),
        closedate: closed ? toDay(d.properties.closedate) : null,
        contactIds: [...dealContacts[String(d.id)]]
      };
    });

    const meetingRecords = Object.keys(meetingContacts).length
      ? await batchRead('meetings', Object.keys(meetingContacts), ['hs_meeting_title', 'hs_createdate', 'hs_meeting_start_time', 'hs_meeting_outcome', 'hs_meeting_source', 'hs_activity_type'])
      : [];
    meetings = meetingRecords.map((m) => {
      const p = m.properties;
      return {
        id: String(m.id),
        title: p.hs_meeting_title || 'Meeting',
        createdate: toDay(p.hs_createdate || m.createdAt),
        start: toDay(p.hs_meeting_start_time),
        outcome: p.hs_meeting_outcome || null,
        source: p.hs_meeting_source || null,
        activityType: p.hs_activity_type || null,
        internal: !!p.hs_activity_type && INTERNAL_MEETING_TYPES.includes(String(p.hs_activity_type).toLowerCase()),
        contactIds: [...meetingContacts[String(m.id)]]
      };
    });
  }
  log(`${deals.length} deal(s), ${meetings.length} meeting(s), ${resolved.length} touch(es), ${contactIds.length} contact record(s)`);

  const data = {
    generatedAt: new Date().toISOString(),
    today,
    timeZone: TIME_ZONE,
    currency: process.env.CURRENCY || info.currency || 'USD',
    portalId,
    reports: {blinqTags: process.env.REPORT_BLINQ_TAGS || null, contactsByStage: process.env.REPORT_CONTACTS_BY_STAGE || null},
    stageOrder: stageOptions.map((o) => o.label.trim()),
    events, contacts, touches: resolved, deals, meetings
  };
  // Send ids are only needed here; keep the page lean.
  for (const ev of data.events) for (const em of ev.emails) delete em.sendIds;
  await mkdir(dirname(OUT), {recursive: true});
  await writeFile(OUT, JSON.stringify(data, null, 2));
  log(`wrote ${OUT}`);
}

main().catch((e) => { console.error('[fetch] failed:', e.message); process.exit(1); });
