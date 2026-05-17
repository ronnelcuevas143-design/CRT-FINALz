// ============================================================
// CRT Scanner - GitHub Actions Direct Script
// Runs every hour - scans Top 50 coins
// Sends Telegram ONLY for valid Grade A/B/C setups
// ============================================================

const CC_KEY   = process.env.CC_KEY   || '108f8dee474443ab7206e517aea0e597477076d507e0db140dd60c29b21d7dae';
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT  = process.env.TG_CHAT_ID;

const STABLES  = ['USDT','USDC','BUSD','DAI','TUSD','FDUSD','USDE','USDS'];
const CC_BASE  = 'https://min-api.cryptocompare.com/data/v2';
const CC_HEADS = { 'Accept':'application/json', 'authorization':`Apikey ${CC_KEY}` };

const TIMEFRAMES = [
  { key:'1mo', label:'Monthly', weight:5 },
  { key:'1w',  label:'Weekly',  weight:4 },
  { key:'1d',  label:'Daily',   weight:3 },
  { key:'4h',  label:'4H',      weight:2 },
  { key:'1h',  label:'1H',      weight:1 },
];

// ---- HELPERS ----
function fp(p) {
  if (!p && p !== 0) return '—';
  if (p >= 10000) return '$' + p.toLocaleString('en', {maximumFractionDigits:0});
  if (p >= 1)     return '$' + p.toFixed(2);
  if (p >= 0.01)  return '$' + p.toFixed(4);
  return '$' + p.toFixed(8);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- FETCH ----
async function fetchOHLC(symbol, type) {
  const urls = {
    '1h':  `${CC_BASE}/histohour?fsym=${symbol}&tsym=USD&limit=100`,
    '4h':  `${CC_BASE}/histohour?fsym=${symbol}&tsym=USD&limit=100&aggregate=4`,
    '1d':  `${CC_BASE}/histoday?fsym=${symbol}&tsym=USD&limit=100`,
    '1w':  `${CC_BASE}/histoday?fsym=${symbol}&tsym=USD&limit=56&aggregate=7`,
    '1mo': `${CC_BASE}/histoday?fsym=${symbol}&tsym=USD&limit=24&aggregate=30`,
  };
  const res  = await fetch(urls[type], { headers: CC_HEADS });
  const data = await res.json();
  if (data.Response === 'Error') throw new Error(data.Message);
  return (data.Data?.Data || [])
    .map(k => ({ t:k.time*1000, o:k.open, h:k.high, l:k.low, c:k.close, v:k.volumefrom }))
    .filter(c => c.h > 0 && c.l > 0);
}

async function fetchTop50() {
  const res  = await fetch('https://min-api.cryptocompare.com/data/top/totalvolfull?limit=50&tsym=USD', { headers: CC_HEADS });
  const data = await res.json();
  return (data.Data || []).map(d => d.CoinInfo?.Name).filter(s => s && !STABLES.includes(s));
}

async function fetchPrice(symbol) {
  const res  = await fetch(`https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${symbol}&tsyms=USD`, { headers: CC_HEADS });
  const data = await res.json();
  const info = data.RAW?.[symbol]?.USD;
  return info ? { price: info.PRICE, change24h: info.CHANGEPCT24HOUR } : null;
}

// ---- HTF BIAS ----
function getTrend(candles) {
  if (candles.length < 6) return 'neutral';
  const last5 = candles.slice(-5);
  const prev5 = candles.slice(-10, -5);
  if (!prev5.length) return 'neutral';
  const avgLast = last5.reduce((a,b) => a+b.c, 0) / last5.length;
  const avgPrev = prev5.reduce((a,b) => a+b.c, 0) / prev5.length;
  if (avgLast > avgPrev * 1.02) return 'bull';
  if (avgLast < avgPrev * 0.98) return 'bear';
  return 'neutral';
}

function getHTFBias(monthlyC, weeklyC) {
  const m = getTrend(monthlyC);
  const w = getTrend(weeklyC);
  if (m === w && m !== 'neutral') return m;
  if (m !== 'neutral') return m;
  if (w !== 'neutral') return w;
  return 'neutral';
}

// ---- POI DETECTION ----
function detectPOIs(candles) {
  const pois = [];
  for (let i = 5; i < candles.length - 3; i++) {
    const c    = candles[i];
    const next = candles[i+1];
    const body = Math.abs(c.c - c.o);
    const range = (c.h - c.l) || 0.0001;
    const avgBody = candles.slice(Math.max(0,i-5), i)
      .reduce((a,b) => a + Math.abs(b.c-b.o), 0) / 5 || 0.0001;

    // Order Block
    if (body >= avgBody * 1.2) {
      if (c.c < c.o && next.c > c.h)
        pois.push({ type:'bull', kind:'OB', high:c.h, low:c.l, mid:(c.h+c.l)/2 });
      if (c.c > c.o && next.c < c.l)
        pois.push({ type:'bear', kind:'OB', high:c.h, low:c.l, mid:(c.h+c.l)/2 });
    }

    // FVG
    if (i >= 1 && i < candles.length - 2) {
      const c0 = candles[i-1], c2 = candles[i+1];
      if (c0.h < c2.l && (c2.l - c0.h) / c0.h > 0.002)
        pois.push({ type:'bull', kind:'FVG', high:c2.l, low:c0.h, mid:(c0.h+c2.l)/2 });
      if (c0.l > c2.h && (c0.l - c2.h) / c2.h > 0.002)
        pois.push({ type:'bear', kind:'FVG', high:c0.l, low:c2.h, mid:(c0.l+c2.h)/2 });
    }

    // Rejection Block
    const uWick = c.h - Math.max(c.o, c.c);
    const lWick = Math.min(c.o, c.c) - c.l;
    if (uWick / range > 0.65)
      pois.push({ type:'bear', kind:'RB', high:c.h, low:Math.max(c.o,c.c), mid:(c.h+Math.max(c.o,c.c))/2 });
    if (lWick / range > 0.65)
      pois.push({ type:'bull', kind:'RB', high:Math.min(c.o,c.c), low:c.l, mid:(Math.min(c.o,c.c)+c.l)/2 });
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
function validateC1(c1, candles, htfBias, pois) {
  const slice   = candles.slice(-15, -1);
  const avgBody = slice.length ? slice.reduce((a,b) => a + Math.abs(b.c-b.o), 0) / slice.length : 0.0001;
  const body    = Math.abs(c1.c - c1.o);
  const range   = (c1.h - c1.l) || 0.0001;
  const isLarge = body >= avgBody * 1.5;
  const notDoji = (body / range) >= 0.4;
  const c1Dir   = c1.c > c1.o ? 'bull' : 'bear';
  const biasOk  = htfBias === 'neutral' || c1Dir === htfBias;
  const poi     = findNearPOI((c1.h+c1.l)/2, pois, htfBias === 'neutral' ? c1Dir : htfBias);
  return { valid: isLarge && notDoji && biasOk && !!poi, poi, direction: c1Dir };
}

// ---- C2 DETECTION ----
function detectC2(c1, c2, htfBias) {
  const c1High = c1.h, c1Low = c1.l;
  const c1Mid  = (c1High + c1Low) / 2;
  const sweptLow  = c2.l < c1Low;
  const sweptHigh = c2.h > c1High;

  let direction = null, sweepPct = 0;
  if ((htfBias === 'bull' || htfBias === 'neutral') && sweptLow) {
    direction = 'bull';
    sweepPct  = ((c1Low - c2.l) / c1Low * 100);
  } else if ((htfBias === 'bear' || htfBias === 'neutral') && sweptHigh) {
    direction = 'bear';
    sweepPct  = ((c2.h - c1High) / c1High * 100);
  }
  if (!direction) return null;

  return {
    direction, sweepPct: sweepPct.toFixed(2),
    c1Mid, c1High, c1Low,
    entryZone: direction === 'bull'
      ? { low: fp(c1Low),  high: fp(c1Mid) }
      : { low: fp(c1Mid),  high: fp(c1High) },
    stopLoss: direction === 'bull' ? fp(c2.l * 0.997) : fp(c2.h * 1.003),
    target:   direction === 'bull' ? fp(c1High) : fp(c1Low),
  };
}

// ---- SCAN ONE TF ----
function scanTF(candles, htfBias) {
  if (candles.length < 6) return { signal:'none' };
  const pois = detectPOIs(candles);

  for (let i = candles.length - 16; i < candles.length - 2; i++) {
    if (i < 1) continue;
    const c1 = candles[i];
    const c2 = candles[i+1]; // closed candle

    const c1v = validateC1(c1, candles.slice(0, i+1), htfBias, pois);
    if (!c1v.valid) continue;

    const c2s = detectC2(c1, c2, htfBias);
    if (!c2s) continue;

    return {
      signal:    'c2closed',
      direction: c2s.direction,
      c1v, c2s,
      pois: pois.filter(p => p.type === c2s.direction).slice(-2),
    };
  }
  return { signal: 'none' };
}

// ---- GRADE ----
function computeGrade(tfResults) {
  const WEIGHTS = [5, 4, 3, 2, 1];
  let bullScore = 0, bearScore = 0;
  const bullTFs = [], bearTFs = [];
  const c2TFs   = { bull: [], bear: [] };

  tfResults.forEach((r, i) => {
    if (!r || r.signal !== 'c2closed') return;
    const w  = WEIGHTS[i];
    const tf = TIMEFRAMES[i];
    if (r.direction === 'bull') { bullScore += w; bullTFs.push(tf.label); c2TFs.bull.push(tf.label); }
    if (r.direction === 'bear') { bearScore += w; bearTFs.push(tf.label); c2TFs.bear.push(tf.label); }
  });

  const direction  = bullScore >= bearScore ? 'bull' : 'bear';
  const score      = Math.max(bullScore, bearScore);
  const alignedTFs = direction === 'bull' ? bullTFs : bearTFs;
  const sweepTFs   = direction === 'bull' ? c2TFs.bull : c2TFs.bear;

  if (alignedTFs.length < 2) return null;

  let grade = null;
  if      (score >= 9 && alignedTFs.length >= 3) grade = 'A';
  else if (score >= 6 && alignedTFs.length >= 3) grade = 'B';
  else if (score >= 4 && alignedTFs.length >= 2) grade = 'C';

  if (!grade) return null;

  // Must have at least Weekly or Monthly aligned
  const hasHTF = alignedTFs.includes('Monthly') || alignedTFs.includes('Weekly');
  if (!hasHTF) return null;

  return { grade, direction, score, alignedTFs, sweepTFs };
}

// ---- SEND TELEGRAM ----
async function sendTelegram(message) {
  if (!TG_TOKEN || !TG_CHAT) { console.log('No Telegram credentials'); return; }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: TG_CHAT, text: message, parse_mode: 'HTML' }),
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram error:', data.description);
    else console.log('✅ Alert sent to Telegram');
  } catch (e) {
    console.error('Telegram error:', e.message);
  }
}

