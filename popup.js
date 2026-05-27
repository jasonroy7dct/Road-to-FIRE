/** Must stay aligned with content.js `historicalReturns` for consistent simulation. */
const HISTORICAL_ANN_RETURN = {
  VOO: 10.2,
  SPY: 10.1,
  QQQ: 13.8,
  VTI: 10.2,
  VT: 9.8,
  VXUS: 8.5,
  NVDA: 35.5,
  TSLA: 24.2,
  BTC: 45.0,
  '0050': 9.5,
  '2330': 15.8,
  MSFT: 12.0,
  GOOGL: 12.0,
};

const POPUP_STR = {
  en: {
    title: 'Road to FIRE',
    tagline: 'Convert prices to ETF shares & visualize future value.',
    secBenchmark: 'Benchmark ticker',
    more: 'More',
    placeholder: 'Other (e.g. AAPL, 2330.TW)',
    apply: 'Apply',
    secQuote: 'Quote & illustration',
    impactTitle: 'Growth projection',
    chartTitle: 'Performance chart',
    loading: 'Loading…',
    unavailable: 'Unavailable',
    switchTitle: 'Enable on pages',
    btnDashboard: 'View My FIRE Journey',
    footerSuffix: 'Road to FIRE Converter',
    restoreWidget: 'Restore Widget',
    projectionHtml: (ticker, pct) =>
      `Estimated future value of a <strong>$1,000</strong> lump-sum today, using ${ticker}’s illustrative <strong>${pct}%</strong> historical annual return.`,
  },
  zh: {
    title: 'Road to FIRE',
    tagline: '將消費換算成 ETF 股數，並試算未來的機會成本。',
    secBenchmark: '基準標的',
    more: '其他',
    placeholder: '其他代號（例：AAPL、2330.TW）',
    apply: '套用',
    secQuote: '報價與試算',
    impactTitle: '長期成長試算',
    chartTitle: '績效走勢圖',
    loading: '載入中…',
    unavailable: '無法取得報價',
    switchTitle: '在網頁上啟用',
    btnDashboard: '查看我的財富自由進度',
    footerSuffix: 'Road to FIRE 價值換算',
    restoreWidget: '恢復顯示浮動小視窗',
    projectionHtml: (ticker, pct) =>
      `假設今日一次投入約 <strong>$1,000</strong>，依 ${ticker} 之<strong>歷史年化約 ${pct}%</strong>粗估未來參考金額（非預測）。`,
  },
};

function annReturnFor(ticker) {
  const k = String(ticker || '')
    .trim()
    .toUpperCase()
    .replace(/\.TW$/i, '');
  return HISTORICAL_ANN_RETURN[k] ?? 10.0;
}

function isTaiwanTicker(sym) {
  const s = String(sym || '').trim().toUpperCase();
  return s.endsWith('.TW') || /^\d{4,6}[A-Z]?$/.test(s);
}

function localeHintFromUrl(url) {
  if (!url || /^(chrome-extension:|chrome:|edge:|about:)/i.test(url)) return null;
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (/\.(tw|hk)\b/i.test(h) || /\.cn\b/i.test(h)) return 'zh';
    if (/eslite|momoshop|pchome|books\.com|yahoo\.com\.tw|ruten|shopee\.tw|gaplus/i.test(h)) return 'zh';
  } catch (_) {}
  return null;
}

function normalizeLocale(langRaw) {
  const s = String(langRaw || '').toLowerCase().trim();
  if (!s) return 'en';
  if (s.startsWith('zh')) return 'zh';
  return 'en';
}

function detectPopupLocale(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) {
      callback('en');
      return;
    }
    const fromUrl = localeHintFromUrl(tab.url || '');
    if (fromUrl) {
      callback(fromUrl);
      return;
    }
    chrome.tabs.sendMessage(tab.id, { action: 'jdctGetPageLang' }, (resp) => {
      if (chrome.runtime.lastError) {
        callback('en');
        return;
      }
      callback(normalizeLocale(resp?.lang));
    });
  });
}

let settings = { enabled: true, ticker: 'VOO', price: 480.0 };
let stockName = ''; // resolved name from Yahoo Finance
/** @type {'en'|'zh'} */
let popupLocale = 'en';

const mainToggle = document.getElementById('mainToggle');
const tickerChips = document.querySelectorAll('.ticker-chip');
const customTickerInput = document.getElementById('customTicker');
const applyBtn = document.getElementById('applyBtn');
const priceDisplay = document.getElementById('currentPrice');
const tickerDisplay = document.getElementById('activeTickerDisplay');
const futureValueDisplay = document.getElementById('futureValueDisplay');
const impactSub = document.getElementById('impactSub');
const btnDashboardText = document.getElementById('i18n-btn-dashboard');
const viewDashboardBtn = document.getElementById('viewDashboard');
const footer = document.getElementById('extFooter');

