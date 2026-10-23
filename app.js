// M-A Building Field Orders — single-page app (no build step needed)
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const CFG = window.APP_CONFIG || {};
const $app = document.getElementById('app');
const $tabbar = document.getElementById('tabbar');
const $user = document.getElementById('topbar-user');
document.getElementById('brand-name').textContent = CFG.APP_NAME || 'Field Orders';
document.title = `${CFG.APP_NAME || 'Field Orders'} · ${CFG.COMPANY_NAME || ''}`;
document.getElementById('company-name').textContent = CFG.COMPANY_NAME || '';

// ---------------------------------------------------------------- light / dark theme
const THEME_KEY = 'fo-theme';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let themePref = (() => { try { return localStorage.getItem(THEME_KEY) || 'light'; } catch { return 'light'; } })();
function applyTheme(pref) {
  themePref = ['light', 'dark', 'system'].includes(pref) ? pref : 'light';
  try { localStorage.setItem(THEME_KEY, themePref); } catch {}
  const dark = themePref === 'dark' || (themePref === 'system' && darkQuery.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#0B1220' : '#F4F5F7');
}
darkQuery.addEventListener?.('change', () => { if (themePref === 'system') applyTheme('system'); });
applyTheme(themePref);
const initialsOf = (name) => String(name || '').trim().split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

// Supabase function that sends push notifications (the name at the end of its URL)
const NOTIFY_FN = CFG.NOTIFY_FUNCTION || 'hyper-responder';
const STATUSES = ['Pending', 'Approved', 'Ordered', 'Partially Delivered', 'Delivered', 'Rejected', 'Cancelled'];
const OPEN = ['Pending', 'Approved', 'Ordered', 'Partially Delivered'];

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const orderNo = (id) => 'MR-' + String(id).padStart(5, '0');
const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d.length === 10 ? d + 'T00:00:00' : d);
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const fmtQty = (n) => (Number.isInteger(Number(n)) ? String(Number(n)) : String(Number(n)));
const jobLabel = (j) => (j ? [j.job_number, j.name].filter(Boolean).join(' — ') : '—');
const badge = (s) => `<span class="badge ${esc(String(s).replace(/\s+/g, ''))}">${esc(s)}</span>`;
const $ = (sel, root = $app) => root.querySelector(sel);
const $$ = (sel, root = $app) => [...root.querySelectorAll(sel)];

let toastTimer;
function toast(msg, isErr = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), isErr ? 6000 : 3200);
}
const errMsg = (e) => (e && (e.message || e.error_description)) || String(e);

// ---------------------------------------------------------------- not configured yet
if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes('YOUR-PROJECT')) {
  $app.innerHTML = `<div class="card login"><h1>Almost there</h1>
    <p>Open <b>config.js</b> and paste in your Supabase project URL and anon key. See <b>README.md</b>, step 2.</p></div>`;
  throw new Error('APP_CONFIG not set');
}

const sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const state = { session: null, profile: null, jobsites: [], catalog: [], recovery: false, channel: null };
const isAdmin = () => state.profile?.role === 'admin';
const isStaff = () => ['admin', 'warehouse'].includes(state.profile?.role);
const isWarehouse = () => state.profile?.role === 'warehouse';
// the screen the app opens on: the queue for warehouse users, a new order for everyone else
const homeHash = () => (isWarehouse() ? '#/admin' : '#/new');
const uid = () => state.session?.user?.id;

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// ---------------------------------------------------------------- order draft (survives refresh)
const DRAFT_KEY = 'fo-draft-v1';
const blankDraft = () => ({ jobsite_id: '', needed_by: '', priority: 'Normal', delivery_method: 'Deliver to site', delivery_notes: '', items: [] });
let draft = (() => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)) || blankDraft(); } catch { return blankDraft(); } })();
const saveDraft = () => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch {} };

// ---------------------------------------------------------------- push notifications
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const vapidReady = () => CFG.VAPID_PUBLIC_KEY && !CFG.VAPID_PUBLIC_KEY.startsWith('YOUR-');

function b64ToUint8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function currentSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
async function saveSub(sub) {
  const j = sub.toJSON();
  const { error } = await sb.from('push_subscriptions')
    .upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_id: uid() }, { onConflict: 'endpoint' });
  return !error;
}
async function enablePush() {
  if (!vapidReady()) throw new Error('Push key not set in config.js yet (README step 5).');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked. Turn them on in your phone or browser settings.');
  const reg = await navigator.serviceWorker.ready;
  const opts = { userVisibleOnly: true, applicationServerKey: b64ToUint8(CFG.VAPID_PUBLIC_KEY) };
  let sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe(opts));
  if (!(await saveSub(sub))) {
    // device was registered to a different login — start fresh
    await sub.unsubscribe();
    sub = await reg.pushManager.subscribe(opts);
    if (!(await saveSub(sub))) throw new Error('Could not save notification settings.');
  }
}
async function disablePush() {
  const sub = await currentSub();
  if (sub) {
    await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
    await sub.unsubscribe();
  }
}
// Turn a Supabase function error into a plain-English reason
async function fnErrorText(error) {
  try {
    const body = await error.context.clone().json();
    const msg = body?.error || body?.message || body?.msg;
    if (msg) {
      if (/not found/i.test(msg)) return 'Supabase can’t find a function named “notify”. Check the function name is exactly notify (lowercase) and that it’s deployed.';
      if (/jwt/i.test(msg)) return `${msg}. In Supabase → Edge Functions → notify → Details, turn OFF “Verify JWT” (the function checks the login itself) and save.`;
      return msg;
    }
  } catch {}
  try { const t = await error.context.clone().text(); if (t) return t.slice(0, 300); } catch {}
  if (error?.name === 'FunctionsFetchError') return 'Couldn’t reach the “notify” function. It may not be deployed, or it crashed on startup. Check Supabase → Edge Functions → notify → Logs.';
  return error?.message || String(error);
}
const notify = (type, order_id) => sb.functions.invoke(NOTIFY_FN, { body: { type, order_id } }).catch(() => {});

// ---------------------------------------------------------------- data
async function loadBasics() {
  const [p, j, c] = await Promise.all([
    sb.from('profiles').select('*').eq('id', uid()).single(),
    sb.from('jobsites').select('*').eq('active', true).order('job_number', { nullsFirst: false }).order('name'),
    sb.from('catalog_items').select('*').eq('active', true).order('category').order('name'),
  ]);
  state.profile = p.data || null;
  if (state.profile?.theme) applyTheme(state.profile.theme);
  state.jobsites = j.data || [];
  state.catalog = c.data || [];
}
const ORDER_SELECT = '*, jobsite:jobsites(id, name, job_number, address), requester:profiles!orders_requested_by_fkey(full_name, email, phone), claimer:profiles!orders_claimed_by_fkey(full_name, email), order_items(*)';

// ---------------------------------------------------------------- router
const ICONS = {
  new: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
  orders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>',
  admin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 21h18M5 21V10l7-5 7 5v11M9 21v-6h6v6"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
};
function renderTabbar(active) {
  if (!state.session || state.recovery) { $tabbar.classList.add('hidden'); return; }
  const tabs = [['new', '#/new', 'New Order'], ['orders', '#/orders', 'My Orders']];
  if (isWarehouse()) tabs.unshift(['admin', '#/admin', 'Queue']);   // warehouse: Queue comes first
  else if (isAdmin()) tabs.push(['admin', '#/admin', 'Admin']);
  tabs.push(['settings', '#/settings', 'Account']);
  $tabbar.innerHTML = tabs.map(([k, href, label]) => `<a href="${href}" class="${active === k ? 'on' : ''}">${ICONS[k]}<span>${label}</span></a>`).join('');
  $tabbar.classList.remove('hidden');
}