// ---- FORMAT ALERT ----
function formatAlert(symbol, gradeResult, tfResults, priceInfo) {
  const { grade, direction, alignedTFs, sweepTFs } = gradeResult;
  const emoji      = direction === 'bull' ? '🟢' : '🔴';
  const gradeEmoji = grade === 'A' ? '🏆' : grade === 'B' ? '🥈' : '🥉';
  const dirLabel   = direction === 'bull' ? 'BULL CRT' : 'BEAR CRT';
  const sweepDir   = direction === 'bull' ? 'below C1 low' : 'above C1 high';
  const now        = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });

  const best = tfResults.find(r => r?.signal === 'c2closed' && r?.direction === direction);
  const poi  = best?.pois?.[0];
  const tvLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}USDT`;

  const priceStr = priceInfo ? `${fp(priceInfo.price)} (${priceInfo.change24h >= 0 ? '+' : ''}${priceInfo.change24h?.toFixed(2)}%)` : '—';

  return `${emoji} ${gradeEmoji} <b>GRADE ${grade} ${dirLabel} ALERT!</b>

📊 <b>${symbol}/USDT</b>
💰 Price: ${priceStr}
⏰ ${now}

<b>Top-Down Alignment:</b>
${alignedTFs.map(tf => `✅ ${tf}`).join('\n')}

