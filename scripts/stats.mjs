// Builds assets/stats-{dark,light}.svg and assets/languages-{dark,light}.svg
// from the GitHub API, private repositories included.
// Needs a token that can read the owner's private repos: GH_TOKEN=... node scripts/stats.mjs
import { mkdirSync, writeFileSync } from 'node:fs';

const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) throw new Error('GH_TOKEN is not set');

// Repositories that are not the owner's own code (bought scripts, templates).
const SKIP_REPOS = new Set(['InfixEdu']);
const TOP_LANGS = 10;

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function collect() {
  const base = await gql(`{ viewer { login name createdAt followers { totalCount } } }`);
  const v = base.viewer;

  const repos = [];
  let cursor = null;
  do {
    const d = await gql(
      `query($c: String) { viewer { repositories(first: 100, after: $c, ownerAffiliations: OWNER, isFork: false) {
        pageInfo { hasNextPage endCursor }
        nodes { name isPrivate stargazerCount
          languages(first: 20, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name color } } } } } } }`,
      { c: cursor },
    );
    const page = d.viewer.repositories;
    repos.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  // The contributions API answers one year at a time.
  const years = [];
  const first = new Date(v.createdAt).getUTCFullYear();
  const now = new Date();
  for (let y = first; y <= now.getUTCFullYear(); y++) {
    const from = new Date(Date.UTC(y, 0, 1)).toISOString();
    const to = y === now.getUTCFullYear() ? now.toISOString() : new Date(Date.UTC(y, 11, 31, 23, 59, 59)).toISOString();
    const d = await gql(
      `query($from: DateTime!, $to: DateTime!) { viewer { contributionsCollection(from: $from, to: $to) {
        totalCommitContributions totalPullRequestContributions totalIssueContributions
        totalPullRequestReviewContributions totalRepositoryContributions restrictedContributionsCount
        contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } } } } }`,
      { from, to },
    );
    years.push({ year: y, ...d.viewer.contributionsCollection });
  }
  return { v, repos, years };
}

function summarise({ v, repos, years }) {
  const own = repos.filter((r) => !SKIP_REPOS.has(r.name));
  const sum = (k) => years.reduce((a, y) => a + y[k], 0);

  // Each repo counts once: a language's score is its share inside each repo,
  // summed over repos, so one huge repo cannot drown out the rest.
  const langs = new Map();
  for (const r of own) {
    const repoTotal = r.languages.edges.reduce((a, e) => a + e.size, 0);
    if (!repoTotal) continue;
    for (const e of r.languages.edges) {
      const label = e.node.name === 'Jupyter Notebook' ? 'Jupyter' : e.node.name;
      const l = langs.get(e.node.name) ?? { name: label, color: e.node.color ?? '#8b949e', size: 0, repos: 0 };
      l.size += e.size / repoTotal;
      l.repos += 1;
      langs.set(e.node.name, l);
    }
  }
  const total = [...langs.values()].reduce((a, l) => a + l.size, 0);
  const sorted = [...langs.values()].sort((a, b) => b.size - a.size);
  const top = sorted.slice(0, TOP_LANGS).map((l) => ({ ...l, pct: (l.size / total) * 100 }));
  const rest = sorted.slice(TOP_LANGS).reduce((a, l) => a + l.size, 0);
  if (rest > 0) top.push({ name: 'Other', color: '#6e7681', size: rest, repos: 0, pct: (rest / total) * 100 });

  const days = years
    .flatMap((y) => y.contributionCalendar.weeks.flatMap((w) => w.contributionDays))
    .sort((a, b) => a.date.localeCompare(b.date));
  let longest = 0, run = 0;
  for (const d of days) { run = d.contributionCount > 0 ? run + 1 : 0; longest = Math.max(longest, run); }
  const busiestDay = days.reduce((a, d) => (d.contributionCount > a.contributionCount ? d : a), days[0]);

  const busiest = [...years].sort((a, b) => b.contributionCalendar.totalContributions - a.contributionCalendar.totalContributions)[0];
  return {
    name: v.name ?? v.login,
    stats: {
      contributions: years.reduce((a, y) => a + y.contributionCalendar.totalContributions, 0),
      commits: sum('totalCommitContributions'),
      repos: own.length,
      privateRepos: own.filter((r) => r.isPrivate).length,
      private: sum('restrictedContributionsCount'),
      activeDays: days.filter((d) => d.contributionCount > 0).length,
      longest,
      busiestDay: busiestDay?.contributionCount ?? 0,
      prs: sum('totalPullRequestContributions'),
      reviews: sum('totalPullRequestReviewContributions'),
      issues: sum('totalIssueContributions'),
      stars: own.reduce((a, r) => a + r.stargazerCount, 0),
      followers: v.followers.totalCount,
      languages: langs.size,
      busiestYear: busiest?.year,
      busiestCount: busiest?.contributionCalendar.totalContributions ?? 0,
    },
    years: years.map((y) => ({ year: y.year, total: y.contributionCalendar.totalContributions })),
    langs: top,
  };
}

// ─────────────────────────────── drawing ───────────────────────────────

const THEMES = {
  dark: { bg: '#0b0b12', card: '#12121c', line: '#23233a', text: '#f2f2f7', muted: '#8b8ba3', accent: '#7c6cff', accent2: '#22d3ee' },
  light: { bg: '#ffffff', card: '#f7f7fb', line: '#e4e4ee', text: '#0b0b12', muted: '#62627a', accent: '#5b4bff', accent2: '#0891b2' },
};
const SANS = `'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif`;
const MONO = `ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => n.toLocaleString('en-US');

function frame(t, w, h, title, hint, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<style>
  .in { opacity: 0; animation: up .7s cubic-bezier(.2,.7,.2,1) forwards; }
  @keyframes up { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  .grow { transform-box: fill-box; transform-origin: left; transform: scaleX(0); animation: grow 1.1s cubic-bezier(.2,.7,.2,1) forwards; }
  @keyframes grow { to { transform: scaleX(1); } }
  @media (prefers-reduced-motion: reduce) { .in, .grow { animation: none; opacity: 1; transform: none; } }
</style>
<defs>
  <linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="${t.accent}"/><stop offset="1" stop-color="${t.accent2}"/></linearGradient>
  <clipPath id="r"><rect width="${w}" height="${h}" rx="18"/></clipPath>
</defs>
<g clip-path="url(#r)">
  <rect width="${w}" height="${h}" fill="${t.bg}"/>
  <rect width="${w}" height="3" fill="url(#g)"/>
</g>
<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="17.5" fill="none" stroke="${t.line}"/>
<text x="36" y="52" font-family="${MONO}" font-size="13" letter-spacing="2" fill="${t.accent}">${esc(title.toUpperCase())}</text>
<text x="${w - 36}" y="52" text-anchor="end" font-family="${MONO}" font-size="12" fill="${t.muted}">${esc(hint)}</text>
${body}
</svg>`;
}

