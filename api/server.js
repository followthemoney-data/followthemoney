const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors());

let cache = {};

async function fetchWithCache(key, url, ttlMinutes = 60) {
  const now = Date.now();
  if (cache[key] && now - cache[key].timestamp < ttlMinutes * 60 * 1000) {
    return cache[key].data;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error('Failed to fetch ' + url);
  const data = await response.json();
  cache[key] = { data, timestamp: now };
  return data;
}

app.get('/api/ecb', async (req, res) => {
  try {
    const series = ['M10', 'M20', 'M30'];
    const results = {};
    for (const s of series) {
      const url = `https://data-api.ecb.europa.eu/service/data/BSI/M.U2.Y.V.${s}.X.1.U2.2300.Z01.E?format=jsondata&lastNObservations=13`;
      const data = await fetchWithCache('ecb_' + s, url);
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
    const body = {
      query: [
        { code: "Tillgångsslag", selection: { filter: "item", values: ["M1","M2","M3"] } },
        { code: "ContentsCode", selection: { filter: "item", values: ["FM0201AA"] } },
        { code: "Tid", selection: { filter: "top", values: ["13"] } }
      ],
      response: { format: "json" }
    };
    const response = await fetch('https://api.scb.se/OV0104/v1/doris/en/ssd/START/FM/FM0201/FM0201A/MoneySupplyM3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error('SCB API error');
    const raw = await response.json();
    const m1 = [], m2 = [], m3 = [];
    raw.data.forEach(row => {
      const entry = { period: row.key[2], value: parseFloat(row.values[0]) };
      if (row.key[0] === 'M1') m1.push(entry);
      else if (row.key[0] === 'M2') m2.push(entry);
      else if (row.key[0] === 'M3') m3.push(entry);
    });
    const sort = arr => arr.sort((a, b) => a.period.localeCompare(b.period));
    res.json({ success: true, data: { m1: sort(m1), m2: sort(m2), m3: sort(m3) } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
