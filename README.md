# JAGG estimate landing page

A pixel copy of the JAGG Fillout form at `https://estimate.fillout.com/jagg-rsw`,
served as a Cloudflare Worker, with submissions written straight into AccuLynx
instead of Fillout.

```
public/index.html    the page (same fields, copy, order and styling as the Fillout form)
public/form.js       validation, phone formatting, address autocomplete, submit
public/countries.js  country + US state lists for the phone and state selectors
worker/index.js      /api/geo (address autocomplete proxy) and /api/lead (AccuLynx)
```

## What was copied

Field for field, from the published Fillout form definition:

| Field | Type | Required |
|---|---|---|
| What's your name? | short answer, placeholder "Enter your name here" | yes |
| Best phone number to contact you? | phone w/ country selector, placeholder "000 000-0000" | yes |
| Your email please? | email, placeholder "Your email here" | no |
| What's your home address? | address (street / city / state / ZIP, country fixed to US, autocomplete on) | yes |
| What services are you interested in? | single choice, two columns: Roofing, Siding, Windows, Other | no |

Plus the logo, the orange `Get a quick free estimate` heading, the divider, the
gradient-bordered card with the cyan glow, the gradient Submit button, and the
"Thank you {first name}! / We will reach out to you ASAP!" ending with the
orange **Check Our Website Here** button linking to
`https://jaggroofingsidingandwindows.com/`.

## How the AccuLynx handoff works

AccuLynx has **no** "create lead" endpoint. In AccuLynx a lead *is* a job sitting
in the Lead milestone, and `POST /jobs` requires an **existing** contact. So one
submission is two calls:

1. `POST https://api.acculynx.com/api/v2/contacts` — name, phone, email →
   returns a contact id.
2. `POST https://api.acculynx.com/api/v2/jobs` — `contact: { id }`,
   `locationAddress`, `leadSource`, `tradeTypes`, `notes`. The job lands in the
   Lead milestone, Unassigned.

Account-specific ids (contact type, lead source, trade types) are **looked up at
runtime and cached**, so nobody has to paste UUIDs:

- `GET /contacts/contact-types`
- `GET /company-settings/leads/lead-sources`
- `GET /company-settings/job-file-settings/trade-types`

The chosen service is matched to a company trade type by name (Roofing / Siding /
Windows). "Other" has no trade type, so the free-text answer rides along in the
job note instead.

If AccuLynx returns an error, the page shows a retry message and — when
`RESEND_API_KEY` + `NOTIFY_EMAIL` are set — the full submission is emailed so the
lead is never lost.

## Setup

1. In AccuLynx: **Account Settings → Add-On Features and Integrations → API Keys
   → Create Key**. The key is account-wide; only a company admin can make one.
2. Set it as a Worker secret:

```bash
cd ~/GIT/jagg-estimate && npm run secret -- put ACCULYNX_API_KEY
```

3. Optional vars in `wrangler.jsonc`:
   - `LEAD_SOURCE_NAME` (default `Website`) — must match a lead source that is
     active in JAGG's AccuLynx settings, otherwise the first active one is used.
   - `CONTACT_TYPE_NAME` (default `Customer`).
4. Optional lead-loss fallback: `npm run secret -- put RESEND_API_KEY` and add
   `NOTIFY_EMAIL` to `vars`.

## Deployment

| | |
|---|---|
| Repo | `heyaaronmarketing/jaggroofing` (public) |
| Cloudflare Worker | `jaggroofing` on `Aaron@kickass.net's Account` (`681da9da…`) |
| Live URL | https://quote.jagg-roofing.com |
| Zone | `jagg-roofing.com` (`bbca6a78…`) |

**Automatic publishing:** the Worker is connected to the GitHub repo through
Cloudflare Workers Builds. Any push to `main` triggers a build that runs
`npx wrangler deploy` against this `wrangler.jsonc`, so no GitHub Action is
needed and none is checked in. The custom domain is declared in `routes` with
`custom_domain: true`, which means it survives every deploy instead of having to
be re-attached in the dashboard.

If a push does not deploy, check **Workers → jaggroofing → Settings → Build** in
the dashboard:

- Build command: *(leave empty)*
- Deploy command: `npx wrangler deploy`
- Root directory: `/`

**Manual deploy** (same result, from this Mac):

```bash
npm run deploy
```

Local dev:

```bash
npm run dev
```

Both wrap `npx wrangler` with `NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem`, which is
what makes wrangler work on this Mac.

Secrets are **not** managed by Workers Builds — set `ACCULYNX_API_KEY` once with
`npm run secret -- put ACCULYNX_API_KEY` and it persists across deploys.

## Verification notes

- `/api/geo` returns deduped US addresses from Photon (keyless, OSM-backed —
  Nominatim's policy forbids autocomplete use), biased toward Long Island.
- `/api/lead` was exercised against the live AccuLynx API with a placeholder key
  and returned AccuLynx's own `401 API Key is invalid or deactivated`, which
  confirms the URL, auth header and request shape. A real key is the only thing
  between this and a live lead.
