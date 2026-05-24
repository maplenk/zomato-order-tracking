// ─── Boot: inject main-world script + panel CSS ──────────────────────────────
const s = document.createElement('script');
s.src = chrome.runtime.getURL('inject.js');
s.onload = () => s.remove();
(document.head || document.documentElement).appendChild(s);

const link = document.createElement('link');
link.rel = 'stylesheet';
link.href = chrome.runtime.getURL('panel.css');
document.documentElement.appendChild(link);

// Read mute preference early — referenced by panel HTML below
let muted = false;
try { muted = localStorage.getItem('zoh:muted') === '1'; } catch (_) {}

// ─── Panel + launcher ─────────────────────────────────────────────────────────
const panel = document.createElement('div');
panel.id = 'zoh-panel';
panel.innerHTML = `
  <div class="zoh-header">
    <span class="zoh-title">Order Helper</span>
    <span class="zoh-status" id="zoh-status"></span>
    <button id="zoh-mute" title="${muted ? 'Unmute rider alerts' : 'Mute rider alerts'}">${muted ? '🔕' : '🔔'}</button>
    <button id="zoh-refresh" title="Refresh now">↻</button>
    <button id="zoh-close" title="Hide">×</button>
  </div>
  <div id="zoh-body"><div class="zoh-empty">Loading orders…</div></div>
`;
document.documentElement.appendChild(panel);

const launcher = document.createElement('button');
launcher.id = 'zoh-launcher';
launcher.title = 'Open Order Helper';
launcher.textContent = 'Order Helper';
document.documentElement.appendChild(launcher);

function openPanel()  { panel.classList.add('open');    launcher.classList.remove('show'); }
function closePanel() { panel.classList.remove('open'); launcher.classList.add('show'); }
document.getElementById('zoh-close').onclick = closePanel;
document.getElementById('zoh-refresh').onclick = () => pollOnce(true);
document.getElementById('zoh-mute').onclick = () => {
  muted = !muted;
  try { localStorage.setItem('zoh:muted', muted ? '1' : '0'); } catch (_) {}
  const btn = document.getElementById('zoh-mute');
  btn.textContent = muted ? '🔕' : '🔔';
  btn.title = muted ? 'Unmute rider alerts' : 'Mute rider alerts';
  if (!muted) playRiderChime();
};
launcher.onclick = openPanel;
launcher.classList.add('show');

// ─── Config ───────────────────────────────────────────────────────────────────
// Only states we care about — picked-up / dispatched are inspected manually.
const STATES = ['NEW', 'ACCEPTED', 'PREPARING', 'READY'];
const POLL_INTERVAL_MS = 30000;
const STALE_AFTER_MS = 60000;
const ORDER_TTL_MS = 120000;       // 4× poll interval — survives 3 missed polls
const DEBUG = false;               // set true to see [ZOH] diagnostic logs

// ─── Sound (rider assignment chime) ──────────────────────────────────────────
// `muted` is declared earlier so the panel HTML can reference it on first render.

// Per-order memory of last known rider state (boolean). Persisted to
// sessionStorage so a page refresh doesn't re-chime existing assignments.
const lastRiderState = new Map();
try {
  const saved = JSON.parse(sessionStorage.getItem('zoh:riderState') || '[]');
  for (const [k, v] of saved) lastRiderState.set(k, v);
} catch (_) {}

function persistRiderState() {
  try {
    sessionStorage.setItem('zoh:riderState', JSON.stringify(Array.from(lastRiderState.entries())));
  } catch (_) {}
}

function hasRider(o) {
  if (!o) return false;
  if (o.riderAssigned) return true;
  const r = o.supportingRiderDetails;
  if (Array.isArray(r) && r.length) return true;
  if (r && typeof r === 'object' && (r[0] || r['0'])) return true;
  return false;
}

let audioCtx = null;
function playRiderChime() {
  if (muted) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const t0 = audioCtx.currentTime;
    // Two-note rising chime: A5 → E6
    const notes = [
      { f: 880,  s: 0.00, d: 0.20 },
      { f: 1319, s: 0.13, d: 0.34 }
    ];
    for (const n of notes) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = n.f;
      const start = t0 + n.s;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.22, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + n.d);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + n.d + 0.05);
    }
  } catch (e) {
    if (DEBUG) console.warn('[ZOH] chime failed', e);
  }
}
const GROUPS = [
  { id: 'preparing', label: 'Preparing', states: ['NEW', 'ACCEPTED', 'PREPARING'] },
  { id: 'ready',     label: 'Ready',     states: ['READY'] }
];