function statsSvg(s, t) {
  const w = 900;
  const st = s.stats;
  const tiles = [
    ['Contributions', fmt(st.contributions), `since ${s.years[0].year}`],
    ['Private contributions', fmt(st.private), 'client work, mostly'],
    ['Active days', fmt(st.activeDays), 'with a contribution'],
    ['Longest streak', `${fmt(st.longest)} days`, `best day: ${fmt(st.busiestDay)}`],
    ['Repositories', fmt(st.repos), `${st.privateRepos} private`],
    ['Languages', fmt(st.languages), 'across all repos'],
    ['Stars earned', fmt(st.stars), `${fmt(st.followers)} followers`],
    ['Best year', String(st.busiestYear), `${fmt(st.busiestCount)} contributions`],
  ];
  const cols = 4, gap = 14, x0 = 36, y0 = 80, tw = (w - x0 * 2 - gap * (cols - 1)) / cols, th = 118;
  const cells = tiles.map(([label, value, sub], i) => {
    const x = x0 + (i % cols) * (tw + gap);
    const y = y0 + Math.floor(i / cols) * (th + gap);
    return `<g class="in" style="animation-delay:${0.08 * i}s">
  <rect x="${x}" y="${y}" width="${tw}" height="${th}" rx="12" fill="${t.card}" stroke="${t.line}"/>
  <text x="${x + 20}" y="${y + 32}" font-family="${SANS}" font-size="13" fill="${t.muted}">${esc(label)}</text>
  <text x="${x + 20}" y="${y + 76}" font-family="${SANS}" font-size="36" font-weight="700" fill="${t.text}" letter-spacing="-1">${esc(value)}</text>
  <text x="${x + 20}" y="${y + 100}" font-family="${MONO}" font-size="11.5" fill="${i % 2 ? t.accent2 : t.accent}">${esc(sub)}</text>
</g>`;
  });

  // Contributions per year, as a small bar chart under the tiles.
  const cy = y0 + 2 * (th + gap) + 18;
  const max = Math.max(...s.years.map((y) => y.total), 1);
  const bw = (w - x0 * 2) / s.years.length;
  const bars = s.years.map((y, i) => {
    const len = Math.max(4, ((bw - 150) * y.total) / max);
    const yy = cy + i * 30;
    return `<g class="in" style="animation-delay:${0.7 + 0.1 * i}s">
  <text x="${x0}" y="${yy + 13}" font-family="${MONO}" font-size="12" fill="${t.muted}">${y.year}</text>
  <rect class="grow" style="animation-delay:${0.8 + 0.1 * i}s" x="${x0 + 52}" y="${yy + 2}" width="${((w - x0 * 2 - 140) * y.total) / max || 4}" height="14" rx="7" fill="url(#g)"/>
  <text x="${w - x0}" y="${yy + 13}" text-anchor="end" font-family="${MONO}" font-size="12" fill="${t.text}">${fmt(y.total)}</text>
</g>`;
    void len;
  });
  const h = cy + s.years.length * 30 + 22;
  return frame(t, w, h, 'GitHub in numbers', 'private work included', cells.join('\n') + '\n' + bars.join('\n'));
}