async function route() {
  if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
  $app.classList.remove('wide');
  const parts = (location.hash.replace(/^#\/?/, '') || 'new').split('/');
  $user.textContent = state.profile ? initialsOf(state.profile.full_name || state.profile.email) : '';

  if (state.recovery) { renderTabbar(); return viewSetPassword(); }
  if (!state.session) { renderTabbar(); return viewLogin(); }
  if (!state.profile) {
    renderTabbar();
    $app.innerHTML = `<div class="card"><h1>Account not set up</h1><p>Your login works, but no profile was found. Ask an admin to check the setup (README step 3).</p><button class="btn secondary" id="so">Sign out</button></div>`;
    $('#so').onclick = () => sb.auth.signOut();
    return;
  }
  const [page, a, b] = parts;
  try {
    if (page === 'orders') { renderTabbar('orders'); return await viewMyOrders(); }
    if (page === 'order') { renderTabbar(isStaff() ? 'admin' : 'orders'); return await viewOrder(Number(a)); }
    if (page === 'admin' && isStaff()) { renderTabbar('admin'); return await viewAdmin(a || 'orders', b); }
    if (page === 'settings') { renderTabbar('settings'); return await viewSettings(); }
    renderTabbar('new');
    return viewNewOrder();
  } catch (e) {
    $app.innerHTML = `<div class="card"><h1>Something went wrong</h1><p class="error">${esc(errMsg(e))}</p><a class="btn secondary" href="#/new">Back</a></div>`;
  }
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- auth views
function viewLogin() {
  $app.innerHTML = `
  <div class="login">
    <img class="logo" src="icons/icon-192.png" alt="">
    <h1 style="text-align:center">${esc(CFG.COMPANY_NAME || '')} ${esc(CFG.APP_NAME || 'Field Orders')}</h1>
    <form class="card" id="f">
      <div class="field"><label for="em">Work email</label><input id="em" type="email" autocomplete="username" required></div>
      <div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required></div>
      <div class="error hidden" id="er"></div>
      <button class="btn block" style="margin-top:14px" id="go">Sign in</button>
      <div style="text-align:center;margin-top:10px"><button type="button" class="linkbtn" id="fg">Forgot password?</button></div>
    </form>
    <p class="sub" style="text-align:center">Need an account? Ask the office to set you up.</p>
  </div>`;
  const er = $('#er');
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    $('#go').disabled = true; er.classList.add('hidden');
    const { error } = await sb.auth.signInWithPassword({ email: $('#em').value.trim(), password: $('#pw').value });
    $('#go').disabled = false;
    if (error) { er.textContent = error.message; er.classList.remove('hidden'); }
  };
  $('#fg').onclick = async () => {
    const email = $('#em').value.trim();
    if (!email) { er.textContent = 'Type your email above first.'; er.classList.remove('hidden'); return; }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (error) toast(error.message, true); else toast('Check your email for a reset link.');
  };
}

function viewSetPassword() {
  $app.innerHTML = `
  <div class="login"><form class="card" id="f"><h1>Set a new password</h1>
    <div class="field"><label>New password</label><input id="p1" type="password" minlength="8" autocomplete="new-password" required></div>
    <div class="field"><label>Confirm password</label><input id="p2" type="password" minlength="8" autocomplete="new-password" required></div>
    <div class="error hidden" id="er"></div>
    <button class="btn block" style="margin-top:14px">Save password</button></form></div>`;
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    const er = $('#er');
    if ($('#p1').value !== $('#p2').value) { er.textContent = 'Passwords do not match.'; er.classList.remove('hidden'); return; }
    const { error } = await sb.auth.updateUser({ password: $('#p1').value });
    if (error) { er.textContent = error.message; er.classList.remove('hidden'); return; }
    state.recovery = false;
    toast('Password updated');
    location.hash = '#/new';
    route();
  };
}

function pushBanner() {
  if (!isStaff() || !pushSupported() || !vapidReady() || Notification.permission !== 'default') return '';
  return `<div class="banner">🔔 Get a notification on this device when a new order comes in. <a href="#/settings">Turn on</a></div>`;
}

// ---------------------------------------------------------------- new order
function viewNewOrder() {
  const jobOpts = state.jobsites.map((j) => `<option value="${j.id}" ${String(j.id) === String(draft.jobsite_id) ? 'selected' : ''}>${esc(jobLabel(j))}</option>`).join('');
  $app.innerHTML = `
    ${pushBanner()}
    <h1>New material / equipment order</h1>
    <div class="card stack">
      <div class="field"><label for="job">Jobsite</label>
        <select id="job"><option value="">Select a jobsite…</option>${jobOpts}</select>
        ${state.jobsites.length ? '' : '<div class="sub" style="margin-top:6px">No jobsites yet — an admin can add them under Admin → Jobsites.</div>'}
      </div>
      <div class="grid2">
        <div class="field"><label for="need">Needed by</label><input id="need" type="date" value="${esc(draft.needed_by)}"></div>
        <div class="field"><label>Priority</label><div class="seg" id="prio">
          ${['Normal', 'Urgent'].map((p) => `<button type="button" data-v="${p}" class="${draft.priority === p ? 'on' : ''}">${p}</button>`).join('')}</div></div>
      </div>
      <div class="field"><label>Delivery</label><div class="seg" id="deliv">
        ${['Deliver to site', 'Will pick up'].map((p) => `<button type="button" data-v="${p}" class="${draft.delivery_method === p ? 'on' : ''}">${p}</button>`).join('')}</div></div>
      <div class="field"><label for="dn">Delivery notes <span class="sub">(gate code, where to drop, contact)</span></label>
        <textarea id="dn">${esc(draft.delivery_notes)}</textarea></div>
    </div>

    <div class="card">
      <h2>Add items</h2>
      <div class="chips" id="cats">
        ${['All', 'Material', 'Equipment'].map((c, i) => `<button type="button" class="chip ${i === 0 ? 'on' : ''}" data-c="${c}">${c}</button>`).join('')}
      </div>
      <input id="q" type="search" placeholder="Search catalog…" style="margin-top:10px" autocomplete="off">
      <div class="picker-results" id="results"></div>
      <div style="margin-top:12px"><button type="button" class="btn secondary block" id="customBtn">+ Item not in the list</button></div>
      <div id="custom" class="hidden stack" style="margin-top:12px;border-top:1px solid var(--line);padding-top:12px">
        <div class="field"><label>Item description</label><input id="cName" type="text" placeholder="e.g. 3/4&quot; PVC sch 40, 10 ft"></div>
        <div class="grid2">
          <div class="field"><label>Type</label><select id="cCat"><option>Material</option><option>Equipment</option></select></div>
          <div class="field"><label>Unit</label><input id="cUnit" type="text" value="ea" placeholder="ea, box, ft, day"></div>
        </div>
        <button type="button" class="btn" id="cAdd">Add to order</button>
      </div>
    </div>

    <div class="card">
      <div class="row spread"><h2 style="margin:0">Order list</h2><span class="sub" id="count"></span></div>
      <div id="cart" style="margin-top:12px"></div>
    </div>
    <div class="error hidden" id="er" style="margin-bottom:10px"></div>
    <button class="btn block" id="submit">Submit order</button>
    <div style="text-align:center;margin-top:8px"><button class="linkbtn" id="clear">Clear form</button></div>`;

  let cat = 'All';
  const renderResults = () => {
    const q = $('#q').value.trim().toLowerCase();
    const list = state.catalog.filter((c) => (cat === 'All' || c.category === cat) && (!q || `${c.name} ${c.description || ''}`.toLowerCase().includes(q)));
    $('#results').innerHTML = list.length
      ? list.slice(0, 200).map((c) => `<button type="button" class="pick" data-id="${c.id}"><span><b>${esc(c.name)}</b><br><span class="meta">${esc(c.category)} · per ${esc(c.unit)}</span></span><span class="plus">+</span></button>`).join('')
      : `<div class="empty" style="padding:20px">No matches. Use “Item not in the list”.</div>`;
  };
  const renderCart = () => {
    $('#count').textContent = draft.items.length ? `${draft.items.length} item${draft.items.length > 1 ? 's' : ''}` : '';
    $('#cart').innerHTML = draft.items.length
      ? draft.items.map((it, i) => `
        <div class="cart-item" data-i="${i}">
          <div class="row">
            ${itemTag(it)}
            <div class="grow"><div class="name">${esc(it.item_name)}</div><div class="meta">${it.catalog_item_id ? '' : 'custom · '}${esc(it.unit || 'ea')}</div></div>
            <div class="qty"><button type="button" data-act="dec" aria-label="Decrease">−</button><input type="number" inputmode="decimal" min="0" step="any" value="${esc(it.quantity)}" data-act="qty" aria-label="Quantity"><button type="button" data-act="inc" aria-label="Increase">+</button></div>
          </div>
          <div class="row notes-row">
            <input type="text" class="notes grow" placeholder="Notes (size, color, brand…)" value="${esc(it.notes || '')}" data-act="notes">
            <button type="button" class="rm" data-act="rm" aria-label="Remove ${esc(it.item_name)}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"></path></svg></button>
          </div>
        </div>`).join('')
      : `<div class="empty" style="padding:16px">Nothing added yet.</div>`;
  };
  const addItem = (it) => {
    const existing = it.catalog_item_id && draft.items.find((x) => x.catalog_item_id === it.catalog_item_id);
    if (existing) existing.quantity = Number(existing.quantity) + 1;
    else draft.items.push({ quantity: 1, notes: '', ...it });
    saveDraft(); renderCart();
    toast(`Added: ${it.item_name}`);
  };

  renderResults(); renderCart();

  $('#job').onchange = (e) => { draft.jobsite_id = e.target.value; saveDraft(); };
  $('#need').onchange = (e) => { draft.needed_by = e.target.value; saveDraft(); };
  $('#dn').oninput = (e) => { draft.delivery_notes = e.target.value; saveDraft(); };
  for (const [id, key] of [['#prio', 'priority'], ['#deliv', 'delivery_method']]) {
    $(id).onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      draft[key] = b.dataset.v; saveDraft();
      $$(`${id} button`).forEach((x) => x.classList.toggle('on', x === b));
    };
  }
  $('#cats').onclick = (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    cat = b.dataset.c; $$('#cats .chip').forEach((x) => x.classList.toggle('on', x === b)); renderResults();
  };
  $('#q').oninput = renderResults;
  $('#results').onclick = (e) => {
    const b = e.target.closest('.pick'); if (!b) return;
    const c = state.catalog.find((x) => String(x.id) === b.dataset.id);
    if (c) addItem({ catalog_item_id: c.id, item_name: c.name, category: c.category, unit: c.unit });
  };
  $('#customBtn').onclick = () => { $('#custom').classList.toggle('hidden'); $('#cName').value = $('#q').value; $('#cName').focus(); };
  $('#cAdd').onclick = () => {
    const name = $('#cName').value.trim();
    if (!name) return toast('Describe the item first', true);
    addItem({ catalog_item_id: null, item_name: name, category: $('#cCat').value, unit: $('#cUnit').value.trim() || 'ea' });
    $('#cName').value = ''; $('#custom').classList.add('hidden');
  };
  $('#cart').onclick = (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    e.preventDefault();
    const i = Number(b.closest('.cart-item').dataset.i); const it = draft.items[i];
    if (b.dataset.act === 'rm') draft.items.splice(i, 1);
    if (b.dataset.act === 'inc') it.quantity = Number(it.quantity || 0) + 1;
    if (b.dataset.act === 'dec') it.quantity = Math.max(1, Number(it.quantity || 0) - 1);
    saveDraft(); renderCart();
  };
  $('#cart').oninput = (e) => {
    const el = e.target; const card = el.closest('.cart-item'); if (!card) return;
    const it = draft.items[Number(card.dataset.i)];
    if (el.dataset.act === 'qty') it.quantity = el.value;
    if (el.dataset.act === 'notes') it.notes = el.value;
    saveDraft();
  };
  $('#clear').onclick = () => { if (confirm('Clear this order form?')) { draft = blankDraft(); saveDraft(); viewNewOrder(); } };

  $('#submit').onclick = async () => {
    const er = $('#er'); er.classList.add('hidden');
    const fail = (m) => { er.textContent = m; er.classList.remove('hidden'); };
    if (!draft.jobsite_id) return fail('Choose a jobsite.');
    if (!draft.items.length) return fail('Add at least one item.');
    if (draft.items.some((i) => !(Number(i.quantity) > 0))) return fail('Every item needs a quantity greater than 0.');
    $('#submit').disabled = true; $('#submit').textContent = 'Submitting…';
    const { data: id, error } = await sb.rpc('submit_order', {
      p_jobsite_id: Number(draft.jobsite_id),
      p_needed_by: draft.needed_by || null,
      p_priority: draft.priority,
      p_delivery_method: draft.delivery_method,
      p_delivery_notes: draft.delivery_notes,
      p_items: draft.items.map((i) => ({ ...i, quantity: Number(i.quantity) })),
    });
    $('#submit').disabled = false; $('#submit').textContent = 'Submit order';
    if (error) return fail(error.message);
    notify('new_order', id);
    const keepJob = draft.jobsite_id;
    draft = blankDraft(); draft.jobsite_id = keepJob; saveDraft();
    toast(`Order ${orderNo(id)} submitted`);
    location.hash = `#/order/${id}`;
  };
}

