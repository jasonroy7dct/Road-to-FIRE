/**
 * Google Search results and Google Finance pages often contain many "$" snippets; injecting badges + MutationObserver
 * can cause memory/rendering process crashes (Chrome Error 11). These paths directly skip extension logic.
 */
(function () {
  'use strict';

  function isGoogleSerpOrFinancePage() {
    try {
      const h = location.hostname;
      const p = location.pathname || '';
      if (!h.includes('google.')) return false;
      return (
        p.startsWith('/search') ||
        p.startsWith('/finance') ||
        p.startsWith('/shopping') ||
        h === 'shopping.google.com'
      );
    } catch (_) {
      return false;
    }
  }

  if (isGoogleSerpOrFinancePage()) return;

  let appSettings = { enabled: true, ticker: 'VOO', price: 480.0 };
  let bypassInterceptor = false;
  let debounceTimer = null;
  let domObserver = null;
  let interceptorAttached = false;

  const MAX_TREE_NODES = 5500;
  const MAX_BADGES_PER_PAGE = 120;
  const SCAN_DEBOUNCE_MS = 380;
  /** Tickets and small accessories are often below $10; previously excluding them caused no badges on sites like SeatGeek. */
  const MIN_DISPLAY_USD = 4;
  /** Use NT$ parsing for Taiwan stock benchmarks (approx. > USD $1). */
  const MIN_DISPLAY_TWD = 35;
  const SKIP_PARENT_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'TEMPLATE',
    'CODE', 'PRE', 'KBD', 'SAMP', 'TEXTAREA', 'INPUT', 'SELECT',
  ]);

  // --- Internationalization (i18n) dictionary ---
  const i18n = {
    en: {
      badgeShares: 'Shares',
      oppCost: 'Opportunity Cost',
      current: 'Current',
      shares: 'Equivalent Shares',
      histReturn: 'Hist. Ann. Return',
      futureVal: 'Future Value',
      wait: 'Congrats! Nice pause!',
      modalLeadRich:
        'That looks like about <strong>{usd}</strong> for this checkout. If you skip it, that money stays with you for FIRE! Roughly <strong>{shares}</strong> shares of <strong>{ticker}</strong> at your benchmark (<strong>{px}</strong> / share).',
      modalFoot: 'Continue only if you still really want this purchase!',
      btnBuy: 'Continue checkout',
      btnSave: 'I saved it for FIRE!',
      modalPriceMissing: 'We could not read a dollar amount on this page.',
      modalNoQuote: 'Could not load a live quote. Open the extension popup and try again.',
      modalGrowthText: 'If you invest this <strong>{usd}</strong> instead, based on the historical {cagr}% return of {ticker}, it could grow to over <strong>{fv}</strong> in 30 years! Imagine that growth!',
    },
    zh: {
      badgeShares: '股',
      oppCost: '機會成本試算',
      current: '目前',
      shares: '等值股數',
      histReturn: '歷史年化報酬',
      futureVal: '未來預估價值',
      wait: '恭喜你，停在這裡很關鍵！',
      modalLeadRich:
        '偵測到此筆約 <strong>{usd}</strong>。若現在不結帳，這筆錢可以先省下；換算約 <strong>{shares}</strong> 股 <strong>{ticker}</strong>（以基準價 <strong>{px}</strong>／股）。當成多存進 {ticker} 也可以。',
      modalFoot: '若思考後仍決定要買，再按「繼續結帳」。',
      btnBuy: '繼續結帳',
      btnSave: '我忍住了！往財富自由路上！',
      modalPriceMissing: '此頁讀不到金額，無法換算。',
      modalNoQuote: '無法取得即時報價，請開啟擴充視窗重試。',
      modalGrowthText: '若將這筆 <strong>{usd}</strong> 轉為投資，以 {ticker} 歷史年化報酬率 {cagr}% 計算，30 年後有機會成長至 <strong>{fv}</strong>！',
    },
  };

  function getLangCode() {
    const lang = document.documentElement.lang || navigator.language || 'en';
    return lang.toLowerCase().includes('zh') ? 'zh' : 'en';
  }

  function getLang() {
    return i18n[getLangCode()];
  }

  // --- Historical annual return rate lookup table ---
  const historicalReturns = {
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
  function annReturnLookupKey(ticker) {
    return String(ticker || '')
      .trim()
      .toUpperCase()
      .replace(/\.TW$/i, '');
  }
  function getAnnReturn(ticker) {
    const k = annReturnLookupKey(ticker);
    return historicalReturns[k] ?? historicalReturns[ticker] ?? 10.0;
  }

  function tickerSymbolUpper() {
    return String(appSettings.ticker || '').trim().toUpperCase();
  }

  function isTaiwanBenchmarkTicker() {
    const s = tickerSymbolUpper();
    return s.endsWith('.TW') || /^\d{4,6}[A-Z]?$/.test(s);
  }

  function formatBenchMoney(amount) {
    const x = Number(amount);
    if (!Number.isFinite(x)) return '—';
    if (isTaiwanBenchmarkTicker()) {
      return `NT$${x.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
    }
    return `$${x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function formatFVHighlight(amount) {
    const n = parseFloat(amount);
    if (!Number.isFinite(n)) return '—';
    if (isTaiwanBenchmarkTicker()) {
      return `NT$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    }
    return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }

  let twdUsdRate = 0.0308; // approx 1/32.5, will be updated from background

  function getPageCurrency() {
    const lang = (document.documentElement.lang || navigator.language || '').toLowerCase();
    const host = location.hostname;
    if (lang.includes('tw') || lang === 'zh-hant' || host.endsWith('.tw') || host.includes('eslite') || host.includes('momoshop') || host.includes('pchome') || host.includes('shopee.tw')) {
      return 'TWD';
    }
    if (document.body && /NT\$|TWD|新台幣|滿.*免運|購物車/i.test(document.body.innerText.slice(0, 5000))) {
      return 'TWD';
    }
    return 'USD';
  }

  function isTaiwanContext() {
    return isTaiwanBenchmarkTicker() || getPageCurrency() === 'TWD';
  }

  function getExchangeMultiplier() {
    const pageCur = getPageCurrency();
    const benchCur = isTaiwanBenchmarkTicker() ? 'TWD' : 'USD';
    if (pageCur === 'TWD' && benchCur === 'USD') return twdUsdRate;
    if (pageCur === 'USD' && benchCur === 'TWD') return 1 / twdUsdRate;
    return 1;
  }

  function formatPageMoney(amount) {
    const cur = getPageCurrency();
    const x = Number(amount);
    if (cur === 'TWD') {
      return `NT$${x.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    }
    return `$${x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function minShopAmount() {
    return isTaiwanBenchmarkTicker() ? MIN_DISPLAY_TWD : MIN_DISPLAY_USD;
  }

  let badgeTooltipUiAttached = false;
  function setupBadgeTooltipUi() {
    if (badgeTooltipUiAttached) return;
    badgeTooltipUiAttached = true;

    let activeBadge = null;
    let tipHideTimeout = null;

    function layoutVooTooltip(badge) {
      const tip = badge.querySelector('.voo-tooltip');
      if (!tip) return;
      tip.style.display = 'flex';
      const br = badge.getBoundingClientRect();
      const margin = 10;
      const tw = tip.offsetWidth || 260;
      const th = tip.offsetHeight || 100;
      let left = br.left + br.width / 2 - tw / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - tw - margin));
      
      let top = br.bottom + margin;
      let placement = 'bottom';
      if (top + th > window.innerHeight - margin) {
        top = Math.max(margin, br.top - th - margin);
        placement = 'top';
      }
      tip.setAttribute('data-placement', placement);

      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(top)}px`;
    }

    function reflowOpenTips() {
      document.querySelectorAll('.voo-badge[data-voo-tip-active="1"]').forEach((b) => layoutVooTooltip(b));
    }

    document.addEventListener(
      'pointerover',
      (ev) => {
        const badge = ev.target.closest?.('.voo-badge');
        const prevBadge = ev.relatedTarget?.closest?.('.voo-badge');

        // Only trigger when entering the badge boundary from the outside
        if (badge && badge !== prevBadge) {
          if (tipHideTimeout) {
            clearTimeout(tipHideTimeout);
            tipHideTimeout = null;
          }

          if (activeBadge && activeBadge !== badge) {
            activeBadge.removeAttribute('data-voo-tip-active');
            activeBadge = null;
          }

          activeBadge = badge;
          // Layout synchronously first so it renders at the correct position immediately
          layoutVooTooltip(badge);
          badge.setAttribute('data-voo-tip-active', '1');
        }
      },
      true,
    );

    document.addEventListener(
      'pointerout',
      (ev) => {
        const badge = ev.target.closest?.('.voo-badge');
        const nextBadge = ev.relatedTarget?.closest?.('.voo-badge');

        // Only trigger when leaving the badge boundary entirely
        if (badge && badge !== nextBadge) {
          if (tipHideTimeout) clearTimeout(tipHideTimeout);
          tipHideTimeout = setTimeout(() => {
            badge.removeAttribute('data-voo-tip-active');
            if (activeBadge === badge) {
              activeBadge = null;
            }
          }, 180);
        }
      },
      true,
    );

    window.addEventListener('scroll', reflowOpenTips, true);
    window.addEventListener('resize', reflowOpenTips);
  }

  /**
   * Consistent with ticker symbols in background.js Yahoo Chart. Google Finance often redirects to /finance/beta/ 
   * in multiple regions and shows "not found", so we default to the Yahoo Finance page.
   */
  function benchmarkTickerExternalUrl(symbol) {
    const raw = String(symbol || 'VOO').trim();
    const s = raw.toUpperCase();
    if (s === 'BTC') return `https://finance.yahoo.com/quote/${encodeURIComponent('BTC-USD')}`;
    if (/^\d{4,6}[A-Z]?$/.test(s)) return `https://finance.yahoo.com/quote/${encodeURIComponent(`${s}.TW`)}`;
    if (!/^[A-Z0-9.\-]{1,24}$/.test(s)) {
      return `https://www.google.com/search?tbm=fin&q=${encodeURIComponent(raw)}&hl=en`;
    }
    const yahooSymbol = s.replace(/\./g, '-');
    return `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}`;
  }

  // --- Major US E-commerce Configurations (dedicated selectors preferred; HTTPS shopping sites not listed can still use generic scanning) ---
  const schemaPrice = (el) => el.getAttribute('content') || el.getAttribute('aria-label') || el.innerText;
  const siteConfigs = [
    {
      domain: 'amazon.com',
      priceSelector: '.a-price:not(.a-text-price):not([data-voo-processed]), #corePrice_feature_div .a-price:not([data-voo-processed]), #apex_offerDisplay_desktop .a-price:not([data-voo-processed])',
      priceExtract: (el) => el.querySelector('.a-offscreen')?.innerText || el.innerText,
      cartButtons: '#add-to-cart-button, #buy-now-button, [name="proceedToRetailCheckout"], #rcx-checkout-submit-buttons input, input[name="submit.add-to-cart"], #checkout-button, .checkout-button, [name="proceedToRetailCheckout"], [data-action="add-to-wishlist"] ~ button',
    },
    {
      domain: 'walmart.com',
      priceSelector: '[itemprop="price"]:not([data-voo-processed]), [data-automation="buybox-price"]:not([data-voo-processed]), [data-testid="price-wrap"]:not([data-voo-processed])',
      priceExtract: (el) => el.getAttribute('content') || el.innerText,
      cartButtons: '[data-automation-id="add-to-cart"], button[data-automation-id="checkout"], [data-automation-id="fulfillmentATC"], [data-testid="action-btn"], [data-automation-id="cta-btn"]',
    },
    {
      domain: 'target.com',
      priceSelector: '[data-test="product-price"]:not([data-voo-processed]), [data-test="@web/components/ProductCard/ProductCardVariantDefault"]:not([data-voo-processed])',
      priceExtract: (el) => el.innerText,
      cartButtons: '[data-test="shippingButton"], [data-test="checkout-button"], [data-test="addToCartButton"], [data-test="OurPicksATCButton"], button[class*="GreenButton"]',
    },
    {
      domain: 'bestbuy.com',
      priceSelector: '.priceView-customer-price span[aria-hidden="true"]:not([data-voo-processed]), .priceView-layout-large .priceView-customer-price:not([data-voo-processed]), [data-testid="customer-price"]:not([data-voo-processed])',
      priceExtract: (el) => el.innerText,
      cartButtons: '.add-to-cart-button, .checkout-buttons button, [data-button-state="ADD_TO_CART"], [data-testid="add-to-cart-button"], [data-testid="checkout-button"], .c-button-submit',
    },
    {
      domain: 'apple.com',
      priceSelector: '.rc-prices-fullprice:not([data-voo-processed]), .as-price-currentprice:not([data-voo-processed]), [data-autom="full-price"]:not([data-voo-processed])',
      priceExtract: (el) => el.innerText,
      cartButtons: '.add-to-cart, button[name="add-to-cart"], .rc-summary-button, [data-autom="add-to-cart"], [data-autom="proceed-to-checkout"], .button-cta',
    },
    {
      domain: 'footlocker.com',
      priceSelector:
        '[itemprop="price"]:not([data-voo-processed]), [data-testid*="price" i]:not([data-voo-processed]), [data-automation*="price" i]:not([data-voo-processed]), [class*="ProductPrice" i]:not([data-voo-processed]), [class*="product-price" i]:not([data-voo-processed])',
      priceExtract: (el) => el.getAttribute('content') || el.innerText,
      cartButtons:
        '[data-testid*="add-to-cart" i], [data-testid*="addtobag" i], button[id*="add-to-cart" i], a[href*="/cart"], a[href*="/checkout"], [aria-label*="add to cart" i], [aria-label*="add to bag" i]',
    },
    {
      domain: 'nike.com',
      priceSelector:
        '.product-price:not([data-voo-processed]), [data-testid="currentPrice-container"]:not([data-voo-processed]), [data-testid*="price" i]:not([data-voo-processed]), [class*="product-price" i]:not([data-voo-processed]), [data-automation*="price" i]:not([data-voo-processed])',
      priceExtract: (el) => el.innerText,
      cartButtons:
        '[data-testid="qa-cart-button"], [data-testid="qa-checkout-button"], [data-testid="add-to-cart-button"], [data-testid*="checkout" i], [data-testid*="bag" i], [data-testid*="submit" i], [data-testid*="place-order" i], [data-automation*="checkout" i], [data-e2e*="checkout" i], a[href*="/checkout"], a[href*="/cart"], a[href*="/bag"], [role="button"][data-testid*="checkout" i]',
    },
    { domain: 'ebay.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .x-price-primary span:not([data-voo-processed]), [data-testid="x-price-primary"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-testid="ux-call-to-action"], #binBtn_btn_1, .ux-call-to-action__button, [data-testid="x-atc-action"], [name="submit.buy"]' },
    {
      domain: 'etsy.com',
      priceSelector: '[data-buy-box-region] [itemprop="price"]:not([data-voo-processed]), .wt-text-body-01.wt-text-bold:not([data-voo-processed]), [data-selector="price-only"] .currency-value:not([data-voo-processed])',
      priceExtract: (el) => el.getAttribute('content') || el.innerText,
      cartButtons: '[data-buy-box-region] button[type="submit"], [data-listing-id] form button[type="submit"], .wt-btn--filled, [data-testid="buy-now-btn"]',
    },
    { domain: 'kingstone.com.tw', priceSelector: '.price_box .price b, .basicunit.price1 b, .basic_price b, .basic_price .price, .price_sale', priceExtract: (el) => el.innerText, cartButtons: '.btn_addcart, .btn_buy, .立即結帳, .加入購物車' },
    {
      domain: 'nordstrom.com',
      priceSelector: '.price:not([data-voo-processed]), [data-testid*="price"]:not([data-voo-processed])',
      priceExtract: (el) => el.innerText,
      cartButtons: '[data-testid="checkout-button"], [data-testid="add-to-bag"]',
    },
    {
      domain: 'shopee.tw',
      priceSelector: '._3e_UQT:not([data-voo-processed]), ._2GchKS:not([data-voo-processed]), [class*="shopee-price"]:not([data-voo-processed])',
      priceExtract: (el) => el.innerText,
      cartButtons: '.btn-solid-primary, button.shopee-button-solid, [class*="shopee-button-solid"]',
    },
    {
      domain: 'homedepot.com',
      priceSelector: '[itemprop="price"]:not([data-voo-processed]), .price__numbers:not([data-voo-processed]), [data-price]:not([data-voo-processed]), [data-testid="price"]:not([data-voo-processed])',
      priceExtract: (el) => el.getAttribute('content') || el.getAttribute('data-price') || el.innerText,
      cartButtons: 'button[data-automation-id="add-to-cart-button"], [data-automation-id="add-to-cart"], #root_primary_btn, .payment__cta, [data-testid="atc-button"]',
    },
    { domain: 'lowes.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), [data-selector="product-price"]:not([data-voo-processed]), .art-pd-wrapper [itemprop="price"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-selector="add-to-cart"], #addToCart, button[data-selector="add-to-cart"], [href*="checkout"]' },
    {
      domain: 'costco.com',
      priceSelector: '[itemprop="price"]:not([data-voo-processed]), .price:not([data-voo-processed]), [automation-id*="Price"]:not([data-voo-processed]), .your-price:not([data-voo-processed])',
      priceExtract: schemaPrice,
      cartButtons: '#add-to-cart, [data-testid="add-to-cart"], [data-automation*="add-to-cart" i], input[value*="Add to Cart" i], button[type="submit"][class*="button" i]',
    },
    { domain: 'samsclub.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), [data-automation-id*="price" i]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-automation-id="addToCart"], button[data-tl-id*="add-to-cart" i], [data-testid="add-to-cart"]' },
    {
      domain: 'wayfair.com',
      priceSelector: '[itemprop="price"]:not([data-voo-processed]), [data-enzyme-id="PriceDisplay"]:not([data-voo-processed]), [data-name="Pricing"]:not([data-voo-processed]), [data-testid="structured-price"]:not([data-voo-processed])',
      priceExtract: schemaPrice,
      cartButtons: '[data-name="AddToCartButton"], [data-enzyme-id="AddToCartButton"], #bd-add-to-cart-button, [data-testid="atcButton"], button[class*="AddToCartButton" i]',
    },
    { domain: 'kohls.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .pdpprice-row-main-text:not([data-voo-processed]), [data-testid="pdp-price"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '#addtobagButton, [data-testid="add-to-bag-button"], .checkout-button, [name="checkout"]' },
    { domain: 'macys.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), [data-auto="price"]:not([data-voo-processed]), .price-large:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '#bag-add-cta, [data-test-id="add-to-bag"], .checkout-cta, [data-auto="checkout"]' },
    { domain: 'nordstrom.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), [data-testid="product-price"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-testid="add-to-bag-button"], [data-testid="checkout-button"], button[data-modal*="AddToBag" i]' },
    { domain: 'nordstromrack.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), [data-testid="product-price"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-testid="add-to-bag-button"], [data-testid="checkout-button"]' },
    { domain: 'chewy.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), [data-testid="price"]:not([data-voo-processed]), .kibocommerce-price:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-testid="add-to-cart"], #buy-now-button, [href*="/checkout"]' },
    { domain: 'petco.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), [data-test="product-price"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-test="add-to-cart"], button[data-track*="add-to-cart" i], #checkout-button-bottom' },
    { domain: 'zappos.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .price:not([data-voo-processed]), [data-testid="price"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '#add-to-cart-button, [data-testid="add-to-cart"], .cart-button' },
    {
      domain: 'newegg.com',
      priceSelector: '.price-current:not([data-voo-processed]), [itemprop="price"]:not([data-voo-processed]), .price-current-num:not([data-voo-processed])',
      priceExtract: (el) => {
        const strong = el.querySelector('.price-current strong, strong');
        return strong ? strong.innerText : (schemaPrice(el));
      },
      cartButtons: '.btn-primary[title*="Add" i], #ProductBuy .btn-primary, [href*="shopping-cart"], .item-actions-checkout, [id*="add-to-cart" i]',
    },
    { domain: 'bhphotovideo.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .topListingQty_price:not([data-voo-processed]), .pricesContainer:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '#submitCartButton, #addToCartPlaceholder a, .bottomBuyButtons button, [data-selenium="addToCartButton"]' },
    { domain: 'adorama.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .price:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '#addToCartBtn, .buy-section button, [href*="shopping-cart"]' },
    { domain: 'gamestop.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .actual-price:not([data-voo-processed]), [data-testid="price"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '.add-to-cart, [data-testid="add-to-cart"], #btnAtc, button[aria-label*="Add to cart" i]' },
    { domain: 'ulta.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), [data-test="price"]:not([data-voo-processed]), .ProductPricing:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-test="add-to-bag"], #AddToBag, .CheckoutButtons button, [href*="/bag"]' },
    {
      domain: 'sephora.com',
      priceSelector: '[itemprop="price"]:not([data-voo-processed]), [data-comp*="Price"]:not([data-voo-processed]), [data-at="price_product_detail"]:not([data-voo-processed])',
      priceExtract: schemaPrice,
      cartButtons: '[data-at*="add-to-basket" i], button[data-comp*="AddToBasket"], [href*="/basket"], [data-at="add_to_basket_button"]',
    },
    { domain: 'rei.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), [data-ui="product-price"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-ui="add-to-cart-button"], #add-to-cart, [href*="/shopping-cart"]' },
    { domain: 'dickssportinggoods.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), [data-testid="product-price"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-testid="add-to-cart"], #add-to-cart-button, [href*="/checkout"]' },
    { domain: 'academy.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), [data-testid="product-price"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-testid="add-to-cart"], #add-to-cart, .checkout-cta' },
    { domain: 'staples.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .price:not([data-voo-processed]), #finalPrice:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '#addToCart, .add-to-cart, [href*="/cart"], #checkoutGuestMain' },
    { domain: 'officedepot.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .price:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '#addToCartLink, .add-to-cart, [href*="/cart"]' },
    { domain: 'gap.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .pdp-pricing:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-testid="add-to-bag"], #add-to-bag-button, .checkout__button' },
    { domain: 'urbanoutfitters.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .c-pwa__price:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-add-to-bag], .o-add-to-bag, [href*="/checkout"]' },
    { domain: 'hm.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .product-item-price-full:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-add-to-cart], button[data-testid="add-to-cart"], .itembuttons-addtocart' },
    { domain: 'uniqlo.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .fr-ec-price:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-test="button"], #product-addtocart, .add-to-cart-button' },
    {
      domain: 'shein.com',
      priceSelector: '[itemprop="price"]:not([data-voo-processed]), [class*="priceInfo" i]:not([data-voo-processed]), [class*="promotion-price" i]:not([data-voo-processed])',
      priceExtract: (el) => el.getAttribute('content') || el.innerText,
      cartButtons: '[class*="add-to-bag" i], [class*="btn-add" i], .product-intro__add-btn, button[s-heid*="add-to-cart" i], [href*="/cart"]',
    },
    { domain: 'lenovo.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .saleprice:not([data-voo-processed]), .pricing-current-price:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '.button_called_add_to_cart, [data-testid="addToCart"], #button-cart-main' },
    { domain: 'dell.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), [data-testid="finalPrice"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-testid="addToCartButton"], #addToCartButton, .dds__button--add-to-cart' },
    { domain: 'hp.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .price:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-add-to-cart], #addToCart, button[data-track*="add to cart" i]' },
    { domain: 'williams-sonoma.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .sale-price:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-testid="add-to-cart-button"], .btn-add-to-cart, [href*="/shopping-cart"]' },
    { domain: 'potterybarn.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .sale-price:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-testid="add-to-cart-button"], .btn-add-to-cart' },
    { domain: 'westelm.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .sale-price:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-testid="add-to-cart-button"], .btn-add-to-cart' },
    { domain: 'bedbathandbeyond.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), [data-test="price"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-test="add-to-cart"], button[type="submit"]' },
    { domain: 'overstock.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .price:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '#addToCartButton, .add-to-cart, [href*="/checkout"]' },
    { domain: 'mercari.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), [data-testid="price"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-testid="purchase-button"], button[type="submit"]' },
    { domain: 'offerup.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), [data-testid="item-price"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-testid="buy-now"], button[aria-label*="Buy" i]' },
    { domain: 'stockx.com', priceSelector: '[data-testid="trade-box"]:not([data-voo-processed]), [itemprop="price"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-testid="buy-button"], button[data-testid*="buy" i]' },
    { domain: 'goat.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), [data-qa="buy_bar"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-qa="purchase"], button[data-e2e*="buy" i]' },
    // --- Taiwan E-commerce ---
    {
      domain: 'pxmart.com.tw',
      priceSelector: '.price:not([data-voo-processed]), [class*="product-price" i]:not([data-voo-processed]), .sale-price:not([data-voo-processed])',
      priceExtract: (el) => {
        // PxMart often has original price and sale price. Sale price usually comes last or has specific class.
        return el.innerText;
      },
      cartButtons: '.add-cart, .buy-now, [class*="add-to-cart" i]',
    },
    {
      domain: 'books.com.tw',
      priceSelector: '[itemprop="price"]:not([data-voo-processed]), .price_a:not([data-voo-processed]), .price01:not([data-voo-processed]), .set_price b:not([data-voo-processed]), .price_sale:not([data-voo-processed])',
      priceExtract: (el) => {
        const c = el.getAttribute('content');
        if (c && /^\d/.test(c)) return c;
        return el.innerText;
      },
      cartButtons: '#btn_addcart, .btn_cart, [class*="addCart" i], a[href*="/cart"]',
    },
    {
      domain: 'momoshop.com.tw',
      priceSelector: '#webPrice:not([data-voo-processed]), .salePrice:not([data-voo-processed]), .money:not([data-voo-processed]), [class*="prd-price" i]:not([data-voo-processed]), [itemprop="price"]:not([data-voo-processed])',
      priceExtract: (el) => {
        const c = el.getAttribute('content');
        if (c && /^\d/.test(c)) return c;
        return el.innerText;
      },
      cartButtons: '#buy_yes, .addCart, [class*="btn-cart" i], [class*="buy" i], a[href*="/cart"], button[id*="checkout" i], a[id*="checkout" i], .checkoutBtn',
    },
    {
      domain: 'pchome.com.tw',
      priceSelector: '.price-number:not([data-voo-processed]), .price:not([data-voo-processed]), [itemprop="price"]:not([data-voo-processed]), [class*="price-value" i]:not([data-voo-processed])',
      priceExtract: (el) => {
        const c = el.getAttribute('content');
        if (c && /^\d/.test(c)) return c;
        return el.innerText;
      },
      cartButtons: '#ButtonContainer button, .btn-cart, [class*="add-cart" i], a[href*="/cart"]',
    },
    {
      domain: 'shopee.tw',
      priceSelector: '[class*="price" i]:not([data-voo-processed]), [data-sqe="name"]:not([data-voo-processed])',
      priceExtract: (el) => el.innerText,
      cartButtons: '[class*="add-to-cart" i], button[class*="buy" i], .cart-page-footer__checkout, button.btn-solid-primary',
    },
    {
      domain: 'eslite.com',
      priceSelector: '[itemprop="price"]:not([data-voo-processed]), [class*="sale" i]:not([data-voo-processed]), .price:not([data-voo-processed])',
      priceExtract: (el) => {
        const c = el.getAttribute('content');
        if (c && /^\d/.test(c)) return c;
        return el.innerText;
      },
      cartButtons: '[class*="add-cart" i], [class*="addCart" i], a[href*="/cart"]',
    },
    {
      domain: 'yahoo.com',
      priceSelector: '[class*="Price__price"]:not([data-voo-processed]), .price:not([data-voo-processed]), [itemprop="price"]:not([data-voo-processed])',
      priceExtract: (el) => el.innerText,
      cartButtons: '.buy-now, .add-to-cart, [class*="AddCart" i]',
    },
    {
      domain: 'ruten.com.tw',
      priceSelector: '.rt-text-price:not([data-voo-processed]), .price:not([data-voo-processed]), [itemprop="price"]:not([data-voo-processed])',
      priceExtract: (el) => el.innerText,
      cartButtons: '.buy-now-btn, .add-cart-btn, [class*="buy-btn" i]',
    },
    {
      domain: 'costco.com.tw',
      priceSelector: '.product-price:not([data-voo-processed]), [itemprop="price"]:not([data-voo-processed])',
      priceExtract: (el) => el.innerText,
      cartButtons: '#add-to-cart, .add-to-cart-button',
    },
    {
      domain: 'carrefour.com.tw',
      priceSelector: '.current-price:not([data-voo-processed]), [itemprop="price"]:not([data-voo-processed])',
      priceExtract: (el) => el.innerText,
      cartButtons: '.add-to-cart, .buy-now',
    },
    {
      domain: 'taobao.com',
      priceSelector: '[class*="priceText"]:not([data-voo-processed]), [class*="Price--"]:not([data-voo-processed])',
      priceExtract: (el) => el.innerText,
      cartButtons: '[class*="buy--"], [class*="cart--"]',
    },
    // --- Global & Delivery Additions ---
    { domain: 'temu.com', priceSelector: '[class*="priceText"]:not([data-voo-processed]), [data-testid="price"]:not([data-voo-processed])', priceExtract: (el) => el.innerText, cartButtons: '[data-testid="add-to-cart"], .add-to-cart-button' },
    { domain: 'aliexpress.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .pdp-price:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '.add-to-cart-btn, .buy-now-btn, [data-role="add-to-cart"]' },
    { domain: 'ubereats.com', priceSelector: '[data-testid="price-text"]:not([data-voo-processed]), .price:not([data-voo-processed])', priceExtract: (el) => el.innerText, cartButtons: 'button[type="submit"], [data-testid="checkout-button"]' },
    { domain: 'foodpanda.com.tw', priceSelector: '.price:not([data-voo-processed]), [data-testid="menu-item-price"]:not([data-voo-processed])', priceExtract: (el) => el.innerText, cartButtons: '[data-testid="add-to-cart"], button[type="submit"]' },
    { domain: 'pinkoi.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .price:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '.add-to-cart, .buy-now, [data-testid="buy-button"]' },
    { domain: 'airbnb.com', priceSelector: '._1y74zjx:not([data-voo-processed]), [data-testid="price-label"]:not([data-voo-processed])', priceExtract: (el) => el.innerText, cartButtons: '[data-testid="homes-pdp-cta-btn"], button[type="submit"]' },
    { domain: 'expedia.com', priceSelector: '[data-test-id="price-column"]:not([data-voo-processed]), .uitk-text-emphasis:not([data-voo-processed])', priceExtract: (el) => el.innerText, cartButtons: '[data-testid="submit-button"], button[type="submit"]' },
    { domain: 'walgreens.com', priceSelector: '.price__container:not([data-voo-processed]), [itemprop="price"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '#wag-cart-btn, #wag-buy-now-btn' },
    // --- Luxury, Gaming & Niche Additions ---
    { domain: 'steampowered.com', priceSelector: '.game_purchase_price:not([data-voo-processed]), .discount_final_price:not([data-voo-processed])', priceExtract: (el) => el.innerText, cartButtons: 'a[href*="cart/add"], .btn_addtocart' },
    { domain: 'farfetch.com', priceSelector: '[data-testid="price"]:not([data-voo-processed]), [itemprop="price"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-testid="add-to-bag"], [data-testid*="checkout" i]' },
    { domain: 'ssense.com', priceSelector: '[data-testid="product-price"]:not([data-voo-processed]), .product-price:not([data-voo-processed])', priceExtract: (el) => el.innerText, cartButtons: '[data-testid="add-to-bag-button"], button[type="submit"]' },
    { domain: 'lululemon.com', priceSelector: '[data-testid="price"]:not([data-voo-processed]), .price-17n59:not([data-voo-processed])', priceExtract: (el) => el.innerText, cartButtons: '[data-testid="add-to-bag-button"], #pdp-add-to-bag' },
    { domain: 'iherb.com', priceSelector: '.product-price:not([data-voo-processed]), #product-price:not([data-voo-processed])', priceExtract: (el) => el.innerText, cartButtons: '[data-testid="add-to-cart"], .add-to-cart' },
    { domain: 'coupang.com', priceSelector: '.total-price:not([data-voo-processed]), .price-value:not([data-voo-processed])', priceExtract: (el) => el.innerText, cartButtons: '.prod-buy-btn, .prod-cart-btn' },
    { domain: 'rakuten.com.tw', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .price-value:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-testid="add-to-cart"], .add-to-cart, .buy-now' },
    { domain: 'mykuji.com.tw', priceSelector: '.price:not([data-voo-processed]), [class*="price" i]:not([data-voo-processed])', priceExtract: (el) => el.innerText, cartButtons: '.add-to-cart, .buy-now, button[type="submit"]' },
    { domain: 'shopify.com', priceSelector: '[class*="price" i]:not([data-voo-processed]), [itemprop="price"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[name="add"], button[type="submit"], [href*="checkout"]' },
    // --- Additional US Platforms ---
    { domain: 'instacart.com', priceSelector: '[data-testid="item-price"]:not([data-voo-processed]), [data-testid="product-price"]:not([data-voo-processed])', priceExtract: (el) => el.innerText, cartButtons: '[data-testid="go-to-checkout"], button[data-testid*="checkout" i], [data-testid="place-order-button"]' },
    { domain: 'kroger.com', priceSelector: '[data-testid="cart-item-price"]:not([data-voo-processed]), .kds-Price:not([data-voo-processed]), [itemprop="price"]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-testid="CartItemsCheckout"], button[data-testid="submit-button"], [data-testid="checkout-button"]' },
    { domain: 'cvs.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .product-price:not([data-voo-processed]), [class*="priceBlock" i]:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '.add-to-cart-button, [data-qa="add-to-cart"], [href*="/checkout"]' },
    { domain: 'myprotein.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .productPrice_price:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-action="atb"], #add-to-basket, button[type="submit"]' },
    { domain: 'groupon.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .deal-price:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '[data-bhw="buy-button"], .buy-btn, button[type="submit"]' },
    { domain: 'rakuten.com', priceSelector: '[itemprop="price"]:not([data-voo-processed]), .price:not([data-voo-processed])', priceExtract: schemaPrice, cartButtons: '.add-to-cart, .buy-now, [href*="/checkout"]' },
    // --- Ticketing / Sports / Concert Sites ---
    {
      domain: 'seatgeek.com',
      priceSelector: '[class*="price" i]:not([data-voo-processed]), [data-testid*="price" i]:not([data-voo-processed])',
      priceExtract: schemaPrice,
    },
    {
      domain: 'ticketmaster.com',
      priceSelector: '[class*="price" i]:not([data-voo-processed]), [data-testid*="price" i]:not([data-voo-processed])',
      priceExtract: schemaPrice,
    },
    {
      domain: 'stubhub.com',
      priceSelector: '[class*="price" i]:not([data-voo-processed]), [data-testid*="price" i]:not([data-voo-processed])',
      priceExtract: schemaPrice,
    },
  ];

  /** Do not include global submit: will accidentally block "send verification code / login" forms. */
  const genericCartButtonsCore =
    'button[name="add"], button[name="checkout"], .add-to-cart, #add-to-cart, [aria-label*="checkout" i], [aria-label*="place order" i], [aria-label*="submit order" i], [data-testid*="add-to-cart" i], [data-testid*="AddToCart" i], [data-testid*="checkout" i], [data-testid*="place-order" i], [data-testid*="submit-order" i], [data-automation-id*="add-to-cart" i], [data-automation-id*="AddToCart" i], [data-automation*="checkout" i], button[data-add-to-cart], [aria-label*="add to cart" i], [aria-label*="加入購物車" i], [aria-label*="結帳" i], [role="button"][data-testid*="checkout" i]';

  function genericCartSelectorsForPage() {
    if (isLikelyCartOrCheckoutPath()) {
      return `${genericCartButtonsCore}, button[type="submit"], input[type="submit"]`;
    }
    return genericCartButtonsCore;
  }

  function isLikelyCartOrCheckoutPath() {
    try {
      const p = (location.pathname || '').toLowerCase();
      const h = (location.hash || '').toLowerCase();
      const q = (location.search || '').toLowerCase();
      const host = (location.hostname || '').toLowerCase();
      return (
        p.includes('checkout') ||
        p.includes('cart') ||
        p.includes('bag') ||
        p.includes('basket') ||
        p.includes('payment') ||
        p.includes('shoppingcart') ||
        p.includes('/buy/') ||
        p.includes('/purchase') ||
        p.includes('/order/') ||
        h.includes('checkout') ||
        h.includes('cart') ||
        q.includes('checkout=1') ||
        q.includes('step=') || // covers multi-step checkout flows
        host.includes('checkout') ||
        host.includes('cart') ||
        // Taiwan-specific patterns
        p.includes('purchaselist') ||
        p.includes('cart.htm') ||
        p.includes('cart.html') ||
        p.includes('mycart')
      );
    } catch (_) {
      return false;
    }
  }

  function isTicketCheckoutPage() {
    try {
      const host = window.location.hostname.toLowerCase();
      const p = window.location.pathname.toLowerCase();
      const h = window.location.hash.toLowerCase();
      const q = window.location.search.toLowerCase();
      return (
        host.includes('checkout') ||
        host.includes('cart') ||
        p.includes('checkout') ||
        p.includes('secure') ||
        p.includes('buy') ||
        p.includes('pay') ||
        p.includes('purchase') ||
        p.includes('booking') ||
        q.includes('checkout') ||
        h.includes('checkout')
      );
    } catch (_) {}
    return false;
  }

  function isAuthPage() {
    try {
      const host = (location.hostname || '').toLowerCase();
      const path = (location.pathname || '').toLowerCase();
      if (
        host.startsWith('auth.') ||
        host.startsWith('accounts.') ||
        host.startsWith('login.') ||
        host.startsWith('signin.') ||
        host.startsWith('signup.') ||
        host.includes('identity') ||
        host.includes('oauth')
      ) {
        return true;
      }
      if (
        path.includes('/login') ||
        path.includes('/signin') ||
        path.includes('/signup') ||
        path.includes('/register') ||
        path.includes('/auth') ||
        path.includes('/oauth') ||
        path.includes('/identity') ||
        path.includes('/authorization')
      ) {
        return true;
      }
    } catch (_) {}
    return false;
  }

  function isVerificationOrAuthUi(el) {
    if (!(el instanceof Element)) return false;
    const root =
      el.closest(
        '[role="dialog"], [class*="modal" i], [class*="Modal" i], [id*="modal" i], [data-testid*="otp" i], [data-testid*="mfa" i], [data-testid*="verify" i], [data-testid*="verification" i], form[action*="verify" i], form[id*="login" i], form[id*="signin" i], [class*="sign-in" i], [class*="SignIn" i], [class*="auth" i], [id*="recaptcha" i]',
      ) || el.closest('form');
    if (!root) return false;
    const blob = `${root.className || ''} ${root.id || ''} ${root.getAttribute('data-testid') || ''} ${root.getAttribute('aria-label') || ''}`.toLowerCase();
    if (
      /(otp|mfa|2fa|two-factor|twofactor|verification|verify|passcode|security code|sms|text me|authenticat|sign.?in|log.?in|password|驗證|簡訊|認證|登入)/i.test(blob)
    ) {
      return true;
    }
    return false;
  }

  function isOtpOrSmsButtonText(raw) {
    const lower = String(raw || '').toLowerCase();
    return /(send code|text code|resend|verification code|verify code|get code|confirm code|one[- ]time|sms|otp|簡訊|驗證碼|發送|重發)/i.test(lower);
  }

  /** Button text fallback: checkout / place order / payment (avoids failing if site data-testid changes) */
  function checkoutIntentFromClick(startEl) {
    const actionable = startEl.closest(
      'button, a[href], [role="button"], input[type="submit"], input[type="button"]',
    );
    if (!actionable || actionable.closest('#voo-interceptor-modal')) return null;
    if (isVerificationOrAuthUi(actionable)) return null;
    const raw =
      actionable.innerText ||
      actionable.getAttribute('aria-label') ||
      actionable.getAttribute('title') ||
      (actionable instanceof HTMLInputElement ? actionable.value : '') ||
      '';
    const lower = String(raw).toLowerCase().trim();
    if (!lower) return null;
    if (isOtpOrSmsButtonText(lower)) return null;

    let isTicketSite = false;
    try {
      const host = window.location.hostname.toLowerCase();
      isTicketSite = host.includes('ticketmaster') || host.includes('seatgeek') || host.includes('stubhub');
    } catch (_) {}

    const isCart = isLikelyCartOrCheckoutPath();
    const strongKeywords = /(check\s*out|place order|submit order|complete (purchase|order)|pay now|continue to checkout|continue securely|order and pay|submit payment|make payment|secure checkout|proceed to checkout|go to checkout|review order|confirm purchase|結帳|付款|下單|送出|前往結帳|去買單|立即購買)/i;

    if (isTicketSite) {
      const isSpecificButton = /(reserve tickets|confirm quantity)/i.test(lower);
      const isGenericTransition = isCart && /(continue|next|buy tickets|get tickets|checkout)/i.test(lower) && lower.length < 30;
      if (!strongKeywords.test(lower) && !isGenericTransition && !isSpecificButton) {
        return null;
      }
    } else {
      if (!strongKeywords.test(lower)) {
        if (!isCart && !/(check\s*out|place order|submit order|pay now|結帳|付款|下單)/i.test(lower)) {
          return null;
        }
      }
    }

    const exclude =
      /^(edit|back|cancel|close|apply|remove|delete|sign in|log in|prev|previous|return to shop|keep shopping|save for later)$/i;
    if (exclude.test(lower) && lower.length < 40) return null;
    return actionable;
  }

  /** Similar to 0050 style converters: common data-* / class containing price nodes (SeatGeek, StubHub, etc.) */
  const SEMANTIC_PRICE_SELECTOR =
    '[itemprop="price"]:not([data-voo-processed]), [data-testid*="price" i]:not([data-voo-processed]), [data-testid*="Price" i]:not([data-voo-processed]), [data-automation*="price" i]:not([data-voo-processed]), [class*="listing-price" i]:not([data-voo-processed]), [class*="ListingPrice" i]:not([data-voo-processed]), [class*="ticket-price" i]:not([data-voo-processed]), [class*="TicketPrice" i]:not([data-voo-processed]), [class*="product-price" i]:not([data-voo-processed]), [class*="ProductPrice" i]:not([data-voo-processed]), [class*="sale-price" i]:not([data-voo-processed]), [class*="current-price" i]:not([data-voo-processed])';

  function isLikelyBenchmarkSpotPrice(v) {
    const px = Number(appSettings.price);
    if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(v)) return false;
    const tol = isTaiwanBenchmarkTicker()
      ? Math.max(1.5, px * 0.001)
      : Math.max(0.06, px * 0.0008);
    return Math.abs(v - px) <= tol;
  }

  const USD_IN_TEXT_RE =
    /(?:US\$|\$|NT\$|TWD|¥|€|£)[\s\u00A0]*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/gi;

  const USD_NOISE_RE = /(month|mo\b|\/mo|\/ mo|interest-free|affirm|klarna|afterpay|zip|payments|starting at|installments|was\s*\$|list\s*price|msrp|comp\.\s*value|suggested|original|retail\s*price|previous\s*price|typical\s*price|basis\s*price)/i;

  /** Extract $ amounts one by one, excluding current benchmark price; never use parseFloat on whole segment to avoid "$15" + "$638" becoming 15638. */
  function extractAllUsdValues(raw) {
    if (!raw) return [];
    const chunks = String(raw).split(/\n|\||;/);
    const out = [];
    for (const chunk of chunks) {
      if (USD_NOISE_RE.test(chunk)) continue;

      let m;
      USD_IN_TEXT_RE.lastIndex = 0;
      while ((m = USD_IN_TEXT_RE.exec(chunk)) !== null) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (Number.isFinite(v) && v >= MIN_DISPLAY_USD && v <= 250000 && !isLikelyBenchmarkSpotPrice(v)) out.push(v);
      }
    }
    return out;
  }

  /**
   * Extract "product USD" from a string; will exclude numbers nearly identical to current benchmark price 
   * (to prevent VOO price in tooltip from being treated as product price). 
   * Takes minimum reasonable value when multiple amounts exist (common: main price + strikethrough/MSRP).
   */
  function extractUsdFromString(raw) {
    const found = extractAllUsdValues(raw);
    if (!found.length) return null;
    return Math.min(...found);
  }

  /** Order summary, etc.: same line may only have "Total $xx"; take largest reasonable $ fragment. */
  function extractLargestUsdFromString(raw) {
    const found = extractAllUsdValues(raw);
    if (!found.length) return null;
    return Math.max(...found);
  }

  const NT_INLINE_RE = /(?:NT\$|TWD|\$|¥)[\s\u00A0]*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/gi;
  const YUAN_INLINE_RE = /([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)\s*元/g;
  /** Matches standalone numbers that look like prices (e.g. bold sale price "675") */
  const BARE_TWD_NUM_RE = /(?:^|\s)([0-9]{2,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)(?:\s|$)/g;

  /** Promo / shipping / units / non-product-price context for TWD lines */
  const TWD_NOISE_RE = /(滿.*免運|運費|免運費|紅利|點數|回饋|已售|月銷|評價|評分|收藏|人氣|累積|件已售|人購買|shipping|ml|kg|cm|mm|oz|lb|瓶|入|組|包|個|粒|g\b|顆|支|份|盤|杯|盒|卷|張|台|串|金幣|點|滿額|全站滿|滿.*送|滿.*折|分期|月付|建議售價|原價|市值|先前價格|典型價格|參考價格)/i;

  function extractAllTwdValues(raw) {
    if (!raw) return [];
    const chunks = String(raw).split(/\n|\||;/);
    const out = [];
    for (const chunk of chunks) {
      if (TWD_NOISE_RE.test(chunk)) continue;

      let m;
      NT_INLINE_RE.lastIndex = 0;
      while ((m = NT_INLINE_RE.exec(chunk)) !== null) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (Number.isFinite(v) && v >= MIN_DISPLAY_TWD && v <= 50000000 && !isLikelyBenchmarkSpotPrice(v)) out.push(v);
      }
      YUAN_INLINE_RE.lastIndex = 0;
      while ((m = YUAN_INLINE_RE.exec(chunk)) !== null) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (Number.isFinite(v) && v >= MIN_DISPLAY_TWD && v <= 50000000 && !isLikelyBenchmarkSpotPrice(v)) out.push(v);
      }
    }
    return out;
  }

  function extractShopAmountFromString(raw) {
    if (isTaiwanContext()) {
      const tw = extractAllTwdValues(raw);
      if (tw.length) {
        return Math.min(...tw);
      }
      const clean = String(raw).replace(/,/g, '').trim();
      if (/^\d+(\.\d+)?$/.test(clean)) {
        const val = parseFloat(clean);
        if (val >= MIN_DISPLAY_TWD && val <= 50000000 && !isLikelyBenchmarkSpotPrice(val)) return val;
      }
    } else {
      const us = extractAllUsdValues(raw);
      if (us.length) {
        return Math.min(...us);
      }
      const clean = String(raw).replace(/,/g, '').trim();
      if (/^\d+(\.\d+)?$/.test(clean)) {
        const val = parseFloat(clean);
        if (val >= MIN_DISPLAY_USD && val <= 250000 && !isLikelyBenchmarkSpotPrice(val)) return val;
      }
    }
    return null;
  }

  function extractLargestShopAmount(raw) {
    if (isTaiwanContext()) {
      const tw = extractAllTwdValues(raw);
      if (tw.length) return Math.max(...tw);
      const clean = String(raw).replace(/,/g, '').trim();
      if (/^\d+(\.\d+)?$/.test(clean)) {
        const val = parseFloat(clean);
        if (val >= MIN_DISPLAY_TWD && val <= 50000000 && !isLikelyBenchmarkSpotPrice(val)) return val;
      }
    } else {
      const us = extractAllUsdValues(raw);
      if (us.length) return Math.max(...us);
      const clean = String(raw).replace(/,/g, '').trim();
      if (/^\d+(\.\d+)?$/.test(clean)) {
        const val = parseFloat(clean);
        if (val >= MIN_DISPLAY_USD && val <= 250000 && !isLikelyBenchmarkSpotPrice(val)) return val;
      }
    }
    return null;
  }

  /**
   * Grab "Payable / Order Total" lines from common cart/checkout sidebar text (avoiding subtotal, shipping single lines, etc.).
   */
  function extractLabeledOrderTotalShop(blob) {
    if (!blob) return null;
    const lines = String(blob)
      .split(/\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const twMode = isTaiwanBenchmarkTicker();
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      const hasAmt = twMode
        ? /(NT\$|[0-9][0-9,]*\s*元|\$\s*[0-9])/.test(line)
        : /\$\s*[0-9]/.test(line);
      if (!hasAmt) continue;
      const low = line.toLowerCase();
      if (
        /(items?\s*\(|shipping\s*to|delivery\s*fee|handling|estimated\s*tax|sales\s*tax|vat|gst|discount|promo|coupon|saved\s|you\s*save|member\s*savings|protection|warranty|gift\s*card|金幣|全站滿|滿額|滿.*折|滿.*送|回饋|點數|現折)/i.test(
          low,
        ) &&
        !/(grand|order)\s*total|subtotal|total\s*due|amount\s*due|pay\s*(today|now|balance)|estimated\s*total|付款總計|應付|小計/i.test(low)
      ) {
        continue;
      }
      if (
        /\b(grand\s*total|order\s*total|subtotal|total\s*due|amount\s*due|estimated\s*total|total\s*\(\s*usd\s*\)|payable|balance\s*due)\b/i.test(
          line,
        ) ||
        /(付款總計|應付金額|訂單總額|總計|小計)/i.test(line) ||
        (/^(total|subtotal)\b/i.test(line) &&
          !/^(total|subtotal)\s+(savings|rewards|reduced|discount|cashback|cash\s*back)/i.test(line))
      ) {
        let v = extractLargestShopAmount(line);
        if (v == null && i < lines.length - 1) {
          v = extractLargestShopAmount(lines[i + 1]);
        }
        if (v != null) return v;
      }
    }
    return null;
  }

  function estimateOrderTotalUsdNearClick(clickEl) {
    const roots = new Set();
    try {
      document
        .querySelectorAll(
          '[class*="order-summary" i], [class*="OrderSummary" i], [class*="checkout-summary" i], [data-testid*="summary" i], [data-testid*="Summary" i], [class*="cart-summary" i], [class*="CartSummary" i], [role="complementary"], aside',
        )
        .forEach((el) => {
          if (el instanceof Element && priceLikelyVisible(el)) roots.add(el);
        });
    } catch (_) { }
    if (clickEl instanceof Element) {
      let w = clickEl;
      for (let i = 0; w && i < 12; w = w.parentElement, i++) {
        if (w.tagName === 'BODY' || w.tagName === 'HTML') break;
        roots.add(w);
      }
    }
    const vals = [];
    for (const root of roots) {
      if (!(root instanceof Element)) continue;
      const blob = (root.innerText || '').slice(0, 12000);
      const v = extractLabeledOrderTotalShop(blob);
      if (v != null) vals.push(v);
    }
    if (!vals.length) return null;
    return Math.max(...vals);
  }

  function estimateItemPriceNearClick(clickEl) {
    if (!(clickEl instanceof Element)) return null;

    // Pass 1: Search up to 20 levels for a container with injected badges
    let w = clickEl;
    let badgeContainer = null;
    for (let i = 0; w && i < 20; w = w.parentElement, i++) {
      if (w.tagName === 'BODY' || w.tagName === 'HTML') break;
      if (w.querySelector('.voo-badge[data-voo-product-price]')) {
        badgeContainer = w;
        break;
      }
    }

    if (badgeContainer) {
      const badges = Array.from(badgeContainer.querySelectorAll('.voo-badge[data-voo-product-price]'));
      const visibleBadges = badges.filter(b => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });

      if (visibleBadges.length > 0) {
        const clickRect = clickEl.getBoundingClientRect();
        const clickX = clickRect.left + clickRect.width / 2;
        const clickY = clickRect.top + clickRect.height / 2;

        let bestBadge = visibleBadges[0];
        let maxScore = -1;

        for (const b of visibleBadges) {
          const r = b.getBoundingClientRect();
          const bx = r.left + r.width / 2;
          const by = r.top + r.height / 2;
          // Distance (minimum 1 to avoid division by zero)
          const dist = Math.max(1, Math.hypot(bx - clickX, by - clickY));

          // Use parent element (the actual price element) to check font size and boldness
          const priceEl = b.parentElement;
          const st = window.getComputedStyle(priceEl);
          const fs = parseFloat(st.fontSize) || 16;
          const isBold = parseInt(st.fontWeight) >= 600 || st.fontWeight === 'bold' ? 1.2 : 1;

          // Score combines font prominence and geometric proximity
          const fontScore = Math.pow(fs / 16, 2) * isBold;
          const score = (fontScore * 100) / Math.pow(dist, 0.5);

          if (score > maxScore) {
            maxScore = score;
            bestBadge = b;
          }
        }
        return parseFloat(bestBadge.dataset.vooProductPrice);
      }
    }

    // Pass 2: If NO badges were found, fallback to text parsing up to 15 levels
    w = clickEl;
    for (let i = 0; w && i < 15; w = w.parentElement, i++) {
      if (w.tagName === 'BODY' || w.tagName === 'HTML') break;

      const clone = w.cloneNode(true);
      // Remove known noise sections from the clone before reading text (Protection, Warranty, Add-ons, etc.)
      clone.querySelectorAll('[class*="protection" i], [id*="protection" i], [class*="warranty" i], [id*="warranty" i], [class*="insurance" i], [class*="add-on" i], [class*="upsell" i], [class*="services" i], [class*="installation" i], [class*="AppleCare" i], [id*="AppleCare" i], [class*="GeekSquad" i], [id*="GeekSquad" i], .attach-warranty-display, #attach-warranty-display, #atc-warranty-section, .a-section.a-spacing-none.a-padding-none, [class*="加購" i], [class*="加購價" i], [class*="安裝" i], [class*="保固" i], [class*="保險" i]').forEach(n => n.remove());

      const raw = clone.innerText || '';
      if (raw.length < 2000) {
        let vals = [];
        if (isTaiwanContext()) {
          vals = extractAllTwdValues(raw);
        }
        if (!vals.length) {
          vals = extractAllUsdValues(raw);
        }
        if (vals.length) {
          const minP = isTaiwanContext() ? MIN_DISPLAY_TWD : MIN_DISPLAY_USD;
          const filtered = vals.filter(v => v >= minP);
          if (filtered.length) {
            // On a Product Page, if we see a very small price vs a larger one, Math.min is generally safer for "Sale Price".
            return Math.min(...filtered);
          }
        }
      }
    }
    return null;
  }

  function findQuantityNearClick(clickEl) {
    if (!(clickEl instanceof Element)) return 1;

    // 1. Search up the DOM tree (up to 10 levels) for select/input quantity elements
    let w = clickEl;
    for (let i = 0; w && i < 10; w = w.parentElement, i++) {
      if (w.tagName === 'BODY' || w.tagName === 'HTML') break;

      // Look for select dropdowns inside this ancestor
      const selects = w.querySelectorAll('select');
      for (const sel of selects) {
        const name = (sel.name || '').toLowerCase();
        const id = (sel.id || '').toLowerCase();
        const className = (sel.className || '').toLowerCase();
        const dataAction = (sel.getAttribute('data-action') || '').toLowerCase();
        if (
          name.includes('quantity') || name.includes('qty') || name.includes('ticket') || name.includes('count') ||
          id.includes('quantity') || id.includes('qty') || id.includes('ticket') || id.includes('count') ||
          className.includes('quantity') || className.includes('qty') || className.includes('ticket') || className.includes('count') ||
          className.includes('quantity-select') || dataAction === 'a-select-quantity'
        ) {
          const val = parseInt(sel.value, 10);
          if (!isNaN(val) && val > 0) return val;
        }
      }

      // Look for input fields inside this ancestor
      const inputs = w.querySelectorAll('input');
      for (const inp of inputs) {
        const name = (inp.name || '').toLowerCase();
        const id = (inp.id || '').toLowerCase();
        const className = (inp.className || '').toLowerCase();
        const type = (inp.type || '').toLowerCase();
        const role = (inp.getAttribute('role') || '').toLowerCase();
        
        const isQtyInput = 
          name.includes('quantity') || name.includes('qty') || name.includes('ticket') || name.includes('count') ||
          id.includes('quantity') || id.includes('qty') || id.includes('ticket') || id.includes('count') ||
          className.includes('quantity') || className.includes('qty') || className.includes('ticket') || className.includes('count') ||
          type === 'number' || role === 'spinbutton' ||
          inp.getAttribute('aria-label')?.toLowerCase().includes('quantity') ||
          inp.getAttribute('aria-label')?.toLowerCase().includes('qty') ||
          inp.getAttribute('aria-label')?.toLowerCase().includes('ticket') ||
          inp.getAttribute('aria-label')?.toLowerCase().includes('count') ||
          inp.getAttribute('aria-label')?.toLowerCase().includes('數量') ||
          inp.getAttribute('aria-label')?.toLowerCase().includes('数量');

        if (isQtyInput) {
          const val = parseInt(inp.value, 10);
          if (!isNaN(val) && val > 0) return val;
        }
      }
    }

    // 2. Global fallback on the page for common selector patterns
    const globalSelectors = [
      'select#quantity', 'select[name="quantity"]', 'select[name="qty"]', 'select.quantity',
      'select.a-native-select', 'select[data-action="a-select-quantity"]',
      'select[name*="ticket" i]', 'select[id*="ticket" i]', 'select[name*="count" i]', 'select[id*="count" i]',
      'input#quantity', 'input[name="quantity"]', 'input[name="qty"]', 'input.quantity',
      'input.shopee-quantity-descriptor__input', 'input.qty-input',
      'input[name*="ticket" i]', 'input[id*="ticket" i]', 'input[name*="count" i]', 'input[id*="count" i]'
    ];
    for (const selStr of globalSelectors) {
      try {
        const el = document.querySelector(selStr);
        if (el) {
          const val = parseInt(el.value, 10);
          if (!isNaN(val) && val > 0) return val;
        }
      } catch (_) {}
    }

    return 1;
  }

  /** Intercept checkout: pick "shopping amount-like" numbers from badges on page, excluding incorrect benchmark prices and obvious outliers. */
  function pickCheckoutUsdFromBadges(amounts) {
    const arr = amounts.filter((n) => Number.isFinite(n) && n > 0);
    if (!arr.length) return 0;
    let pool = arr.filter((n) => !isLikelyBenchmarkSpotPrice(n));
    if (!pool.length) {
      if (arr.every((n) => isLikelyBenchmarkSpotPrice(n))) return 0;
      pool = arr.slice();
    }
    const uniq = [...new Set(pool)].sort((a, b) => a - b);
    if (uniq.length >= 2) {
      const hi = uniq[uniq.length - 1];
      const second = uniq[uniq.length - 2];
      const med = uniq[Math.floor(uniq.length / 2)];
      const hiFloor = isTaiwanBenchmarkTicker() ? 120000 : 500;
      if (hi > hiFloor && hi > second * 20 && hi > med * 15) {
        pool = pool.filter((n) => n !== hi);
        if (!pool.length) pool = arr.filter((n) => !isLikelyBenchmarkSpotPrice(n));
      }
    }
    return pool.length ? Math.max(...pool) : 0;
  }

  function mergeInterceptCheckoutUsd(domEst, badgeEst, onCheckout) {
    const d = domEst != null && domEst > 0 ? domEst : 0;
    const b = badgeEst > 0 ? badgeEst : 0;
    if (d && !b) return d;
    if (b && !d) return b;
    if (d && b) {
      const hi = Math.max(d, b);
      const lo = Math.min(d, b);
      if (hi / lo > 6) return lo;
      return onCheckout ? d : Math.min(d, b);
    }
    return 0;
  }

  function runSemanticPriceScan() {
    try {
      document.querySelectorAll(SEMANTIC_PRICE_SELECTOR).forEach((el) => {
        if (badgeCount() >= MAX_BADGES_PER_PAGE) return;
        if (el.closest('[data-voo-processed]') || el.querySelector('[data-voo-processed]')) return;
        if (!priceLikelyVisible(el)) return;
        if (priceInAddonSection(el)) return;
        if (el.querySelector?.('.voo-badge')) return;

        const st = window.getComputedStyle(el);
        if (st.textDecoration && st.textDecoration.includes('line-through')) return;

        const t = el.getAttribute('content') || el.innerText || el.textContent || '';
        const parentText = el.parentElement ? el.parentElement.innerText || el.parentElement.textContent : '';
        if (PROMO_REGEX.test(t.slice(0, 300)) || PROMO_REGEX.test((parentText || '').slice(0, 300))) return;

        const val = extractShopAmountFromString(t);
        if (val == null || !Number.isFinite(val)) return;
        injectBadge(val, el);
      });
    } catch (_) { }
  }

  function runGenericTextScan() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.hasAttribute('data-voo-processed')) return NodeFilter.FILTER_REJECT;
        if (parent.closest('[data-voo-processed]')) return NodeFilter.FILTER_REJECT;
        if (parent.querySelector('.voo-badge')) return NodeFilter.FILTER_REJECT;
        if (SKIP_PARENT_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        const ariaHidden = parent.closest('[aria-hidden="true"]');
        if (ariaHidden) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node;
    let steps = 0;

    while ((node = walker.nextNode())) {
      if (badgeCount() >= MAX_BADGES_PER_PAGE) break;
      if (++steps > MAX_TREE_NODES) break;
      const nv = node.nodeValue;
      if (!nv) continue;
      if (isTaiwanBenchmarkTicker()) {
        if (!/(NT\$|[\$＄]?\s*[0-9]|[0-9,]+\s*元)/.test(nv)) continue;
      } else if (!/\$/.test(nv)) continue;
      const val = extractShopAmountFromString(nv);
      if (val == null || val < minShopAmount()) continue;
      if (isLikelyBenchmarkSpotPrice(val)) continue;
      const parent = node.parentElement;
      if (parent.querySelector('.voo-badge')) continue;
      const badge = document.createElement('span');
      badge.className = 'voo-badge';
      badge.dataset.vooProductPrice = String(val);
      badge.innerHTML = createBadgeHTML(val);
      parent.setAttribute('data-voo-processed', 'true');
      if (node.nextSibling) parent.insertBefore(badge, node.nextSibling);
      else parent.appendChild(badge);
    }
  }

  function scheduleScan() {
    if (!appSettings.enabled || !document.body || document.visibilityState === 'hidden') return;
    clearTimeout(debounceTimer);
    const run = () => {
      if (document.visibilityState === 'hidden') return;
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => {
          try {
            scan();
          } catch (err) {
            console.warn('[FIRE] scan', err);
          }
        }, { timeout: 650 });
      } else {
        try {
          scan();
        } catch (err) {
          console.warn('[FIRE] scan', err);
        }
      }
    };
    debounceTimer = setTimeout(run, SCAN_DEBOUNCE_MS);
  }

  function badgeCount() {
    return document.querySelectorAll('.voo-badge').length;
  }

  function clearVooDecorations() {
    document.querySelectorAll('.voo-badge').forEach((n) => n.remove());
    document.querySelectorAll('[data-voo-processed]').forEach((el) => el.removeAttribute('data-voo-processed'));
    if (typeof injectedBadgePositions !== 'undefined') injectedBadgePositions.length = 0;
  }

  function priceLikelyVisible(el) {
    if (!(el instanceof Element)) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    const st = window.getComputedStyle(el);
    if (st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    if (st.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  }

  function priceInAddonSection(el) {
    return !!el.closest(
      '[data-testid*="protection" i], [data-automation*="protection" i], [class*="protection-plan" i], [class*="ProtectionPlan" i], [data-testid*="warranty" i], [aria-label*="protection plan" i]',
    );
  }

  const PROMO_REGEX = /(orders\s*over|滿.*免運|滿.*送|滿.*折|全站滿|滿額|折價券|優惠券|折扣碼|promo\s*code|coupon|禮券|membership|premium|subscribe|subscribe\s*save|subscribe\s*and\s*save|autoship)/i;

  /**
   * Sites like Walmart put multiple [itemprop=price] on one page (variant buttons vs main price).
   * Pick the "visible and largest area" one as the hero price to avoid sticking to small variants.
   */
  function pickHeroPriceCandidate(els, priceExtract, skipVisibility = false) {
    let best = null;
    let maxScore = -1;
    for (const el of els) {
      if (!skipVisibility && !priceLikelyVisible(el)) continue;
      if (priceInAddonSection(el)) continue;

      const st = window.getComputedStyle(el);
      // Skip prices with strikethrough (Original/MSRP)
      if (st.textDecoration && st.textDecoration.includes('line-through')) continue;
      if (el.closest('del, s, strike, .a-text-strike')) continue;
      if (el.parentElement && window.getComputedStyle(el.parentElement).textDecoration.includes('line-through')) continue;

      const text = priceExtract ? priceExtract(el) : (el.getAttribute('content') || el.innerText || el.textContent || '');
      if (!text) continue;

      // Check if the element itself contains noise
      if (USD_NOISE_RE.test(text.slice(0, 100)) || TWD_NOISE_RE.test(text.slice(0, 100))) continue;
      if (PROMO_REGEX.test(text.slice(0, 300))) continue;

      // Check parent for promo context, but be careful not to skip based on nearby "List Price" labels 
      // if this is the main price element.
      const parentText = el.parentElement ? (el.parentElement.innerText || el.parentElement.textContent || '').slice(0, 300) : '';
      if (parentText.length < 250 && PROMO_REGEX.test(parentText)) continue;

      const val = extractShopAmountFromString(text);
      const minP = isTaiwanContext() ? MIN_DISPLAY_TWD : MIN_DISPLAY_USD;
      if (val == null || val < minP) continue;
      const r = el.getBoundingClientRect();
      const fs = parseFloat(st.fontSize) || 16;
      const isBold = parseInt(st.fontWeight) >= 600 || st.fontWeight === 'bold' ? 1.2 : 1;
      const top = Math.max(0, r.top);

      let fontScore = Math.pow(fs / 16, 3) * 1000;
      let posScore = 1;
      if (top > 1000) posScore = 0.8;
      if (top > 2500) posScore = 0.4;
      if (top > 5000) posScore = 0.1;

      const score = fontScore * isBold * posScore;
      if (score > maxScore) {
        maxScore = score;
        best = { el, val, area: score };
      }
    }
    return best;
  }

  function nodeFromOurUI(node) {
    if (!node || node.nodeType !== 1) return false;
    const el = node;
    if (el.id === 'voo-interceptor-modal') return true;
    if (el.classList?.contains('voo-badge')) return true;
    if (el.closest?.('.voo-badge')) return true;
    if (el.closest?.('#voo-interceptor-modal')) return true;
    return false;
  }

  function mutationsLookLikePageWork(mutations) {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && !nodeFromOurUI(n)) return true;
        if (n.nodeType === 3 && !n.parentElement?.closest?.('.voo-badge')) return true;
      }
    }
    return false;
  }

  /** Variation switches often only change text/class, not adding nodes — must listen to characterData / attributes */
  function shouldScheduleScanFromMutations(mutations) {
    for (const m of mutations) {
      if (m.type === 'childList' && m.addedNodes.length > 0) {
        if (mutationsLookLikePageWork([m])) return true;
      }
      if (m.type === 'characterData') {
        const p = m.target && m.target.parentElement;
        if (p && !p.closest?.('.voo-badge')) return true;
      }
      if (m.type === 'attributes' && m.target instanceof Element) {
        const t = m.target;
        if (!nodeFromOurUI(t) && !t.closest?.('.voo-badge')) return true;
      }
    }
    return false;
  }

  function applyPriceFromResponse(resp) {
    if (resp && typeof resp.price === 'number' && resp.price > 0 && Number.isFinite(resp.price)) {
      appSettings.price = resp.price;
    }
  }

  function startExtension() {
    chrome.runtime.sendMessage({ action: 'getExchangeRate' }, (rateResp) => {
      if (rateResp && rateResp.rate) twdUsdRate = rateResp.rate;

      chrome.runtime.sendMessage({ action: 'getPrice', symbol: appSettings.ticker }, (resp) => {
        if (chrome.runtime.lastError) {
          observeDOM();
          setupInterceptor();
          setupBadgeTooltipUi();
          setupFloatingWidget();
          scheduleScan();
          return;
        }
        applyPriceFromResponse(resp);
        observeDOM();
        setupInterceptor();
        setupBadgeTooltipUi();
        setupFloatingWidget();
        scheduleScan();
      });
    });
  }

  // ============================================================
  // Floating Widget — Premium Persistent Icon + Panel
  // ============================================================
  let widgetPanelVisible = false;
  let widgetAutoShown = false;

  function setupFloatingWidget() {
    if (document.getElementById('voo-widget-btn')) return;
    renderWidget();
  }

  function renderWidget() {
    const lang = getLang();
    const isZh = lang === i18n.zh;

    // --- Floating button (always visible unless hidden) ---
    const btn = document.createElement('div');
    btn.id = 'voo-widget-btn';
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');

    // Minimal j + flame on navy (flame ignites on hover via CSS)
    btn.innerHTML = `
    <svg class="voo-widget-icon" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path class="flame" d="M24 6C24 6 20 12 20 15.5C20 17.7 21.8 19.5 24 19.5C26.2 19.5 28 17.7 28 15.5C28 12 24 6 24 6Z" fill="#fff" opacity="0.85"/>
      <text x="24" y="41" text-anchor="middle" fill="#fff" style="font-family:'Times New Roman',Times,serif;font-size:22px;">j</text>
    </svg>`;

    document.body.appendChild(btn);

    // --- Panel ---
    const panel = document.createElement('div');
    panel.id = 'voo-widget-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Road to FIRE');
    panel.innerHTML = buildWidgetPanelHtml(lang, isZh);
    document.body.appendChild(panel);

    // Restore saved position
    try {
      const savedY = sessionStorage.getItem('voo_widget_y');
      if (savedY) {
        btn.style.bottom = 'auto';
        btn.style.top = savedY + 'px';
      }
    } catch (_) { }

    // --- Drag support (vertical only) ---
    let isDragging = false, dragStartY = 0, btnStartTop = 0, hasMoved = false;

    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // Only left click/touch
      isDragging = true;
      hasMoved = false;
      const rect = btn.getBoundingClientRect();
      dragStartY = e.clientY;
      btnStartTop = rect.top;
      btn.setPointerCapture(e.pointerId);
      btn.style.transition = 'none';
    });

    btn.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const dy = e.clientY - dragStartY;
      if (Math.abs(dy) > 4) hasMoved = true;
      let newTop = btnStartTop + dy;
      newTop = Math.max(8, Math.min(window.innerHeight - 70, newTop));
      btn.style.bottom = 'auto';
      btn.style.top = newTop + 'px';
    });

    const onDragEnd = (e) => {
      if (!isDragging) return;
      isDragging = false;
      btn.style.transition = '';
      try { sessionStorage.setItem('voo_widget_y', parseInt(btn.style.top)); } catch (_) { }
      repositionPanel();
    };
    btn.addEventListener('pointerup', onDragEnd);
    btn.addEventListener('pointercancel', onDragEnd);

    btn.addEventListener('click', (e) => {
      if (!hasMoved) {
        widgetPanelVisible ? hideWidgetPanel() : showWidgetPanel(lang, isZh);
      }
    });

    // Wire up panel actions
    panel.addEventListener('click', (e) => {
      const target = e.target;
      const hideTrigger = target.id === 'voo-widget-hide-trigger' || target.closest('#voo-widget-hide-trigger');
      const gearTrigger = target.id === 'voo-widget-gear' || target.closest('#voo-widget-gear');

      if (hideTrigger) {
        hideWidgetPanel();
      }

      if (target.id === 'voo-widget-dashboard' || target.closest('#voo-widget-dashboard')) {
        const currentLang = getLangCode();
        try {
          chrome.runtime.sendMessage({ action: 'openDashboard', lang: currentLang });
        } catch (err) {
          console.warn('[FIRE] Extension context invalidated. Please refresh the page.');
        }
      }
    });

    // Auto-show once if on a shopping page
    if (!widgetAutoShown) {
      widgetAutoShown = true;
      setTimeout(() => {
        const hasBadges = document.querySelector('.voo-badge') != null;
        if (isLikelyCartOrCheckoutPath() || hasBadges) {
          showWidgetPanel(lang, isZh);
          setTimeout(() => {
            if (widgetPanelVisible && !panel.dataset.userInteracted) {
              hideWidgetPanel();
            }
          }, 5000);
        }
      }, 1500);
    }

    panel.addEventListener('pointerdown', () => {
      panel.dataset.userInteracted = '1';
    });
  }

  function showWidgetCompletely() {
    const btn = document.getElementById('voo-widget-btn');
    if (btn) btn.style.display = 'flex';
  }

  function repositionPanel() {
    const btn = document.getElementById('voo-widget-btn');
    const panel = document.getElementById('voo-widget-panel');
    if (!btn || !panel) return;
    const btnRect = btn.getBoundingClientRect();
    const panelHeight = 320;
    let panelTop = btnRect.top - panelHeight - 12;
    if (panelTop < 8) panelTop = btnRect.bottom + 12;
    panel.style.top = panelTop + 'px';
    panel.style.bottom = 'auto';
    panel.style.right = '20px';
  }

  function buildWidgetPanelHtml(lang, isZh) {
    const ticker = escapeHTML(appSettings.ticker || 'VOO');
    const totalLabel = isZh ? '累積守住金額' : 'Capital Preserved';
    const dashLabel = isZh ? '查看你守住了多少錢！' : 'View How much you saved!';
    const hideLabel = isZh ? '關閉' : 'Close';
    const tagline = isZh ? '每一次忍住，都是向財務自由更近一步！' : 'Every impulse resisted is a step closer to freedom';

    return `
      <div class="voo-wp-header">
        <div class="voo-wp-header-left">
          <div class="voo-wp-brand">Road to FIRE</div>
          <div class="voo-wp-sub">${tagline}</div>
        </div>
        <div class="voo-wp-gear" id="voo-widget-gear" title="${isZh ? '設定' : 'Settings'}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
        </div>
      </div>
      <div class="voo-wp-body">
        <div class="voo-wp-stat-card">
          <div class="voo-wp-stat-top">
            <span class="voo-wp-stat-label">${totalLabel}</span>
            <span class="voo-wp-ticker-chip">${ticker}</span>
          </div>
          <span class="voo-wp-stat-value" id="voo-widget-total">—</span>
        </div>
        <a id="voo-widget-dashboard" class="voo-wp-cta" role="button" tabindex="0">
          ${dashLabel}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="vertical-align:-2px;margin-left:4px"><path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </a>
      </div>
      <div class="voo-wp-footer">
        <span id="voo-widget-hide-trigger" class="voo-wp-hide">${hideLabel}</span>
      </div>
    `;
  }

  function showWidgetPanel(lang, isZh) {
    const panel = document.getElementById('voo-widget-panel');
    const btn = document.getElementById('voo-widget-btn');
    if (!panel) return;
    widgetPanelVisible = true;
    repositionPanel();
    panel.classList.add('voo-wp-visible');
    btn && btn.classList.add('voo-widget-btn-active');

    chrome.storage.sync.get(['totalSavedUsd'], (res) => {
      const total = res.totalSavedUsd || 0;
      const el = document.getElementById('voo-widget-total');
      if (el) {
        el.textContent = total > 0 ? `$${total.toFixed(2)}` : (isZh ? '尚無記錄' : '$0.00');
      }
    });
  }

  function hideWidgetPanel() {
    const panel = document.getElementById('voo-widget-panel');
    const btn = document.getElementById('voo-widget-btn');
    widgetPanelVisible = false;
    panel && panel.classList.remove('voo-wp-visible');
    btn && btn.classList.remove('voo-widget-btn-active');
  }



  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') clearTimeout(debounceTimer);
  });

  chrome.storage.sync.get(['settings'], (res) => {
    if (res.settings) appSettings = { ...appSettings, ...res.settings };
    if (!appSettings.enabled) return;
    startExtension();
  });

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'sync' || !changes.settings) return;
    const prev = changes.settings.oldValue || {};
    const next = changes.settings.newValue || {};
    const wasOn = prev.enabled !== false;
    const nowOn = next.enabled !== false;
    appSettings = { ...appSettings, ...next };

    function syncModalIfOpen() {
      if (document.getElementById('voo-interceptor-modal')) {
        syncInterceptorModalContent();
      }
    }

    if (!nowOn) {
      if (domObserver) {
        domObserver.disconnect();
        domObserver = null;
      }
      document.querySelectorAll('.voo-badge').forEach((el) => el.remove());
      document.querySelectorAll('[data-voo-processed]').forEach((el) => el.removeAttribute('data-voo-processed'));
      return;
    }

    if (!wasOn && nowOn) {
      document.querySelectorAll('[data-voo-processed]').forEach((el) => el.removeAttribute('data-voo-processed'));
      startExtension();
      return;
    }

    if (prev.ticker !== next.ticker) {
      document.querySelectorAll('.voo-badge').forEach((el) => el.remove());
      document.querySelectorAll('[data-voo-processed]').forEach((el) => el.removeAttribute('data-voo-processed'));
      chrome.runtime.sendMessage({ action: 'getPrice', symbol: next.ticker }, (resp) => {
        if (!chrome.runtime.lastError) applyPriceFromResponse(resp);
        scheduleScan();
        syncModalIfOpen();
      });
    } else if (prev.price !== next.price) {
      syncModalIfOpen();
    }
  });

  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function createBadgeHTML(rawPagePrice) {
    const lang = getLang();
    const exRate = getExchangeMultiplier();
    const adjustedPrice = rawPagePrice * exRate;

    const sharesRaw = adjustedPrice / appSettings.price;
    const shares = sharesRaw < 0.1 ? sharesRaw.toFixed(4) : sharesRaw < 1 ? sharesRaw.toFixed(3) : sharesRaw.toFixed(2);
    const annReturnRate = getAnnReturn(appSettings.ticker);
    const futureValue30Y = (adjustedPrice * Math.pow(1 + annReturnRate / 100, 30)).toFixed(2);
    const returnColor = annReturnRate >= 0 ? '#003358' : '#D93025';
    const returnSign = annReturnRate > 0 ? '+' : '';
    const pxFmt = formatBenchMoney(appSettings.price);
    const fvFmt = formatFVHighlight(futureValue30Y);

    const safeTicker = escapeHTML(appSettings.ticker);

    return `<span class="voo-badge-main">≈ ${shares} ${lang.badgeShares} ${safeTicker}</span><span class="voo-tooltip" role="tooltip">
      <span class="voo-title">${lang.oppCost}</span>
      <span class="voo-row"><span>${lang.current} ${safeTicker}</span> <span>${pxFmt}</span></span>
      <span class="voo-row"><span>${lang.shares}</span> <span>${shares}</span></span>
      <span class="voo-row"><span>${lang.histReturn}</span> <span style="color: ${returnColor}; font-weight: 600;">${returnSign}${annReturnRate.toFixed(1)}%</span></span>
      <span class="voo-highlight">
        <span class="voo-highlight-label">${lang.futureVal}</span>
        <span class="voo-highlight-value">${fvFmt}</span>
      </span>
    </span>`;
  }

  const injectedBadgePositions = [];

  function injectBadge(usdPrice, target) {
    if (!appSettings.enabled || target.hasAttribute('data-voo-processed')) return;
    if (badgeCount() >= MAX_BADGES_PER_PAGE) return;
    if (target.querySelector('.voo-badge')) return;
    if (target.closest('.voo-badge')) return;
    if (target.nextElementSibling?.classList.contains('voo-badge')) return;
    if (target.previousElementSibling?.classList.contains('voo-badge')) return;

    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const absX = rect.left + window.scrollX;
    const absY = rect.top + window.scrollY;
    for (const pos of injectedBadgePositions) {
      if (Math.abs(absX - pos.x) < 35 && Math.abs(absY - pos.y) < 25) {
        return;
      }
    }

    const badge = document.createElement('span');
    badge.className = 'voo-badge';
    badge.dataset.vooProductPrice = String(usdPrice);
    badge.innerHTML = createBadgeHTML(usdPrice);
    target.setAttribute('data-voo-processed', 'true');
    target.parentElement?.setAttribute('data-voo-processed', 'true');
    target.appendChild(badge);

    injectedBadgePositions.push({ x: absX, y: absY });
  }

  function scan() {
    if (!appSettings.enabled || !document.body) return;
    clearVooDecorations();

    const host = window.location.hostname;
    let isVIPSite = false;

    for (const config of siteConfigs) {
      if (host.includes(config.domain)) {
        isVIPSite = true;
        const priceEls = document.querySelectorAll(config.priceSelector);

        if (host.includes('walmart.com') || host.includes('footlocker.com')) {
          const hero = pickHeroPriceCandidate(Array.from(priceEls), config.priceExtract);
          if (hero) injectBadge(hero.val, hero.el);
        } else {
          for (let i = 0; i < priceEls.length; i++) {
            if (badgeCount() >= MAX_BADGES_PER_PAGE) break;
            const el = priceEls[i];

            const st = window.getComputedStyle(el);
            if (st.textDecoration && st.textDecoration.includes('line-through')) continue;

            const text = config.priceExtract(el);
            if (text) {
              const parentText = el.parentElement ? el.parentElement.innerText || el.parentElement.textContent : '';
              // Promo check is okay on parent, but noise (List Price) check should be more specific
              if (PROMO_REGEX.test(text.slice(0, 300)) || PROMO_REGEX.test((parentText || '').slice(0, 300))) continue;

              // Only skip if the element text itself contains the noise word (e.g. "MSRP $19.99")
              if (USD_NOISE_RE.test(text.slice(0, 100)) || TWD_NOISE_RE.test(text.slice(0, 100))) continue;

              const val = extractShopAmountFromString(text);
              if (val != null && val >= minShopAmount()) injectBadge(val, el);
            }
          }
        }
        break;
      }
    }

    if (!isVIPSite) {
      runSemanticPriceScan();
      runGenericTextScan();
    } else if (badgeCount() < MAX_BADGES_PER_PAGE) {
      const needSupplement =
        isLikelyCartOrCheckoutPath() ||
        badgeCount() === 0 ||
        host.includes('walmart.com') ||
        host.includes('footlocker.com');
      if (needSupplement) {
        runSemanticPriceScan();
        runGenericTextScan();
      }
    }
  }

  function observeDOM() {
    if (!appSettings.enabled || !document.body) return;
    if (domObserver) domObserver.disconnect();
    try {
      scan();
    } catch (err) {
      console.warn('[FIRE] scan', err);
    }
    domObserver = new MutationObserver((mutations) => {
      if (!shouldScheduleScanFromMutations(mutations)) return;
      scheduleScan();
    });
    domObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'aria-selected', 'aria-checked', 'data-state', 'data-selected', 'hidden'],
    });
  }

  function setupInterceptor() {
    if (interceptorAttached) return;
    interceptorAttached = true;
    document.body.addEventListener(
      'click',
      (e) => {
        if (!appSettings.enabled || bypassInterceptor || isAuthPage()) return;
        const host = window.location.hostname;
        let target = null;

        if (isVerificationOrAuthUi(e.target)) return;

        const currentSiteConfig = siteConfigs.find((c) => host.includes(c.domain));
        const genericSel = genericCartSelectorsForPage();
        
        let isTicketSite = false;
        try {
          const lowerHost = host.toLowerCase();
          isTicketSite = lowerHost.includes('ticketmaster') || lowerHost.includes('seatgeek') || lowerHost.includes('stubhub');
        } catch (_) {}

        if (isTicketSite) {
          const btnEl = e.target.closest('button, a, [role="button"]');
          const btnText = btnEl ? (btnEl.innerText || btnEl.getAttribute('aria-label') || '').toLowerCase().trim() : '';
          const isTargetButton = btnText.includes('reserve tickets') || btnText.includes('confirm quantity');
          if (!isTargetButton && !isTicketCheckoutPage()) {
            return;
          }
        }

        const useGeneric = !isTicketSite || isLikelyCartOrCheckoutPath();
        const mergedCartSelectors = currentSiteConfig
          ? `${currentSiteConfig.cartButtons || ''}${currentSiteConfig.cartButtons && useGeneric ? ', ' : ''}${useGeneric ? genericSel : ''}`
          : (useGeneric ? genericSel : '');

        if (mergedCartSelectors && mergedCartSelectors.trim()) {
          try {
            target = e.target.closest(mergedCartSelectors);
          } catch (_) {}
        }

        if (target) {
          const raw = target.innerText || target.getAttribute('aria-label') || target.getAttribute('title') || '';
          const lower = String(raw).toLowerCase().trim();
          if (/^(edit|back|cancel|close|close cart|close bag|remove|delete|x)$/i.test(lower)) {
            target = null;
          } else {
            const cls = target.className;
            if (typeof cls === 'string' && /(^|\s)(close|btn-close|cart-close|modal-close|drawer-close)(\s|$)/i.test(cls)) {
              target = null;
            } else if (target.closest('[aria-label="close" i], [aria-label="Close cart" i], [aria-label="Close drawer" i], [title="Close" i]')) {
              target = null;
            }
          }
        }

        if (!target) {
          target = checkoutIntentFromClick(e.target);
        }
        if (!target && e.target.tagName.toLowerCase() === 'button') {
          const btnText = e.target.innerText.toLowerCase();
          const allowLooseBuy =
            isLikelyCartOrCheckoutPath() &&
            (btnText.includes('cart') || btnText.includes('checkout') || btnText.includes('結帳') || btnText.includes('買單') || btnText.includes('去買單'));
          if (allowLooseBuy || (btnText.includes('buy') && /(checkout|cart|bag|order)/i.test(window.location.pathname))) {
            target = e.target;
          }
        }

        if (!target) return;
        if (isTicketSite) {
          const raw = target.innerText || target.getAttribute('aria-label') || target.getAttribute('title') || '';
          const lower = String(raw).toLowerCase().trim();
          const isCart = isLikelyCartOrCheckoutPath();
          const strongKeywords = /(check\s*out|place order|submit order|complete (purchase|order)|pay now|continue to checkout|continue securely|order and pay|submit payment|make payment|secure checkout|proceed to checkout|go to checkout|review order|confirm purchase|結帳|付款|下單|送出|前往結帳|去買單|立即購買)/i;
          const isGenericTransition = isCart && /(continue|next|buy tickets|get tickets|checkout)/i.test(lower) && lower.length < 30;
          const isSpecificButton = /(reserve tickets|confirm quantity)/i.test(lower);
          if (!strongKeywords.test(lower) && !isGenericTransition && !isSpecificButton) return;
        }
        if (isVerificationOrAuthUi(target)) return;
        if (isOtpOrSmsButtonText(target.innerText || target.getAttribute('aria-label') || '')) return;

        e.preventDefault();
        e.stopPropagation();

        try {
          scan();
        } catch (_) { }

        const badgeEls = document.querySelectorAll('.voo-badge[data-voo-product-price]');
        const amounts = Array.from(badgeEls)
          .map((b) => parseFloat(b.dataset.vooProductPrice))
          .filter((n) => !Number.isNaN(n) && n > 0);

        const isCartPath = isLikelyCartOrCheckoutPath();
        const fromBadges = pickCheckoutUsdFromBadges(amounts);
        const fromDom = estimateOrderTotalUsdNearClick(target);
        const itemPrice = estimateItemPriceNearClick(target);

        const btnText = target.innerText || target.getAttribute('aria-label') || target.value || '';
        let btnPrice = 0;
        if (btnText && !PROMO_REGEX.test(btnText.slice(0, 300))) {
          btnPrice = extractLargestShopAmount(btnText) || 0;
        }

        let estUsd = 0;
        let isOrderTotal = false;
        if (btnPrice > 0) {
          estUsd = btnPrice;
        } else if (fromDom > 0) {
          estUsd = fromDom;
          isOrderTotal = true;
        } else if (itemPrice > 0) {
          estUsd = itemPrice;
        } else {
          const pageHero = estimatePageUsdBestEffort();
          if (pageHero > 0) {
            estUsd = pageHero;
          }
        }

        if (estUsd > 0 && !isOrderTotal && !isTicketSite) {
          try {
            const qty = findQuantityNearClick(target);
            if (qty > 1) {
              estUsd = estUsd * qty;
            }
          } catch (_) {}
        }

        showInterceptorModal(estUsd, target, e.target);
      },
      true,
    );
  }

  /**
   * Sync and redraw open interceptor windows when user switches benchmark ticker/quote updates in popup
   * (to keep shares and ticker symbols consistent with appSettings).
   */
  function syncInterceptorModalContent() {
    const overlay = document.getElementById('voo-interceptor-modal');
    if (!overlay) return;
    const raw = overlay.dataset.vooEstUsd;
    const parsed = raw != null && raw !== '' ? parseFloat(raw) : NaN;
    const estUsd = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

    const lang = getLang();
    const titleEl = overlay.querySelector('#voo-modal-title');
    if (titleEl) titleEl.textContent = lang.wait;

    const oldBody = overlay.querySelector('.voo-modal-body');
    if (oldBody) {
      const html = buildInterceptorBodyHtml(estUsd).trim();
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      const neu = tpl.content.firstElementChild;
      if (neu) oldBody.replaceWith(neu);
    }

    const buy = overlay.querySelector('#voo-btn-buy');
    const save = overlay.querySelector('#voo-btn-save');
    if (buy) buy.textContent = lang.btnBuy;
    if (save) save.textContent = lang.btnSave;
  }

  function buildInterceptorBodyHtml(estUsd) {
    const lang = getLang();
    const px = Number(appSettings.price);
    const hasQuote = px > 0 && Number.isFinite(px);
    if (!hasQuote) {
      return `<div class="voo-modal-body"><p class="voo-math-note">${lang.modalNoQuote}</p></div>`;
    }
    if (!(estUsd > 0)) {
      return `<div class="voo-modal-body"><p class="voo-modal-lead">${lang.modalPriceMissing}</p></div>`;
    }
    const exRate = getExchangeMultiplier();
    const adjustedPrice = estUsd * exRate;
    const sharesStr = (adjustedPrice / px).toFixed(4);
    const pxStr = formatBenchMoney(px);

    const displayTicker = isTaiwanBenchmarkTicker()
      ? appSettings.ticker.replace(/\.TW$/i, '')
      : appSettings.ticker;
    const safeDisplayTicker = escapeHTML(displayTicker);

    const lead = lang.modalLeadRich
      .replace(/\{usd\}/g, formatPageMoney(estUsd))
      .replace(/\{shares\}/g, sharesStr)
      .replace(/\{ticker\}/g, safeDisplayTicker)
      .replace(/\{px\}/g, pxStr);

    const cagr = historicalReturns[annReturnLookupKey(appSettings.ticker)] || 7.0;
    const years = 30;
    const fv = estUsd * Math.pow(1 + cagr / 100, years);
    const growthText = (lang.modalGrowthText || '')
      .replace(/\{usd\}/g, formatPageMoney(estUsd))
      .replace(/\{cagr\}/g, cagr.toFixed(1))
      .replace(/\{ticker\}/g, safeDisplayTicker)
      .replace(/\{fv\}/g, formatPageMoney(fv));

    return `<div class="voo-modal-body">
      <div class="voo-modal-lead">${lead}</div>
      <div class="voo-modal-hero" aria-hidden="true"><span class="voo-hero-shares">≈ ${sharesStr}</span><span class="voo-hero-ticker">${safeDisplayTicker}</span></div>
      
      <div class="voo-modal-growth" aria-hidden="true">
        <div id="voo-modal-chart-container" class="voo-chart-loading"></div>
        <div class="voo-growth-text">${growthText}</div>
      </div>

      <p class="voo-modal-foot">${lang.modalFoot}</p>
    </div>`;
  }

  function renderSparkline(dataPoints) {
    if (!dataPoints || dataPoints.length < 2) return '';
    const w = 300, h = 60;
    const minP = Math.min(...dataPoints.map(d => d.price));
    const maxP = Math.max(...dataPoints.map(d => d.price));
    const range = maxP - minP || 1;

    let path = `M 0,${h - ((dataPoints[0].price - minP) / range) * h}`;
    for (let i = 1; i < dataPoints.length; i++) {
      const x = (i / (dataPoints.length - 1)) * w;
      const y = h - ((dataPoints[i].price - minP) / range) * h;
      path += ` L ${x},${y}`;
    }

    return `<svg viewBox="0 0 ${w} ${h}" class="voo-sparkline" preserveAspectRatio="none">
        <path d="${path}" fill="none" stroke="#003358" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  // ============================================================
  // Toast & Celebration Helpers
  // ============================================================

  function showToast(message, type = 'fire', duration = 3200) {
    const existing = document.querySelector('.voo-toast');
    if (existing) existing.remove();
    const t = document.createElement('div');
    t.className = `voo-toast voo-toast-${type}`;
    t.textContent = message;
    document.body.appendChild(t);
    requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 400);
    }, duration);
  }

  function spawnEmojiRain(emojis) {
    const count = 18;
    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        const el = document.createElement('span');
        el.className = 'voo-emoji-particle';
        el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
        el.style.left = `${8 + Math.random() * 84}vw`;
        el.style.top = `${10 + Math.random() * 50}vh`;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 1600);
      }, i * 60);
    }
  }

  function showFireCelebration(lang) {
    const isZh = (lang === i18n.zh);
    const msg = isZh ? '🔥 太棒了！你守住了這筆錢！FIRE 之路更近一步！' : '🔥 Amazing! You kept the money — one step closer to FIRE!';
    spawnEmojiRain(['🔥', '💰', '🚀', '🎉', '💎', '⭐']);
    showToast(msg, 'fire', 3800);
  }

  function showEncouragementToast(lang) {
    const isZh = (lang === i18n.zh);
    const msgs = isZh
      ? ['👍 沒關係！若無跳轉，請再次點選原本的結帳按鈕！', '😊 理性消費也是一種智慧！若未自動跳轉請再點一次！', '🤝 這次就買吧！若未自動跳轉請再點一次！']
      : ["👍 That's okay! If it didn't redirect, please click the checkout button again.", "😊 Intentional spending is smart spending!", "🤝 Go for it! Click checkout again if needed."];
    const msg = msgs[Math.floor(Math.random() * msgs.length)];
    showToast(msg, 'ok', 4000);
  }

  function showInterceptorModal(estUsd, originalButton, exactTarget = null) {
    if (document.getElementById('voo-interceptor-modal')) return;
    const lang = getLang();
    const overlay = document.createElement('div');
    overlay.id = 'voo-interceptor-modal';
    overlay.className = 'voo-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'voo-modal-title');
    overlay.dataset.vooEstUsd = String(Number(estUsd) > 0 ? estUsd : 0);

    const bodyHtml = buildInterceptorBodyHtml(estUsd);

    overlay.innerHTML = `
    <div class="voo-modal-box">
      <div class="voo-modal-title" id="voo-modal-title">${lang.wait}</div>
      ${bodyHtml}
      <div class="voo-btn-group">
        <button type="button" id="voo-btn-buy" class="voo-btn-buy">${lang.btnBuy}</button>
        <button type="button" id="voo-btn-save" class="voo-btn-save">${lang.btnSave}</button>
      </div>
    </div>
  `;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('active'));

    try {
      chrome.runtime.sendMessage({ action: 'getChartData', symbol: appSettings.ticker }, (res) => {
        const chartContainer = overlay.querySelector('#voo-modal-chart-container');
        if (chartContainer) {
          if (res && res.ok && res.data && res.data.length > 0) {
            chartContainer.innerHTML = renderSparkline(res.data);
            chartContainer.classList.remove('voo-chart-loading');
          } else {
            chartContainer.style.display = 'none'; // Hide if failed
          }
        }
      });
    } catch (e) { }

    const focusEl = overlay.querySelector('#voo-btn-save');
    if (focusEl) focusEl.focus();

    const closeModal = () => {
      overlay.classList.remove('active');
      setTimeout(() => overlay.remove(), 180);
      document.removeEventListener('keydown', onKey);
    };

    function onKey(ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeModal();
      }
    }
    document.addEventListener('keydown', onKey);

    overlay.querySelector('#voo-btn-save').addEventListener('click', () => {
      document.removeEventListener('keydown', onKey);
      const currentLang = getLang(); // Capture synchronously before any async work
      // Save data for the FIRE Dashboard
      // Save data for the FIRE Dashboard using sync storage (follows the user's Google account)
      chrome.storage.sync.get(['savedItems', 'totalSavedUsd'], (res) => {
        const savedItems = res.savedItems || [];

        // Normalize the amount to USD for consistent summation
        const exRate = getExchangeMultiplier();
        const currentCurrency = getPageCurrency();
        // If it's TWD, we multiply by the exchange rate to get USD equivalent
        const normalizedUsd = (currentCurrency === 'TWD') ? (Number(estUsd) * twdUsdRate) : Number(estUsd);

        const totalSavedUsd = (res.totalSavedUsd || 0) + normalizedUsd;

        const host = window.location.hostname;
        let storeName = host.replace(/^www\./i, '').split('.')[0];
        if (host.includes('amazon')) storeName = 'Amazon';
        else if (host.includes('momo')) storeName = 'Momo';
        else if (host.includes('pchome')) storeName = 'PChome';
        else if (host.includes('shopee')) storeName = 'Shopee';
        else if (host.includes('target')) storeName = 'Target';
        else if (host.includes('walmart')) storeName = 'Walmart';
        else if (host.includes('ebay')) storeName = 'eBay';
        else if (host.includes('bestbuy')) storeName = 'BestBuy';
        else if (host.includes('stubhub')) storeName = 'StubHub';
        else if (host.includes('ticketmaster')) storeName = 'Ticketmaster';
        else if (host.includes('seatgeek')) storeName = 'SeatGeek';
        else storeName = storeName.charAt(0).toUpperCase() + storeName.slice(1);

        function extractEventOrPageTitle() {
          const lowerHost = host.toLowerCase();
          const isTicket = lowerHost.includes('ticketmaster') || lowerHost.includes('seatgeek') || lowerHost.includes('stubhub');
          
          if (isTicket) {
            const selectors = [
              '[data-testid*="event-title" i]',
              '[data-testid*="event-name" i]',
              '[data-testid*="eventName" i]',
              '[data-testid*="eventTitle" i]',
              '[class*="eventTitle" i]',
              '[class*="eventName" i]',
              '[class*="event-title" i]',
              '[class*="event-name" i]',
              '[class*="eventHeader" i]',
              '[class*="event-header" i]',
              'h1',
              'h2'
            ];
            for (const sel of selectors) {
              try {
                const el = document.querySelector(sel);
                if (el) {
                  const text = el.innerText.trim();
                  if (text && text.length > 3 && !/^\d{1,2}:\d{2}(\s|$)/.test(text) && !/checkout/i.test(text) && !/\d+\s+left/i.test(text)) {
                    return text;
                  }
                }
              } catch (_) {}
            }
          }
          
          let titleVal = document.title || '';
          if (/^\d{1,2}:\d{2}(\s|$)/.test(titleVal.trim()) || /checkout/i.test(titleVal.trim()) || titleVal.trim().length <= 5 || /\d+\s+left/i.test(titleVal)) {
            try {
              const h1 = document.querySelector('h1');
              if (h1 && h1.innerText.trim().length > 3) {
                return h1.innerText.trim();
              }
            } catch (_) {}
          }
          return titleVal;
        }

        savedItems.push({
          timestamp: Date.now(),
          amount: Number(estUsd), // Original amount on page
          currency: currentCurrency,
          usdAmount: normalizedUsd, // Normalized for global stats
          ticker: appSettings.ticker,
          shares: (Number(estUsd) * exRate) / Number(appSettings.price),
          url: window.location.href,
          title: extractEventOrPageTitle(),
          store: storeName
        });

        // Limit history to 1000 items to stay within chrome.storage.sync limits
        if (savedItems.length > 1000) savedItems.shift();

        // sync storage ensures data persists across devices (Google Account)
        chrome.storage.sync.set({ savedItems, totalSavedUsd }, () => {
          overlay.classList.remove('active');
          setTimeout(() => {
            overlay.remove();
            showFireCelebration(currentLang);
            setTimeout(() => {
              chrome.runtime.sendMessage({ action: 'openDashboard' });
              // Redirect the shopping page so user doesn't stay on the checkout page
              const ticker = appSettings.ticker || 'VOO';
              window.location.href = benchmarkTickerExternalUrl(ticker);
            }, 800);
          }, 160);
        });
      });
    });

    overlay.querySelector('#voo-btn-buy').addEventListener('click', () => {
      const currentLang = getLang();
      overlay.classList.remove('active');
      setTimeout(() => {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        showEncouragementToast(currentLang);
        bypassInterceptor = true;

        const targetBtn = originalButton || exactTarget;
        const exact = exactTarget || originalButton;
        if (exact || targetBtn) {
          setTimeout(() => {
            const prepareEl = (el) => {
              if (!el) return;
              try {
                if (el.disabled) el.disabled = false;
                el.removeAttribute('disabled');
                el.removeAttribute('aria-disabled');
                el.classList.remove('disabled');
                el.style.pointerEvents = 'auto';
              } catch (_) {}
            };

            prepareEl(exact);
            prepareEl(targetBtn);

            const clickEl = (el) => {
              if (!el) return;
              const opts = { bubbles: true, cancelable: true, view: window };
              el.dispatchEvent(new PointerEvent('pointerdown', opts));
              el.dispatchEvent(new MouseEvent('mousedown', opts));
              el.dispatchEvent(new PointerEvent('pointerup', opts));
              el.dispatchEvent(new MouseEvent('mouseup', opts));
              el.dispatchEvent(new MouseEvent('click', opts));
              el.click();
            };

            if (exact) clickEl(exact);
            if (targetBtn && targetBtn !== exact) {
              clickEl(targetBtn);
            }

            // 2. Fallback form submission (for standard HTML forms)
            const form = (targetBtn || exact)?.closest('form');
            if (form) {
              const submitEl = targetBtn || exact;
              if (submitEl && (submitEl.type === 'submit' || submitEl.tagName === 'BUTTON' || submitEl.getAttribute('type') === 'submit')) {
                if (typeof form.requestSubmit === 'function') {
                  try {
                    form.requestSubmit(submitEl);
                  } catch (e) { }
                } else {
                  try {
                    form.submit();
                  } catch (e) { }
                }
              }
            }

            // 3. Forced Navigation Fallback for <a> tags
            const a = (targetBtn || exact)?.closest('a');
            if (a && a.href && !a.href.startsWith('javascript:')) {
              setTimeout(() => {
                if (window.location.href.split('#')[0] === a.href.split('#')[0]) {
                  window.location.assign(a.href);
                }
              }, 400);
            }
          }, 120);
        }

        // We permanently bypass the interceptor for this page session since the user chose to buy
        // They can just click the button again manually if our simulated click above didn't work.
      }, 160);
    });
  }

  /** For Popup: Read-only estimation, does not write to DOM; still usable when extension is disabled. */
  function parseShopCandidateLoose(v) {
    const x = Number(v);
    const lo = minShopAmount();
    const hi = isTaiwanBenchmarkTicker() ? 50000000 : 250000;
    if (!Number.isFinite(x) || x < lo || x > hi) return null;
    return x;
  }

  /** 
   * "Truthful Page Price Extraction":
   * 1. Priority check for site-specific siteConfig.
   * 2. Check official metadata (itemprop="price").
   * 3. Finally, generic scanning engine.
   */
  function estimatePageUsdBestEffort() {
    if (!document.body) return null;
    const host = window.location.hostname;

    // 1. Priority use of site-specific configurations
    const currentSite = siteConfigs.find(c => host.includes(c.domain));
    if (currentSite) {
      const cleanSelector = currentSite.priceSelector.replace(/:not\(\[data-voo-processed\]\)/g, '');
      const els = document.querySelectorAll(cleanSelector);
      const hero = pickHeroPriceCandidate(Array.from(els), currentSite.priceExtract);
      if (hero && hero.val > 0) return hero.val;
    }

    // 2. Fetch official standard product tags (itemprop="price") or Schema.org JSON-LD
    const itemProps = document.querySelectorAll('[itemprop="price"], [property="product:price:amount"]');
    for (const el of itemProps) {
      if (!priceLikelyVisible(el)) continue;
      const c = el.getAttribute('content') || el.getAttribute('value');
      if (c && !isNaN(parseFloat(c))) return parseFloat(c);
      const val = extractShopAmountFromString(el.innerText || el.textContent);
      if (val) return val;
    }

    // 2b. Attempt to parse JSON-LD for unknown sites
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        const json = JSON.parse(s.textContent);
        const offers = json?.offers || json?.mainEntity?.offers;
        if (offers) {
          const p = Array.isArray(offers) ? offers[0].price : offers.price;
          if (p && !isNaN(parseFloat(p))) return parseFloat(p);
        }
      }
    } catch (_) { }

    const scored = [];
    const push = (v, weight) => {
      const x = parseShopCandidateLoose(v);
      if (x != null) scored.push({ v: x, w: weight });
    };

    document.querySelectorAll('meta[property="product:price:amount"], meta[property="og:price:amount"]').forEach((m) => {
      push(parseFloat(m.getAttribute('content')), 1000000);
    });

    // 3. Only if above fail, proceed with generic scanning (limited range, excluding likely ad areas)
    try {
      document.querySelectorAll(SEMANTIC_PRICE_SELECTOR.replace(/:not\(\[data-voo-processed\]\)/g, '')).forEach((el) => {
        if (!priceLikelyVisible(el)) return;
        // Ignore if in ad areas or navigation bars
        if (el.closest('header, footer, nav, aside, [class*="banner" i], [class*="promo" i], [class*="recommend" i], [class*="event" i], [class*="campaign" i], [id*="banner" i], [id*="promo" i]')) return;

        const st = window.getComputedStyle(el);
        if (st.textDecoration && st.textDecoration.includes('line-through')) return;

        const t = el.getAttribute('content') || el.innerText || el.textContent || '';
        const parentText = el.parentElement ? el.parentElement.innerText || el.parentElement.textContent : '';
        if (PROMO_REGEX.test(t.slice(0, 300)) || PROMO_REGEX.test((parentText || '').slice(0, 300))) return;

        const x = extractShopAmountFromString(t);
        if (x == null) return;

        const r = el.getBoundingClientRect();
        const fs = parseFloat(st.fontSize) || 16;
        const isBold = parseInt(st.fontWeight) >= 600 || st.fontWeight === 'bold' ? 1.2 : 1;
        const top = Math.max(0, r.top);

        let fontScore = Math.pow(fs / 16, 3) * 1000;
        let posScore = 1;
        // Prices are usually at the top of the page; weight decreases significantly for bottom half to avoid recommended items.
        if (top > 800) posScore = 0.5;
        if (top > 1500) posScore = 0.1;

        push(x, fontScore * isBold * posScore * 1.2);
      });
    } catch (_) { }

    if (!scored.length) return null;
    scored.sort((a, b) => b.w - a.w);
    return scored[0].v;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.action === 'forceShowWidget') {
      chrome.storage.local.remove('voo_hide_until', () => {
        try { sessionStorage.removeItem('voo_widget_hidden'); } catch (_) { }

        if (!document.getElementById('voo-widget-btn')) {
          renderWidget();
        } else {
          showWidgetCompletely();
        }

        setTimeout(() => {
          const lang = getLang();
          const isZh = lang === i18n.zh;
          showWidgetPanel(lang, isZh);
        }, 50);
      });
      sendResponse({ success: true });
      return true;
    }
    if (msg && msg.action === 'jdctGetPageUsd') {
      try {
        const usd = estimatePageUsdBestEffort();
        sendResponse({ usd: usd != null ? usd : null });
      } catch (_) {
        sendResponse({ usd: null });
      }
      return true;
    }
    if (msg && msg.action === 'jdctGetPageLang') {
      try {
        const lang =
          document.documentElement.getAttribute('lang') ||
          document.documentElement.lang ||
          navigator.language ||
          '';
        sendResponse({ lang: String(lang).trim() });
      } catch (_) {
        sendResponse({ lang: '' });
      }
      return true;
    }
    return false;
  });

})();