⚡ <b>C2 Swept ${sweepDir} on: ${sweepTFs.join(', ')}</b>
📉 Sweep: ${best?.c2s?.sweepPct}%

${poi ? `🎯 POI: ${poi.kind} ${fp(poi.low)}–${fp(poi.high)}\n` : ''}
<b>Entry Details:</b>
📥 Entry: ${best?.c2s?.entryZone?.low} – ${best?.c2s?.entryZone?.high}
🛑 SL: ${best?.c2s?.stopLoss}
💰 Target: ${best?.c2s?.target}

📈 <a href="${tvLink}">View on TradingView</a>

⚠️ <i>C3 pa lang forming — confirm muna sa chart bago mag-entry. Educational only.</i>`;
}

// ---- MAIN ----
async function main() {
  console.log('🔍 CRT Scanner starting...');
  console.log(`⏰ ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}`);

  try {
    const symbols = await fetchTop50();
    console.log(`📊 Scanning ${symbols.length} coins...`);

    const validSetups  = [];
    const alertsSent   = new Set();

    // Scan in batches of 5
    for (let i = 0; i < symbols.length; i += 5) {
      const batch = symbols.slice(i, i + 5);

      await Promise.all(batch.map(async symbol => {
        try {
          // Fetch all 5 TFs
          const allCandles = await Promise.all(
            TIMEFRAMES.map(tf => fetchOHLC(symbol, tf.key).catch(() => []))
          );

          const htfBias    = getHTFBias(allCandles[0], allCandles[1]);
          const tfResults  = allCandles.map((c, i) => c.length > 5 ? scanTF(c, htfBias) : { signal:'none' });
          const gradeResult = computeGrade(tfResults);

          if (!gradeResult) {
            console.log(`  ⚪ ${symbol} — no valid setup`);
            return;
          }

          console.log(`  ${gradeResult.direction === 'bull' ? '🟢' : '🔴'} ${symbol} — Grade ${gradeResult.grade} ${gradeResult.direction.toUpperCase()} CRT`);
          console.log(`     C2 swept on: ${gradeResult.sweepTFs.join(', ')}`);

          validSetups.push({ symbol, gradeResult });

          // Send alert (no duplicates per run)
          const alertKey = `${symbol}-${gradeResult.direction}-${gradeResult.grade}`;
          if (!alertsSent.has(alertKey)) {
            alertsSent.add(alertKey);
            const priceInfo = await fetchPrice(symbol).catch(() => null);
            const message   = formatAlert(symbol, gradeResult, tfResults, priceInfo);
            await sendTelegram(message);
            await delay(800);
          }

        } catch (e) {
          console.log(`  ❌ ${symbol} — ${e.message}`);
        }
      }));

      // Delay between batches
      if (i + 5 < symbols.length) await delay(1500);
    }

    // Summary
    console.log(`\n✅ Scan complete!`);
    console.log(`📊 Scanned: ${symbols.length} coins`);
    console.log(`🎯 Valid setups: ${validSetups.length}`);

    if (validSetups.length === 0) {
      const now = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
      await sendTelegram(`⚪ <b>CRT Scan Complete</b>\n\n📊 ${symbols.length} coins scanned\n⏰ ${now}\n\nWalang valid Grade A/B/C CRT setup ngayon.\nSusunod na scan: 1 hour.`);
    }

  } catch (err) {
    console.error('❌ Scanner error:', err.message);
    await sendTelegram(`❌ CRT Scanner error: ${err.message}`);
    process.exit(1);
  }
}

main();