// ---------------------------------------------------------------- order lists
const remainingOf = (i) => Math.max(0, Number(i.quantity) - Number(i.qty_delivered || 0));
const isClosed = (o) => ['Delivered', 'Rejected', 'Cancelled'].includes(o.status);
const claimerName = (o) => (o.claimer ? o.claimer.full_name || o.claimer.email : o.claimed_by ? 'Warehouse' : '');
function itemTag(it) {
  if (!it.catalog_item_id) return '<span class="tag new" aria-hidden="true">NEW</span>';
  return it.category === 'Equipment' ? '<span class="tag eqp" aria-hidden="true">EQP</span>' : '<span class="tag mat" aria-hidden="true">MAT</span>';
}
function claimTag(o) {
  if (!o.claimed_by || isClosed(o)) return '';
  if (o.claimed_by === uid()) return `<span class="claim-tag me"><span class="initials">${esc(initialsOf(state.profile?.full_name))}</span>You’re pulling this</span>`;
  const name = isStaff() ? claimerName(o) : 'Warehouse';
  return `<span class="claim-tag"><span class="initials">${esc(initialsOf(name))}</span>${esc(name)} is pulling this</span>`;
}
function progressBar(o, extra = '') {
  const items = o.order_items || [];
  if (o.status !== 'Partially Delivered' || !items.length) return '';
  const done = items.filter((i) => remainingOf(i) === 0).length;
  const pct = Math.round((done / items.length) * 100);
  return `<div class="progress"><div class="label"><span>${done} of ${items.length} items complete</span><span>${extra || pct + '%'}</span></div><div class="bar"><span style="width:${pct}%"></span></div></div>`;
}

