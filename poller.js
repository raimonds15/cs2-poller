import pg from 'pg';
const { Pool } = pg;

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const SPORT_ID = 17;
const MONEYLINE_MARKET = '171';

const pool = new Pool({ connectionString: DATABASE_URL });

function mapStatus(statusId) {
  if (statusId === 0) return 'upcoming';
  if (statusId === 1) return 'locked';
  if (statusId === 2) return 'resolved';
  return null;
}

function dateRange() {
  const from = new Date();
  const to = new Date();
  to.setDate(to.getDate() + 3);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(to) };
}

async function fetchFixtures() {
  const { from, to } = dateRange();
  const url = `https://api.oddspapi.io/v4/fixtures?apiKey=${ODDS_API_KEY}&sportId=${SPORT_ID}&from=${from}&to=${to}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fixtures failed: ${res.status}`);
  return res.json();
}

async function fetchOdds(fixtureId) {
  const url = `https://api.oddspapi.io/v4/odds?apiKey=${ODDS_API_KEY}&fixtureId=${fixtureId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`odds failed: ${res.status}`);
  return res.json();
}

function computeDevigOdds(oddsJson) {
  const books = oddsJson.bookmakerOdds;
  if (!books) return null;
  const pricesA = [];
  const pricesB = [];
  for (const bookKey of Object.keys(books)) {
    const book = books[bookKey];
    if (book.suspended || !book.markets) continue;
    const ml = book.markets[MONEYLINE_MARKET];
    if (!ml || !ml.marketActive || !ml.outcomes) continue;
    const oA = ml.outcomes['171'];
    const oB = ml.outcomes['172'];
    const pA = oA?.players?.['0']?.price;
    const pB = oB?.players?.['0']?.price;
    const aActive = oA?.players?.['0']?.active;
    const bActive = oB?.players?.['0']?.active;
    if (aActive && pA > 1) pricesA.push(pA);
    if (bActive && pB > 1) pricesB.push(pB);
  }
  if (pricesA.length === 0 || pricesB.length === 0) return null;
  const avg = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
  const avgA = avg(pricesA);
  const avgB = avg(pricesB);
  const impA = 1 / avgA;
  const impB = 1 / avgB;
  const total = impA + impB;
  const oddsA = +(1 / (impA / total)).toFixed(2);
  const oddsB = +(1 / (impB / total)).toFixed(2);
  return { oddsA, oddsB };
}

async function upsertTournament(client, fx) {
  await client.query(
    `insert into tournaments (id, name, slug, category)
     values ($1, $2, $3, $4)
     on conflict (id) do update set name = excluded.name`,
    [fx.tournamentId, fx.tournamentName, fx.tournamentSlug, fx.categoryName]
  );
}

async function approvedTournamentIds(client) {
  const { rows } = await client.query(`select id from tournaments where approved = true`);
  return new Set(rows.map((r) => String(r.id)));
}

async function upsertMatch(client, fx, odds) {
  const status = mapStatus(fx.statusId);
  if (!status) return;
  await client.query(
    `insert into matches
       (fixture_id, tournament_id, team_a, team_b, odds_a, odds_b, start_time, true_start, status, has_odds, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     on conflict (fixture_id) do update set
       odds_a     = excluded.odds_a,
       odds_b     = excluded.odds_b,
       status     = excluded.status,
       true_start = excluded.true_start,
       has_odds   = excluded.has_odds,
       updated_at = now()`,
    [
      fx.fixtureId, fx.tournamentId, fx.participant1Name, fx.participant2Name,
      odds ? odds.oddsA : null, odds ? odds.oddsB : null,
      fx.startTime, fx.trueStartTime, status, fx.hasOdds,
    ]
  );
}

async function run() {
  const client = await pool.connect();
  try {
    console.log(`[${new Date().toISOString()}] Poll start`);
    const fixtures = await fetchFixtures();
    console.log(`Fetched ${fixtures.length} fixtures`);
    for (const fx of fixtures) {
      if (fx.tournamentId) await upsertTournament(client, fx);
    }
    const approved = await approvedTournamentIds(client);
    let stored = 0, priced = 0;
    for (const fx of fixtures) {
      if (!approved.has(String(fx.tournamentId))) continue;
      let odds = null;
      if (fx.hasOdds && mapStatus(fx.statusId) === 'upcoming') {
        try {
          const oddsJson = await fetchOdds(fx.fixtureId);
          odds = computeDevigOdds(oddsJson);
          if (odds) priced++;
        } catch (e) {
          console.error(`odds error ${fx.fixtureId}: ${e.message}`);
        }
      }
      await upsertMatch(client, fx, odds);
      stored++;
    }
    console.log(`Stored ${stored} matches, ${priced} with odds`);
  } catch (err) {
    console.error('Poll error:', err.message);
  } finally {
    client.release();
  }
}

run();
setInterval(run, 5 * 60 * 1000);
