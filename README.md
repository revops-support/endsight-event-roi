# Endsight Event ROI

A standalone event ROI page for Endsight, rebuilt daily from Endsight's HubSpot. The page is one HTML file with the day's data written into it, so there is no API token or separate data URL in the browser.

```
scripts/fetch-data.mjs      Endsight HubSpot  ->  data/data.json
scripts/render.mjs          template + data   ->  dist/index.html            (any web server)
                                               ->  dist/hubspot-template.html (HubSpot coded template)
scripts/publish-hubspot.mjs dist/hubspot-template.html -> our HubSpot Design Manager
.github/workflows/refresh.yml  runs all three every morning at 5:47 AM Pacific, and on demand
hubspot-function/           HubSpot function behind the page's Refresh data button
```

Node 22 or later. No npm dependencies. The page loads Chart.js from jsDelivr and Lexend Deca from Google Fonts.

## What the page shows

For each HubSpot campaign with an **Event date**, over a 30, 60, 90 or 180-day credit window after that date:

- **Return:** won MRR and open pipeline from deals the event created, the same for deals it influenced, ROAS, and meetings held
- **Deals:** every credited deal, marked Created or Influenced, with its even share when another event also credits it
- **Meetings:** booked, held, upcoming and canceled or no-show, by contact Type and by how the meeting was booked
- **Influence:** every contact the event touched, ranked attended, engaged or targeted, by contact Type, with a breakdown of which touch put each contact there, plus HubSpot's Associated contacts by stage
- **Captures:** Blinq scans, Engagement by Blinq tags split by contact Type, and where captured contacts sit in the lifecycle
- **Email and web:** pre-event and post-event email performance, campaign pages, sessions and form submissions

Every number opens a panel listing the records behind it, and every record links to its page in HubSpot. The page carries contact names and companies, so keep it password-protected.

## Matching rules

The nightly job pulls each touch with its date; the page applies these rules for whichever window is selected.

| Question | Rule |
|---|---|
| When did the event happen? | The campaign's Event date. The window runs from it. |
| When did someone register? | HubSpot marketing event registrations on the campaign (0 for WIFS, which Endsight exhibits at). |
| Attended | Scanned into the event's Blinq campaign, dated by when the contact joined the Blinq list. |
| Engaged | Opened or clicked a campaign email, or submitted a campaign form, between the campaign start and the end of the window. Meetings are credited as outcomes only: they never raise a contact's tier or make an open deal influenced. |
| Targeted | Only on a campaign list, or counted by HubSpot through a touch the API doesn't expose (sequence, page view, ad). |
| Meeting credited | Any meeting created in the window with an influenced contact. Internal and personal meeting types are excluded. Held = start time passed and outcome not canceled or no-show. |
| Deal created | Created in the window with any influenced contact. |
| Deal influenced | Open on the Event date, with a contact who attended or engaged while the deal was open. Targeted-only contacts don't qualify. |
| Shared credit | Deals and meetings credited by more than one event are split evenly between them. Weighted credit replaces this later. |
| Customer / partner / prospect | Contact Type only. Client = Customer; Partner or Reseller = Partner; Prospect = Prospect; other values = Other; blank = Unknown. |

## What has to be true in Endsight's HubSpot

1. The campaign has the **Event date** property filled in. That is what adds an event to the picker.
2. The Blinq campaign name matches the HubSpot campaign name exactly, e.g. `WIFS 2026`. Captures join on the contact's Blinq Campaigns value.
3. Promo and follow-up emails are associated with the campaign. Unassociated emails do not count.
4. Spend items are entered on the campaign. ROAS stays blank without them.
5. Deal Amount is the monthly value. The page reports it as MRR.

## Setup: hosted on our HubSpot

### 1. Private app on Endsight's portal (read data)

Settings > Integrations > Private Apps > Create. Scopes:

- `crm.objects.contacts.read`
- `crm.objects.companies.read`
- `crm.objects.deals.read`
- `crm.schemas.contacts.read`
- `crm.schemas.companies.read`
- `crm.lists.read` (list members and when they joined)
- `marketing.campaigns.read`
- `forms` (form submissions)
- `content` (marketing email stats, open and click events, page URLs; HubSpot has no read-only version)