function orderCard(o, showRequester) {
  const n = o.order_items?.length || 0;
  const claimed = o.claimed_by && !isClosed(o);
  const foot = claimed ? `<div class="card-foot">${claimTag(o)}</div>`
    : (showRequester && OPEN.includes(o.status) && o.status !== 'Partially Delivered' ? `<div class="card-foot"><span class="unclaimed">Nobody on it yet</span></div>` : '');
  return `<a class="card order-card ${claimed ? 'claimed' : ''}" href="#/order/${o.id}">
    <div class="row spread"><span class="order-no">${orderNo(o.id)}</span><span class="row" style="gap:6px">${o.priority === 'Urgent' ? badge('Urgent') : ''}${badge(o.status)}</span></div>
    <div class="job">${esc(o.jobsite?.name || jobLabel(o.jobsite))}</div>
    <div class="meta">${n} item${n === 1 ? '' : 's'} · needed ${fmtDate(o.needed_by)}${showRequester ? ` · ${esc(o.requester?.full_name || o.requester?.email || '')}` : ''}</div>
    ${progressBar(o)}
    ${foot}
  </a>`;
}

async function viewMyOrders() {
  $app.innerHTML = `<h1>My orders</h1><div class="loading">Loading…</div>`;
  const { data, error } = await sb.from('orders').select(ORDER_SELECT).eq('requested_by', uid()).order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  let filter = 'Open';
  const draw = () => {
    const list = data.filter((o) => filter === 'All' || OPEN.includes(o.status));
    $('#list').innerHTML = list.length ? list.map((o) => orderCard(o)).join('') : `<div class="empty">No ${filter === 'Open' ? 'open ' : ''}orders. <a href="#/new">Start one</a></div>`;
  };
  $app.innerHTML = `<h1>My orders</h1>
    <div class="chips" id="f" style="margin-bottom:12px">${['Open', 'All'].map((f) => `<button class="chip ${f === filter ? 'on' : ''}" data-f="${f}">${f}</button>`).join('')}</div>
    <div id="list"></div>`;
  $('#f').onclick = (e) => { const b = e.target.closest('.chip'); if (!b) return; filter = b.dataset.f; $$('#f .chip').forEach((x) => x.classList.toggle('on', x === b)); draw(); };
  draw();
}

