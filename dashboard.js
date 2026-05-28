document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const langParam = urlParams.get('lang') || 'en';
  const isZh = langParam === 'zh';

  // DOM
  const totalUsdEl = document.getElementById('total-usd');
  const totalUsdLabelEl = document.getElementById('total-usd-label');
  const totalSharesEl = document.getElementById('total-shares');
  const assetLabelEl = document.getElementById('asset-label');
  const recalcInput = document.getElementById('recalc-input');
  const recalcBtn = document.getElementById('recalc-btn');
  const chips = document.querySelectorAll('.chip');
  const listEl = document.getElementById('history-list');
  const emptyState = document.getElementById('empty-state');
  const historyCountEl = document.getElementById('history-count');
  const pageHeading = document.getElementById('page-heading');
  const pageSubtitle = document.getElementById('page-subtitle');
  const journeyTitle = document.getElementById('nav-text-journey');
  const noRecords = document.querySelector('#empty-state p');
  const impactEl = document.getElementById('text-impact');

  const i18n = {
    en: {
      heading: "Your FIRE Fortress",
      subtitle: "Turning every 'No' into a piece of your future freedom.",
      totalLabel: "Wealth Retained",
      sharesLabel: "Asset Equivalent",
      recalc: "Recalculate",
      journey: "Road To FIRE Journey",
      noRecords: "The journey of a thousand miles begins with a single saved item.",
      date: "Date", store: "Store", item: "Description", amount: "Amount", gain: "Gain",
      errPrice: "Could not find price for ",
      impact: "↑ Growing"
    },
    zh: {
      heading: "您的 FIRE 堡壘",
      subtitle: "每一次克制消費，都是在為未來的自由添磚加瓦。",
      totalLabel: "成功守住的財富",
      sharesLabel: "等值資產換算",
      recalc: "重新計算",
      journey: "Road To FIRE 歷程",
      noRecords: "千里之行，始於足下。開始儲存您的第一筆財富吧！",
      date: "日期", store: "商店", item: "說明", amount: "金額", gain: "增長",
      errPrice: "找不到此代碼的價格：",
      impact: "↑ 持續增長"
    }
  };

  const t = i18n[isZh ? 'zh' : 'en'];

  document.title = isZh ? 'Road to FIRE — 總覽' : 'Road to FIRE — Overview';
  if (pageHeading) pageHeading.textContent = t.heading;
  if (pageSubtitle) pageSubtitle.textContent = t.subtitle;
  if (journeyTitle) journeyTitle.textContent = t.journey;
  if (noRecords) noRecords.textContent = t.noRecords;
  if (recalcBtn) recalcBtn.textContent = t.recalc;
  if (impactEl) impactEl.textContent = t.impact;

  const ids = { date: 'th-date', store: 'th-store', item: 'th-item', amount: 'th-amount', gain: 'th-gain' };
  Object.entries(ids).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = t[key];
  });

  let cachedSavedItems = [];
  let cachedTotalUsd = 0;
  let currentDisplayTicker = 'VOO';
  let globalTwdUsdRate = 0.0308;

  function updateUI(ticker, price) {
    const tu = String(ticker).toUpperCase();
    const tw = tu.endsWith('.TW') || ['0050', '2330'].includes(tu);

    if (tw) {
      totalUsdEl.textContent = `NT$${(cachedTotalUsd / globalTwdUsdRate).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
      totalUsdLabelEl.textContent = `${t.totalLabel} (TWD)`;
    } else {
      totalUsdEl.textContent = `$${cachedTotalUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      totalUsdLabelEl.textContent = `${t.totalLabel} (USD)`;
    }

    const finalAmount = tw ? (cachedTotalUsd / globalTwdUsdRate) : cachedTotalUsd;
    totalSharesEl.innerHTML = `${(finalAmount / price).toFixed(4)} <span class="metric-unit">${tw ? '股' : 'Shares'}</span>`;
    assetLabelEl.textContent = `${tu} ${t.sharesLabel}`;

    chips.forEach(c => {
      const match = c.dataset.symbol === tu || (tu.endsWith('.TW') && c.dataset.symbol === tu.replace('.TW', ''));
      c.classList.toggle('active', match);
    });
  }

  function handleRecalc(raw) {
    let sym = String(raw || '').toUpperCase().trim();
    if (!sym) return;
    if (/^\d{4,6}[A-Z]?$/.test(sym)) sym += '.TW';
    totalSharesEl.textContent = '…';
    chrome.runtime.sendMessage({ action: 'getPrice', symbol: sym }, r => {
      if (r && r.ok && r.price > 0) { currentDisplayTicker = sym; updateUI(sym, r.price); }
      else { totalSharesEl.textContent = '—'; alert(t.errPrice + sym); }
    });
  }

  function getStoreLogo(name) {
    const n = name.toLowerCase();
    let domain = '';
    if (n.includes('amazon')) domain = 'amazon.com';
    else if (n.includes('walmart')) domain = 'walmart.com';
    else if (n.includes('best buy') || n.includes('bestbuy')) domain = 'bestbuy.com';
    else if (n.includes('target')) domain = 'target.com';
    else if (n.includes('shopee') || n.includes('蝦皮')) domain = 'shopee.tw';
    else if (n.includes('momo')) domain = 'momo.com.tw';
    else if (n.includes('pchome')) domain = 'pchome.com.tw';
    else if (n.includes('apple')) domain = 'apple.com';
    else if (n.includes('ebay')) domain = 'ebay.com';
    else if (n.includes('rakuten') || n.includes('樂天')) domain = 'rakuten.com';
    else if (n.includes('foot locker') || n.includes('footlocker')) domain = 'footlocker.com';
    else if (n.includes('nike')) domain = 'nike.com';
    else if (n.includes('alo')) domain = 'aloyoga.com';
    else if (n.includes('lululemon')) domain = 'lululemon.com';
    else if (n.includes('adidas')) domain = 'adidas.com';
    else if (n.includes('zara')) domain = 'zara.com';
    else if (n.includes('hm.com') || n === 'h&m' || n === 'hm') domain = 'hm.com';
    else if (n.includes('uniqlo')) domain = 'uniqlo.com';
    else if (n.includes('sephora')) domain = 'sephora.com';
    else if (n.includes('nordstrom')) domain = 'nordstrom.com';
    else if (n.includes('macy')) domain = 'macys.com';
    else if (n.includes('costco.com.tw')) domain = 'costco.com.tw';
    else if (n.includes('costco')) domain = 'costco.com';
    else if (n.includes('yahoo')) domain = 'yahoo.com.tw';
    else if (n.includes('books') || n.includes('博客來')) domain = 'books.com.tw';
    else if (n.includes('pinkoi')) domain = 'pinkoi.com';
    else if (n.includes('eslite') || n.includes('誠品')) domain = 'eslite.com';
    else if (n.includes('carrefour') || n.includes('家樂福')) domain = 'carrefour.com.tw';
    else if (n.includes('ikea')) domain = 'ikea.com.tw';
    else if (n.includes('decathlon') || n.includes('迪卡儂')) domain = 'decathlon.tw';
    else if (n.includes('ulta')) domain = 'ulta.com';
    else if (n.includes('gap')) domain = 'gap.com';
    else if (n.includes('old navy')) domain = 'oldnavy.com';
    else if (n.includes('j.crew') || n.includes('jcrew')) domain = 'jcrew.com';
    else if (n.includes('home depot')) domain = 'homedepot.com';
    else if (n.includes('lowes')) domain = 'lowes.com';
    else if (n.includes('urban outfitters')) domain = 'urbanoutfitters.com';

    if (domain) {
      return `<img src="https://www.google.com/s2/favicons?sz=64&domain=${domain}" class="store-logo" alt="${name}">`;
    }
    return `<div class="store-logo-fallback">${name.charAt(0).toUpperCase()}</div>`;
  }

  function loadData() {
    chrome.storage.sync.get(['savedItems', 'settings'], res => {
      chrome.storage.local.get(['rate_TWDUSD'], local => {
        cachedSavedItems = res.savedItems || [];
        const s = res.settings || { ticker: 'VOO', price: 480.0 };
        currentDisplayTicker = s.ticker;
        globalTwdUsdRate = (local.rate_TWDUSD || { rate: 0.0308 }).rate;
        recalcInput.value = currentDisplayTicker.replace(/\.TW$/i, '');
        historyCountEl.textContent = cachedSavedItems.length;

        cachedTotalUsd = 0;
        cachedSavedItems.forEach(i => {
          if (typeof i.usdAmount === 'number') cachedTotalUsd += i.usdAmount;
          else if (i.currency === 'TWD') cachedTotalUsd += (i.amount || 0) * globalTwdUsdRate;
          else cachedTotalUsd += (i.amount || 0);
        });

        cachedSavedItems.sort((a, b) => b.timestamp - a.timestamp);
        listEl.innerHTML = '';
        if (!cachedSavedItems.length) { emptyState.style.display = 'block'; }
        else {
          emptyState.style.display = 'none';
          cachedSavedItems.forEach(i => {
            const d = new Date(i.timestamp).toLocaleDateString(isZh ? 'zh-TW' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const c = i.currency || 'USD';
            const p = c === 'TWD' ? 'NT$' : '$';
            const a = (i.amount || 0).toLocaleString(undefined, { minimumFractionDigits: c === 'TWD' ? 0 : 2, maximumFractionDigits: 2 });
            const sh = i.shares ? i.shares.toFixed(4) : '0.0000';
            const store = i.store || (isZh ? '線上' : 'Online');
            const logo = getStoreLogo(store);
            let title = (i.title || 'Unknown').replace(/Amazon\.com\s*:\s*/i, '').split('|')[0].trim();
            const row = document.createElement('tr');
            row.innerHTML = `
              <td>${d}</td>
              <td class="col-store">
                <div class="store-info">
                  ${logo}
                  <span class="store-name">${store}</span>
                </div>
              </td>
              <td><a href="${i.url}" target="_blank" class="item-link">${title}</a></td>
              <td class="col-amount">${p}${a}</td>
              <td class="col-gain">+${sh} ${i.ticker || 'VOO'}</td>
            `;
            listEl.appendChild(row);
          });
        }
        updateUI(currentDisplayTicker, s.price);
      });
    });
  }

  recalcBtn.addEventListener('click', () => handleRecalc(recalcInput.value));
  recalcInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleRecalc(recalcInput.value); });
  chips.forEach(c => c.addEventListener('click', () => { recalcInput.value = c.dataset.symbol; handleRecalc(c.dataset.symbol); }));
  chrome.storage.onChanged.addListener((ch, ns) => { if (ns === 'sync') loadData(); });
  loadData();
});
