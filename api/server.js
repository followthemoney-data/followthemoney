const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const { Redis } = require('@upstash/redis');

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// ─── Confirmed SCB v1 path for money supply table ─────────────────────────────
// FM/FM5001/FM5001A/FM5001penningmangd
// "Growth rate and volume by money supply. Month 1999M01 - present"
// Discovered by navigating api.scb.se/OV0104/v1/doris/en/ssd tree.
const SCB_V1_URL = 'https://api.scb.se/OV0104/v1/doris/en/ssd/FM/FM5001/FM5001A/FM5001penningmangd';

// ─── ECB endpoint ─────────────────────────────────────────────────────────────

app.get('/api/ecb', async (req, res) => {
  try {
    const series = ['M10', 'M20', 'M30'];
    const results = {};
    for (const s of series) {
      const url = `https://data-api.ecb.europa.eu/service/data/BSI/M.U2.Y.V.${s}.X.1.U2.2300.Z01.E?format=jsondata&startPeriod=1997-01`;
      const r = await fetch(url);
      if (!r.ok) throw new Error('ECB API ' + r.status);
      const data = await r.json();
      const obs = data.dataSets[0].series['0:0:0:0:0:0:0:0:0:0:0'].observations;
      const periods = data.structure.dimensions.observation[0].values;
      const entries = Object.entries(obs)
        .map(([i, v]) => ({ period: periods[+i].id, value: v[0] }))
        .filter(d => d.value !== null)
        .sort((a, b) => a.period.localeCompare(b.period));
      results[s === 'M10' ? 'm1' : s === 'M20' ? 'm2' : 'm3'] = entries;
    }
    res.json({ success: true, data: results });
  } catch (e) {
    console.error('ECB error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── SCB parser ───────────────────────────────────────────────────────────────

function parseScbJsonStat2(data) {
  const M1 = '5LLM1.1E.NEP.V.A';
  const M2 = '5LLM2.1E.NEP.V.A';
  const M3 = '5LLM3a.1E.NEP.V.A';
  const VOL = '000007WQ';

  const dimIds = data.id;
  const dimSizes = data.size;
  const values = data.value;

  const getOrderedCodes = (dimName) => {
    const cat = data.dimension[dimName].category;
    return Object.keys(cat.index).sort((a, b) => cat.index[a] - cat.index[b]);
  };

  const penningmCodes = getOrderedCodes('Penningm');
  const contentsCodes = getOrderedCodes('ContentsCode');
  const tidCodes = getOrderedCodes('Tid');

  const m1Pos = penningmCodes.indexOf(M1);
  const m2Pos = penningmCodes.indexOf(M2);
  const m3Pos = penningmCodes.indexOf(M3);
  const volPos = contentsCodes.indexOf(VOL);

  if (m1Pos === -1 || m2Pos === -1 || m3Pos === -1 || volPos === -1) {
    throw new Error(`Missing codes. m1:${m1Pos} m2:${m2Pos} m3:${m3Pos} vol:${volPos}`);
  }

  function flatIdx(coords) {
    let idx = 0;
    let stride = 1;
    for (let i = dimIds.length - 1; i >= 0; i--) {
      idx += coords[dimIds[i]] * stride;
      stride *= dimSizes[i];
    }
    return idx;
  }

  const results = [];
  for (let t = 0; t < tidCodes.length; t++) {
    const rawPeriod = tidCodes[t];
    const match = rawPeriod.match(/^(\d{4})M(\d{2})$/);
    if (!match) continue;
    const period = `${match[1]}-${match[2]}`;
    const m1Val = values[flatIdx({ Penningm: m1Pos, ContentsCode: volPos, Tid: t })];
    const m2Val = values[flatIdx({ Penningm: m2Pos, ContentsCode: volPos, Tid: t })];
    const m3Val = values[flatIdx({ Penningm: m3Pos, ContentsCode: volPos, Tid: t })];
    if (m1Val != null && m2Val != null && m3Val != null) {
      results.push({ period, m1: m1Val, m2: m2Val, m3: m3Val });
    }
  }
  return results;
}

// ─── Riksbank live endpoint ───────────────────────────────────────────────────
// Fast path: reads a single Redis key 'riksbank:snapshot' (one JSON blob).
// SCB v2 is only called once per day (riksbank:scb_checked key with 24h TTL).

app.get('/api/riksbank', async (req, res) => {
  try {
    const M1 = '5LLM1.1E.NEP.V.A';
    const M2 = '5LLM2.1E.NEP.V.A';
    const M3 = '5LLM3a.1E.NEP.V.A';
    const VOL = '000007WQ';

    // 1. Load snapshot from Redis (single key, fast)
    const raw = await redis.get('riksbank:snapshot');
    let snapshot = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};

    // 2. Only call SCB v2 if cache has expired (once per day)
    const scbCached = await redis.get('riksbank:scb_checked');
    if (!scbCached) {
      const scbUrl = 'https://statistikdatabasen.scb.se/api/v2/tables/TAB6541/data' +
        `?lang=en&outputFormat=json-stat2` +
        `&valueCodes[Penningm]=${encodeURIComponent(M1)},${encodeURIComponent(M2)},${encodeURIComponent(M3)}` +
        `&valueCodes[ContentsCode]=${VOL}` +
        `&valueCodes[Tid]=top(3)`;

      const r = await fetch(scbUrl);
      if (!r.ok) throw new Error('SCB v2 ' + r.status);
      const data = await r.json();
      const rows = parseScbJsonStat2(data);

      // Merge new periods into snapshot
      let updated = false;
      for (const row of rows) {
        if (!snapshot[row.period] || snapshot[row.period].m3 !== row.m3) {
          snapshot[row.period] = { m1: row.m1, m2: row.m2, m3: row.m3 };
          updated = true;
        }
      }

      if (updated) {
        await redis.set('riksbank:snapshot', JSON.stringify(snapshot));
      }

      // Mark as checked — won't call SCB again for 24 hours
      await redis.set('riksbank:scb_checked', '1', { ex: 86400 });
    }

    // 3. Build response from snapshot
    const periods = Object.keys(snapshot).sort();
    const history = { m1: [], m2: [], m3: [] };
    for (const period of periods) {
      const e = snapshot[period];
      history.m1.push({ period, value: parseFloat(e.m1) });
      history.m2.push({ period, value: parseFloat(e.m2) });
      history.m3.push({ period, value: parseFloat(e.m3) });
    }

    res.json({
      success: true,
      data: history,
      source: scbCached ? 'cache' : 'live',
      periods_stored: periods.length,
    });
  } catch (e) {
    console.error('Riksbank error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Seed endpoint ────────────────────────────────────────────────────────────
// Uses SCB v1 API with filter:"all" to fetch ALL historical periods at once.
// Run this once to populate Redis. After that, /api/riksbank keeps it updated.

app.get('/api/seed', async (req, res) => {
  try {
    // Step 1: GET metadata from v1 to get variable codes
    const metaR = await fetch(SCB_V1_URL);
    if (!metaR.ok) throw new Error(`SCB v1 metadata HTTP ${metaR.status}`);
    const meta = await metaR.json();

    // Step 2: POST with filter:"all" — fetches every available period
    const query = {
      query: meta.variables.map(v => ({
        code: v.code,
        selection: { filter: 'all', values: ['*'] }
      })),
      response: { format: 'json-stat2' }
    };

    const dataR = await fetch(SCB_V1_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(query)
    });
    if (!dataR.ok) throw new Error(`SCB v1 data HTTP ${dataR.status}: ${await dataR.text().then(t => t.slice(0, 300))}`);

    const data = await dataR.json();
    const rows = parseScbJsonStat2(data);

    if (rows.length <= 1) {
      return res.json({ success: false, message: `Only ${rows.length} period(s) returned.`, rows });
    }

    // Step 3: Write all rows as a single snapshot to Redis
    const snapshot = {};
    for (const row of rows) {
      snapshot[row.period] = { m1: row.m1, m2: row.m2, m3: row.m3 };
    }
    await redis.set('riksbank:snapshot', JSON.stringify(snapshot));

    res.json({
      success: true,
      message: `Seed complete. Wrote ${rows.length} periods as single snapshot to Redis.`,
      seeded: rows.length,
      firstPeriod: rows[0].period,
      lastPeriod: rows[rows.length - 1].period,
      sample: rows.slice(-3),
    });
  } catch (e) {
    console.error('Seed error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Wipe endpoint ────────────────────────────────────────────────────────────

app.get('/api/wipe', async (req, res) => {
  try {
    await redis.del('riksbank:snapshot');
    res.json({ success: true, message: 'Snapshot wiped.' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Status endpoint ──────────────────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
  try {
    const raw = await redis.get('riksbank:snapshot');
    const snapshot = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
    const keys = Object.keys(snapshot).sort();
    res.json({
      redisKeys: keys.length,
      firstPeriod: keys[0] ? keys[0].replace('riksbank:', '') : null,
      lastPeriod: keys[keys.length - 1] ? keys[keys.length - 1].replace('riksbank:', '') : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Browse endpoint (for debugging the v1 API tree) ─────────────────────────

app.get('/api/scb-browse', async (req, res) => {
  try {
    const path = req.query.path || '';
    const url = `https://api.scb.se/OV0104/v1/doris/en/ssd/${path}`;
    const r = await fetch(url);
    if (!r.ok) return res.json({ error: `HTTP ${r.status}`, url });
    const data = await r.json();
    res.json({ url, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Norway debug endpoint ────────────────────────────────────────────────────
// Shows raw SSB response for last 2 periods so we can confirm dimension codes.

app.get('/api/norway-debug', async (req, res) => {
  try {
    const url = 'https://data.ssb.no/api/pxwebapi/v2/tables/10945/data' +
      '?lang=en&outputFormat=json-stat2' +
      '&valueCodes[ContentsCode]=*' +
      '&valueCodes[Tid]=top(2)';
    const r = await fetch(url);
    if (!r.ok) throw new Error(`SSB HTTP ${r.status}: ${await r.text().then(t => t.slice(0, 300))}`);
    const data = await r.json();
    // Return a summary: dimension names, codes, and the raw values
    res.json({
      id: data.id,
      size: data.size,
      dimensions: Object.fromEntries(
        data.id.map(dim => [dim, {
          label: data.dimension[dim].label,
          codes: Object.keys(data.dimension[dim].category.index)
        }])
      ),
      valueCount: data.value?.length,
      sampleValues: data.value?.slice(0, 10)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Norway endpoint ──────────────────────────────────────────────────────────
// Fetches ALL M1/M2/M3 history from SSB Norway directly — no Redis needed.
// SSB v2 wildcard actually works unlike SCB.

app.get('/api/norway', async (req, res) => {
  try {
    const url = 'https://data.ssb.no/api/pxwebapi/v2/tables/10945/data' +
      '?lang=en&outputFormat=json-stat2' +
      '&valueCodes[ContentsCode]=*' +
      '&valueCodes[Tid]=*';
    const r = await fetch(url);
    if (!r.ok) throw new Error(`SSB HTTP ${r.status}: ${await r.text().then(t => t.slice(0, 300))}`);
    const data = await r.json();

    // Parse dimensions
    const dimIds = data.id;
    const dimSizes = data.size;
    const values = data.value;

    const getOrderedCodes = (dimName) => {
      const cat = data.dimension[dimName].category;
      return Object.keys(cat.index).sort((a, b) => cat.index[a] - cat.index[b]);
    };

    const contentsCodes = getOrderedCodes('ContentsCode');
    const tidCodes = getOrderedCodes('Tid');

    // Confirmed codes from /api/norway-debug:
    // PengmengdBehM1 = M1 stocks (NOK million)
    // PengmengdBehM2 = M2 stocks (NOK million)
    // PengmengdBehM3 = M3 stocks (NOK million)
    const m1Idx = contentsCodes.indexOf('PengmengdBehM1');
    const m2Idx = contentsCodes.indexOf('PengmengdBehM2');
    const m3Idx = contentsCodes.indexOf('PengmengdBehM3');

    if (m1Idx === -1 || m2Idx === -1 || m3Idx === -1) {
      return res.json({
        success: false,
        message: 'Could not find M1/M2/M3 stock codes',
        availableCodes: contentsCodes
      });
    }

    function flatIdx(coords) {
      let idx = 0;
      let stride = 1;
      for (let i = dimIds.length - 1; i >= 0; i--) {
        idx += coords[dimIds[i]] * stride;
        stride *= dimSizes[i];
      }
      return idx;
    }

    const m1 = [], m2 = [], m3 = [];
    for (let t = 0; t < tidCodes.length; t++) {
      const rawPeriod = tidCodes[t]; // e.g. "2024M03"
      const match = rawPeriod.match(/^(\d{4})M(\d{2})$/);
      if (!match) continue;
      const period = `${match[1]}-${match[2]}`;

      const v1 = values[flatIdx({ ContentsCode: m1Idx, Tid: t })];
      const v2 = values[flatIdx({ ContentsCode: m2Idx, Tid: t })];
      const v3 = values[flatIdx({ ContentsCode: m3Idx, Tid: t })];

      if (v1 != null) m1.push({ period, value: v1 });
      if (v2 != null) m2.push({ period, value: v2 });
      if (v3 != null) m3.push({ period, value: v3 });
    }

    res.json({
      success: true,
      data: { m1, m2, m3 },
      periods: tidCodes.length,
      firstPeriod: m3[0]?.period,
      lastPeriod: m3[m3.length - 1]?.period,
    });
  } catch (e) {
    console.error('Norway error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// SNB data portal: data.snb.ch/api/cube/snbmonagg
// Dimensions confirmed: D0(B)=Level, D1(GM1/GM2/GM3)=M1/M2/M3
// CSV format, semicolon-separated, data starts at row 4 (0-indexed)
// Units: CHF millions. No auth needed. Full history: 1984-01 onwards.
// Three separate fetches (one per aggregate) — SNB doesn't support multi-value D1 in one call.

app.get('/api/switzerland', async (req, res) => {
  try {
    const BASE = 'https://data.snb.ch/api/cube/snbmonagg/data/csv/en';

    async function fetchAggregate(code) {
      const url = `${BASE}?dimSel=D0(B),D1(${code})&fromDate=1984-01`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`SNB HTTP ${r.status} for ${code}`);
      const text = await r.text();

      // CSV format:
      // Line 0: "CubeId";"snbmonagg"
      // Line 1: "PublishingDate";"..."
      // Line 2: (blank)
      // Line 3: "Date";"D0";"D1";"Value"
      // Line 4+: data rows
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const dataLines = lines.slice(3); // skip header lines, keep column header + data

      const series = [];
      for (const line of dataLines) {
        if (line.startsWith('"Date"')) continue; // skip column header
        // Each row: "YYYY-MM";"B";"GM1";"123456"
        const parts = line.split(';').map(p => p.replace(/"/g, '').trim());
        if (parts.length < 4) continue;
        const [date, , , value] = parts;
        if (!date || !value || isNaN(Number(value))) continue;
        // date format is already "YYYY-MM"
        series.push({ period: date, value: Number(value) });
      }
      return series.sort((a, b) => a.period.localeCompare(b.period));
    }

    const [m1, m2, m3] = await Promise.all([
      fetchAggregate('GM1'),
      fetchAggregate('GM2'),
      fetchAggregate('GM3'),
    ]);

    if (!m3.length) throw new Error('No data returned from SNB');

    res.json({
      success: true,
      data: { m1, m2, m3 },
      periods: m3.length,
      firstPeriod: m3[0]?.period,
      lastPeriod: m3[m3.length - 1]?.period,
    });
  } catch (e) {
    console.error('Switzerland error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── USA (FRED) endpoint ──────────────────────────────────────────────────────
// Series: M1SL (M1) and M2SL (M2). USA has no official M3.
// Units: billions of USD (not millions like other countries). Data from 1959.
// Uses official FRED JSON API — requires FRED_API_KEY env var in Vercel.
// Same Redis caching pattern as Sweden: full snapshot stored once, refreshed once per day.
// Redis keys: usa:snapshot (full M1+M2 arrays), usa:fred_checked (24h TTL refresh flag).

async function fetchFromFred() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('FRED_API_KEY environment variable is not set');
  const BASE = 'https://api.stlouisfed.org/fred/series/observations';

  async function fetchSeries(seriesId) {
    const url = `${BASE}?series_id=${seriesId}&api_key=${apiKey}&file_type=json&observation_start=1959-01-01`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`FRED HTTP ${r.status} for ${seriesId}`);
    const data = await r.json();
    if (data.error_code) throw new Error(`FRED error: ${data.error_message}`);
    return data.observations
      .filter(o => o.value !== '.')
      .map(o => ({ period: o.date.slice(0, 7), value: parseFloat(o.value) }))
      .sort((a, b) => a.period.localeCompare(b.period));
  }

  const [m1, m2] = await Promise.all([fetchSeries('M1SL'), fetchSeries('M2SL')]);
  if (!m2.length) throw new Error('No data returned from FRED');
  return { m1, m2 };
}

app.get('/api/usa', async (req, res) => {
  try {
    const raw = await redis.get('usa:snapshot');
    let snapshot = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;

    const fredCached = await redis.get('usa:fred_checked');
    const source = fredCached && snapshot ? 'cache' : 'live';

    if (!fredCached || !snapshot) {
      snapshot = await fetchFromFred();
      await redis.set('usa:snapshot', JSON.stringify(snapshot));
      await redis.set('usa:fred_checked', '1', { ex: 86400 });
    }

    res.json({
      success: true,
      data: snapshot,
      source,
      periods: snapshot.m2.length,
      firstPeriod: snapshot.m2[0]?.period,
      lastPeriod: snapshot.m2[snapshot.m2.length - 1]?.period,
    });
  } catch (e) {
    console.error('USA error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── USA seed endpoint ────────────────────────────────────────────────────────

app.get('/api/usa-seed', async (req, res) => {
  try {
    const snapshot = await fetchFromFred();
    await redis.set('usa:snapshot', JSON.stringify(snapshot));
    await redis.set('usa:fred_checked', '1', { ex: 86400 });
    res.json({
      success: true,
      message: `USA seed complete. Stored ${snapshot.m1.length} M1 and ${snapshot.m2.length} M2 periods in Redis.`,
      firstPeriod: snapshot.m2[0]?.period,
      lastPeriod: snapshot.m2[snapshot.m2.length - 1]?.period,
    });
  } catch (e) {
    console.error('USA seed error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── GDP endpoint ─────────────────────────────────────────────────────────────
// Fetches quarterly real GDP levels from FRED, calculates year-on-year growth %.
// Series (OECD National Accounts via FRED):
//   USA:         GDPC1              (Real GDP, billions 2017 USD, quarterly SA)
//   Euro Area:   CLVMNACSCAB1GQEA19 (Real GDP Euro Area 19, volume index)
//   Sweden:      CLVMNACSCAB1GQSE
//   Norway:      CLVMNACSCAB1GQNO
//   Switzerland: CLVMNACSCAB1GQCH
// Redis keys: gdp:snapshot, gdp:checked (24h TTL)

async function fetchGdpFromFred() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('FRED_API_KEY not set');
  const BASE = 'https://api.stlouisfed.org/fred/series/observations';

  async function fetchSeries(seriesId) {
    const url = `${BASE}?series_id=${seriesId}&api_key=${apiKey}&file_type=json&observation_start=1960-01-01`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`FRED HTTP ${r.status} for ${seriesId}`);
    const data = await r.json();
    if (data.error_code) throw new Error(`FRED: ${data.error_message}`);
    return data.observations
      .filter(o => o.value !== '.')
      .map(o => ({ period: o.date.slice(0, 7), value: parseFloat(o.value) }))
      .sort((a, b) => a.period.localeCompare(b.period));
  }

  function calcYoY(series) {
    return series
      .map((d, i) => {
        if (i < 4) return null;
        const prev = series[i - 4];
        return { period: d.period, value: +((d.value - prev.value) / prev.value * 100).toFixed(2) };
      })
      .filter(Boolean);
  }

  const seriesMap = {
    usa:         'GDPC1',
    ecb:         'CLVMNACSCAB1GQEA19',
    riksbank:    'CLVMNACSCAB1GQSE',
    norway:      'CLVMNACSCAB1GQNO',
    switzerland: 'CLVMNACSCAB1GQCH',
  };

  const wait = ms => new Promise(r => setTimeout(r, ms));
  const errors = {};
  const results = {};
  for (const [key, id] of Object.entries(seriesMap)) {
    if (Object.keys(results).length > 0) await wait(700);
    try {
      results[key] = calcYoY(await fetchSeries(id));
    } catch (e) {
      console.error(`GDP fetch failed for ${key} (${id}):`, e.message);
      results[key] = null;
      errors[key] = e.message;
    }
  }
  results._errors = errors;
  return results;
}

app.get('/api/debt-reset', async (req, res) => {
  await redis.del('debt:snapshot');
  await redis.del('debt:checked');
  res.json({ success: true, message: 'Debt cache cleared.' });
});

app.get('/api/gdp', async (req, res) => {
  try {
    const raw = await redis.get('gdp:snapshot');
    let snapshot = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    const cached = await redis.get('gdp:checked');
    if (!cached || !snapshot) {
      snapshot = await fetchGdpFromFred();
      await redis.set('gdp:snapshot', JSON.stringify(snapshot));
      await redis.set('gdp:checked', '1', { ex: 86400 });
    }
    res.json({ success: true, data: snapshot, source: cached && snapshot ? 'cache' : 'live' });
  } catch (e) {
    console.error('GDP error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/gdp-seed', async (req, res) => {
  try {
    const snapshot = await fetchGdpFromFred();
    await redis.set('gdp:snapshot', JSON.stringify(snapshot));
    await redis.set('gdp:checked', '1', { ex: 86400 });
    const { _errors, ...data } = snapshot;
    const summary = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, v
        ? { periods: v.length, first: v[0]?.period, last: v[v.length - 1]?.period }
        : { failed: true, error: _errors?.[k] || 'unknown' }
      ])
    );
    res.json({ success: true, message: 'GDP seed complete.', summary });
  } catch (e) {
    console.error('GDP seed error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Debt endpoint ────────────────────────────────────────────────────────────
// IMF DataMapper API — public, no key required.
// GGXWDG_NGDP: General Government Gross Debt (% of GDP), annual
// NGDP:        Nominal GDP, billions of national currency, annual
// Country codes: XM = Euro Area, SWE, NOR, CHE, USA
// Debt value = NGDP × GGXWDG_NGDP / 100  (in billions local currency → multiply ×1e9 for units)
// Per-second rate derived from year-on-year change in debt.
// Redis keys: debt:snapshot, debt:checked (24h TTL)

async function fetchDebtFromIMF() {
  // EU = European Union aggregate (closest available proxy for Euro Area in IMF DataMapper)
  const IMF_MAP = { ecb: 'EU', riksbank: 'SWE', norway: 'NOR', switzerland: 'CHE', usa: 'USA' };
  const BASE = 'https://www.imf.org/external/datamapper/api/v1';
  const capYear = new Date().getFullYear();

  const [r1, r2] = await Promise.all([
    fetch(`${BASE}/GGXWDG_NGDP`),
    fetch(`${BASE}/NGDPD`),
  ]);
  if (!r1.ok) throw new Error(`IMF GGXWDG_NGDP HTTP ${r1.status}`);
  if (!r2.ok) throw new Error(`IMF NGDPD HTTP ${r2.status}`);

  const d1 = await r1.json();
  const d2 = await r2.json();

  const result = {};
  for (const [key, code] of Object.entries(IMF_MAP)) {
    try {
      const debtPct = d1.values?.GGXWDG_NGDP?.[code] || {};
      const gdpUsd  = d2.values?.NGDPD?.[code] || {};

      const years = Object.keys(debtPct)
        .map(Number)
        .filter(y => debtPct[y] != null && gdpUsd[y] != null && y <= capYear)
        .sort((a, b) => a - b);

      if (years.length < 2) { result[key] = null; continue; }

      const y1 = years[years.length - 1];
      const y0 = years[years.length - 2];

      const debt1 = gdpUsd[y1] * debtPct[y1] / 100; // billions USD
      const debt0 = gdpUsd[y0] * debtPct[y0] / 100;

      const perSecond = (debt1 - debt0) * 1e9 / (365.25 * 24 * 3600);

      result[key] = {
        value:     Math.round(debt1 * 1e9),
        gdpRatio:  +debtPct[y1].toFixed(1),
        perSecond: +perSecond.toFixed(2),
        period:    String(y1),
        series:    years.map(y => ({ period: String(y), value: +debtPct[y].toFixed(1) })),
      };
    } catch (_) {
      result[key] = null;
    }
  }
  // Override USA with FRED GFDEBTN (1966–) for longer history than IMF
  try {
    const apiKey = process.env.FRED_API_KEY;
    const BASE_FRED = 'https://api.stlouisfed.org/fred/series/observations';
    const [r3, r4] = await Promise.all([
      fetch(`${BASE_FRED}?series_id=GFDEBTN&api_key=${apiKey}&file_type=json&observation_start=1966-01-01`),
      fetch(`${BASE_FRED}?series_id=GDP&api_key=${apiKey}&file_type=json&observation_start=1966-01-01`),
    ]);
    const debtObs = (await r3.json()).observations?.filter(o => o.value !== '.') || [];
    const gdpObs  = (await r4.json()).observations?.filter(o => o.value !== '.') || [];

    const gdpMap = {};
    for (const o of gdpObs) gdpMap[o.date.slice(0, 7)] = parseFloat(o.value);

    const annualMap = {};
    for (const o of debtObs) {
      const year = o.date.slice(0, 4);
      if (parseInt(year) > capYear) continue;
      const gdp = gdpMap[o.date.slice(0, 7)];
      if (!gdp) continue;
      annualMap[year] = {
        ratio:   +((parseFloat(o.value) / 1000) / gdp * 100).toFixed(1),
        debtUsd: parseFloat(o.value) * 1e6,
      };
    }

    const usaYears = Object.keys(annualMap).sort();
    if (usaYears.length > 1) {
      const y1 = usaYears[usaYears.length - 1];
      const y0 = usaYears[usaYears.length - 2];
      const perSecond = (annualMap[y1].debtUsd - annualMap[y0].debtUsd) / (365.25 * 24 * 3600);
      result.usa = {
        value:     Math.round(annualMap[y1].debtUsd),
        gdpRatio:  annualMap[y1].ratio,
        perSecond: +perSecond.toFixed(2),
        period:    y1,
        series:    usaYears.map(y => ({ period: y, value: annualMap[y].ratio })),
      };
    }
  } catch (e) {
    console.error('USA FRED debt override failed:', e.message);
  }

  return result;
}


app.get('/api/debt', async (req, res) => {
  try {
    const raw = await redis.get('debt:snapshot');
    let snapshot = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    const cached = await redis.get('debt:checked');
    if (!cached || !snapshot) {
      snapshot = await fetchDebtFromIMF();
      await redis.set('debt:snapshot', JSON.stringify(snapshot));
      await redis.set('debt:checked', '1', { ex: 86400 });
    }
    res.json({ success: true, data: snapshot, source: cached && snapshot ? 'cache' : 'live' });
  } catch (e) {
    console.error('Debt error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── CPI endpoint (purchasing power data via FRED) ───────────────────────────
// Fetches monthly CPI index for all 5 countries from FRED (same API key as USA).
// Used by the frontend to calculate purchasing power over time.
// Redis keys: cpi:snapshot, cpi:checked (24h TTL)
// Series IDs — ECB and Norway confirmed working. Others updated after debugging.
//   USA:         CPIAUCSL           (BLS CPI-U All Items, 1947-)
//   Euro Area:   CP0000EZ19M086NEST (Eurostat HICP EA19, confirmed 1996-)
//   Sweden:      CP0000SEM086NEST   (Eurostat HICP Sweden)
//   Norway:      NORCPIALLMINMEI    (OECD MEI, confirmed 1960-)
//   Switzerland: CP0000CHM086NEST   (Eurostat HICP Switzerland)

async function fetchCpiFromFred() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('FRED_API_KEY not set');
  const BASE = 'https://api.stlouisfed.org/fred/series/observations';

  async function fetchSeries(seriesId) {
    const url = `${BASE}?series_id=${seriesId}&api_key=${apiKey}&file_type=json&observation_start=1960-01-01`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`FRED HTTP ${r.status} for ${seriesId}`);
    const data = await r.json();
    if (data.error_code) throw new Error(`FRED series ${seriesId}: ${data.error_message}`);
    return data.observations
      .filter(o => o.value !== '.')
      .map(o => ({ period: o.date.slice(0, 7), value: parseFloat(o.value) }))
      .sort((a, b) => a.period.localeCompare(b.period));
  }

  const seriesMap = {
    usa:         'CPIAUCSL',
    ecb:         'CP0000EZ19M086NEST',
    riksbank:    'CP0000SEM086NEST',
    norway:      'NORCPIALLMINMEI',
    switzerland: 'CP0000CHM086NEST',
  };

  // Sequential with 700ms gap — FRED rate limit is 2 req/sec (120/min)
  const errors = {};
  const results = {};
  const wait = ms => new Promise(r => setTimeout(r, ms));
  for (const [key, id] of Object.entries(seriesMap)) {
    if (Object.keys(results).length > 0) await wait(700);
    try {
      results[key] = await fetchSeries(id);
    } catch (e) {
      console.error(`CPI fetch failed for ${key} (${id}):`, e.message);
      results[key] = null;
      errors[key] = e.message;
    }
  }
  results._errors = errors;
  return results;
}

app.get('/api/cpi', async (req, res) => {
  try {
    const raw = await redis.get('cpi:snapshot');
    let snapshot = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;

    const cpiCached = await redis.get('cpi:checked');
    const source = cpiCached && snapshot ? 'cache' : 'live';

    if (!cpiCached || !snapshot) {
      snapshot = await fetchCpiFromFred();
      await redis.set('cpi:snapshot', JSON.stringify(snapshot));
      await redis.set('cpi:checked', '1', { ex: 86400 });
    }

    res.json({ success: true, data: snapshot, source });
  } catch (e) {
    console.error('CPI error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/cpi-test', async (req, res) => {
  const seriesId = req.query.s || 'CPIAUCSL';
  const from = req.query.from || '1990-01-01';
  const apiKey = process.env.FRED_API_KEY;
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&observation_start=${from}`;
  try {
    const r = await fetch(url);
    const data = await r.json();
    const obs = data.observations || [];
    res.json({ seriesId, from, status: r.status, count: obs.length, first: obs[0]?.date, last: obs[obs.length-1]?.date, error_code: data.error_code, error_message: data.error_message });
  } catch (e) {
    res.json({ seriesId, error: e.message });
  }
});

app.get('/api/cpi-seed', async (req, res) => {
  try {
    const snapshot = await fetchCpiFromFred();
    await redis.set('cpi:snapshot', JSON.stringify(snapshot));
    await redis.set('cpi:checked', '1', { ex: 86400 });
    const { _errors, ...data } = snapshot;
    const summary = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, v
        ? { periods: v.length, first: v[0]?.period, last: v[v.length-1]?.period }
        : { failed: true, error: _errors?.[k] || 'unknown' }
      ])
    );
    res.json({ success: true, message: 'CPI seed complete.', summary });
  } catch (e) {
    console.error('CPI seed error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Interest rates endpoint ──────────────────────────────────────────────────
// Central bank policy rates from FRED.
// Series:
//   USA:         FEDFUNDS           (Federal Funds Rate, monthly avg, 1954-)
//   ECB:         ECBDFR             (ECB Deposit Facility Rate, 1999-)
//   Sweden:      IRSTCB01SEM156N    (Riksbank rate, OECD MEI)
//   Norway:      IRSTCB01NOM156N    (Norges Bank rate, OECD MEI)
//   Switzerland: IRSTCB01CHM156N    (SNB rate, OECD MEI)
// Redis keys: rates:snapshot, rates:checked (24h TTL)

async function fetchRatesFromFred() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('FRED_API_KEY not set');
  const BASE = 'https://api.stlouisfed.org/fred/series/observations';

  async function fetchSeries(seriesId) {
    const url = `${BASE}?series_id=${seriesId}&api_key=${apiKey}&file_type=json&observation_start=1990-01-01`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`FRED HTTP ${r.status} for ${seriesId}`);
    const data = await r.json();
    if (data.error_code) throw new Error(`FRED: ${data.error_message}`);
    return data.observations
      .filter(o => o.value !== '.')
      .map(o => ({ period: o.date.slice(0, 7), value: parseFloat(o.value) }))
      .sort((a, b) => a.period.localeCompare(b.period));
  }

  const seriesMap = {
    usa:         'FEDFUNDS',
    ecb:         'ECBDFR',
    riksbank:    'IR3TIB01SEM156N',
    norway:      'IR3TIB01NOM156N',
    switzerland: 'IR3TIB01CHM156N',
  };

  const wait = ms => new Promise(r => setTimeout(r, ms));
  const errors = {};
  const results = {};
  for (const [key, id] of Object.entries(seriesMap)) {
    if (Object.keys(results).length > 0) await wait(700);
    try {
      results[key] = await fetchSeries(id);
    } catch (e) {
      console.error(`Rates fetch failed for ${key} (${id}):`, e.message);
      results[key] = null;
      errors[key] = e.message;
    }
  }
  results._errors = errors;
  return results;
}

app.get('/api/rates', async (req, res) => {
  try {
    const raw = await redis.get('rates:snapshot');
    let snapshot = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    const cached = await redis.get('rates:checked');
    if (!cached || !snapshot) {
      snapshot = await fetchRatesFromFred();
      await redis.set('rates:snapshot', JSON.stringify(snapshot));
      await redis.set('rates:checked', '1', { ex: 86400 });
    }
    res.json({ success: true, data: snapshot, source: cached && snapshot ? 'cache' : 'live' });
  } catch (e) {
    console.error('Rates error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/rates-seed', async (req, res) => {
  try {
    const snapshot = await fetchRatesFromFred();
    await redis.set('rates:snapshot', JSON.stringify(snapshot));
    await redis.set('rates:checked', '1', { ex: 86400 });
    const { _errors, ...data } = snapshot;
    const summary = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, v
        ? { periods: v.length, first: v[0]?.period, last: v[v.length - 1]?.period }
        : { failed: true, error: _errors?.[k] || 'unknown' }
      ])
    );
    res.json({ success: true, message: 'Rates seed complete.', summary });
  } catch (e) {
    console.error('Rates seed error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