// ---------------------------------------------------------------- order detail
async function viewOrder(id) {
  if (!$('#orderView')) $app.innerHTML = `<div class="loading">Loading…</div>`;
  const [{ data: o, error }, { data: events }] = await Promise.all([
    sb.from('orders').select(ORDER_SELECT).eq('id', id).single(),
    sb.from('order_events').select('*, user:profiles(full_name, email)').eq('order_id', id).order('created_at', { ascending: false }),
  ]);
  if (error || !o) throw new Error('Order not found');
  const mine = o.requested_by === uid();
  const staff = isStaff();
  const closed = isClosed(o);
  const items = (o.order_items || []).sort((a, b) => a.id - b.id);
  const anyDelivered = items.some((i) => Number(i.qty_delivered) > 0);
  const showDelivered = anyDelivered || o.status === 'Partially Delivered';
  const claimedByMe = o.claimed_by === uid();
  const who = claimerName(o);
  const openItems = items.filter((i) => remainingOf(i) > 0);

  let claimBox = '';
  if (!closed && staff) {
    if (!o.claimed_by) claimBox = `<div class="claim-box open no-print"><div class="grow"><b>Nobody is pulling this order yet</b><div class="meta">Claim it so the other guys know you’ve got it.</div></div><button class="btn" id="claim">I’m pulling this</button></div>`;
    else if (claimedByMe) claimBox = `<div class="claim-box mine no-print"><span class="initials">${esc(initialsOf(state.profile?.full_name))}</span><div class="grow"><b>You’re pulling this order</b><div class="meta">since ${fmtDateTime(o.claimed_at)}</div></div><button class="btn secondary small" id="release">Release</button></div>`;
    else claimBox = `<div class="claim-box other no-print"><span class="initials">${esc(initialsOf(who))}</span><div class="grow"><b>${esc(who)} is pulling this order</b><div class="meta">since ${fmtDateTime(o.claimed_at)} — no need to go get it</div></div><button class="btn secondary small" id="takeover">Take over</button></div>`;
  } else if (!closed && o.claimed_by) {
    claimBox = `<div class="claim-box other"><span class="initials">W</span><div class="grow"><b>The warehouse is pulling your order</b><div class="meta">since ${fmtDateTime(o.claimed_at)}</div></div></div>`;
  }

  const itemRows = items.map((it) => {
    const rem = remainingOf(it);
    const del = Number(it.qty_delivered || 0);
    const st = rem === 0 && del > 0 ? 'done' : del > 0 ? 'part' : showDelivered ? 'wait' : 'open';
    const icon = st === 'done' ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"></path></svg>' : st === 'open' ? '' : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="M12 8v4l2.5 2"></path></svg>';
    const right = st === 'done' ? '<span class="done">Done</span>' : st === 'part' ? `<span class="partial">${fmtQty(rem)} left</span>` : st === 'wait' ? `<span class="meta">${fmtQty(rem)} left</span>` : '';
    const qtyText = showDelivered ? `${fmtQty(del)} of ${fmtQty(it.quantity)} ${esc(it.unit || '')}` : `${fmtQty(it.quantity)} ${esc(it.unit || '')}`;
    return `<div class="item-row">${st === 'open' ? itemTag(it) : `<span class="state-dot ${st}">${icon}</span>`}
      <div class="grow"><b>${esc(it.item_name)}</b><div class="meta">${qtyText}${it.catalog_item_id ? '' : ' · custom'}${it.notes ? ' · ' + esc(it.notes) : ''}</div></div>
      <div class="right">${right}</div></div>`;
  }).join('');

  const deliverBox = (!staff || closed || !openItems.length) ? '' : `
    <div class="card no-print stack" id="deliverBox">
      <div class="row spread wrap"><h2 style="margin:0">Record a delivery</h2>
        <div class="row"><button class="btn secondary small" id="fillAll">All</button><button class="btn secondary small" id="fillNone">None</button></div></div>
      <p class="sub" style="margin:0">Enter what’s going out <b>now</b>. Put 0 for anything that isn’t available — it stays open for the next trip.</p>
      ${openItems.map((it) => `
        <div class="deliver-row">
          <div class="grow"><b>${esc(it.item_name)}</b><div class="meta">${fmtQty(remainingOf(it))} ${esc(it.unit || '')} remaining${Number(it.qty_delivered) > 0 ? ` (of ${fmtQty(it.quantity)})` : ''}</div></div>
          <input type="number" inputmode="decimal" min="0" step="any" max="${remainingOf(it)}" value="${remainingOf(it)}" data-item="${it.id}" data-max="${remainingOf(it)}" aria-label="Quantity delivered for ${esc(it.item_name)}">
        </div>`).join('')}
      <div class="field"><label for="dnote">Note <span class="sub">(backorder, ETA, where it was dropped…)</span></label><textarea id="dnote" placeholder="e.g. Rest of drywall on backorder, ETA Friday"></textarea></div>
      <button class="btn" id="deliver">Record delivery</button>
    </div>`;

  const adminBox = !isAdmin() ? '' : `
    <div class="card no-print stack" id="adminBox">
      <h2>Update status</h2>
      <div class="chips" id="st">${STATUSES.map((s) => `<button class="chip ${s === o.status ? 'on' : ''}" data-s="${s}">${s}</button>`).join('')}</div>
      <div class="field"><label for="an">Office notes <span class="sub">(visible to the requester)</span></label><textarea id="an" placeholder="PO #, supplier, ETA…">${esc(o.admin_notes || '')}</textarea></div>
      <div class="row"><button class="btn" id="save">Save</button><button class="btn danger" id="del">Delete order</button></div>
    </div>`;

  const log = (events || []).length ? `
    <div class="card"><h2>Activity</h2>
      ${events.map((e) => `<div class="event ${esc(e.kind)}"><div><div>${esc(e.message)}</div><div class="meta">${esc(e.user?.full_name || e.user?.email || '')}${e.user ? ' · ' : ''}${fmtDateTime(e.created_at)}</div></div></div>`).join('')}
    </div>` : '';

  $app.innerHTML = `<div id="orderView">
    <div class="row spread no-print" style="margin-bottom:8px">
      <a href="${staff ? '#/admin' : '#/orders'}" class="btn secondary small" aria-label="Back">← Back</a>
      <div class="row"><button class="btn secondary small" id="print">Print</button>${mine || isAdmin() ? `<button class="btn secondary small" id="reorder">Reorder</button>` : ''}</div>
    </div>
    <section class="hero">
      <div class="row spread"><span class="row" style="gap:6px">${o.priority === 'Urgent' ? badge('Urgent') : ''}${badge(o.status)}</span><span class="meta">Needed ${fmtDate(o.needed_by)}</span></div>
      <h1>${esc(o.jobsite?.name || jobLabel(o.jobsite))}</h1>
      <div class="meta">${orderNo(o.id)}${o.jobsite?.job_number ? ' · Job ' + esc(o.jobsite.job_number) : ''}${o.jobsite?.address ? ' · ' + esc(o.jobsite.address) : ''}</div>
      ${progressBar(o)}
      <dl class="kv">
        <dt>Requested by</dt><dd>${esc(o.requester?.full_name || o.requester?.email || '')}${o.requester?.phone ? ` · <a href="tel:${esc(o.requester.phone)}">${esc(o.requester.phone)}</a>` : ''}</dd>
        <dt>Submitted</dt><dd>${fmtDateTime(o.created_at)}</dd>
        <dt>Delivery</dt><dd>${esc(o.delivery_method)}</dd>
        ${o.delivery_notes ? `<dt>Notes</dt><dd style="white-space:pre-wrap">${esc(o.delivery_notes)}</dd>` : ''}
        ${o.admin_notes ? `<dt>Office notes</dt><dd style="white-space:pre-wrap">${esc(o.admin_notes)}</dd>` : ''}
      </dl>
    </section>
    ${claimBox}
    <div class="card" style="padding-top:6px;padding-bottom:6px">${itemRows}</div>
    ${deliverBox}
    ${adminBox}
    ${log}
    ${mine && o.status === 'Pending' && !o.claimed_by && !staff ? `<button class="btn danger block no-print" id="cancel">Cancel this order</button>` : ''}
  </div>`;

  // live updates: if someone else claims / delivers while this is open, refresh
  if (state.channel) sb.removeChannel(state.channel);
  state.channel = sb.channel(`order-${id}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${id}` }, () => {
      const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('#deliverBox, #adminBox');
      if (typing) { toast('This order was just updated by someone else.'); return; }
      viewOrder(id);
    })
    .subscribe();

  const rpc = async (fn, args, okMsg) => {
    const { data, error: e } = await sb.rpc(fn, args);
    if (e) { toast(e.message, true); viewOrder(id); return null; }
    if (okMsg) toast(okMsg);
    return data ?? true;
  };

  $('#print').onclick = () => window.print();
  const reorder = $('#reorder');
  if (reorder) reorder.onclick = () => {
    draft = { ...blankDraft(), jobsite_id: o.jobsite_id, delivery_method: o.delivery_method, delivery_notes: o.delivery_notes || '',
      items: items.map((i) => ({ catalog_item_id: i.catalog_item_id, item_name: i.item_name, category: i.category, unit: i.unit, quantity: Number(i.quantity), notes: i.notes || '' })) };
    saveDraft(); toast('Items copied to a new order'); location.hash = '#/new';
  };
  const cancel = $('#cancel');
  if (cancel) cancel.onclick = async () => {
    if (!confirm('Cancel this order?')) return;
    const { data: upd, error: e } = await sb.from('orders').update({ status: 'Cancelled' }).eq('id', o.id).select('id');
    if (e || !upd?.length) return toast(e?.message || 'The warehouse has already started on this order — call the office to change it.', true);
    toast('Order cancelled'); viewOrder(o.id);
  };

  const claim = $('#claim'), release = $('#release'), takeover = $('#takeover');
  if (claim) claim.onclick = async () => { claim.disabled = true; if (await rpc('claim_order', { p_order_id: id, p_take_over: false }, 'It’s yours — others can see you’re pulling it')) viewOrder(id); };
  if (release) release.onclick = async () => { if (await rpc('release_order', { p_order_id: id }, 'Released')) viewOrder(id); };
  if (takeover) takeover.onclick = async () => {
    if (!confirm(`${who} is already pulling this order. Take it over?`)) return;
    if (await rpc('claim_order', { p_order_id: id, p_take_over: true }, 'You took over this order')) viewOrder(id);
  };

  const box = $('#deliverBox');
  if (box) {
    const inputs = $$('input[data-item]', box);
    $('#fillAll').onclick = () => inputs.forEach((i) => (i.value = i.dataset.max));
    $('#fillNone').onclick = () => inputs.forEach((i) => (i.value = 0));
    $('#deliver').onclick = async () => {
      const lines = inputs.map((i) => ({ order_item_id: Number(i.dataset.item), quantity: Number(i.value || 0) })).filter((l) => l.quantity > 0);
      if (!lines.length) return toast('Enter a quantity for at least one item', true);
      const over = inputs.find((i) => Number(i.value) > Number(i.dataset.max));
      if (over) return toast('One of the quantities is more than what’s left on the order', true);
      if (o.claimed_by && !claimedByMe && !confirm(`${who} is pulling this order. Record a delivery anyway?`)) return;
      const btn = $('#deliver'); btn.disabled = true; btn.textContent = 'Saving…';
      const newStatus = await rpc('record_delivery', { p_order_id: id, p_items: lines, p_note: $('#dnote').value }, null);
      if (!newStatus) return;
      notify('delivery', id);
      toast(newStatus === 'Delivered' ? 'Order complete — marked Delivered' : 'Partial delivery saved — the rest stays open');
      viewOrder(id);
    };
  }

  if (isAdmin()) {
    let status = o.status;
    $('#st').onclick = (e) => { const b = e.target.closest('.chip'); if (!b) return; status = b.dataset.s; $$('#st .chip').forEach((x) => x.classList.toggle('on', x === b)); };
    $('#save').onclick = async () => {
      const changed = status !== o.status;
      const { error: e } = await sb.from('orders').update({ status, admin_notes: $('#an').value.trim() || null }).eq('id', o.id);
      if (e) return toast(e.message, true);
      if (changed) notify('status_change', o.id);
      toast('Saved'); viewOrder(o.id);
    };
    $('#del').onclick = async () => {
      if (!confirm(`Permanently delete ${orderNo(o.id)}?`)) return;
      const { error: e } = await sb.from('orders').delete().eq('id', o.id);
      if (e) return toast(e.message, true);
      toast('Order deleted'); location.hash = '#/admin';
    };
  }
}

