// ============================================================
// CRT Scanner - Vercel Cron Job
// Runs every hour automatically - scans Top 50 coins
// Sends Telegram alert ONLY for Grade A/B/C valid setups
// ============================================================

const CC_KEY = process.env.CC_KEY || '108f8dee474443ab7206e517aea0e597477076d507e0db140dd60c29b21d7dae';
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// Track sent alerts per session - avoid duplicates
const sentAlerts = new Set();

const TIMEFRAMES = [
  { key: '1mo', label: 'Monthly', weight: 5 },
  { key: '1w',  label: 'Weekly',  weight: 4 },
  { key: '1d',  label: 'Daily',   weight: 3 },
  { key: '4h',  label: '4H',      weight: 2 },
  { key: '1h',  label: '1H',      weight: 1 },
];

// ---- FETCH ----
async function fetchOHLC(symbol, type) {
  const BASE = 'https://min-api.cryptocompare.com/data/v2';
  const h = { 'Accept': 'application/json', 'authorization': `Apikey ${CC_KEY}` };
  const urls = {
    '1h':  `${BASE}/histohour?fsym=${symbol}&tsym=USD&limit=100`,
    '4h':  `${BASE}/histohour?fsym=${symbol}&tsym=USD&limit=100&aggregate=4`,
    '1d':  `${BASE}/histoday?fsym=${symbol}&tsym=USD&limit=100`,
    '1w':  `${BASE}/histoday?fsym=${symbol}&tsym=USD&limit=56&aggregate=7`,
    '1mo': `${BASE}/histoday?fsym=${symbol}&tsym=USD&limit=24&aggregate=30`,
  };
  const res = await fetch(urls[type], { headers: h });
  const data = await res.json();
  if (data.Response === 'Error') throw new Error(data.Message);
  return (data.Data?.Data || [])
    .map(k => ({ t: k.time*1000, o: k.open, h: k.high, l: k.low, c: k.close, v: k.volumefrom }))
    .filter(c => c.h > 0 && c.l > 0);
}

async function fetchTop(limit = 50) {
  const h = { 'Accept': 'application/json', 'authorization': `Apikey ${CC_KEY}` };
  const res = await fetch(`https://min-api.cryptocompare.com/data/top/totalvolfull?limit=${limit}&tsym=USD`, { headers: h });
  const data = await res.json();
  const STABLES = ['USDT','USDC','BUSD','DAI','TUSD','FDUSD','USDE','USDS'];
  return (data.Data || [])
    .map(d => d.CoinInfo?.Name)
    .filter(s => s && !STABLES.includes(s));
}

async function fetchPrice(symbol) {
  const h = { 'Accept': 'application/json', 'authorization': `Apikey ${CC_KEY}` };
  const res = await fetch(`https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${symbol}&tsyms=USD`, { headers: h });
  const data = await res.json();
  const info = data.RAW?.[symbol]?.USD;
  return info ? { price: info.PRICE, change24h: info.CHANGEPCT24HOUR } : null;
}

// ---- HTF BIAS ----
function getHTFBias(monthlyC, weeklyC) {
  function dir(candles) {
    if (candles.length < 5) return 'neutral';
    const last5  = candles.slice(-5);
    const prev5  = candles.slice(-10, -5);
    const avgLast = last5.reduce((a,b) => a+b.c, 0) / last5.length;
    const avgPrev = prev5.reduce((a,b) => a+b.c, 0) / prev5.length;
    if (avgLast > avgPrev * 1.02) return 'bull';
    if (avgLast < avgPrev * 0.98) return 'bear';
    return 'neutral';
  }
  const m = dir(monthlyC);
  const w = dir(weeklyC);
  if (m === w && m !== 'neutral') return m;
  if (m !== 'neutral') return m;
  if (w !== 'neutral') return w;
  return 'neutral';
}