// ─── State ────────────────────────────────────────────────────────────────────
let ordersById = new Map();          // id → order (merged from REST + store + intercept)
let resMeta = null;                  // restaurantsMetaState (for outlet lat/lng)
let selectedResId = null;
let lastUpdateAt = 0;
let lastSource = 'rest';             // 'rest' | 'store' | 'intercept'
let expanded = new Set();            // order ids whose card is expanded
let authError = false;
let pollTimer = null;
let tickTimer = null;

// ─── Inbound messages from inject.js ──────────────────────────────────────────
window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== window.location.origin) return;
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'ZOH_ORDERS_LIST') {
    if (msg.resMeta) resMeta = msg.resMeta;
    if (msg.selectedResId) selectedResId = msg.selectedResId;
    mergeOrders(msg.orders || [], 'store');
  } else if (msg.type === 'ZOH_ORDER') {
    const o = msg.payload?.order;
    if (o && o.id) mergeOrders([o], 'intercept');
  }
});

function mergeOrders(list, source) {
  const now = Date.now();
  let added = 0;
  const transitions = [];
  for (const o of list) {
    if (!o || !o.id) continue;
    const key = String(o.id);
    const prev = ordersById.get(key);
    const merged = prev ? { ...prev, ...o } : { ...o };
    merged.id = key;
    merged._zohStub = false;
    delete merged._zohStubState;
    merged._zohSeenAt = now;
    merged._zohFirstSeenAt = prev?._zohFirstSeenAt || now;
    if (source === 'intercept' || source === 'detail') merged._zohViewedAt = now;
    ordersById.set(key, merged);
    added++;

    // Rider-assignment transition detection — only counts when we have real data.
    // First real observation just records baseline; chime fires only on no→yes flip.
    const isRealData = !!(merged.creator || merged.cartDetails);
    if (isRealData) {
      const nowHas = hasRider(merged);
      const lastHad = lastRiderState.get(key);
      if (lastHad === undefined) {
        lastRiderState.set(key, nowHas);
      } else if (!lastHad && nowHas) {
        transitions.push(merged);
        lastRiderState.set(key, nowHas);
      } else if (lastHad !== nowHas) {
        lastRiderState.set(key, nowHas);
      }
    }
  }
  if (transitions.length) {
    playRiderChime();
    if (DEBUG) console.log(`[ZOH] rider assigned: ${transitions.map((o) => o.id).join(', ')}`);
  }
  persistRiderState();
  lastUpdateAt = now;
  lastSource = source;
  authError = false;
  if (DEBUG) console.log(`[ZOH] merge from ${source}: ${added} orders, map size=${ordersById.size}`);
  render();
}

// Mark an order as seen this tick without overwriting its fields (used when
// get-all returns bare IDs — keeps the entry alive in the cache).
function markSeen(ids, source) {
  const now = Date.now();
  for (const id of ids) {
    const key = String(id);
    const prev = ordersById.get(key);
    if (prev) {
      prev._zohSeenAt = now;
    } else {
      // Stub entry — no details yet, but we know it exists
      ordersById.set(key, {
        id: key, _zohStub: true, _zohSeenAt: now, _zohFirstSeenAt: now,
        _zohStubState: source._zohState || 'UNKNOWN'
      });
    }
  }
  lastUpdateAt = now;
  lastSource = source.label || 'rest';
  authError = false;
  if (DEBUG) console.log(`[ZOH] mark seen (${source.label}): ${ids.length} ids, map size=${ordersById.size}`);
}

const VIEWED_TTL_MS = 15 * 60 * 1000;  // recently viewed orders stay 15 min

function expireStaleOrders() {
  const cutoff = Date.now() - ORDER_TTL_MS;
  const viewedCutoff = Date.now() - VIEWED_TTL_MS;
  let removed = 0;
  for (const [id, o] of Array.from(ordersById.entries())) {
    const seenStale = (o._zohSeenAt || 0) < cutoff;
    const viewedStale = (o._zohViewedAt || 0) < viewedCutoff;
    if (seenStale && viewedStale) { ordersById.delete(id); removed++; }
  }
  if (removed && DEBUG) console.log(`[ZOH] expired ${removed} stale orders`);
}