// ---------------------------------------------------------------- admin / warehouse queue
async function viewAdmin(tab) {
  $app.classList.add('wide');
  if (!isAdmin()) tab = 'orders'; // warehouse sees the queue only
  const tabs = [['orders', 'Orders'], ['catalog', 'Catalog'], ['jobsites', 'Jobsites'], ['users', 'Users']];
  $app.innerHTML = `${pushBanner()}${isAdmin() ? `<div class="chips admin-tabs">${tabs.map(([k, l]) => `<a class="chip ${k === tab ? 'on' : ''}" href="#/admin/${k}">${l}</a>`).join('')}</div>` : ''}<div id="pane"><div class="loading">Loading…</div></div>`;
  const pane = $('#pane');
  if (tab === 'catalog') return adminCatalog(pane);
  if (tab === 'jobsites') return adminJobsites(pane);
  if (tab === 'users') return adminUsers(pane);
  return adminOrders(pane);
}

async function adminOrders(pane) {
  let filter = 'Open', job = '', q = '', data = [];
  const load = async () => {
    const { data: d, error } = await sb.from('orders').select(ORDER_SELECT).order('created_at', { ascending: false }).limit(500);
    if (error) throw error;
    data = d;
  };
  await load();
  const filtered = () => data.filter((o) => {
    if (filter === 'Open' && !OPEN.includes(o.status)) return false;
    if (filter === 'Not claimed' && (!OPEN.includes(o.status) || o.claimed_by)) return false;
    if (filter === 'Mine' && (o.claimed_by !== uid() || isClosed(o))) return false;
    if (STATUSES.includes(filter) && o.status !== filter) return false;
    if (job && String(o.jobsite_id) !== job) return false;
    if (q) {
      const hay = [orderNo(o.id), o.requester?.full_name, o.requester?.email, claimerName(o), jobLabel(o.jobsite), ...(o.order_items || []).map((i) => i.item_name)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const draw = () => {
    const open = data.filter((o) => OPEN.includes(o.status));
    $('#stats', pane).innerHTML = `
      <div class="stat"><b>${open.filter((o) => !o.claimed_by).length}</b><span>Not claimed</span></div>
      <div class="stat"><b>${open.filter((o) => o.claimed_by).length}</b><span>Being pulled</span></div>
      <div class="stat"><b>${data.filter((o) => o.status === 'Partially Delivered').length}</b><span>Partially delivered</span></div>
      <div class="stat"><b style="color:var(--bad)">${open.filter((o) => o.priority === 'Urgent').length}</b><span>Urgent &amp; open</span></div>`;
    const list = filtered();
    $('#list', pane).innerHTML = list.length ? list.map((o) => orderCard(o, true)).join('') : `<div class="empty">No orders match.</div>`;
  };
  const jobs = [...new Map(data.filter((o) => o.jobsite).map((o) => [o.jobsite_id, o.jobsite])).values()];
  const chips = ['Open', 'Not claimed', 'Mine', ...STATUSES, 'All'];
  pane.innerHTML = `
    <div class="row spread wrap"><h1 style="margin:0">${isAdmin() ? 'Orders' : 'Warehouse queue'}</h1><button class="btn secondary small" id="csv">Export CSV</button></div>
    <div class="stats" id="stats" style="margin-top:12px"></div>
    <div class="chips" id="f" style="margin-bottom:10px">${chips.map((f) => `<button class="chip ${f === filter ? 'on' : ''}" data-f="${f}">${f}</button>`).join('')}</div>
    <div class="grid2" style="margin-bottom:12px">
      <select id="job"><option value="">All jobsites</option>${jobs.map((j) => `<option value="${j.id}">${esc(jobLabel(j))}</option>`).join('')}</select>
      <input id="q" type="search" placeholder="Search order #, name, item…">
    </div>
    <div id="list"></div>`;
  $('#f', pane).onclick = (e) => { const b = e.target.closest('.chip'); if (!b) return; filter = b.dataset.f; $$('#f .chip', pane).forEach((x) => x.classList.toggle('on', x === b)); draw(); };
  $('#job', pane).onchange = (e) => { job = e.target.value; draw(); };
  $('#q', pane).oninput = (e) => { q = e.target.value.trim().toLowerCase(); draw(); };
  $('#csv', pane).onclick = () => exportCsv(filtered());
  draw();

  // live updates while the queue is open (claims show up for everyone right away)
  state.channel = sb.channel('orders-dash')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, async (payload) => {
      await new Promise((r) => setTimeout(r, 800)); // let order items finish saving
      await load(); draw();
      if (payload.eventType === 'INSERT') toast(`New order ${orderNo(payload.new.id)}`);
    })
    .subscribe();
}

function exportCsv(orders) {
  const head = ['Order #', 'Submitted', 'Status', 'Priority', 'Job #', 'Jobsite', 'Requested by', 'Needed by', 'Delivery', 'Delivery notes', 'Being pulled by', 'Item', 'Type', 'Qty ordered', 'Qty delivered', 'Qty remaining', 'Unit', 'Item notes', 'Office notes'];
  const rows = [head];
  for (const o of orders) for (const i of o.order_items || []) {
    rows.push([orderNo(o.id), new Date(o.created_at).toLocaleString(), o.status, o.priority, o.jobsite?.job_number || '', o.jobsite?.name || '',
      o.requester?.full_name || o.requester?.email || '', o.needed_by || '', o.delivery_method, o.delivery_notes || '', isClosed(o) ? '' : claimerName(o),
      i.item_name, i.category || '', i.quantity, i.qty_delivered || 0, remainingOf(i), i.unit || '', i.notes || '', o.admin_notes || '']);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = `field-orders-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// Generic add / edit / hide list for catalog + jobsites
async function adminList(pane, cfg) {
  const { table, title, fields, order, display, help } = cfg;
  const { data, error } = await sb.from(table).select('*').order(order[0]).order(order[1] || order[0]);
  if (error) throw error;
  const input = (f, val) => f.options
    ? `<select data-k="${f.key}">${f.options.map((o) => `<option ${o === val ? 'selected' : ''}>${o}</option>`).join('')}</select>`
    : `<input type="text" data-k="${f.key}" value="${esc(val ?? f.default ?? '')}" placeholder="${esc(f.label)}">`;
  const formRow = (rec = {}) => `<div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">${fields.map((f) => `<div><label>${esc(f.label)}</label>${input(f, rec[f.key])}</div>`).join('')}</div>`;
  const read = (root) => Object.fromEntries($$('[data-k]', root).map((el) => [el.dataset.k, el.value.trim() || null]));

  pane.innerHTML = `
    <h1>${esc(title)}</h1>
    <div class="card"><h2>Add new</h2><div id="add">${formRow()}</div><button class="btn" id="addBtn" style="margin-top:12px">Add</button>
      ${help ? `<p class="sub" style="margin-bottom:0">${help}</p>` : ''}</div>
    <div class="card" id="rows">${data.length ? '' : '<div class="empty">Nothing here yet.</div>'}
      ${data.map((r) => `<div class="list-row ${r.active ? '' : 'inactive'}" data-id="${r.id}">
        <div class="grow view">${display(r)}</div>
        <button class="btn secondary small" data-act="edit">Edit</button>
        <button class="btn secondary small" data-act="toggle">${r.active ? 'Hide' : 'Show'}</button></div>`).join('')}</div>`;

  $('#addBtn', pane).onclick = async () => {
    const rec = read($('#add', pane));
    if (fields.some((f) => f.required && !rec[f.key])) return toast(`${fields.find((f) => f.required).label} is required`, true);
    const { error: e } = await sb.from(table).insert(rec);
    if (e) return toast(e.message, true);
    toast('Added'); await loadBasics(); adminList(pane, cfg);
  };
  $('#rows', pane).onclick = async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const row = b.closest('.list-row'); const rec = data.find((r) => String(r.id) === row.dataset.id);
    if (b.dataset.act === 'toggle') {
      const { error: er } = await sb.from(table).update({ active: !rec.active }).eq('id', rec.id);
      if (er) return toast(er.message, true);
      await loadBasics(); return adminList(pane, cfg);
    }
    if (b.dataset.act === 'edit') {
      $('.view', row).innerHTML = formRow(rec);
      b.textContent = 'Save'; b.dataset.act = 'save'; b.classList.remove('secondary');
      return;
    }
    if (b.dataset.act === 'save') {
      const { error: er } = await sb.from(table).update(read(row)).eq('id', rec.id);
      if (er) return toast(er.message, true);
      toast('Saved'); await loadBasics(); return adminList(pane, cfg);
    }
  };
}

const adminCatalog = (pane) => adminList(pane, {
  table: 'catalog_items', title: 'Materials & equipment catalog', order: ['category', 'name'],
  fields: [
    { key: 'name', label: 'Item name', required: true },
    { key: 'category', label: 'Type', options: ['Material', 'Equipment'] },
    { key: 'unit', label: 'Unit', default: 'ea' },
    { key: 'description', label: 'Description / spec (optional)' },
  ],
  display: (r) => `<b>${esc(r.name)}</b><div class="meta">${esc(r.category)} · per ${esc(r.unit)}${r.description ? ' · ' + esc(r.description) : ''}${r.active ? '' : ' · hidden'}</div>`,
  help: '“Hide” removes an item from the order screen without affecting past orders.',
});

const adminJobsites = (pane) => adminList(pane, {
  table: 'jobsites', title: 'Jobsites', order: ['job_number', 'name'],
  fields: [
    { key: 'job_number', label: 'Job #' },
    { key: 'name', label: 'Jobsite name', required: true },
    { key: 'address', label: 'Address' },
  ],
  display: (r) => `<b>${esc(jobLabel(r))}</b><div class="meta">${esc(r.address || 'No address')}${r.active ? '' : ' · hidden (closed job)'}</div>`,
  help: 'Hide a jobsite when the job closes so it no longer appears for field crews.',
});

const ROLE_OPTS = [['field', 'Field'], ['warehouse', 'Warehouse'], ['admin', 'Admin']];
const roleSelect = (val, attrs = '') => `<select ${attrs}>${ROLE_OPTS.map(([v, l]) => `<option value="${v}" ${v === val ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
function makePassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}
// Calls the notify function's admin actions (it holds the key needed to manage logins)
async function adminCall(type, payload) {
  const { data, error } = await sb.functions.invoke(NOTIFY_FN, { body: { type, ...payload } });
  if (error) throw new Error(await fnErrorText(error));
  if (data?.error) throw new Error(data.error);
  return data;
}

async function adminUsers(pane, notice = '') {
  const { data, error } = await sb.from('profiles').select('*').order('full_name');
  if (error) throw error;
  let showDisabled = false;
  const active = (p) => p.active !== false;

  pane.innerHTML = `
    <h1>Users</h1>
    ${notice}
    <div class="card stack" id="addUser">
      <h2>Add an employee</h2>
      <div class="grid2">
        <div class="field"><label>Full name</label><input type="text" id="nuName" placeholder="Mike Rivera"></div>
        <div class="field"><label>Email (their login)</label><input type="email" id="nuEmail" placeholder="mike@mabldg.com" autocomplete="off"></div>
        <div class="field"><label>Phone <span class="sub">(optional)</span></label><input type="tel" id="nuPhone"></div>
        <div class="field"><label>Role</label>${roleSelect('field', 'id="nuRole"')}</div>
      </div>
      <div class="field"><label>Starting password <span class="sub">(8+ characters — they can change it under Account)</span></label>
        <div class="row"><input type="text" id="nuPw" class="grow" autocomplete="off" value="${makePassword()}"><button type="button" class="btn secondary small" id="nuGen">New</button></div></div>
      <button class="btn" id="nuAdd">Add employee</button>
    </div>
    <div class="card">
      <div class="row spread wrap"><h2 style="margin:0">Employees</h2>
        <label class="row" style="font-weight:600;margin:0"><input type="checkbox" id="showDis"> Show disabled</label></div>
      <div id="userRows"></div>
    </div>`;

  const drawRows = () => {
    const list = data.filter((p) => showDisabled || active(p));
    $('#userRows', pane).innerHTML = list.map((p) => `
      <div class="user-row ${active(p) ? '' : 'inactive'}" data-id="${p.id}">
        <div class="list-row wrap">
          <div class="grow" style="min-width:200px"><input type="text" data-k="full_name" value="${esc(p.full_name || '')}" placeholder="Full name">
            <div class="meta" style="margin-top:4px">${esc(p.email || '')}${active(p) ? '' : ' · <b>login disabled</b>'}${p.id === uid() ? ' · you' : ''}</div></div>
          <input type="tel" data-k="phone" value="${esc(p.phone || '')}" placeholder="Phone" style="max-width:150px">
          ${roleSelect(p.role, 'data-k="role" style="max-width:130px"')}
          <button class="btn secondary small" data-act="pw">Set password</button>
          ${p.id === uid() ? '' : `<button class="btn ${active(p) ? 'danger' : 'secondary'} small" data-act="toggle">${active(p) ? 'Disable' : 'Enable'}</button>`}
        </div>
        <div class="pw-box hidden row wrap">
          <input type="text" class="grow" data-pw autocomplete="off" value="${makePassword()}" aria-label="New password">
          <button class="btn small" data-act="pwSave">Save password</button>
          <button class="btn secondary small" data-act="pwCancel">Cancel</button>
        </div>
      </div>`).join('') || '<div class="empty">No employees yet.</div>';
  };
  drawRows();

  $('#showDis', pane).onchange = (e) => { showDisabled = e.target.checked; drawRows(); };
  $('#nuGen', pane).onclick = () => { $('#nuPw', pane).value = makePassword(); };
  $('#nuAdd', pane).onclick = async () => {
    const rec = {
      full_name: $('#nuName', pane).value.trim(), email: $('#nuEmail', pane).value.trim().toLowerCase(),
      phone: $('#nuPhone', pane).value.trim(), role: $('#nuRole', pane).value, password: $('#nuPw', pane).value,
    };
    if (!rec.full_name || !rec.email) return toast('Enter a name and email', true);
    if (rec.password.length < 8) return toast('Password needs at least 8 characters', true);
    const btn = $('#nuAdd', pane); btn.disabled = true; btn.textContent = 'Adding…';
    try {
      await adminCall('admin_create_user', rec);
      adminUsers(pane, `<div class="banner"><b>${esc(rec.full_name)} can sign in now.</b> Send them the app link and these details:<br>
        Email: <b>${esc(rec.email)}</b> &nbsp; Password: <b>${esc(rec.password)}</b></div>`);
    } catch (e) { toast(errMsg(e), true); btn.disabled = false; btn.textContent = 'Add employee'; }
  };

  const rows = $('#userRows', pane);
  rows.onchange = async (ev) => {
    const el = ev.target; if (!el.dataset.k) return;
    const id = el.closest('.user-row').dataset.id;
    if (el.dataset.k === 'role' && id === uid() && el.value !== 'admin' && !confirm('Remove your own admin access?')) { el.value = 'admin'; return; }
    const { error: e } = await sb.from('profiles').update({ [el.dataset.k]: el.value.trim() || null }).eq('id', id);
    if (e) toast(e.message, true); else { toast('Saved'); const p = data.find((x) => x.id === id); if (p) p[el.dataset.k] = el.value.trim() || null; }
    if (id === uid()) { await loadBasics(); route(); }
  };
  rows.onclick = async (ev) => {
    const b = ev.target.closest('button[data-act]'); if (!b) return;
    const row = b.closest('.user-row'); const id = row.dataset.id; const p = data.find((x) => x.id === id);
    const box = $('.pw-box', row);
    if (b.dataset.act === 'pw') { box.classList.toggle('hidden'); $('[data-pw]', box).select(); return; }
    if (b.dataset.act === 'pwCancel') { box.classList.add('hidden'); return; }
    if (b.dataset.act === 'pwSave') {
      const pw = $('[data-pw]', box).value;
      if (pw.length < 8) return toast('Password needs at least 8 characters', true);
      b.disabled = true;
      try {
        await adminCall('admin_set_password', { user_id: id, password: pw });
        box.classList.add('hidden');
        toast(`Password changed for ${p.full_name || p.email}. New password: ${pw}`);
      } catch (e) { toast(errMsg(e), true); }
      b.disabled = false;
      return;
    }
    if (b.dataset.act === 'toggle') {
      const enable = !active(p);
      if (!enable && !confirm(`Disable ${p.full_name || p.email}? They won’t be able to sign in. Their past orders stay.`)) return;
      b.disabled = true;
      try {
        await adminCall('admin_set_active', { user_id: id, active: enable });
        p.active = enable; drawRows();
        toast(enable ? 'Login enabled' : 'Login disabled');
      } catch (e) { toast(errMsg(e), true); b.disabled = false; }
    }
  };
}

// ---------------------------------------------------------------- settings
async function viewSettings() {
  const p = state.profile;
  const sub = await currentSub().catch(() => null);
  let pushHtml;
  if (!pushSupported()) {
    pushHtml = isIOS && !isStandalone()
      ? `<p>On iPhone/iPad, notifications only work after you add this app to your Home Screen: tap <b>Share</b> → <b>Add to Home Screen</b>, then open it from the icon and come back here.</p>`
      : `<p class="sub">This browser doesn’t support push notifications.</p>`;
  } else if (Notification.permission === 'denied') {
    pushHtml = `<p>Notifications are blocked for this app. Turn them on in your phone or browser settings, then reload.</p>`;
  } else if (sub && Notification.permission === 'granted') {
    pushHtml = `<p>✅ Notifications are <b>on</b> for this device.</p><div class="row"><button class="btn secondary" id="test">Send test</button><button class="btn secondary" id="pushOff">Turn off</button></div><div id="testResult" class="sub" style="margin-top:10px"></div>`;
  } else {
    pushHtml = `<p>${isStaff() ? 'Get notified when a new order is submitted.' : 'Get notified when your order is approved, ordered or delivered.'}</p><button class="btn" id="pushOn">Turn on notifications</button>`;
  }

  $app.innerHTML = `
    <h1>Account</h1>
    <div class="card stack">
      <h2>Your info</h2>
      <div class="field"><label>Name</label><input id="nm" type="text" value="${esc(p.full_name || '')}"></div>
      <div class="field"><label>Phone</label><input id="ph" type="tel" value="${esc(p.phone || '')}"></div>
      <div class="sub">${esc(p.email || '')} · ${{ admin: 'Admin', warehouse: 'Warehouse', field: 'Field' }[p.role] || p.role}</div>
      <button class="btn secondary" id="saveP">Save</button>
    </div>
    <div class="card stack">
      <h2>Appearance</h2>
      <div class="seg" id="theme" role="group" aria-label="Theme">
        ${[['light', 'Light'], ['dark', 'Dark'], ['system', 'Match phone']].map(([v, l]) => `<button type="button" data-v="${v}" class="${themePref === v ? 'on' : ''}" aria-pressed="${themePref === v}">${l}</button>`).join('')}
      </div>
      <div class="sub">Dark mode is easier on the eyes early in the morning and at night.</div>
    </div>
    <div class="card"><h2>Notifications</h2>${pushHtml}</div>
    <div class="card">
      <h2>Install on your phone</h2>
      ${isStandalone() ? '<p>✅ Installed.</p>' : `<p><b>iPhone (Safari):</b> Share button → <b>Add to Home Screen</b>.<br><b>Android (Chrome):</b> ⋮ menu → <b>Install app</b> / <b>Add to Home screen</b>.</p>`}
    </div>
    <div class="card stack">
      <h2>Change password</h2>
      <input id="np" type="password" placeholder="New password (8+ characters)" autocomplete="new-password">
      <button class="btn secondary" id="savePw">Update password</button>
    </div>
    <button class="btn danger block" id="out">Sign out</button>`;

  $('#theme').onclick = async (e) => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    applyTheme(b.dataset.v);
    $$('#theme button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); });
    // remember it on the account so it follows them to other devices
    const { error } = await sb.from('profiles').update({ theme: b.dataset.v }).eq('id', uid());
    if (!error && state.profile) state.profile.theme = b.dataset.v;
  };
  $('#saveP').onclick = async () => {
    const { error } = await sb.from('profiles').update({ full_name: $('#nm').value.trim() || null, phone: $('#ph').value.trim() || null }).eq('id', uid());
    if (error) return toast(error.message, true);
    await loadBasics(); toast('Saved'); route();
  };
  $('#savePw').onclick = async () => {
    const pw = $('#np').value;
    if (pw.length < 8) return toast('Use at least 8 characters', true);
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) toast(error.message, true); else { $('#np').value = ''; toast('Password updated'); }
  };
  const on = $('#pushOn'), off = $('#pushOff'), test = $('#test');
  if (on) on.onclick = async () => { try { on.disabled = true; await enablePush(); toast('Notifications on'); viewSettings(); } catch (e) { on.disabled = false; toast(errMsg(e), true); } };
  if (off) off.onclick = async () => { await disablePush(); toast('Notifications off'); viewSettings(); };
  if (test) test.onclick = async () => {
    const out = $('#testResult');
    test.disabled = true; out.className = 'sub'; out.textContent = 'Sending…';
    // make sure this device is saved to your login before testing
    const sub = await currentSub().catch(() => null);
    if (sub && !(await saveSub(sub))) {
      out.className = 'error'; out.textContent = 'This device is registered to another login. Tap “Turn off”, then “Turn on notifications”.';
      test.disabled = false; return;
    }
    const { data, error } = await sb.functions.invoke(NOTIFY_FN, { body: { type: 'test', client_public_key: CFG.VAPID_PUBLIC_KEY } });
    test.disabled = false;
    if (error) {
      const why = await fnErrorText(error);
      out.className = 'error'; out.textContent = 'Test failed: ' + why;
      console.error('notify test failed', why, error);
    } else {
      out.className = 'sub'; out.textContent = `✅ Sent to ${data?.sent ?? 0} device(s). If nothing shows up within a minute, check that notifications are allowed for this app in your phone settings.`;
    }
  };
  $('#out').onclick = async () => { await disablePush().catch(() => {}); await sb.auth.signOut(); };
}

// ---------------------------------------------------------------- start
sb.auth.onAuthStateChange((event, session) => {
  // run outside the auth callback (supabase-js recommendation)
  setTimeout(async () => {
    const prev = state.session?.user?.id;
    state.session = session;
    if (event === 'PASSWORD_RECOVERY') state.recovery = true;
    if (event === 'INITIAL_SESSION') {
      if (session) await loadBasics();
      // opening the app (or the home-screen icon) lands warehouse users on their queue
      if (session && ['', '#', '#/', '#/new'].includes(location.hash) && homeHash() !== '#/new') { history.replaceState(null, '', homeHash()); }
      return route();
    }
    if (event === 'SIGNED_OUT') { state.profile = null; location.hash = ''; return route(); }
    if (session && session.user.id !== prev) {
      await loadBasics();
      if (['', '#', '#/', '#/new'].includes(location.hash) && homeHash() !== '#/new') history.replaceState(null, '', homeHash());
      return route();
    }
    if (event === 'PASSWORD_RECOVERY') route();
  }, 0);
});
