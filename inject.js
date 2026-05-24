(function () {
  const SINGLE_ORDER_URL_RE = /getOrder|order\/details|order_id=|\/o2_api\/.*order/i;
  const ORDERS_LIST_URL_RE  = /\/merchant-api\/orders\/get-all/i;

  // ── Shape helpers ─────────────────────────────────────────────────────────
  function looksLikeSingleOrder(json) {
    return json && json.status === 'success' && json.order && json.order.id && json.order.creator;
  }

  function extractOrdersList(json) {
    if (!json || typeof json !== 'object') return null;
    const candidates = [
      json.entities,
      json.orders,
      json.data?.entities,
      json.data?.orders,
      json.result?.entities,
      json.response?.entities
    ];
    for (const c of candidates) {
      if (Array.isArray(c)) return c;
    }
    return null;
  }

  function looksLikeFullOrder(o) {
    return o && o.id && (o.creator || o.cartDetails || o.state);
  }

  // ── Bridges to content script ────────────────────────────────────────────
  function forwardSingle(json) {
    try {
      if (looksLikeSingleOrder(json)) {
        window.postMessage({ type: 'ZOH_ORDER', payload: json }, window.location.origin);
      }
    } catch (_) {}
  }

  function forwardList(json, url) {
    try {
      const list = extractOrdersList(json);
      if (!list || list.length === 0) return;
      // Skip the minimal "select=tab_id,updated_timestamp" shape
      if (!looksLikeFullOrder(list[0])) return;
      window.postMessage({
        type: 'ZOH_ORDERS_LIST',
        orders: list,
        source: 'intercept',
        url
      }, window.location.origin);
    } catch (_) {}
  }

  function handleResponseBody(url, json) {
    if (SINGLE_ORDER_URL_RE.test(url)) forwardSingle(json);
    if (ORDERS_LIST_URL_RE.test(url)) forwardList(json, url);
    // Generic fallback: anything that looks like a single order, forward it
    if (looksLikeSingleOrder(json)) forwardSingle(json);
  }

  // ── Patch fetch ──────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      if (
        SINGLE_ORDER_URL_RE.test(url) ||
        ORDERS_LIST_URL_RE.test(url) ||
        /json/i.test(ct)
      ) {
        res.clone().json().then((j) => handleResponseBody(url, j)).catch(() => {});
      }
    } catch (_) {}
    return res;
  };

  // ── Patch XHR ────────────────────────────────────────────────────────────
  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let _url = '';
    const open = xhr.open;
    xhr.open = function (m, u, ...rest) { _url = u; return open.call(this, m, u, ...rest); };
    xhr.addEventListener('load', () => {
      try {
        const isText = xhr.responseType === '' || xhr.responseType === 'text';
        if (!isText) return;
        const ct = (xhr.getResponseHeader && xhr.getResponseHeader('content-type')) || '';
        if (
          SINGLE_ORDER_URL_RE.test(_url) ||
          ORDERS_LIST_URL_RE.test(_url) ||
          /json/i.test(ct)
        ) {
          handleResponseBody(_url, JSON.parse(xhr.responseText));
        }
      } catch (_) {}
    });
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  // ── window.store bridge (live Redux feed) ────────────────────────────────
  (function bridgeStore() {
    const STORE_KEYS = ['store', '__REDUX_STORE__', '__store', 'reduxStore'];
    let store = null;
    let lastSent = 0;
    let scheduled = false;
    let tries = 0;
    const SEND_THROTTLE_MS = 400;
    const MAX_TRIES = 240;

    function findStore() {
      for (const k of STORE_KEYS) {
        const s = window[k];
        if (s && typeof s.subscribe === 'function' && typeof s.getState === 'function') return s;
      }
      return null;
    }

    function send() {
      if (!store) return;
      scheduled = false;
      lastSent = Date.now();
      try {
        const state = store.getState() || {};
        const orders = Array.isArray(state.orders) ? state.orders : null;
        if (!orders) return;
        window.postMessage({
          type: 'ZOH_ORDERS_LIST',
          orders,
          source: 'store',
          resMeta: state.restaurantsMetaState || null,
          selectedResId: state.selectedResId || null
        }, window.location.origin);
      } catch (_) {}
    }

    function schedule() {
      if (scheduled) return;
      const wait = Math.max(0, SEND_THROTTLE_MS - (Date.now() - lastSent));
      scheduled = true;
      setTimeout(send, wait);
    }

    function hook() {
      const s = findStore();
      if (s) {
        store = s;
        try { store.subscribe(schedule); schedule(); } catch (_) {}
        // eslint-disable-next-line no-console
        console.log('[ZOH] hooked window store');
        return true;
      }
      return false;
    }

    const iv = setInterval(() => {
      if (hook() || ++tries >= MAX_TRIES) clearInterval(iv);
    }, 250);
  })();
})();
