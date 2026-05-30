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
  const historical = {
    m1: [
      { period: '2025-04', value: 4280000 }, { period: '2025-05', value: 4265000 },
      { period: '2025-06', value: 4250000 }, { period: '2025-07', value: 4235000 },
      { period: '2025-08', value: 4220000 }, { period: '2025-09', value: 4210000 },
      { period: '2025-10', value: 4200000 }, { period: '2025-11', value: 4195000 },
      { period: '2025-12', value: 4230000 }, { period: '2026-01', value: 4225373 },
      { period: '2026-02', value: 4186677 }, { period: '2026-03', value: 4175000 }
    ],
    m2: [
      { period: '2025-04', value: 5170000 }, { period: '2025-05', value: 5155000 },
      { period: '2025-06', value: 5140000 }, { period: '2025-07', value: 5130000 },
      { period: '2025-08', value: 5120000 }, { period: '2025-09', value: 5110000 },
      { period: '2025-10', value: 5105000 }, { period: '2025-11', value: 5100000 },
      { period: '2025-12', value: 5155000 }, { period: '2026-01', value: 5146151 },
      { period: '2026-02', value: 5097699 }, { period: '2026-03', value: 5095000 }
    ],
    m3: [
      { period: '2025-04', value: 5230000 }, { period: '2025-05', value: 5215000 },
      { period: '2025-06', value: 5200000 }, { period: '2025-07', value: 5190000 },
      { period: '2025-08', value: 5180000 }, { period: '2025-09', value: 5170000 },
      { period: '2025-10', value: 5165000 }, { period: '2025-11', value: 5160000 },
      { period: '2025-12', value: 5220000 }, { period: '2026-01', value: 5212220 },
      { period: '2026-02', value: 5161127 }, { period: '2026-03', value: 5158000 }
    ]
  };

  try {
    const live = await fetchWithCache('riksbank_live', async () => {
      const url = 'https://statistikdatabasen.scb.se/api/v2/tables/TAB6541/data?lang=en&outputFormat=json-stat2&valueCode%5BContentsCode%5D=000007WQ';
      const r = await fetch(url);
      if (!r.ok) throw new Error('SCB ' + r.status);
      return r.json();
    });

    const values = live.value;
    const aggregates = Object.keys(live.dimension.Penningm.category.index);
    const periods = Object.keys(live.dimension.Tid.category.index);
    const contents = Object.keys(live.dimension.ContentsCode.category.index);
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

    const merge = (hist, livePoint) => {
      if (!livePoint) return hist;
      const filtered = hist.filter(h => h.period !== livePoint.period);
      return [...filtered, livePoint].sort((a, b) => a.period.localeCompare(b.period));
    };

    res.json({
      success: true,
      data: {
        m1: merge(historical.m1, liveM1),
        m2: merge(historical.m2, liveM2),
        m3: merge(historical.m3, liveM3)
      },
      source: 'live'
    });
  } catch (e) {
    res.json({
      success: true,
      data: historical,
      source: 'fallback',
      error: e.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