// ---- POI DETECTION ----
function detectPOIs(candles) {
  const pois = [];
  const len = candles.length;

  for (let i = 5; i < len - 3; i++) {
    const c = candles[i];
    const prev = candles[i-1];
    const next = candles[i+1];
    const body = Math.abs(c.c - c.o);
    const range = c.h - c.l || 0.0001;
    const avgBody = candles.slice(Math.max(0,i-5),i)
      .reduce((a,b) => a + Math.abs(b.c - b.o), 0) / 5;

    // Order Block — significant candle before impulse move
    if (body >= avgBody * 1.2) {
      // Bullish OB: bearish candle before bullish move
      if (c.c < c.o && next.c > c.h) {
        pois.push({ type:'bull', kind:'OB', high:c.h, low:c.l, mid:(c.h+c.l)/2 });
      }
      // Bearish OB: bullish candle before bearish move
      if (c.c > c.o && next.c < c.l) {
        pois.push({ type:'bear', kind:'OB', high:c.h, low:c.l, mid:(c.h+c.l)/2 });
      }
    }

    // FVG — Fair Value Gap (3-candle imbalance)
    if (i >= 1 && i < len - 2) {
      const c0 = candles[i-1];
      const c2 = candles[i+1];
      if (c0.h < c2.l && (c2.l - c0.h) / c0.h > 0.003) {
        pois.push({ type:'bull', kind:'FVG', high:c2.l, low:c0.h, mid:(c0.h+c2.l)/2 });
      }
      if (c0.l > c2.h && (c0.l - c2.h) / c2.h > 0.003) {
        pois.push({ type:'bear', kind:'FVG', high:c0.l, low:c2.h, mid:(c0.l+c2.h)/2 });
      }
    }

    // Rejection Block — large wick candle
    const upperWick = c.h - Math.max(c.o, c.c);
    const lowerWick = Math.min(c.o, c.c) - c.l;
    if (upperWick / range > 0.65) {
      pois.push({ type:'bear', kind:'RB', high:c.h, low:Math.max(c.o,c.c), mid:(c.h+Math.max(c.o,c.c))/2 });
    }
    if (lowerWick / range > 0.65) {
      pois.push({ type:'bull', kind:'RB', high:Math.min(c.o,c.c), low:c.l, mid:(Math.min(c.o,c.c)+c.l)/2 });
    }
  }
  return pois.slice(-15);
}

function findNearPOI(price, pois, direction, pct = 0.03) {
  return pois.find(p =>
    (p.type === direction || direction === 'neutral') &&
    Math.abs(price - p.mid) / (p.mid || 1) < pct
  ) || null;
}

// ---- C1 VALIDATION ----
// Valid C1: large body, not doji, clear direction, near POI, aligned with HTF bias
function validateC1(c1, candles, htfBias, pois) {
  const avgBody = candles.slice(-15, -1)
    .reduce((a,b) => a + Math.abs(b.c - b.o), 0) / 14 || 0.0001;
  const body  = Math.abs(c1.c - c1.o);
  const range = (c1.h - c1.l) || 0.0001;
  const bodyRatio = body / range;

  const isLarge    = body >= avgBody * 1.5;          // 1.5x average
  const notDoji    = bodyRatio >= 0.4;               // body = 40%+ of range
  const c1Dir      = c1.c > c1.o ? 'bull' : 'bear';
  const biasOk     = htfBias === 'neutral' || c1Dir === htfBias;
  const poi        = findNearPOI((c1.h + c1.l) / 2, pois, htfBias === 'neutral' ? c1Dir : htfBias);

  return {
    valid: isLarge && notDoji && biasOk && !!poi,
    isLarge, notDoji, biasOk,
    poi,
    direction: c1Dir,
  };
}

// ---- C2 DETECTION ----
// C2 must: sweep C1 high/low AND be a CLOSED candle (not forming)
function detectC2Signal(c1, c2, htfBias) {
  const c1High = c1.h, c1Low = c1.l;
  const c1Mid  = (c1High + c1Low) / 2;

  const sweptLow  = c2.l < c1Low;
  const sweptHigh = c2.h > c1High;

  let direction = null;
  let sweepPct  = 0;

  if ((htfBias === 'bull' || htfBias === 'neutral') && sweptLow) {
    direction = 'bull';
    sweepPct  = ((c1Low - c2.l) / c1Low * 100);
  } else if ((htfBias === 'bear' || htfBias === 'neutral') && sweptHigh) {
    direction = 'bear';
    sweepPct  = ((c2.h - c1High) / c1High * 100);
  }

  if (!direction) return null;

  return {
    direction,
    sweepPct: sweepPct.toFixed(2),
    c1Mid: c1Mid.toFixed(6),
    c1High: c1High.toFixed(6),
    c1Low: c1Low.toFixed(6),
    entryZone: direction === 'bull'
      ? { low: c1Low.toFixed(4), high: c1Mid.toFixed(4) }
      : { low: c1Mid.toFixed(4), high: c1High.toFixed(4) },
    stopLoss: direction === 'bull'
      ? (c2.l * 0.997).toFixed(4)
      : (c2.h * 1.003).toFixed(4),
    target: direction === 'bull'
      ? c1High.toFixed(4)
      : c1Low.toFixed(4),
  };
}