function langsSvg(s, t) {
  const w = 900, x0 = 36, barY = 82, barW = w - x0 * 2;
  let x = x0;
  const segs = s.langs.map((l, i) => {
    const sw = (barW * l.pct) / 100;
    const r = `<rect class="grow" style="animation-delay:${0.05 * i}s" x="${x.toFixed(2)}" y="${barY}" width="${Math.max(sw, 0.5).toFixed(2)}" height="14" fill="${l.color}"/>`;
    x += sw;
    return r;
  });
  const cols = 2, rowH = 34, listY = barY + 54, colW = barW / cols;
  const rows = Math.ceil(s.langs.length / cols);
  const items = s.langs.map((l, i) => {
    const cx = x0 + Math.floor(i / rows) * colW;
    const cy = listY + (i % rows) * rowH;
    const track = colW - 250;
    return `<g class="in" style="animation-delay:${0.3 + 0.05 * i}s">
  <circle cx="${cx + 7}" cy="${cy - 5}" r="6" fill="${l.color}"/>
  <text x="${cx + 24}" y="${cy}" font-family="${SANS}" font-size="15" font-weight="600" fill="${t.text}">${esc(l.name)}</text>
  <rect x="${cx + 140}" y="${cy - 9}" width="${track}" height="6" rx="3" fill="${t.line}"/>
  <rect class="grow" style="animation-delay:${0.5 + 0.05 * i}s" x="${cx + 140}" y="${cy - 9}" width="${Math.max(3, (track * l.pct) / s.langs[0].pct)}" height="6" rx="3" fill="${l.color}"/>
  <text x="${cx + colW - 24}" y="${cy}" text-anchor="end" font-family="${MONO}" font-size="13" fill="${t.muted}">${l.pct.toFixed(1)}%</text>
</g>`;
  });
  const h = listY + rows * rowH + 6;
  const body = `<clipPath id="bar"><rect x="${x0}" y="${barY}" width="${barW}" height="14" rx="7"/></clipPath>
<g clip-path="url(#bar)">${segs.join('')}</g>
${items.join('\n')}`;
  return frame(t, w, h, 'Languages I write', `${s.stats.languages} languages · ${s.stats.repos} repos`, body);
}

const data = summarise(await collect());
if (process.argv.includes('--dump')) console.log(JSON.stringify(data, null, 2));
mkdirSync('assets', { recursive: true });
for (const [name, t] of Object.entries(THEMES)) {
  writeFileSync(`assets/stats-${name}.svg`, statsSvg(data, t));
  writeFileSync(`assets/languages-${name}.svg`, langsSvg(data, t));
}
console.log('wrote assets/stats-*.svg and assets/languages-*.svg');