let priceLoading = false;

function str() {
  return POPUP_STR[popupLocale] || POPUP_STR.en;
}

function applyPopupI18n() {
  const t = str();
  document.documentElement.lang = popupLocale === 'zh' ? 'zh-Hant' : 'en';

  const el = (id, text) => {
    const n = document.getElementById(id);
    if (n) n.textContent = text;
  };

  el('i18n-title', t.title);
  el('i18n-tagline', t.tagline);
  el('i18n-sec-benchmark', t.secBenchmark);
  el('i18n-more', t.more);
  el('i18n-sec-quote', t.secQuote);
  el('i18n-impact-title', t.impactTitle);
  el('i18n-chart-title', t.chartTitle);
  if (customTickerInput) customTickerInput.placeholder = t.placeholder;
  if (applyBtn) applyBtn.textContent = t.apply;
  if (btnDashboardText) btnDashboardText.textContent = t.btnDashboard;
  const sw = document.getElementById('i18n-switch-wrap');
  if (sw) sw.title = t.switchTitle;

  try {
    const v = chrome.runtime.getManifest().version;
    if (footer && v) {
      footer.innerHTML = `${t.footerSuffix} · v${v} · <a href="#" id="restoreWidgetLink" style="color:var(--accent);text-decoration:none;font-weight:500;">${t.restoreWidget}</a>`;
      const link = document.getElementById('restoreWidgetLink');
      if (link) {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
              chrome.tabs.sendMessage(tabs[0].id, { action: 'forceShowWidget' }, () => {
                if (chrome.runtime.lastError) {
                  link.textContent = popupLocale === 'zh' ? '請重新整理此網頁！' : 'Please refresh page!';
                  link.style.color = '#d93025';
                } else {
                  window.close();
                }
              });
            }
          });
        });
      }
    }
  } catch (_) {}
}

function formatMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '—';
  if (isTaiwanTicker(settings.ticker)) {
    return `NT$${x.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  }
  return `$${x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function projectionLine(ticker, rate) {
  const r = Number(rate);
  const pct = Number.isFinite(r) ? r.toFixed(1) : '10.0';
  return str().projectionHtml(escapeHTML(ticker), pct);
}

function updateUI(fromFetch) {
  mainToggle.checked = settings.enabled;

  // Quote section label: show resolved name for Taiwan stocks
  if (isTaiwanTicker(settings.ticker)) {
    const num = settings.ticker.replace(/\.TW$/i, '');
    tickerDisplay.textContent = stockName ? `${num}: ${stockName}` : num;
  } else {
    tickerDisplay.textContent = settings.ticker;
  }
  const t = str();

  if (priceLoading) {
    priceDisplay.className = 'stats-value loading';
    priceDisplay.textContent = t.loading;
  } else if (fromFetch === 'error') {
    priceDisplay.className = 'stats-value err';
    priceDisplay.textContent = t.unavailable;
  } else {
    priceDisplay.className = 'stats-value';
    priceDisplay.textContent = formatMoney(settings.price);
  }

  tickerChips.forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.symbol === settings.ticker);
  });

  const rate = annReturnFor(settings.ticker);
  const fv = 1000 * Math.pow(1 + rate / 100, 30);
  futureValueDisplay.textContent = formatMoney(fv);
  if (impactSub) impactSub.innerHTML = projectionLine(settings.ticker, rate);

  customTickerInput.disabled = priceLoading;
  applyBtn.disabled = priceLoading;
}

let currentChartData = null;
let chartListenersAttached = false;

function attachChartListeners() {
  if (chartListenersAttached) return;
  chartListenersAttached = true;
  const container = document.querySelector('.chart-container');
  const tooltip = document.getElementById('chartTooltip');
  const line = document.getElementById('chartLine');
  const dot = document.getElementById('chartDot');
  const svg = document.getElementById('sparkline');
  
  if (!container || !tooltip || !line || !dot || !svg) return;

  const hide = () => {
    tooltip.style.display = 'none';
    line.style.display = 'none';
    dot.style.display = 'none';
  };

  container.addEventListener('mouseleave', hide);
  
  container.addEventListener('mousemove', (e) => {
    if (!currentChartData || currentChartData.length < 2) return;
    
    const rect = svg.getBoundingClientRect();
    let x = e.clientX - rect.left;
    if (x < 0) x = 0;
    if (x > rect.width) x = rect.width;
    
    const pct = x / rect.width;
    let idx = Math.round(pct * (currentChartData.length - 1));
    if (idx < 0) idx = 0;
    if (idx >= currentChartData.length) idx = currentChartData.length - 1;
    
    const d = currentChartData[idx];
    const minP = Math.min(...currentChartData.map((v) => v.price));
    const maxP = Math.max(...currentChartData.map((v) => v.price));
    const range = maxP - minP || 1;
    
    const yPct = ((d.price - minP) / range) * 0.9 + 0.05;
    const pxY = rect.height - (yPct * rect.height);
    const pxX = (idx / (currentChartData.length - 1)) * rect.width;
    
    line.style.display = 'block';
    line.style.left = `${pxX}px`;
    
    dot.style.display = 'block';
    dot.style.left = `${pxX}px`;
    dot.style.top = `${pxY}px`;
    
    const date = new Date(d.time * 1000);
    const mStr = date.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
    const pStr = formatMoney(d.price);
    
    tooltip.style.display = 'block';
    tooltip.textContent = `${mStr} · ${pStr}`;
    tooltip.style.left = `${pxX}px`;
  });
}