// ---- SCAN ONE TIMEFRAME ----
function scanTF(candles, htfBias) {
  if (candles.length < 6) return { signal: 'none' };

  const pois = detectPOIs(candles);

  // Scan last 15 closed candles for C1-C2 pattern
  // candles[-1] = current forming, candles[-2] = last closed
  for (let i = candles.length - 16; i < candles.length - 2; i++) {
    if (i < 1) continue;
    const c1 = candles[i];
    const c2 = candles[i + 1]; // This is CLOSED (not forming)

    const c1Check = validateC1(c1, candles.slice(0, i + 1), htfBias, pois);
    if (!c1Check.valid) continue;

    const c2Signal = detectC2Signal(c1, c2, htfBias);
    if (!c2Signal) continue;

    // Valid setup found!
    return {
      signal: 'c2closed',
      direction: c2Signal.direction,
      c1Check,
      c2Signal,
      pois: pois.filter(p => p.type === c2Signal.direction).slice(-2),
    };
  }

  return { signal: 'none' };
}

// ---- COMPUTE GRADE ----
function computeGrade(tfResults) {
  const WEIGHTS = [5, 4, 3, 2, 1]; // monthly, weekly, daily, 4h, 1h
  let bullScore = 0, bearScore = 0;
  const bullTFs = [], bearTFs = [];

  tfResults.forEach((r, i) => {
    if (!r || r.signal !== 'c2closed') return;
    const w = WEIGHTS[i];
    const tf = TIMEFRAMES[i];
    if (r.direction === 'bull') { bullScore += w; bullTFs.push(tf.label); }
    if (r.direction === 'bear') { bearScore += w; bearTFs.push(tf.label); }
  });

  const direction = bullScore >= bearScore ? 'bull' : 'bear';
  const score = Math.max(bullScore, bearScore);
  const alignedTFs = direction === 'bull' ? bullTFs : bearTFs;

  // Need at least 2 TFs aligned
  if (alignedTFs.length < 2) return null;

  // Grade A: score >= 9 (Monthly + 2 more)
  // Grade B: score >= 6 (Weekly + Daily + one more)
  // Grade C: score >= 4 (Daily + 4H)
  let grade = null;
  if (score >= 9 && alignedTFs.length >= 3) grade = 'A';
  else if (score >= 6 && alignedTFs.length >= 3) grade = 'B';
  else if (score >= 4 && alignedTFs.length >= 2) grade = 'C';

  if (!grade) return null;

  return { grade, direction, score, alignedTFs };
}

// ---- SEND TELEGRAM ----
async function sendTelegram(message) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.log('No Telegram credentials');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: message, parse_mode: 'HTML' })
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram error:', data.description);
  } catch (e) {
    console.error('Telegram send error:', e.message);
  }
}

// ---- FORMAT ALERT ----
function formatAlert(symbol, gradeResult, tfResults, priceInfo) {
  const { grade, direction, alignedTFs } = gradeResult;
  const emoji = direction === 'bull' ? '🟢' : '🔴';
  const gradeEmoji = grade === 'A' ? '🏆' : grade === 'B' ? '🥈' : '🥉';
  const dirLabel = direction === 'bull' ? 'BULL CRT' : 'BEAR CRT';
  const now = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });

  // Get best TF result for entry details
  const bestIdx = tfResults.findIndex(r => r?.signal === 'c2closed' && r?.direction === direction);
  const best = bestIdx >= 0 ? tfResults[bestIdx] : null;
  const poi = best?.pois?.[0];

  const priceStr = priceInfo ? `$${priceInfo.price?.toFixed(4)}` : '—';
  const chgStr = priceInfo ? `${priceInfo.change24h >= 0 ? '+' : ''}${priceInfo.change24h?.toFixed(2)}%` : '';

  const tvLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}USDT`;

  return `${emoji} ${gradeEmoji} <b>GRADE ${grade} ${dirLabel} ALERT!</b>

