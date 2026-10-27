import { readFile, writeFile, mkdir } from "node:fs/promises";

// War tracker for the war/ page. Unlike poll.js it watches the territory map itself: the
// territory list carries each territory's owner and `acquired` timestamp, so every owner
// change between polls is caught with its exact time. One run polls in a loop for
// --duration seconds (the workflow keeps runs back to back), then writes:
//
//   war/series.json   [tSec, leftTerr, rightTerr, leftWars, rightWars, leftOnline, rightOnline]
//                     seeded once from the 5-min snapshots.json since the war start
//   war/changes.json  every owner change touching either guild (snipes, HQ hits, third parties)
//   war/members.json  per-member all-time war counter, with a history of its changes
//   war/state.json    last seen owner of every territory (to diff the next run against)
//
//   node war-poll.js [--duration 250] [--interval 20]

const DIR = "war";
const CONFIG = `${DIR}/config.json`;
const SERIES = `${DIR}/series.json`;
const CHANGES = `${DIR}/changes.json`;
const MEMBERS = `${DIR}/members.json`;
const STATE = `${DIR}/state.json`;
const SNAPSHOTS = "snapshots.json";
const TIMEOUT_MS = 25_000;
const UA = "race-tracker/2.0 (war)";
const GUILD_EVERY = 3;          // fetch member data every Nth loop iteration
const SERIES_HEARTBEAT = 300;
// More wars than this between two member polls (~1 min) is not a real gain but a hidden
// counter becoming visible, so it rebaselines instead of counting.
const MAX_WAR_JUMP = 50;   // write a series point at least this often (s), even if flat

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const DURATION = arg("duration", 0);
const INTERVAL = arg("interval", 20);

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function loadJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return fallback; }
}