function drawChart(data) {
  currentChartData = data;
  const svg = document.getElementById('sparkline');
  const loader = document.getElementById('chartLoading');
  if (!svg || !loader) return;
  
  if (!data || data.length < 2) {
    svg.style.display = 'none';
    loader.style.display = 'flex';
    loader.textContent = str().unavailable;
    return;
  }
  
  loader.style.display = 'none';
  svg.style.display = 'block';
  attachChartListeners();
  
  const minP = Math.min(...data.map((d) => d.price));
  const maxP = Math.max(...data.map((d) => d.price));
  const range = maxP - minP || 1;
  
  const w = 1000;
  const h = 100;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  
  let dPath = '';
  for (let i = 0; i < data.length; i++) {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((data[i].price - minP) / range) * (h * 0.9) - (h * 0.05);
    if (i === 0) dPath += `M ${x} ${y} `;
    else dPath += `L ${x} ${y} `;
  }
  
  const isPositive = data[data.length - 1].price >= data[0].price;
  const color = isPositive ? '#1A73E8' : '#D93025';
  
  svg.innerHTML = `
    <defs>
      <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.15"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0.0"/>
      </linearGradient>
    </defs>
    <path d="${dPath} L ${w} ${h} L 0 ${h} Z" fill="url(#chartGrad)" stroke="none" />
    <path d="${dPath}" fill="none" stroke="${color}" stroke-width="3" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
  `;
}

function changeTicker(symbol) {
  settings.ticker = symbol;
  priceLoading = true;
  updateUI(false);
  
  const svg = document.getElementById('sparkline');
  const loader = document.getElementById('chartLoading');
  if (svg) svg.style.display = 'none';
  if (loader) {
    loader.style.display = 'flex';
    loader.textContent = str().loading;
  }

  chrome.runtime.sendMessage({ action: 'getPrice', symbol }, (res) => {
    if (chrome.runtime.lastError) {
      priceLoading = false;
      updateUI('error');
      chrome.storage.local.set({ settings });
      return;
    }

    priceLoading = false;

    if (res && typeof res.price === 'number' && res.price > 0 && Number.isFinite(res.price)) {
      settings.price = res.price;
      // Store resolved stock name (e.g. 'Taiwan Semiconductor Manufacturing Co.' → show as display name)
      stockName = res.name || '';
      updateUI(false);
      chrome.storage.sync.set({ settings });
    } else {
      stockName = '';
      updateUI('error');
      chrome.storage.sync.set({ settings });
    }
  });

  chrome.runtime.sendMessage({ action: 'getChartData', symbol }, (res) => {
    if (res && res.ok && res.data) {
      drawChart(res.data);
    } else {
      drawChart(null);
    }
  });
}

function boot() {
  chrome.storage.sync.get(['settings'], (result) => {
    detectPopupLocale((loc) => {
      popupLocale = loc === 'zh' ? 'zh' : 'en';
      applyPopupI18n();
      if (result.settings) settings = { ...settings, ...result.settings };
      updateUI(false);
      changeTicker(settings.ticker);
    });
  });
}

boot();

tickerChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    if (priceLoading) return;
    changeTicker(chip.dataset.symbol);
    customTickerInput.value = '';
  });
});

applyBtn.addEventListener('click', () => {
  let symbol = customTickerInput.value.toUpperCase().trim();
  // Auto-detect Taiwan stock: pure numbers (4-6 digits) → append .TW
  if (/^\d{4,6}[A-Z]?$/.test(symbol)) {
    symbol = symbol + '.TW';
  }
  if (symbol) changeTicker(symbol);
});

customTickerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    let symbol = customTickerInput.value.toUpperCase().trim();
    if (/^\d{4,6}[A-Z]?$/.test(symbol)) {
      symbol = symbol + '.TW';
    }
    if (symbol) changeTicker(symbol);
  }
});

mainToggle.addEventListener('change', (e) => {
  settings.enabled = e.target.checked;
  chrome.storage.sync.set({ settings });
});

document.getElementById('viewDashboard').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'openDashboard' });
});