📊 Coin: <b>${symbol}/USDT</b>
💰 Price: ${priceStr} ${chgStr}
⏰ Time: ${now}

<b>Top-Down Alignment:</b>
${alignedTFs.map(tf => `✅ ${tf}`).join('\n')}

${poi ? `🎯 Near POI: ${poi.kind} $${poi.low.toFixed ? poi.low.toFixed(4) : poi.low} – $${poi.high.toFixed ? poi.high.toFixed(4) : poi.high}\n` : ''}
<b>Entry Details:</b>
📥 Entry Zone: $${best?.c2Signal?.entryZone?.low} – $${best?.c2Signal?.entryZone?.high}
🛑 Stop Loss: $${best?.c2Signal?.stopLoss}
💰 Target: $${best?.c2Signal?.target}
📉 C2 Swept: ${best?.c2Signal?.sweepPct}%

📈 <a href="${tvLink}">View on TradingView</a>

⚠️ <i>C3 pa lang forming — mag-confirm muna bago mag-entry. Educational purposes lang.</i>`;
}

// ---- MAIN SCAN ----
async function scanCoin(symbol) {
  try {
    // Fetch all 5 TF candles in parallel
    const allCandles = await Promise.all(
      TIMEFRAMES.map(tf => fetchOHLC(symbol, tf.key).catch(() => []))
    );

    // Get HTF bias from Monthly + Weekly
    const htfBias = getHTFBias(allCandles[0], allCandles[1]);

    // Scan each TF
    const tfResults = allCandles.map((candles, i) =>
      candles.length > 5 ? scanTF(candles, htfBias) : { signal: 'none' }
    );

    // Compute grade
    const gradeResult = computeGrade(tfResults);
    if (!gradeResult) return null;

    return { symbol, gradeResult, tfResults, htfBias, allCandles };
  } catch (e) {
    console.log(`Error scanning ${symbol}:`, e.message);
    return null;
  }
}

// ---- HANDLER ----
export default async function handler(req, res) {
  // Auth check for cron
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers['authorization'];
  const isManual = req.query.manual === 'true';

  if (!isManual && cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const scanLimit = parseInt(req.query.limit) || 50;
  console.log(`🔍 CRT Scan started — Top ${scanLimit} coins`);

  try {
    const symbols = await fetchTop(scanLimit);
    console.log(`📊 Scanning ${symbols.length} coins...`);

    const validSetups = [];
    const alertsSent = [];

    // Batch scan — 5 at a time
    for (let i = 0; i < symbols.length; i += 5) {
      const batch = symbols.slice(i, i + 5);
      const results = await Promise.all(batch.map(scanCoin));

      for (const result of results) {
        if (!result) continue;
        const { symbol, gradeResult, tfResults } = result;

        validSetups.push({ symbol, grade: gradeResult.grade, direction: gradeResult.direction });

        // Check duplicate
        const alertKey = `${symbol}-${gradeResult.direction}-${gradeResult.grade}-${new Date().toDateString()}-${new Date().getHours()}`;
        if (sentAlerts.has(alertKey)) continue;
        sentAlerts.add(alertKey);

        // Fetch price for alert
        const priceInfo = await fetchPrice(symbol).catch(() => null);

        // Format and send alert
        const message = formatAlert(symbol, gradeResult, tfResults, priceInfo);
        await sendTelegram(message);
        alertsSent.push({ symbol, grade: gradeResult.grade, direction: gradeResult.direction });

        // Delay between messages
        await new Promise(r => setTimeout(r, 800));
      }

      // Delay between batches
      if (i + 5 < symbols.length) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    // Send summary if no setups found
    if (alertsSent.length === 0) {
      const now = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
      await sendTelegram(`⚪ CRT Scan Complete\n\n📊 ${symbols.length} coins scanned\n⏰ ${now}\n\nWalang valid Grade A/B/C CRT setup ngayon. Mag-a-update ulit sa susunod na hour.`);
    }

    return res.status(200).json({
      success: true,
      scanned: symbols.length,
      validSetups,
      alertsSent,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('Scan error:', err);
    return res.status(500).json({ error: err.message });
  }
}
