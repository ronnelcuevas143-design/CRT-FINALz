export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');

  const { type, symbol, token, chat_id, text, limit } = req.query;
  const CC_KEY = process.env.CC_KEY || '108f8dee474443ab7206e517aea0e597477076d507e0db140dd60c29b21d7dae';

  try {
    let url, response, data;

    // Telegram
    if (type === 'telegram') {
      url = `https://api.telegram.org/bot${token}/sendMessage`;
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id, text, parse_mode: 'HTML' })
      });
      return res.status(200).json(await response.json());
    }

    const sym = (symbol || 'BTC').toUpperCase();
    const BASE = 'https://min-api.cryptocompare.com/data/v2';
    const lim = limit || 100;
    const headers = { 'Accept': 'application/json', 'authorization': `Apikey ${CC_KEY}` };

    if      (type === '1h')    url = `${BASE}/histohour?fsym=${sym}&tsym=USD&limit=${lim}`;
    else if (type === '4h')    url = `${BASE}/histohour?fsym=${sym}&tsym=USD&limit=${lim}&aggregate=4`;
    else if (type === '1d')    url = `${BASE}/histoday?fsym=${sym}&tsym=USD&limit=${lim}`;
    else if (type === '1w')    url = `${BASE}/histoday?fsym=${sym}&tsym=USD&limit=56&aggregate=7`;
    else if (type === '1mo')   url = `${BASE}/histoday?fsym=${sym}&tsym=USD&limit=24&aggregate=30`;
    else if (type === 'price') url = `https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${sym}&tsyms=USD`;
    else if (type === 'top50') url = `https://min-api.cryptocompare.com/data/top/totalvolfull?limit=50&tsym=USD`;
    else if (type === 'top100') url = `https://min-api.cryptocompare.com/data/top/totalvolfull?limit=100&tsym=USD`;
    else return res.status(400).json({ error: 'Invalid type' });

    response = await fetch(url, { headers });
    if (!response.ok) return res.status(response.status).json({ error: `API ${response.status}` });
    data = await response.json();
    if (data.Response === 'Error') return res.status(400).json({ error: data.Message });
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
