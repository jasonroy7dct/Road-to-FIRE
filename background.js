/** Yahoo Finance chart API — send a desktop User-Agent; bare fetch often gets HTTP 404 in MV3. */

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const FETCH_HEADERS = {
  'User-Agent': DESKTOP_UA,
  Accept: 'application/json,text/plain,*/*',
};

function mapSymbolToYahoo(symbol) {
  const raw = String(symbol || 'VOO').trim();
  const u = raw.toUpperCase();
  if (u === 'BTC') return 'BTC-USD';
  if (/^\d{4,6}[A-Z]?$/.test(u)) return `${u}.TW`;
  if (/^\d{4,6}[A-Z]?\.TW$/i.test(raw.trim())) return raw.trim().toUpperCase();
  return u.replace(/\./g, '-');
}

function extractChartPrice(json) {
  const r = json?.chart?.result?.[0];
  if (!r) return null;
  let price = r.meta?.regularMarketPrice;
  if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
    return { price, name: r.meta?.longName || r.meta?.shortName || '' };
  }
  const closes = r.indicators?.quote?.[0]?.close;
  if (Array.isArray(closes)) {
    for (let i = closes.length - 1; i >= 0; i--) {
      const c = closes[i];
      if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
        return { price: c, name: r.meta?.longName || r.meta?.shortName || '' };
      }
    }
  }
  const meta = r.meta;
  if (meta && typeof meta.previousClose === 'number' && meta.previousClose > 0) {
    return { price: meta.previousClose, name: meta.longName || meta.shortName || '' };
  }
  return null;
}

async function fetchPriceFromYahooChart(yahooSymbol) {
  const bases = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
  let lastErr = null;
  for (const base of bases) {
    const url = `${base}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=5d&interval=1d`;
    try {
      const response = await fetch(url, { headers: FETCH_HEADERS, credentials: 'omit' });
      if (!response.ok) {
        lastErr = new Error(`HTTP ${response.status}`);
        continue;
      }
      const json = await response.json();
      const result = extractChartPrice(json);
      if (result != null) return result; // { price, name }
      lastErr = new Error('No chart result');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Yahoo chart failed');
}

async function fetchChartDataFromYahoo(yahooSymbol) {
  const bases = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
  let lastErr = null;
  for (const base of bases) {
    const url = `${base}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=max&interval=1mo`;
    try {
      const response = await fetch(url, { headers: FETCH_HEADERS, credentials: 'omit' });
      if (!response.ok) {
        lastErr = new Error(`HTTP ${response.status}`);
        continue;
      }
      const json = await response.json();
      const r = json?.chart?.result?.[0];
      if (!r) throw new Error('No chart result');
      const timestamps = r.timestamp || [];
      const closes = r.indicators?.quote?.[0]?.close || [];
      const data = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (typeof closes[i] === 'number') {
          data.push({ time: timestamps[i], price: closes[i] });
        }
      }
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Yahoo chart failed');
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getChartData') {
    const symbol = (request.symbol || 'VOO').trim().toUpperCase();
    const yahooSymbol = mapSymbolToYahoo(symbol);
    const CACHE_KEY = `chart_${symbol}`;
    
    chrome.storage.local.get([CACHE_KEY], async (res) => {
      const data = res[CACHE_KEY];
      const now = Date.now();
      const TTL = 86400000;
      if (data && now - data.timestamp < TTL) {
        sendResponse({ data: data.series, ok: true });
        return;
      }
      try {
        const series = await fetchChartDataFromYahoo(yahooSymbol);
        await chrome.storage.local.set({ [CACHE_KEY]: { series, timestamp: now } });
        sendResponse({ data: series, ok: true });
      } catch (e) {
        const fallback = data?.series || [];
        sendResponse({ data: fallback, ok: fallback.length > 0 });
      }
    });
    return true;
  }

  if (request.action === 'getExchangeRate') {
    const pair = 'TWDUSD=X';
    const CACHE_KEY = 'rate_TWDUSD';
    chrome.storage.local.get([CACHE_KEY], async (res) => {
      const data = res[CACHE_KEY];
      const now = Date.now();
      const TTL = 86400000; // 24 hours for exchange rate
      if (data && now - data.timestamp < TTL) {
        sendResponse({ rate: data.rate, ok: true });
        return;
      }
      try {
        const result = await fetchPriceFromYahooChart(pair);
        const rate = result?.price;
        if (typeof rate !== 'number' || rate <= 0) throw new Error('Invalid rate');
        await chrome.storage.local.set({ [CACHE_KEY]: { rate, timestamp: now } });
        sendResponse({ rate, ok: true });
      } catch (e) {
        const fallback = data?.rate || 0.0308; // Default fallback if fetch fails (~32.5 TWD/USD)
        sendResponse({ rate: fallback, ok: fallback > 0 });
      }
    });
    return true;
  }

  if (request.action === 'openDashboard') {
    const lang = request.lang || 'en';
    chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html?lang=${lang}`) });
    sendResponse({ ok: true });
    return true;
  }

  if (request.action !== 'getPrice') return;

  const raw = (request.symbol || 'VOO').trim();
  const symbol = raw.toUpperCase();
  const yahooSymbol = mapSymbolToYahoo(symbol);
  const CACHE_KEY = `price_${symbol}`;

  chrome.storage.local.get([CACHE_KEY], async (res) => {
    const data = res[CACHE_KEY];
    const now = Date.now();
    const TTL = 3600000;

    if (data && now - data.timestamp < TTL) {
      sendResponse({ price: data.price, name: data.name || '', ok: true });
      return;
    }

    try {
      const result = await fetchPriceFromYahooChart(yahooSymbol);
      const price = result?.price;
      const name = result?.name || '';
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
        throw new Error(`Bad price for ${yahooSymbol}`);
      }
      await chrome.storage.local.set({ [CACHE_KEY]: { price, name, timestamp: now } });
      sendResponse({ price, name, ok: true });
    } catch (e) {
      console.error('getPrice:', e?.message || e, { symbol, yahooSymbol });
      const fallback = typeof data?.price === 'number' && data.price > 0 ? data.price : 0;
      sendResponse({ price: fallback, name: data?.name || '', ok: fallback > 0 });
    }
  });

  return true;
});