// ─── Order detail auto-fetch ──────────────────────────────────────────────────
const DETAIL_REFRESH_MS = 25000;
const detailLastFetched = new Map();

async function fetchOrderDetail(id, force = false) {
  if (!force) {
    const last = detailLastFetched.get(id) || 0;
    if (Date.now() - last < DETAIL_REFRESH_MS) return null;
  }
  detailLastFetched.set(id, Date.now());
  try {
    const r = await fetch(`/merchant-api/orders/order-details?tab_id=${encodeURIComponent(id)}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    });
    if (r.status === 401 || r.status === 403) throw new Error('auth');
    if (!r.ok) throw new Error('http_' + r.status);
    const json = await r.json();
    if (json?.status === 'success' && json.order && json.order.id) {
      mergeOrders([json.order], 'detail');
      return json.order;
    }
    return null;
  } catch (e) {
    if (DEBUG) console.warn('[ZOH] detail fetch failed', id, e?.message || e);
    return null;
  }
}

async function fillStubsAndStaleDetails() {
  const stubIds = [];
  const refreshIds = [];
  const cutoff = Date.now() - DETAIL_REFRESH_MS;
  for (const [id, o] of ordersById) {
    if (o._zohStub) stubIds.push(id);
    else if ((detailLastFetched.get(id) || 0) < cutoff) refreshIds.push(id);
  }
  // Stubs first — they're empty placeholders
  if (stubIds.length && DEBUG) console.log(`[ZOH] auto-filling ${stubIds.length} stub(s)`);
  await Promise.all(stubIds.map((id) => fetchOrderDetail(id, true)));
  // Then refresh known orders to keep rider/ETA fields current
  if (refreshIds.length) {
    const queue = refreshIds.slice();
    const worker = async () => { while (queue.length) await fetchOrderDetail(queue.shift(), false); };
    await Promise.all([worker(), worker(), worker()]);
  }
}

// ─── REST polling fallback / baseline ─────────────────────────────────────────
async function fetchActiveOrders() {
  const results = await Promise.allSettled(STATES.map(async (st) => {
    const r = await fetch(`/merchant-api/orders/get-all?state=${st}&delivery_mode=delivery,takeaway`, {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    });
    if (r.status === 401 || r.status === 403) throw new Error('auth');
    if (!r.ok) throw new Error('http_' + r.status);
    return { state: st, json: await r.json() };
  }));
  let auth = false;
  let ok = 0;
  const byState = {};
  for (const r of results) {
    if (r.status === 'rejected') {
      if (r.reason && r.reason.message === 'auth') auth = true;
      continue;
    }
    ok++;
    const { state, json } = r.value;
    const ents = json && (json.entities || json.orders || json.data?.entities || json.data?.orders);
    const arr = Array.isArray(ents) ? ents : [];
    const fullOrders = [];
    const bareIds = [];
    for (const e of arr) {
      if (e && typeof e === 'object' && (e.creator || e.cartDetails || e.state)) fullOrders.push(e);
      else if (e && (typeof e === 'string' || typeof e === 'number')) bareIds.push(String(e));
      else if (e && typeof e === 'object' && e.id && !e.creator) bareIds.push(String(e.id));
    }
    byState[state] = { fullOrders, bareIds, count: json?.count ?? arr.length };
    if (DEBUG) console.log(`[ZOH] ${state}: full=${fullOrders.length} ids=${bareIds.length} count=${byState[state].count}`);
  }
  return { auth, anyOk: ok > 0, byState };
}

async function pollOnce(force = false) {
  try {
    const result = await fetchActiveOrders();
    const { auth, anyOk, byState } = result;
    if (auth && !anyOk) { authError = true; render(); return; }
    // Per state, either we got full orders OR bare ids. Either way, mark seen.
    let totalFull = 0, totalIds = 0;
    for (const [state, entry] of Object.entries(byState)) {
      if (entry.fullOrders.length) {
        mergeOrders(entry.fullOrders.map((o) => ({ ...o, state: o.state || state })), 'rest');
        totalFull += entry.fullOrders.length;
      }
      if (entry.bareIds.length) {
        markSeen(entry.bareIds, { label: 'rest', _zohState: state });
        totalIds += entry.bareIds.length;
      }
    }
    expireStaleOrders();
    if (DEBUG) console.log(`[ZOH] poll done: full=${totalFull} ids=${totalIds}`);
    render();
    // Kick off detail backfill (fire-and-forget) so stub cards self-populate
    fillStubsAndStaleDetails().catch((e) => DEBUG && console.warn('[ZOH] fill failed', e));
  } catch (e) {
    if (DEBUG) console.warn('[ZOH] poll error', e);
    render(); // refresh status indicator
  }
}

function startPolling() {
  if (pollTimer) return;
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
}

// Tick once a second to update countdown timers and stale indicator
function startTicker() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    // cheap update: just timers + status
    updateTickingBits();
  }, 1000);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function dishesArray(o) {
  const d = o?.cartDetails?.items?.dishes;
  if (!d) return [];
  return Array.isArray(d) ? d : Object.values(d);
}

function parseDistanceFromAddress(addr) {
  if (!addr) return null;
  const m = String(addr).match(/\(([\d.]+)\s*kms?,\s*(\d+)\s*mins?\s*away\)/i);
  if (!m) return null;
  return { km: parseFloat(m[1]), mins: parseInt(m[2], 10) };
}

function haversineKm(a, b) {
  if (!a || !b) return null;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function outletLocationFor(o) {
  if (!resMeta) return null;
  const meta = resMeta[o.resId] || resMeta[selectedResId] || null;
  const loc = meta?.location || meta?.address?.location || meta?.coordinates || null;
  if (loc && Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude)) return loc;
  return null;
}

function distanceFor(o) {
  // Prefer the parsed "(X kms, Y mins away)" since Zomato pre-computes it server-side
  const parsed = parseDistanceFromAddress(o?.creator?.address?.address);
  if (parsed) return parsed;
  const outlet = outletLocationFor(o);
  const dest = o?.creator?.address?.location;
  const km = haversineKm(outlet, dest);
  if (km == null) return null;
  return { km, mins: Math.round(km * 3) };
}

function fmtCountdown(targetIso) {
  if (!targetIso || String(targetIso).startsWith('1970')) return '';
  const target = new Date(targetIso).getTime();
  if (!Number.isFinite(target)) return '';
  const diff = target - Date.now();
  const overdue = diff < 0;
  const abs = Math.abs(diff);
  const m = Math.floor(abs / 60000);
  const s = Math.floor((abs % 60000) / 1000);
  return (overdue ? '+' : '') + m + ':' + String(s).padStart(2, '0');
}

function instructionsFor(o) {
  const msgs = Array.isArray(o?.orderMessages) ? o.orderMessages : [];
  return msgs
    .filter((m) => m && m.messageTag && /order_top|instruction|note/i.test(m.messageTag))
    .map((m) => (typeof m.value === 'string' ? m.value : m.value?.message))
    .filter(Boolean);
}

function groupOrders() {
  const all = Array.from(ordersById.values());
  const activeStates = new Set(GROUPS.flatMap((g) => g.states));
  const groups = GROUPS.map((g) => ({ ...g, orders: [] }));
  const recent = [];
  for (const o of all) {
    const state = o.state || o._zohStubState;
    if (activeStates.has(state)) {
      const g = groups.find((g) => g.states.includes(state));
      if (g) g.orders.push(o);
    } else if (o._zohViewedAt) {
      // Order not in any active group — keep it visible if user clicked it recently
      recent.push(o);
    }
  }
  for (const g of groups) g.orders.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  if (recent.length) {
    recent.sort((a, b) => (b._zohViewedAt || 0) - (a._zohViewedAt || 0));
    groups.push({ id: 'recent', label: 'Recently viewed', orders: recent.slice(0, 5) });
  }
  return groups;
}

function titleCase(s) {
  return String(s || '').toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function statePill(state) {
  const ok = ['DELIVERED', 'PICKED_UP', 'READY'];
  const warn = ['NEW'];
  const cls = ok.includes(state) ? 'ok' : warn.includes(state) ? 'warn' : 'muted';
  return `<span class="zoh-pill ${cls}">${escapeHtml(titleCase(state) || '—')}</span>`;
}

function riderOf(o) {
  return o?.supportingRiderDetails?.[0] || (o?.supportingRiderDetails && o.supportingRiderDetails['0']) || null;
}

function fmtMinShort(ms) {
  const abs = Math.abs(ms);
  const m = Math.floor(abs / 60000);
  const s = Math.floor((abs % 60000) / 1000);
  if (m === 0) return `${s}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function computeRiderEtaText(event, iso) {
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return '';
  const now = Date.now();
  switch (event) {
    case 'arriving': {
      const diff = target - now;
      if (diff > 0) return `Arriving in ${fmtMinShort(diff)}`;
      return `Should be here · ${fmtMinShort(-diff)} late`;
    }
    case 'arrived':   return `At outlet · ${fmtMinShort(now - target)} ago`;
    case 'picked_up': return `Picked up · ${fmtMinShort(now - target)} ago`;
    case 'delivered': return 'Delivered';
    case 'assigned':  return `Assigned · ${fmtMinShort(now - target)} ago`;
    default: return '';
  }
}

function riderEvent(rider) {
  const pick = (iso, event) => {
    if (!iso || String(iso).startsWith('1970')) return null;
    return { event, iso, text: computeRiderEtaText(event, iso) };
  };
  return (
    pick(rider.deliveredAt, 'delivered') ||
    pick(rider.pickedUp,    'picked_up') ||
    pick(rider.riderArrivedAt, 'arrived') ||
    pick(rider.pickup || rider.expectedPickupTime, 'arriving') ||
    pick(rider.assignedAt,  'assigned') ||
    { event: '', iso: '', text: rider.riderStatus || 'En route' }
  );
}

function renderRiderStrip(o) {
  const rider = riderOf(o);
  const needsRider = o.state === 'READY' || o.state === 'PREPARING' || o.state === 'NEW' || o.state === 'ACCEPTED';
  if (rider) {
    const ev = riderEvent(rider);
    const dataAttrs = ev.iso ? `data-event="${ev.event}" data-target="${escapeHtml(ev.iso)}"` : '';
    return `
      <div class="zoh-rider-strip ok">
        <span class="zoh-rider-ico">🛵</span>
        <span class="zoh-rider-name">${escapeHtml(rider.name || 'Rider')}</span>
        ${rider.phone ? `<a class="zoh-rider-phone" href="tel:${escapeHtml(rider.phone)}">${escapeHtml(rider.phone)}</a>` : ''}
        ${ev.iso || ev.text ? `<span class="zoh-rider-eta" ${dataAttrs}>${escapeHtml(ev.text)}</span>` : ''}
      </div>`;
  }
  if (needsRider) {
    return `
      <div class="zoh-rider-strip alert">
        <span class="zoh-rider-ico">⚠️</span>
        <span class="zoh-rider-name">No rider assigned yet</span>
      </div>`;
  }
  return '';
}

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

// Reject any URL whose scheme isn't http/https. Prevents javascript:/data: XSS
// via untrusted href values that pass through the network from upstream.
function safeUrl(u) {
  if (!u) return null;
  try {
    const url = new URL(u, location.origin);
    return (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : null;
  } catch (_) { return null; }
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function render() {
  if (authError) { renderAuthError(); return; }
  const groups = groupOrders();
  const total = groups.reduce((n, g) => n + g.orders.length, 0);
  if (!total) {
    document.getElementById('zoh-body').innerHTML =
      `<div class="zoh-empty">No active orders.<br><small>Auto-refreshing every ${POLL_INTERVAL_MS / 1000}s</small></div>`;
    updateStatus();
    return;
  }

  const html = groups
    .filter((g) => g.orders.length > 0)
    .map((g) => `
      <section class="zoh-group" data-group="${g.id}">
        <header class="zoh-group-head">
          <span>${escapeHtml(g.label)}</span>
          <span class="zoh-group-count">${g.orders.length}</span>
        </header>
        <div class="zoh-group-body">
          ${g.orders.map(renderCard).join('')}
        </div>
      </section>
    `)
    .join('');

  document.getElementById('zoh-body').innerHTML = html;
  wireCardEvents();
  updateStatus();
}

function renderCard(o) {
  if (o._zohStub) return renderStubCard(o);
  const c = o.creator || {};
  const dishes = dishesArray(o);
  const itemCount = dishes.reduce((n, d) => n + (d.quantity || 1), 0);
  const dist = distanceFor(o);
  const distStr = dist ? `${dist.km.toFixed(1)} km · ~${dist.mins} min` : '';
  const instr = instructionsFor(o);
  const isExpanded = expanded.has(o.id);
  const rider = o?.supportingRiderDetails?.[0] || (o?.supportingRiderDetails && o.supportingRiderDetails['0']);
  const isDelivery = (o.deliveryMode || '').toLowerCase() === 'delivery';
  const isZomatoFleet = !!o.zomatoDelivered;

  const countdownTarget =
    (o.meta?.actionExpiryTime && !String(o.meta.actionExpiryTime).startsWith('1970'))
      ? o.meta.actionExpiryTime
      : o.expectedHandOverTime;

  const hasRiderNow = !!rider || !!o.riderAssigned;
  const needsRider = ['NEW','ACCEPTED','PREPARING','READY'].includes(o.state);
  const articleClass = [
    'zoh-card',
    isExpanded ? 'expanded' : '',
    hasRiderNow ? 'has-rider' : (needsRider ? 'no-rider' : '')
  ].filter(Boolean).join(' ');

  return `
  <article class="${articleClass}" data-id="${escapeHtml(o.id)}">
    ${renderRiderStrip(o)}
    <div class="zoh-card-top">
      <div class="zoh-card-left">
        <div class="zoh-row">
          ${statePill(o.state)}
          <span class="zoh-pill muted">#${escapeHtml(o.displayId || o.id)}</span>
          ${isDelivery
            ? `<span class="zoh-pill ${isZomatoFleet ? '' : 'muted'}">${isZomatoFleet ? 'Zomato' : 'Self'}</span>`
            : `<span class="zoh-pill muted">Takeaway</span>`}
        </div>
        <div class="zoh-name">${escapeHtml(c.originalName || c.name || 'Customer')}
          <span class="zoh-sub">· ${escapeHtml(c.orderCountDisplay || '')}</span>
        </div>
        <div class="zoh-meta">
          <span>${itemCount} item${itemCount === 1 ? '' : 's'}</span>
          ${distStr ? `<span>· ${escapeHtml(distStr)}</span>` : ''}
          ${o.otp ? `<span>· OTP <b>${escapeHtml(o.otp)}</b></span>` : ''}
        </div>
        ${instr.length ? `<div class="zoh-instr">${instr.map((t) => `📝 ${escapeHtml(t)}`).join('<br>')}</div>` : ''}
      </div>
      <div class="zoh-card-right">
        <div class="zoh-timer" data-target="${escapeHtml(countdownTarget || '')}">
          ${fmtCountdown(countdownTarget)}
        </div>
        <button class="zoh-toggle" data-id="${escapeHtml(o.id)}">${isExpanded ? '▾' : '▸'}</button>
      </div>
    </div>
    ${isExpanded ? renderCardDetails(o, rider) : ''}
  </article>`;
}

function renderStubCard(o) {
  const shortId = String(o.id).slice(-4);
  return `
  <article class="zoh-card stub" data-id="${escapeHtml(o.id)}">
    <div class="zoh-card-top">
      <div class="zoh-card-left">
        <div class="zoh-row">
          ${statePill(o._zohStubState || 'UNKNOWN')}
          <span class="zoh-pill muted">#${escapeHtml(shortId)}</span>
        </div>
        <div class="zoh-sub" style="margin-top:8px;">
          <span class="zoh-spinner"></span> Loading details…
        </div>
      </div>
    </div>
  </article>`;
}

function renderCardDetails(o, rider) {
  const c = o.creator || {};
  const dishes = dishesArray(o);
  const items = dishes.map((d) => {
    const cust = (d.customisations || []).map((x) => x.name).filter(Boolean).join(', ');
    return `<li>
      <span>${d.quantity} × ${escapeHtml(d.name)}${cust ? ` <em>· ${escapeHtml(cust)}</em>` : ''}</span>
      <span>${escapeHtml(d.displayCost || ('₹' + (d.totalCost ?? '')))}</span>
    </li>`;
  }).join('');
  const subtotal = o.cartDetails?.subtotal?.amountDetails?.displayCost || '';
  const total    = o.cartDetails?.total?.amountDetails?.displayCost || '';
  const discount = o.cartDetails?.discountApplied?.discounts?.[0]?.discount?.displayCost || '';
  const addr = c.address?.address || '—';
  const loc  = c.address?.location;

  return `
    <div class="zoh-card-details">
      <div class="zoh-section">
        <div class="zoh-label">Address</div>
        <div>${escapeHtml(addr)}</div>
        ${(() => {
          const lat = Number(loc?.latitude), lng = Number(loc?.longitude);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
          const url = safeUrl(`https://www.google.com/maps?q=${lat},${lng}`);
          return url ? `<a class="zoh-link" target="_blank" rel="noopener" href="${escapeHtml(url)}">Open in Maps</a>` : '';
        })()}
      </div>
      <div class="zoh-section">
        <div class="zoh-label">Items</div>
        <ul class="zoh-items">${items || '<li class="zoh-sub">No items</li>'}</ul>
        ${subtotal ? `<div class="zoh-row split"><span>Subtotal</span><span>${escapeHtml(subtotal)}</span></div>` : ''}
        ${discount ? `<div class="zoh-row split discount"><span>Discount</span><span>${escapeHtml(discount)}</span></div>` : ''}
        ${total ? `<div class="zoh-row split total"><span>Total</span><span>${escapeHtml(total)}</span></div>` : ''}
      </div>
      ${rider ? `
      <div class="zoh-section">
        <div class="zoh-label">Rider</div>
        <div class="zoh-row split">
          <span>${escapeHtml(rider.name || '')}</span>
          <span>${escapeHtml(rider.riderStatus || '')}</span>
        </div>
        ${rider.phone ? `<a class="zoh-link" href="tel:${escapeHtml(rider.phone)}">${escapeHtml(rider.phone)}</a>` : ''}
      </div>` : ''}
      ${(() => {
        const url = safeUrl(c.profileUrl);
        return url ? `<a class="zoh-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">View Zomato profile →</a>` : '';
      })()}
    </div>
  `;
}

function wireCardEvents() {
  document.querySelectorAll('.zoh-toggle').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      render();
    });
  });
  document.querySelectorAll('.zoh-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      const id = card.getAttribute('data-id');
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      render();
    });
  });
}

function updateTickingBits() {
  document.querySelectorAll('.zoh-timer').forEach((el) => {
    const t = el.getAttribute('data-target');
    if (!t) return;
    el.textContent = fmtCountdown(t);
    const diff = new Date(t).getTime() - Date.now();
    el.classList.toggle('overdue', diff < 0);
  });
  document.querySelectorAll('.zoh-rider-eta').forEach((el) => {
    const event = el.getAttribute('data-event');
    const iso = el.getAttribute('data-target');
    if (!event || !iso) return;
    el.textContent = computeRiderEtaText(event, iso);
  });
  updateStatus();
}

function updateStatus() {
  const el = document.getElementById('zoh-status');
  if (!el) return;
  if (!lastUpdateAt) { el.textContent = ''; el.className = 'zoh-status'; return; }
  const age = Date.now() - lastUpdateAt;
  const stale = age > STALE_AFTER_MS;
  const ago = age < 5000 ? 'just now'
    : age < 60000 ? Math.round(age / 1000) + 's ago'
    : Math.round(age / 60000) + 'm ago';
  el.textContent = `${lastSource} · ${ago}`;
  el.className = 'zoh-status' + (stale ? ' stale' : '');
}

function renderAuthError() {
  document.getElementById('zoh-body').innerHTML = `
    <div class="zoh-empty">
      <div style="font-size:24px;margin-bottom:8px;">🔒</div>
      Session expired.<br>
      <small>Reload the dashboard tab to re-authenticate.</small>
      <div style="margin-top:12px;">
        <button class="zoh-link" id="zoh-retry" style="background:none;border:0;cursor:pointer;">Retry</button>
      </div>
    </div>`;
  const r = document.getElementById('zoh-retry');
  if (r) r.onclick = () => pollOnce(true);
  updateStatus();
}

// ─── Kick off ────────────────────────────────────────────────────────────────
function boot() {
  startPolling();
  startTicker();
  openPanel();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