const sec = iso => Math.floor(new Date(iso).getTime() / 1000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Seeds the series from the race snapshots, which already hold both guilds' territory and
// war counts every 5 minutes. Only done once; afterwards the war poller is the source.
async function seedSeries(cfg) {
  const snaps = (await loadJson(SNAPSHOTS, { snapshots: [] })).snapshots || [];
  const start = sec(cfg.start);
  const points = [];
  for (const s of snaps) {
    const t = sec(s.ts);
    if (t < start - 3600) continue;
    if (s.left?.prefix !== cfg.left.prefix || s.right?.prefix !== cfg.right.prefix) continue;
    points.push([t, s.left.territories, s.right.territories, s.left.wars, s.right.wars, s.left.online, s.right.online]);
  }
  return { seededUntil: points.length ? points[points.length - 1][0] : null, points };
}

function memberRows(guild) {
  const out = [];
  for (const group of Object.values(guild.members || {})) {
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    for (const [username, m] of Object.entries(group)) {
      if (!m?.uuid) continue;
      // a player with API privacy on has no war counter: null, not 0
      const w = m.globalData?.wars;
      out.push({ uuid: m.uuid, name: username, wars: Number.isFinite(Number(w)) && w !== null ? Number(w) : null, online: !!m.online });
    }
  }
  return out;
}

// Before v2, a hidden war counter (API privacy) was stored as 0, so switching privacy off
// counted the player's whole career as wars "since tracking". Rebuild each baseline from
// visible values only, skipping jumps that can't be real gains.
function migrateHidden(members) {
  for (const m of Object.values(members.members)) {
    const vis = [[m.t0, m.w0], ...m.h].filter(([, w]) => w > 0);
    if (vis.length === m.h.length + 1) continue;
    if (!vis.length) { m.w0 = null; m.w = null; m.h = []; m.hidden = true; continue; }
    let prev = vis[0][1], counted = 0;
    const kept = [];
    for (const [t, w] of vis.slice(1)) {
      if (w >= prev && w - prev <= MAX_WAR_JUMP) { counted += w - prev; if (w !== prev) kept.push([t, w]); }
      prev = w;
    }
    m.w0 = prev - counted; m.w = prev; m.h = kept;
  }
}

async function main() {
  const cfg = JSON.parse(await readFile(CONFIG, "utf8"));
  await mkdir(DIR, { recursive: true });
  const sides = [cfg.left.prefix, cfg.right.prefix];

  const state = await loadJson(STATE, { terr: {} });
  const series = (await loadJson(SERIES, null)) || await seedSeries(cfg);
  const changes = await loadJson(CHANGES, { since: null, changes: [] });
  const members = await loadJson(MEMBERS, { since: null, members: {} });
  if (members.v !== 2) { migrateHidden(members); members.v = 2; }

  const last = series.points[series.points.length - 1] || [];
  let wars = { [sides[0]]: last[3] ?? null, [sides[1]]: last[4] ?? null };
  let online = { [sides[0]]: last[5] ?? null, [sides[1]]: last[6] ?? null };

  const endAt = Date.now() + DURATION * 1000;
  let iter = 0, newChanges = 0, errors = 0;
  do {
    const iterStart = Date.now();
    try {
      // members (and the guild war counter) every few iterations — they move slower
      if (iter % GUILD_EVERY === 0) {
        const nowSec = Math.floor(Date.now() / 1000);
        members.since ??= nowSec;
        for (const c of [cfg.left, cfg.right]) {
          const g = await fetchJson(`https://api.wynncraft.com/v3/guild/prefix/${encodeURIComponent(c.prefix)}`);
          wars[c.prefix] = Number(g.wars ?? 0);
          let on = 0;
          const seen = new Set();
          for (const r of memberRows(g)) {
            seen.add(r.uuid);
            if (r.online) on++;
            const m = members.members[r.uuid];
            if (!m) {
              members.members[r.uuid] = { n: r.name, g: c.prefix, w0: r.wars, t0: nowSec, w: r.wars, h: [] };
            } else {
              m.n = r.name;
              if (m.g !== c.prefix) { m.g = c.prefix; m.w0 = r.wars; m.t0 = nowSec; m.h = []; }
              if (r.wars == null) {
                m.hidden = true;                  // keep the last known count while hidden
              } else if (m.w0 == null || m.w == null || r.wars - m.w > MAX_WAR_JUMP) {
                // first visible value (API privacy switched off) or an impossible jump: start
                // counting from here; wars fought while hidden can't be attributed
                m.w0 = r.wars - (m.w != null && m.w0 != null ? m.w - m.w0 : 0);
                m.w = r.wars;
                delete m.hidden;
              } else {
                if (r.wars !== m.w) { m.h.push([nowSec, r.wars]); m.w = r.wars; }
                delete m.hidden;
              }
              delete m.left;
            }
          }
          online[c.prefix] = on;
          for (const [uuid, m] of Object.entries(members.members)) {
            if (m.g === c.prefix && !seen.has(uuid)) m.left = true;
          }
        }
        members.updated = new Date().toISOString();
      }

      // territory map: diff owners against the last poll
      const terr = await fetchJson("https://api.wynncraft.com/v3/guild/list/territory");
      const pollSec = Math.floor(Date.now() / 1000);
      const first = !changes.since;
      const prevPollSec = state.lastPoll ? sec(state.lastPoll) : null;
      // focus territories (config.focus) get their owner at first sight recorded, so uptime
      // can be measured from the moment it was acquired rather than from the first change
      changes.firstSeen ??= {};
      for (const name of cfg.focus || []) {
        const t = terr[name];
        if (t && !changes.firstSeen[name]) changes.firstSeen[name] = { g: t.guild?.prefix ?? null, a: t.acquired ?? null, t: pollSec };
      }
      const counts = { [sides[0]]: 0, [sides[1]]: 0 };
      for (const [name, t] of Object.entries(terr)) {
        const g = t.guild?.prefix ?? null;
        if (g in counts) counts[g]++;
        const prev = state.terr[name];
        state.terr[name] = { g, a: t.acquired ?? null, h: !!t.hq };
        if (first || !prev || prev.a === (t.acquired ?? null)) continue;
        if (!sides.includes(prev.g) && !sides.includes(g)) continue;
        // A changed `acquired` with the same owner means it was lost and retaken in between.
        changes.changes.push({
          t: t.acquired ? sec(t.acquired) : pollSec,
          p: pollSec,
          ...(prevPollSec ? { pp: prevPollSec } : {}),
          terr: name,
          from: prev.g,
          to: g,
          hq: !!prev.h || !!t.hq,
          ...(prev.g === g ? { retake: true } : {}),
        });
        newChanges++;
      }
      changes.since ??= pollSec;
      state.lastPoll = new Date(pollSec * 1000).toISOString();

      const pt = [pollSec, counts[sides[0]], counts[sides[1]], wars[sides[0]], wars[sides[1]], online[sides[0]], online[sides[1]]];
      const prevPt = series.points[series.points.length - 1];
      const same = prevPt && pt.slice(1).every((v, i) => v === prevPt[i + 1]);
      if (!same || pollSec - prevPt[0] >= SERIES_HEARTBEAT) series.points.push(pt);
    } catch (e) {
      errors++;
      console.error(`iteration ${iter}: ${e.message}`);
    }
    iter++;
    const wait = INTERVAL * 1000 - (Date.now() - iterStart);
    if (Date.now() + wait >= endAt) break;
    await sleep(Math.max(0, wait));
  } while (Date.now() < endAt);

  changes.changes.sort((a, b) => a.t - b.t);
  changes.updated = series.updated = state.updated = new Date().toISOString();
  await writeFile(SERIES, JSON.stringify(series) + "\n");
  await writeFile(CHANGES, JSON.stringify(changes) + "\n");
  await writeFile(MEMBERS, JSON.stringify(members) + "\n");
  await writeFile(STATE, JSON.stringify(state) + "\n");
  console.log(`OK war iterations=${iter} errors=${errors} newChanges=${newChanges} total=${changes.changes.length} points=${series.points.length}`);
  if (errors === iter) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
