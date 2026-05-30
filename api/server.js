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
    const data = await fetchWithCache('riksbank_v2', async () => {
      const metaUrl = 'https://statistikdatabasen.scb.se/api/v2/en/tables/TAB6541';
      const metaR = await fetch(metaUrl);
      if (!metaR.ok) throw new Error('meta ' + metaR.status + ' ' + await metaR.text().then(t=>t.slice(0,100)));
      const meta = await metaR.json();
      return { meta };
    });
    res.json({ success: true, meta: data.meta });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
