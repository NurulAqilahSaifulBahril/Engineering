# Plan: connect the C&I Portal to NUrul_DB

Status: proposal, nothing built yet. Written 2026-11-19.

## Where things stand

- The portal (`index.html`, Electron shell `main.js`) has never talked to a database.
  Everything — deals, clients, sign-in accounts — lives in local storage on one machine.
- A deal's **Salesperson** is a free-text box (`#dealAgent`, saved as `lead.agent`),
  so names like Safwan or Adam are only there if someone typed them on that machine.
- NUrul_DB is the Railway Postgres the Installation System uses, reached through
  `pg-proxy-production.up.railway.app/api/sql` with a bearer token
  (`backup admin/1. Installation/lib/proxy-db.ts`). The Installation System only calls it
  from server code, so the token never reaches a browser.
- Relevant tables (`data_schema.md`):
  - `public.agent` — 200 sales agents (`name`, `agent_type`, `agent_code`, `contact`, `email`,
    **plus IC images, bank account, address**).
  - `public.user` — 217 staff/agent accounts (`name`, `main_department`, `access_level`, …).
  - `public.app_users` — the Installation System's own 5 logins.

## The one hard constraint

The portal runs on each person's PC. Any token put in `index.html` **or** in the Electron
app can be pulled out of the installer. The current proxy token is the `postgres` user, i.e.
it can read IC/bank data and change any table. **It must not ship in the portal.**

## Proposed design

```
Portal (Electron / browser)  ──HTTPS + portal key──▶  portal-api (new, on Railway)
                                                          │  holds PG_PROXY_TOKEN
                                                          ▼
                                                     pg-proxy ──▶ NUrul_DB
```

`portal-api` is a tiny Node service (same style as `server.js`) with a fixed list of
read-only endpoints. It only returns the columns the portal needs, so a leaked portal key
exposes agent names, not ICs or bank accounts.

### Phase 1 — agent list for Salesperson (small, safe)

1. `portal-api`: `GET /agents` →
   `select agent_code, name, agent_type from public.agent where name is not null order by name`.
   Checks an `X-Portal-Key` header; sets CORS for `app://portal` and `http://localhost:5173`.
2. Portal: on start (and a **Refresh agents** button in IT Admin), fetch `/agents`, store as
   `state.agentDirectory` with a `syncedAt` timestamp. Works offline from the cached copy.
3. Deal form: turn `#dealAgent` into an input with a `<datalist>` of agent names — still
   accepts free text, so existing deals and non-listed names keep working.
4. KPI / pipeline filters can then group by agent reliably.
5. Not added to `AUDIT_COLLECTIONS` (it's a read-only mirror, not user edits).

### Phase 2 — optional, decide later

- **Sign in with NUrul_DB accounts** (`public.user` or `app_users`): needs `portal-api` to
  verify passwords server-side and issue a session. Bigger change; replaces local accounts.
- **Shared portal data** (deals/clients in NUrul_DB so every PC sees the same pipeline):
  new `portal_*` tables, write endpoints, conflict handling, migration of each PC's local
  data. This is the real fix for "data is per machine", but it's a project on its own.

## Before building

- Confirm Safwan and Adam are actually in `public.agent` (not just `public.user` or the
  commission `dashboard` schema) — I couldn't query the live DB from this session.
- Decide where `portal-api` runs (new Railway service vs. a route in an existing one).
- Ideally get a **read-only** pg-proxy token for `portal-api` instead of the `postgres` one.

## Effort (rough)

- Phase 1: portal-api ~1 small file + deploy; portal changes ~60–100 lines in `index.html`;
  release 1.3.0 via `npm run release`.
