const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const { Redis } = require('@upstash/redis');

const app = express();
app.use(cors());

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

app.get('/api/ecb', async (req, res) => {
  try {
    const series = ['M10', 'M20', 'M30'];
    const results = {};
    for (const s of series) {
      const url = `https://data-api.ecb.europa.eu/service/data/BSI/M.U2.Y.V.${s}.X.1.U2.2300.Z01.E?format=jsondata&lastNObservations=13`;
      const r = await fetch(url);
      if (!r.ok) throw new Error('ECB API ' + r.status);
      const data = await r.json();
      const obs = data.dataSets[0].series['0:0:0:0:0:0:0:0:0:0:0'].observations;
      const periods = data.structure.dimensions.observation[0].values;
      const entries = Object.entries(obs)
        .map(([i, v]) => ({ period: periods[+i].id, value: v[0] }))
        .sort((a, b) => a.period.localeCompare(b.period));
      results[s === 'M10' ? 'm1' : s === 'M20' ? 'm2' : 'm3'] = entries;
    }
    res.json({ success: true, data: results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/wipe', async (req, res) => {
  try {
    const keys = await redis.keys('riksbank:*');
    for (const key of keys) {
      await redis.del(key);
    }
    res.json({ success: true, wiped: keys.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/seed', async (req, res) => {
  try {
    const url = 'https://statistikdatabasen.scb.se/api/v2/tables/TAB6541/data?lang=en&outputFormat=json-stat2';
    
    const body = {
      selection: [
        { variableCode: 'ContentsCode', valueCodes: ['000007WQ'] },
        { variableCode: 'Tid', valueCodes: ['*'] }
      ]
    };

    const r = await fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Origin': 'https://statistikdatabasen2.scb.se'
      },
      body: JSON.stringify(body)
    });

    if (!r.ok) throw new Error('SCB POST ' + r.status + ': ' + await r.text().then(t => t.slice(0, 300)));
    const data = await r.json();

    const values = data.value;
    const aggregates = Object.keys(data.dimension.Penningm.category.index);
    const periods = Object.keys(data.dimension.Tid.category.index);
    const contents = Object.keys(data.dimension.ContentsCode.category.index);
    const nAgg = aggregates.length;
    const nPeriods = periods.length;
    const nContents = contents.length;
    const volumeContentIdx = contents.findIndex(c => c === '000007WQ');

    let count = 0;
    for (let p = 0; p < nPeriods; p++) {
      const period = periods[p].replace('M', '-');
      const entry = {};
      for (let a = 0; a < nAgg; a++) {
        const idx = p * nAgg * nContents + a * nContents + volumeContentIdx;
        const value = values[idx];
        if (value === null || value === undefined) continue;
        const agg = aggregates[a];
        if (agg === '5LLM1.1E.NEP.V.A') entry.m1 = value;
        else if (agg === '5LLM2.1E.NEP.V.A') entry.m2 = value;
        else if (agg === '5LLM3a.1E.NEP.V.A') entry.m3 = value;
      }
      if (entry.m1 || entry.m2 || entry.m3) {
        await redis.hset(`riksbank:${period}`, entry);
        count++;
      }
    }

    res.json({ success: true, seeded: count, periods_available: nPeriods });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/riksbank', async (req, res) => {
  try {
    const url = 'https://statistikdatabasen.scb.se/api/v2/tables/TAB6541/data?lang=en&outputFormat=json-stat2&valueCode%5BContentsCode%5D=000007WQ';
    const r = await fetch(url);
    if (!r.ok) throw new Error('SCB ' + r.status);
    const data = await r.json();

    const values = data.value;
    const aggregates = Object.keys(data.dimension.Penningm.category.index);
    const periods = Object.keys(data.dimension.Tid.category.index);
    const contents = Object.keys(data.dimension.ContentsCode.category.index);
    const nAgg = aggregates.length;
    const nPeriods = periods.length;
    const nContents = contents.length;
    const volumeContentIdx = contents.findIndex(c => c === '000007WQ');

    let liveM1, liveM2, liveM3;
    for (let p = 0; p < nPeriods; p++) {
      for (let a = 0; a < nAgg; a++) {
        const idx = p * nAgg * nContents + a * nContents + volumeContentIdx;
        const period = periods[p].replace('M', '-');
        const value = values[idx];
        if (value === null || value === undefined) continue;
        const agg = aggregates[a];
        if (agg === '5LLM1.1E.NEP.V.A') liveM1 = { period, value };
        else if (agg === '5LLM2.1E.NEP.V.A') liveM2 = { period, value };
        else if (agg === '5LLM3a.1E.NEP.V.A') liveM3 = { period, value };
      }
    }

    if (liveM1) await redis.hset(`riksbank:${liveM1.period}`, { m1: liveM1.value, m2: liveM2?.value, m3: liveM3?.value });

    const storedKeys = await redis.keys('riksbank:*');
    const history = { m1: [], m2: [], m3: [] };

    for (const key of storedKeys) {
      const entry = await redis.hgetall(key);
      const period = key.replace('riksbank:', '');
      if (entry.m1) history.m1.push({ period, value: parseFloat(entry.m1) });
      if (entry.m2) history.m2.push({ period, value: parseFloat(entry.m2) });
      if (entry.m3) history.m3.push({ period, value: parseFloat(entry.m3) });
    }

    const sort = arr => arr.sort((a, b) => a.period.localeCompare(b.period));

    res.json({
      success: true,
      data: { m1: sort(history.m1), m2: sort(history.m2), m3: sort(history.m3) },
      source: 'live',
      periods_stored: storedKeys.length
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