Meetings are read through the contacts association. If the first run fails with a 403 on meetings, add the meetings read scope that HubSpot names in the error. The `content` scope also covers reading page URLs.

### 2. Private app on our portal (publish)

Scope: `content` only.

### 3. Repository and secrets

Push this folder to a **private** GitHub repo. `data/` and `dist/` are git-ignored so client data never lands in the repo. Add two repository secrets:

- `ENDSIGHT_HUBSPOT_TOKEN`: token from step 1
- `REVOPS_HUBSPOT_CONTENT_TOKEN`: token from step 2

### 4. First run

Actions > Refresh Endsight Event ROI > Run workflow. This uploads `endsight/endsight-event-roi.html` into Design Manager on our portal.

### 5. Create the page, once

1. Website pages > Create, and pick the **Endsight Event ROI** template.
2. Settings: set a URL slug, turn off search indexing, and leave it out of the sitemap.
3. Audience access: **Password**. Share the password with Endsight separately from the link.
4. Publish.

From then on, every scheduled run re-uploads the template and the live page shows the new data immediately. Nothing else needs republishing. A campaign that gets an Event date appears in the picker after the next run. Refresh data on the page starts a run and reloads the page when the new data is live, usually within two minutes.

### 6. Refresh data button

The button calls a HubSpot function on our portal (`/hs/serverless/endsight-event-roi/refresh`), which holds a GitHub token and starts the workflow. The page never carries a credential. Public function endpoints need Content Hub Enterprise.

1. GitHub: create a fine-grained personal access token. Resource owner `revops-support`, repository access limited to `endsight-event-roi`, one permission: Actions, Read and write.
2. Install the HubSpot CLI (`npm install -g @hubspot/cli`, version 8.4 or later) and run `hs account auth` against our portal.
3. From `hubspot-function/`: `hs secret add ENDSIGHT_GITHUB_TOKEN` and paste the token at the prompt, then `hs project upload`, then `hs project install-app`.
4. Run the workflow once so the page picks up the button.

The endpoint is public, so it only reports a run's id, status and timestamps, never starts a second run while one is queued or running, and never starts one within a minute of the last. Rotate the token by repeating step 1 and running `hs secret update ENDSIGHT_GITHUB_TOKEN`.

## Moving to Endsight's server

Run the same scripts on a schedule and write the page into the web root. Skip the publish step. Leave `REFRESH_ENDPOINT` unset and the Refresh button stays hidden, unless their server gets an equivalent endpoint.

```
# crontab, 5:47 AM server time
47 5 * * *  cd /opt/endsight-event-roi && HUBSPOT_TOKEN=... OUTPUT_PATH=/var/www/event-roi/index.html npm run refresh >> /var/log/event-roi.log 2>&1
```

Put the page behind their SSO or basic auth. It carries deal names and revenue.

## Running it by hand

```
HUBSPOT_TOKEN=... npm run refresh
open dist/index.html
```

Optional variables: `INTERNAL_MEETING_TYPES` (semicolon-separated meeting types never credited; default `Administrative / Internal / Interview;Personal`), `TIME_ZONE` (default `America/Los_Angeles`, used for every date), `CURRENCY` (default `USD`), `HUBSPOT_TEMPLATE_PATH` (default `endsight/endsight-event-roi.html`), `HUBSPOT_PORTAL_ID` (used for HubSpot links if the account-info call is not allowed; Endsight's is 2823558), `REPORT_BLINQ_TAGS` and `REPORT_CONTACTS_BY_STAGE` (saved report ids the page links to; 446645630 and 446661489 in Endsight's portal), `INFLUENCED_LOOKBACK_DAYS` (default 365).

## If a run fails

The workflow log names the HubSpot call and status. A failed run publishes nothing, so the page keeps the previous day's data and its "Data as of" line shows how old it is.

Three campaign endpoints are lightly documented by HubSpot: the metrics report (sessions), the influenced-contacts report, and per-asset metrics on the assets list. If any comes back in a different shape, the script logs it and the page shows a dash or a note for that section instead of failing. Check the first run's log for lines starting `[fetch] ... unavailable`.
