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

// ─── Germany (Bundesbank) endpoint ───────────────────────────────────────────
// Uses Bundesbank SDMX API (BBSIS flow) — same BSI key structure as ECB.
// Germany joined the eurozone in 1999. Post-1999 data = German contribution
// to euro area aggregates (EUR). Pre-1999 not available in BBSIS.
// Units: EUR millions. No auth needed.

app.get('/api/germany-debug', async (req, res) => {
  // Use wildcards to discover current BBK01 money supply series keys
  // The Bundesbank supports * as wildcard in BBK01
  // Try searching for series containing "M3" or "Geldmenge" patterns
  const attempts = [
    // Wildcard search for anything containing M3 in BBK01
    'https://api.statistiken.bundesbank.de/rest/data/BBK01/*M3*?format=sdmx_csv&lang=en&startPeriod=2025-01&lastNObservations=2',
    // Try the new alphanumeric format — OXA pattern seen in other BBK01 keys
    'https://api.statistiken.bundesbank.de/rest/data/BBK01/OXA8B2?format=sdmx_csv&lang=en&startPeriod=2025-01',
  ];
  const results = [];
  for (const url of attempts) {
    try {
      const r = await fetch(url);
      const text = await r.text();
      results.push({ status: r.status, url: url.split('?')[0], preview: text.slice(0, 500) });
    } catch (e) {
      results.push({ error: e.message, url });
    }
  }
  res.json(results);
});

app.get('/api/germany', async (req, res) => {
  try {
    const BASE = 'https://api.statistiken.bundesbank.de/rest/data/BBSIS';
    // BSI key: M.{country}.Y.V.{aggregate}.X.1.U2.2300.Z01.E
    // M10=M1, M20=M2, M30=M3 — seasonally adjusted (Y series)
    const seriesMap = {
      m1: 'M.DE.Y.V.M10.X.1.U2.2300.Z01.E',
      m2: 'M.DE.Y.V.M20.X.1.U2.2300.Z01.E',
      m3: 'M.DE.Y.V.M30.X.1.U2.2300.Z01.E',
    };

    async function fetchSeries(key) {
      const url = `${BASE}/${key}?format=sdmx_csv&lang=en`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Bundesbank HTTP ${r.status} for ${key}: ${await r.text().then(t => t.slice(0, 200))}`);
      const text = await r.text();
      // csvdata format: header row then data rows
      // Typical: KEY,FREQ,... ,TIME_PERIOD,OBS_VALUE
      const lines = text.trim().split('\n');
      const header = lines[0].split(',');
      const timePeriodIdx = header.findIndex(h => h.trim().replace(/"/g, '') === 'TIME_PERIOD');
      const obsValueIdx = header.findIndex(h => h.trim().replace(/"/g, '') === 'OBS_VALUE');
      if (timePeriodIdx === -1 || obsValueIdx === -1) {
        throw new Error(`Unexpected CSV headers: ${lines[0].slice(0, 200)}`);
      }
      const series = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map(c => c.replace(/"/g, '').trim());
        const period = cols[timePeriodIdx];
        const value = parseFloat(cols[obsValueIdx]);
        if (period && !isNaN(value)) {
          series.push({ period, value });
        }
      }
      return series.sort((a, b) => a.period.localeCompare(b.period));
    }

    const [m1, m2, m3] = await Promise.all([
      fetchSeries(seriesMap.m1),
      fetchSeries(seriesMap.m2),
      fetchSeries(seriesMap.m3),
    ]);

    if (!m3.length) throw new Error('No data returned from Bundesbank');

    res.json({
      success: true,
      data: { m1, m2, m3 },
      periods: m3.length,
      firstPeriod: m3[0]?.period,
      lastPeriod: m3[m3.length - 1]?.period,
    });
  } catch (e) {
    console.error('Germany error:', e);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
