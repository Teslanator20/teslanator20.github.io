# the race

Side-by-side tracker for Sequoia vs Avicia. Polls every 5 min, retains the whole current
season (plus a 14-day floor across season changes), renders charts on a static page hosted
via GitHub Pages.

- `guilds.json` — the two guilds to compare
- `poll.js` — fetches both guilds + 5 raid SR leaderboards, appends to `snapshots.json`
- `snapshots.json` — season history (committed by the action). Older entries are thinned by
  age — full 5-min resolution for 3 days, 30 min up to 14 days, 2 h beyond — so a full season
  stays a few MB instead of tens.
- `index.html` — comparison dashboard
- `aeqavo/` — a second pairing (Aequitas vs Avicia) as its own page, same files one level
  down. `poll.js <dir>` reads that directory's `guilds.json` and writes its data there; the
  action runs the poller once per pairing.
- `hspnol/` — Hesperides vs Sequoia in the NOL raid (Orphion's Nexus of Light). Same poller
  and data files; the page races on the guilds' Orphion SR (`perRaid.orphion`), which is
  all-time and untouched by the season scalar, so hero, gap charts and ETA use plain linear
  trends over the full history.
- `record/` — Sequoia against the all-time season record ([Shy] ShadowFall, Season 1,
  20,270,919). No poller of its own: the page reads the root `snapshots.json` and draws the
  record as a fixed line, with pace and a projected break date.

Workflow: `.github/workflows/poll.yml` runs every 5 min on cron + workflow_dispatch.
Reliable trigger via cron-job.org → `POST /actions/workflows/poll.yml/dispatches`.
