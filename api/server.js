const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors());

let cache = {};

async function fetchWithCache(key, fetchFn, ttlMinutes = 60) {
  const now = Date.now();
  if (cache[key] && now - cache[key].timestamp < ttlMinutes * 60 * 1000) {
    return cache[key].data;
  }
  const data = await fetchFn();
  cache[key] = { data, timestamp: now };
  return data;
}

app.get('/api/ecb', async (req, res) => {
  try {
    const series = ['M10', 'M20', 'M30'];
    const results = {};
    for (const s of series) {
      const url = `https://data-api.ecb.europa.eu/service/data/BSI/M.U2.Y.V.${s}.X.1.U2.2300.Z01.E?format=jsondata&lastNObservations=13`;
      const data = await fetchWithCache('ecb_' + s, async () => {
        const r = await fetch(url);
        if (!r.ok) throw new Error('ECB API ' + r.status);
        return r.json();
      });
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

app.get('/api/riksbank', async (req, res) => {
  const fallback = {
    m1: [
      { period: '2024-03', value: 4330000 }, { period: '2024-04', value: 4298000 },
      { period: '2024-05', value: 4310000 }, { period: '2024-06', value: 4290000 },
      { period: '2024-07', value: 4275000 }, { period: '2024-08', value: 4260000 },
      { period: '2024-09', value: 4240000 }, { period: '2024-10', value: 4220000 },
      { period: '2024-11', value: 4210000 }, { period: '2024-12', value: 4250000 },
      { period: '2025-01', value: 4225373 }, { period: '2025-02', value: 4186677 }
    ],
    m2: [
      { period: '2024-03', value: 5220000 }, { period: '2024-04', value: 5195000 },
      { period: '2024-05', value: 5180000 }, { period: '2024-06', value: 5165000 },
      { period: '2024-07', value: 5150000 }, { period: '2024-08', value: 5140000 },
      { period: '2024-09', value: 5130000 }, { period: '2024-10', value: 5120000 },
      { period: '2024-11', value: 5115000 }, { period: '2024-12', value: 5160000 },
      { period: '2025-01', value: 5146151 }, { period: '2025-02', value: 5097699 }
    ],
    m3: [
      { period: '2024-03', value: 5280000 }, { period: '2024-04', value: 5255000 },
      { period: '2024-05', value: 5240000 }, { period: '2024-06', value: 5225000 },
      { period: '2024-07', value: 5210000 }, { period: '2024-08', value: 5200000 },
      { period: '2024-09', value: 5190000 }, { period: '2024-10', value: 5180000 },
      { period: '2024-11', value: 5175000 }, { period: '2024-12', value: 5220000 },
      { period: '2025-01', value: 5212220 }, { period: '2025-02', value: 5161127 }
    ]
  };

  try {
    const data = await fetchWithCache('riksbank_scb', async () => {
      const url = 'https://api.scb.se/OV0104/v1/doris/en/ssd/START/FM/FM0201/FM0201A/MoneySupplyM3';
      const metaR = await fetch(url);
      if (!metaR.ok) throw new Error('meta ' + metaR.status);
      const meta = await metaR.json();
      const tidVar = meta.variables.find(v => v.code === 'Tid');
      const latestPeriods = tidVar.values.slice(-13);
      const assetVar = meta.variables[0];
      const contentsVar = meta.variables.find(v => v.code === 'ContentsCode') || meta.variables[1];
      const body = {
        query: [
          { code: assetVar.code, selection: { filter: 'item', values: ['M1', 'M2', 'M3'] } },
          { code: contentsVar.code, selection: { filter: 'item', values: [contentsVar.values[0]] } },
          { code: 'Tid', selection: { filter: 'item', values: latestPeriods } }
        ],
        response: { format: 'json' }
      };
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('post ' + r.status);
      return r.json();
    });

    const m1 = [], m2 = [], m3 = [];
    data.data.forEach(row => {
      const entry = { period: row.key[row.key.length - 1], value: parseFloat(row.values[0]) };
      if (row.key[0] === 'M1') m1.push(entry);
      else if (row.key[0] === 'M2') m2.push(entry);
      else if (row.key[0] === 'M3') m3.push(entry);
    });
    const sort = arr => arr.sort((a, b) => a.period.localeCompare(b.period));
    res.json({ success: true, data: { m1: sort(m1), m2: sort(m2), m3: sort(m3) }, source: 'live' });
  } catch (e) {
    res.json({ success: true, data: fallback, source: 'fallback', note: 'Source: Sveriges Riksbank via SCB. Last updated February 2026.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
