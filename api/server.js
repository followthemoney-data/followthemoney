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

// ─── ECB endpoint ─────────────────────────────────────────────────────────────
// Fetches ALL available M1/M2/M3 data for Euro Area from Jan 1997 onwards.
// The ECB back-calculated harmonised data to Jan 1997, before the euro physically launched.

app.get('/api/ecb', async (req, res) => {
  try {
    const series = ['M10', 'M20', 'M30'];
    const results = {};
    for (const s of series) {
      // startPeriod=1997-01 fetches from the very beginning of available data.
      // No lastNObservations limit — we want the full history.
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
// Parses json-stat2 response from SCB into array of { period, m1, m2, m3 }

function parseScbData(data) {
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
    throw new Error(`Missing expected codes. m1:${m1Pos} m2:${m2Pos} m3:${m3Pos} vol:${volPos}`);
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

app.get('/api/riksbank', async (req, res) => {
  try {
    const M1 = '5LLM1.1E.NEP.V.A';
    const M2 = '5LLM2.1E.NEP.V.A';
    const M3 = '5LLM3a.1E.NEP.V.A';
    const VOL = '000007WQ';

    const scbUrl = 'https://statistikdatabasen.scb.se/api/v2/tables/TAB6541/data' +
      `?lang=en&outputFormat=json-stat2` +
      `&valueCodes[Penningm]=${encodeURIComponent(M1)},${encodeURIComponent(M2)},${encodeURIComponent(M3)}` +
      `&valueCodes[ContentsCode]=${VOL}` +
      `&valueCodes[Tid]=top(1)`;

    const r = await fetch(scbUrl);
    if (!r.ok) throw new Error('SCB ' + r.status + ': ' + await r.text().then(t => t.slice(0, 300)));
    const data = await r.json();

    const rows = parseScbData(data);
    const latest = rows.length > 0 ? rows[rows.length - 1] : null;

    if (latest) {
      await redis.hset(`riksbank:${latest.period}`, {
        m1: latest.m1,
        m2: latest.m2,
        m3: latest.m3,
      });
    }

    const storedKeys = await redis.keys('riksbank:*');
    storedKeys.sort();
    const history = { m1: [], m2: [], m3: [] };
    for (const key of storedKeys) {
      const entry = await redis.hgetall(key);
      const period = key.replace('riksbank:', '');
      if (entry && entry.m1) history.m1.push({ period, value: parseFloat(entry.m1) });
      if (entry && entry.m2) history.m2.push({ period, value: parseFloat(entry.m2) });
      if (entry && entry.m3) history.m3.push({ period, value: parseFloat(entry.m3) });
    }

    const sort = arr => arr.sort((a, b) => a.period.localeCompare(b.period));
    res.json({
      success: true,
      data: { m1: sort(history.m1), m2: sort(history.m2), m3: sort(history.m3) },
      source: 'live',
      periods_stored: storedKeys.length,
    });
  } catch (e) {
    console.error('Riksbank error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Seed endpoint ────────────────────────────────────────────────────────────

app.get('/api/seed', async (req, res) => {
  try {
    const M1 = '5LLM1.1E.NEP.V.A';
    const M2 = '5LLM2.1E.NEP.V.A';
    const M3 = '5LLM3a.1E.NEP.V.A';
    const VOL = '000007WQ';

    const scbUrl = 'https://statistikdatabasen.scb.se/api/v2/tables/TAB6541/data' +
      `?lang=en&outputFormat=json-stat2` +
      `&valueCodes[Penningm]=${encodeURIComponent(M1)},${encodeURIComponent(M2)},${encodeURIComponent(M3)}` +
      `&valueCodes[ContentsCode]=${VOL}` +
      `&valueCodes[Tid]=*`;

    const r = await fetch(scbUrl);
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`SCB ${r.status}: ${errText.slice(0, 500)}`);
    }
    const data = await r.json();
    const rows = parseScbData(data);

    if (rows.length === 0) {
      return res.json({ success: false, message: 'SCB returned 0 rows.' });
    }

    let written = 0;
    for (const row of rows) {
      await redis.hset(`riksbank:${row.period}`, { m1: row.m1, m2: row.m2, m3: row.m3 });
      written++;
    }

    res.json({
      success: true,
      message: `Seed complete. Wrote ${written} periods to Redis.`,
      seeded: written,
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
    const keys = await redis.keys('riksbank:*');
    for (const key of keys) { await redis.del(key); }
    res.json({ success: true, wiped: keys.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Debug endpoint ───────────────────────────────────────────────────────────

app.get('/api/scb-debug', async (req, res) => {
  try {
    const M1 = '5LLM1.1E.NEP.V.A';
    const M2 = '5LLM2.1E.NEP.V.A';
    const M3 = '5LLM3a.1E.NEP.V.A';
    const VOL = '000007WQ';
    const url = 'https://statistikdatabasen.scb.se/api/v2/tables/TAB6541/data' +
      `?lang=en&outputFormat=json-stat2` +
      `&valueCodes[Penningm]=${encodeURIComponent(M1)},${encodeURIComponent(M2)},${encodeURIComponent(M3)}` +
      `&valueCodes[ContentsCode]=${VOL}` +
      `&valueCodes[Tid]=top(3)`;
    const r = await fetch(url);
    const text = await r.text();
    res.set('Content-Type', 'application/json');
    res.send(text);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Status endpoint ──────────────────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
  try {
    const keys = await redis.keys('riksbank:*');
    keys.sort();
    res.json({
      redisKeys: keys.length,
      firstPeriod: keys[0] ? keys[0].replace('riksbank:', '') : null,
      lastPeriod: keys[keys.length - 1] ? keys[keys.length - 1].replace('riksbank:', '') : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
