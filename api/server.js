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
  try {
    const data = await fetchWithCache('riksbank_v2_get', async () => {
      const url = 'https://statistikdatabasen.scb.se/api/v2/tables/TAB6541/data?lang=en&outputFormat=json-stat2';
      const r = await fetch(url);
      if (!r.ok) throw new Error('SCB ' + r.status);
      return r.json();
    });

    const values = data.value;
    const periods = Object.keys(data.dimension.Tid.category.index);
    const aggregates = Object.keys(data.dimension.Penningar.category.index);
    const contentCodes = Object.keys(data.dimension.ContentsCode.category.index);
    const nPeriods = periods.length;
    const nAggregates = aggregates.length;
    const nContents = contentCodes.length;

    const m1 = [], m2 = [], m3 = [];

    for (let p = 0; p < nPeriods; p++) {
      for (let a = 0; a < nAggregates; a++) {
        for (let c = 0; c < nContents; c++) {
          const idx = p * nAggregates * nContents + a * nContents + c;
          const contentCode = contentCodes[c];
          if (contentCode !== 'FM0201AA') continue;
          const period = periods[p].replace('M', '-');
          const value = values[idx];
          const agg = aggregates[a];
          const entry = { period, value };
          if (agg === 'M1') m1.push(entry);
          else if (agg === 'M2') m2.push(entry);
          else if (agg === 'M3') m3.push(entry);
        }
      }
    }

    const sort = arr => arr.sort((a, b) => a.period.localeCompare(b.period));
    const latest13 = arr => arr.slice(-13);
    res.json({ success: true, data: { m1: latest13(sort(m1)), m2: latest13(sort(m2)), m3: latest13(sort(m3)) }, source: 'live' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
