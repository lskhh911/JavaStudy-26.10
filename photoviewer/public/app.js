/* ==========================================================================
   照片阅读器 · 前端逻辑
   - 年 / 月 / 全部 三种浏览密度（对齐 iPhone「照片」App）
   - 粘性日期分组 + 网格缩放
   - 查看器：缩放、拖动、滑动切换、实况照片播放、视频、信息面板
   ========================================================================== */
'use strict';

// ------------------------------------------------------------------ 工具
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const enc = encodeURIComponent;

const PAD = (n) => String(n).padStart(2, '0');
const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function fmtDayLabel(s) {
  const dt = parseDate(s);
  return `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日`;
}
function fmtMonthLabel(s) {
  const [y, m] = s.split('-');
  return `${y}年${Number(m)}月`;
}
function fmtTime(ts) {
  const dt = new Date(ts * 1000);
  return `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日 ${PAD(dt.getHours())}:${PAD(dt.getMinutes())}`;
}
function fmtSize(b) {
  if (!b) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1024 ** 3) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 ** 3).toFixed(2) + ' GB';
}
function fmtDur(sec) {
  if (!sec || !isFinite(sec)) return '';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${PAD(s % 60)}` : `0:${PAD(s)}`;
}
function fmtExposure(v) {
  if (!v) return '';
  if (v >= 1) return v.toFixed(1).replace(/\.0$/, '') + ' 秒';
  return `1/${Math.round(1 / v)} 秒`;
}
function fmtCoords(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}°${ns}, ${Math.abs(lon).toFixed(4)}°${ew}`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ------------------------------------------------------------------ 状态
const state = {
  all: [],           // 全部媒体
  filtered: [],      // 当前筛选结果（查看器遍历顺序）
  view: 'library',   // library | favorites | videos | live
  mode: 'month',     // day | month | year
  cols: 6,
  query: '',
  device: '',
  favs: new Set(),
  years: new Map(),
  devices: new Map(),
};

const settings = Object.assign(
  { theme: 'dark', hoverLive: true, autoLive: true, slide: 3500, badges: true },
  JSON.parse(localStorage.getItem('pv.settings') || '{}')
);
function saveSettings() {
  localStorage.setItem('pv.settings', JSON.stringify(settings));
}

const VIEW_TITLE = { library: '图库', favorites: '收藏', live: '实况照片', videos: '视频' };

// ---------------------------------------------------------- 主题 & 启动
function applyTheme() {
  const t = settings.theme === 'auto'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : settings.theme;
  document.documentElement.dataset.theme = t;
}

function setBoot(pct, text) {
  const bar = $('#bootBar');
  if (bar) bar.style.width = pct + '%';
  if (text) $('.boot-text').textContent = text;
}
function hideBoot() {
  const b = $('#boot');
  b.classList.add('hide');
  setTimeout(() => b.remove(), 320);
  $('#app').hidden = false;
}

// ------------------------------------------------------------------ 载入
async function boot() {
  applyTheme();
  setBoot(8, '正在读取索引…');
  let index;
  try {
    const res = await fetch('/api/index');
    if (!res.ok) throw new Error('索引不可用（HTTP ' + res.status + '）');
    setBoot(45, '正在解析索引…');
    index = await res.json();
  } catch (e) {
    $('.boot-text').textContent = '载入失败：' + e.message;
    setBoot(100, '');
    return;
  }

  setBoot(70, '正在整理照片…');
  state.all = index.items;

  // 预计算搜索串 & 统计
  for (const it of state.all) {
    it._s = (it.name + ' ' + it.date + ' ' + (it.model || '') + ' ' + it.folder).toLowerCase();
    const y = it.date.slice(0, 4);
    state.years.set(y, (state.years.get(y) || 0) + 1);
    if (it.model) state.devices.set(it.model, (state.devices.get(it.model) || 0) + 1);
  }

  // 收藏
  try {
    const fav = await fetch('/api/favorites').then((r) => r.json());
    state.favs = new Set(fav.favorites || []);
  } catch { /* 忽略 */ }

  setBoot(88, '正在渲染…');
  buildSidebar();
  const savedCols = Number(localStorage.getItem('pv.cols'));
  state.cols = savedCols || clamp(Math.round((innerWidth - 250) / 200), 4, 10);
  $('#densityRange').value = state.cols;
  render();
  updateFavUI();

  setBoot(100, '完成');
  hideBoot();
  setTimeout(hideBootFallback, 900);
  window.addEventListener('resize', onResize);
  if (!restoreFromHash()) {
    // 首次打开定位到最新照片（和 iPhone 一样从最近的照片开始）
    // content-visibility 的分组高度是估算值，分几帧纠正才能真正落到底部
    let n = 0;
    const scrollToEnd = () => {
      const sc = $('#scroller');
      sc.scrollTop = sc.scrollHeight;
      if (++n < 14) requestAnimationFrame(scrollToEnd);
    };
    requestAnimationFrame(scrollToEnd);
  }
  checkBuild();
}

function hideBootFallback() {
  const b = $('#boot');
  if (b) hideBoot();
}

/** 如果构建还在进行，显示进度条 */
async function checkBuild() {
  try {
    const s = await fetch('/api/status').then((r) => r.json());
    const p = s.progress;
    const banner = $('#banner');
    if (p && p.phase && !String(p.phase).includes('完成') && p.total && p.done < p.total) {
      banner.hidden = false;
      banner.innerHTML = `${esc(p.phase)}… <b>${Math.round((p.done / p.total) * 100)}%</b> (${p.done.toLocaleString()}/${p.total.toLocaleString()})`;
      setTimeout(checkBuild, 2500);
    } else {
      banner.hidden = true;
    }
  } catch { /* 忽略 */ }
}

// ---------------------------------------------------------------- 侧栏
function buildSidebar() {
  const yl = $('#yearList');
  const years = [...state.years.keys()].sort((a, b) => b - a);
  yl.innerHTML = years
    .map((y) => `<button class="year-item" data-year="${y}"><span>${y}</span><em>${state.years.get(y).toLocaleString()}</em></button>`)
    .join('');

  const dl = $('#deviceList');
  const devices = [...state.devices.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  dl.innerHTML = devices
    .map(([d, n]) => `<button class="year-item" data-device="${esc(d)}"><span>${esc(shortDevice(d))}</span><em>${n.toLocaleString()}</em></button>`)
    .join('');

  const total = state.all.length;
  const live = state.all.filter((i) => i.live).length;
  const vids = state.all.filter((i) => i.t === 'vid').length;
  const bytes = state.all.reduce((s, i) => s + (i.size || 0), 0);
  $('#cntLive').textContent = live.toLocaleString();
  $('#cntVid').textContent = vids.toLocaleString();
  $('#footStats').innerHTML = `${total.toLocaleString()} 项 · ${live.toLocaleString()} 实况 · ${fmtSize(bytes)}`;
}

function shortDevice(d) {
  return d.replace(/^Apple\s+/i, '').replace(/\s*\(.*\)$/, '');
}

// -------------------------------------------------------------- 渲染
function computeFiltered() {
  let arr = state.all;
  if (state.view === 'favorites') arr = arr.filter((i) => state.favs.has(i.id));
  else if (state.view === 'live') arr = arr.filter((i) => i.live);
  else if (state.view === 'videos') arr = arr.filter((i) => i.t === 'vid');
  if (state.device) arr = arr.filter((i) => i.model === state.device);
  const q = state.query.trim().toLowerCase();
  if (q) {
    const tokens = q.split(/\s+/);
    arr = arr.filter((i) => tokens.every((t) => i._s.includes(t)));
  }
  return arr;
}

function cellHTML(it, idx, cols, opts = {}) {
  const isVid = it.t === 'vid';
  const src = isVid ? `/api/poster?id=${enc(it.id)}` : `/api/thumb?id=${enc(it.id)}`;
  const bits = [];
  if (settings.badges) {
    if (it.live) bits.push('<span class="badge live">实况</span>');
    if (isVid) bits.push(`<span class="badge dur">${fmtDur(it.dur)}</span>`);
    if (state.favs.has(it.id)) bits.push('<span class="badge fav">♥</span>');
    if (opts.dayChip) bits.push(`<span class="daychip">${opts.dayChip}</span>`);
  }
  return (
    `<button class="cell" data-idx="${idx}" data-id="${esc(it.id)}" title="${esc(it.name)}">` +
    `<img src="${src}" loading="lazy" decoding="async" alt="">` +
    `<span class="ph"></span>` +
    bits.join('') +
    `</button>`
  );
}

function render() {
  const list = computeFiltered();
  state.filtered = list;
  const content = $('#content');
  const empty = $('#empty');

  updateTitle(list);

  if (!list.length) {
    content.innerHTML = '';
    empty.hidden = false;
    $('#yearList').querySelectorAll('.on').forEach((e) => e.classList.remove('on'));
    return;
  }
  empty.hidden = true;

  if (state.mode === 'year') {
    renderYears(list, content);
  } else {
    renderGroups(list, content);
  }
  syncNavHighlight();
  markSidebarYear();
  $('#scroller').scrollTop = 0;
  $('#scrollTop').hidden = true;
}

function updateTitle(list) {
  let t = VIEW_TITLE[state.view];
  if (state.device) t = shortDevice(state.device);
  $('#title').textContent = t;
  const bytes = list.reduce((s, i) => s + (i.size || 0), 0);
  $('#subtitle').textContent = `${list.length.toLocaleString()} 项 · ${fmtSize(bytes)}`;
}

function groupBy(list, keyFn) {
  const map = new Map();
  for (const it of list) {
    const k = keyFn(it);
    let g = map.get(k);
    if (!g) map.set(k, (g = []));
    g.push(it);
  }
  return map;
}

function renderGroups(list, content) {
  const mode = state.mode;
  const cols = state.cols;
  const isMonth = mode === 'month';
  const groups = groupBy(list, (it) => (isMonth ? it.date.slice(0, 7) : it.date));

  const parts = [];
  let idx = 0;
  for (const [key, items] of groups) {
    let head;
    if (isMonth) {
      head =
        `${fmtMonthLabel(key)}` +
        `<span class="cnt">${items.length.toLocaleString()} 项</span>` +
        `<span class="jump">按日查看 ›</span>`;
    } else {
      const dt = parseDate(key);
      head = `${fmtDayLabel(key)}<span class="wk">${WEEK[dt.getDay()]}</span><span class="cnt">${items.length} 项</span>`;
    }
    let cells = '';
    let prevDay = '';
    for (const it of items) {
      let chip = '';
      if (isMonth && it.date !== prevDay) {
        chip = `${Number(it.date.slice(8, 10))}日`;
        prevDay = it.date;
      }
      cells += cellHTML(it, idx++, cols, { dayChip: chip });
    }
    parts.push(
      `<section class="grp${isMonth ? ' month' : ''}" data-key="${key}" data-n="${items.length}">` +
      `<h2 class="grp-h">${head}</h2>` +
      `<div class="grid" style="--cols:${cols}">${cells}</div>` +
      `</section>`
    );
  }
  content.innerHTML = `<div class="grp-wrap">${parts.join('')}</div>`;
}

function renderYears(list, content) {
  const groups = groupBy(list, (it) => it.date.slice(0, 4));
  const years = [...groups.keys()].sort((a, b) => b - a);
  const cards = years.map((y) => {
    const items = groups.get(y);
    const picks = pickMosaic(items, 4);
    const bytes = items.reduce((s, i) => s + (i.size || 0), 0);
    const imgs = picks
      .map((it) => `<img src="${it.t === 'vid' ? '/api/poster' : '/api/thumb'}?id=${enc(it.id)}" loading="lazy" decoding="async" alt="">`)
      .join('');
    return (
      `<div class="year-card" data-year="${y}">` +
      `<div class="year-mosaic m${picks.length}">${imgs}</div>` +
      `<div class="year-meta"><b>${y}</b><span>${items.length.toLocaleString()} 项 · ${fmtSize(bytes)}</span></div>` +
      `</div>`
    );
  });
  content.innerHTML = `<div class="year-grid">${cards.join('')}</div>`;
}

function pickMosaic(items, n) {
  if (items.length <= n) return items.slice();
  const out = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor((i * (items.length - 1)) / (n - 1 || 1))]);
  return out;
}

/** 取当前视口顶部所在分组的 key（年视图返回年份） */
function currentAnchor() {
  const secs = document.querySelectorAll('.grp');
  if (secs.length) {
    let lo = 0;
    let hi = secs.length - 1;
    let found = secs[secs.length - 1];
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = secs[mid].getBoundingClientRect();
      if (r.bottom > 90) {
        found = secs[mid];
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return found.dataset.key || '';
  }
  const cards = document.querySelectorAll('.year-card');
  if (!cards.length) return '';
  for (const c of cards) {
    if (c.getBoundingClientRect().bottom > 90) return c.dataset.year || '';
  }
  return cards[cards.length - 1].dataset.year || '';
}

/** 年视图里同一行的卡片无法靠位置区分，单独记一下当前关注的年份 */
let yearFocus = '';

/** 切换浏览密度时保留当前位置 */
function switchMode(mode) {
  if (mode === state.mode) return;
  const leavingYear = state.mode === 'year';
  const anchor = leavingYear && yearFocus ? yearFocus : currentAnchor();
  state.mode = mode;
  render();
  if (!anchor) return;
  const key = mode === 'year' ? anchor.slice(0, 4) : anchor.slice(0, 7);
  if (mode === 'year') yearFocus = key;
  requestAnimationFrame(() => scrollToKey(key));
}

function syncNavHighlight() {
  $$('.nav-item').forEach((b) => b.classList.toggle('on', b.dataset.view === state.view));
  $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
}

function markSidebarYear() {
  const y = (currentAnchor() || '').slice(0, 4);
  $$('#yearList .year-item').forEach((b) => b.classList.toggle('on', b.dataset.year === y));
  $$('#deviceList .year-item').forEach((b) => b.classList.toggle('on', b.dataset.device === state.device));
}

// ------------------------------------------------------------ 图片懒加载态
function attachMediaObservers() {
  document.addEventListener(
    'load',
    (e) => {
      const el = e.target;
      if (el.tagName === 'IMG') {
        el.classList.add('loaded');
        const ph = el.nextElementSibling;
        if (ph && ph.classList.contains('ph')) ph.remove();
      }
    },
    true
  );
  document.addEventListener(
    'error',
    (e) => {
      const el = e.target;
      if (el.tagName === 'IMG') el.classList.add('err');
    },
    true
  );
}

// ---------------------------------------------------------------- 查看器
const V = {
  el: null, stage: null, track: null, img: null, liveVid: null, vid: null,
  idx: -1, zoom: 1, tx: 0, ty: 0, pointers: new Map(),
  dragStart: null, pinchStart: null, infoOpen: false, slideTimer: null,
  chromeTimer: null,
};

function initViewer() {
  V.el = $('#viewer');
  V.stage = $('#vStage');
  V.track = $('#vTrack');
  V.img = $('#vImg');
  V.liveVid = $('#vLiveVid');
  V.vid = $('#vVid');

  $('#vClose').onclick = closeViewer;
  $('#vPrev').onclick = () => showAt(V.idx - 1);
  $('#vNext').onclick = () => showAt(V.idx + 1);
  $('#vFav').onclick = toggleFavCurrent;
  $('#vInfo').onclick = () => toggleInfo();
  $('#vInfoClose').onclick = () => toggleInfo(false);
  $('#vLive').onclick = () => playLive(true);
  $('#vPlay').onclick = toggleSlideshow;
  $('#vFull').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else V.el.requestFullscreen?.().catch(() => {});
  };
  $('#vDownload').onclick = () => {
    const it = state.filtered[V.idx];
    if (!it) return;
    const a = document.createElement('a');
    a.href = `/api/original?id=${enc(it.id)}`;
    a.download = it.name;
    a.click();
  };

  const scrub = $('#vScrub');
  scrub.addEventListener('input', () => {
    $('#vPos').textContent = (Number(scrub.value) + 1).toLocaleString();
  });
  scrub.addEventListener('change', () => showAt(Number(scrub.value)));

  V.liveVid.addEventListener('ended', () => setLivePlaying(false));
  V.liveVid.addEventListener('pause', () => {
    if (V.liveVid.currentTime >= (V.liveVid.duration || 0) - 0.05) setLivePlaying(false);
  });

  // 鼠标 / 触摸交互
  V.stage.addEventListener('pointerdown', onPointerDown);
  V.stage.addEventListener('pointermove', onPointerMove);
  V.stage.addEventListener('pointerup', onPointerUp);
  V.stage.addEventListener('pointercancel', onPointerUp);
  V.stage.addEventListener('wheel', onWheel, { passive: false });
  V.stage.addEventListener('dblclick', onDblClick);
  V.el.addEventListener('mousemove', showChrome);
  V.el.addEventListener('contextmenu', (e) => {
    if (e.target.tagName === 'IMG') e.preventDefault();
  });
}

function openViewer(idx) {
  V.el.hidden = false;
  document.body.classList.add('viewing');
  showAt(idx);
  showChrome();
}

function closeViewer() {
  V.el.hidden = true;
  document.body.classList.remove('viewing');
  stopSlideshow();
  V.liveVid.pause();
  V.liveVid.removeAttribute('src');
  V.liveVid.load();
  V.vid.pause();
  V.vid.removeAttribute('src');
  V.vid.load();
  toggleInfo(false);
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch {
    /* 忽略 */
  }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

/** 从 URL hash 恢复上次浏览的照片 */
function restoreFromHash() {
  const raw = location.hash.slice(1);
  if (!raw) return false;
  let id;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return false;
  }
  const idx = state.filtered.findIndex((it) => it.id === id);
  if (idx < 0) return false;
  openViewer(idx);
  return true;
}

function showAt(i) {
  const list = state.filtered;
  if (!list.length) return;
  i = clamp(i, 0, list.length - 1);
  V.idx = i;
  const it = list[i];

  // 复位缩放
  V.zoom = 1; V.tx = 0; V.ty = 0;
  V.track.style.transition = 'none';
  applyTransform();

  // 清理
  V.img.classList.remove('ready');
  V.img.removeAttribute('src');
  V.vid.classList.remove('on');
  V.vid.pause();
  if (it.t !== 'vid' && V.vid.getAttribute('src')) {
    V.vid.removeAttribute('src');
    V.vid.load();
  }
  V.liveVid.pause();
  setLivePlaying(false);
  $('#vLive').hidden = true;

  // 标题
  $('#vDate').textContent = fmtTime(it.ts);
  const sub = [];
  if (it.model) sub.push(shortDevice(it.model));
  if (it.w && it.h) sub.push(`${it.w}×${it.h}`);
  if (it.live) sub.push('实况照片');
  if (it.t === 'vid') sub.push('视频 ' + fmtDur(it.dur));
  $('#vSub').textContent = sub.join(' · ');
  $('#vFav').classList.toggle('on', state.favs.has(it.id));

  // 主体
  if (it.t === 'vid') {
    V.img.style.display = 'none';
    V.vid.classList.add('on');
    V.vid.src = `/api/full?id=${enc(it.id)}`;
    V.vid.play().catch(() => {});
  } else {
    V.img.style.display = '';
    const full = `/api/full?id=${enc(it.id)}`;
    V.img.onload = () => {
      V.img.classList.add('ready');
      $('#vLoading').classList.remove('on');
    };
    V.img.onerror = () => $('#vLoading').classList.remove('on');
    $('#vLoading').classList.add('on');
    V.img.src = full;

    if (it.live) {
      $('#vLive').hidden = false;
      V.liveVid.src = `/api/live?id=${enc(it.id)}`;
      if (settings.autoLive) {
        V.liveVid.muted = true;
        V.liveVid.currentTime = 0;
        V.liveVid.play().then(() => setLivePlaying(true)).catch(() => {});
      }
    } else {
      V.liveVid.removeAttribute('src');
      V.liveVid.load();
    }
  }

  // 底部
  $('#vScrub').max = Math.max(0, list.length - 1);
  $('#vScrub').value = i;
  $('#vPos').textContent = (i + 1).toLocaleString();
  $('#vTotal').textContent = list.length.toLocaleString();
  $('#vPrev').disabled = i === 0;
  $('#vNext').disabled = i === list.length - 1;

  if (V.infoOpen) renderInfo(it);

  // 预载相邻
  for (const d of [1, 2, -1]) {
    const n = list[i + d];
    if (n && n.t === 'img') { const im = new Image(); im.src = `/api/full?id=${enc(n.id)}`; }
  }
  // 更新 URL hash，便于刷新后定位（节流，避免浏览器导航频率限制）
  scheduleHash(it);
}

let hashTimer = null;
function scheduleHash(it) {
  if (hashTimer) return;
  hashTimer = setTimeout(() => {
    hashTimer = null;
    try {
      history.replaceState(null, '', '#' + enc(it.id));
    } catch {
      /* 忽略 */
    }
  }, 350);
}

function setLivePlaying(on) {
  V.liveVid.classList.toggle('on', on);
  $('#vLive').classList.toggle('playing', on);
}

function playLive(withSound) {
  const it = state.filtered[V.idx];
  if (!it || !it.live) return;
  V.liveVid.currentTime = 0;
  V.liveVid.muted = !withSound;
  setLivePlaying(true);
  V.liveVid.play().catch(() => setLivePlaying(false));
}

function applyTransform() {
  V.track.style.transform = `translate3d(${V.tx}px, ${V.ty}px, 0) scale(${V.zoom})`;
  V.stage.classList.toggle('zoomed', V.zoom > 1.01);
}

function zoomTo(z, cx, cy) {
  const rect = V.stage.getBoundingClientRect();
  const px = cx - rect.left - rect.width / 2;
  const py = cy - rect.top - rect.height / 2;
  const nz = clamp(z, 1, 8);
  // 让光标下的点保持不动
  const k = nz / V.zoom;
  V.tx = px - (px - V.tx) * k;
  V.ty = py - (py - V.ty) * k;
  V.zoom = nz;
  if (V.zoom <= 1.001) { V.tx = 0; V.ty = 0; V.zoom = 1; }
  constrain();
  V.track.style.transition = 'transform .16s cubic-bezier(.22,.61,.36,1)';
  applyTransform();
}

function constrain() {
  const rect = V.stage.getBoundingClientRect();
  const maxX = Math.max(0, (rect.width * (V.zoom - 1)) / 2);
  const maxY = Math.max(0, (rect.height * (V.zoom - 1)) / 2);
  V.tx = clamp(V.tx, -maxX, maxX);
  V.ty = clamp(V.ty, -maxY, maxY);
}

function onDblClick(e) {
  if (e.target.closest('video')) return;
  if (V.zoom > 1.01) zoomTo(1, e.clientX, e.clientY);
  else zoomTo(2.6, e.clientX, e.clientY);
}

function onWheel(e) {
  e.preventDefault();
  if (e.ctrlKey || V.zoom > 1.01) {
    const factor = Math.exp(-e.deltaY * 0.0022);
    zoomTo(V.zoom * factor, e.clientX, e.clientY);
    return;
  }
  // 未缩放时：竖向滚动切换上一张 / 下一张（带节流）
  const now = performance.now();
  if (now - (V.wheelLock || 0) < 320) return;
  V.wheelAcc = (V.wheelAcc || 0) + e.deltaY;
  if (Math.abs(V.wheelAcc) > 110) {
    showAt(V.idx + (V.wheelAcc > 0 ? 1 : -1));
    V.wheelAcc = 0;
    V.wheelLock = now;
  }
}

function onPointerDown(e) {
  if (e.target.closest('video')) return;
  V.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  V.stage.setPointerCapture(e.pointerId);
  if (V.pointers.size === 2) {
    const [a, b] = [...V.pointers.values()];
    V.pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), z: V.zoom };
    V.dragStart = null;
  } else if (V.pointers.size === 1) {
    V.dragStart = { x: e.clientX, y: e.clientY, tx: V.tx, ty: V.ty, moved: false };
    V.stage.classList.add('grabbing');
  }
}

function onPointerMove(e) {
  if (!V.pointers.has(e.pointerId)) return;
  V.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (V.pointers.size === 2 && V.pinchStart) {
    const [a, b] = [...V.pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    zoomTo(V.pinchStart.z * (d / (V.pinchStart.d || 1)), midX, midY);
    return;
  }

  const ds = V.dragStart;
  if (!ds) return;
  const dx = e.clientX - ds.x;
  const dy = e.clientY - ds.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) ds.moved = true;

  if (V.zoom > 1.01) {
    V.tx = ds.tx + dx;
    V.ty = ds.ty + dy;
    constrain();
    V.track.style.transition = 'none';
    applyTransform();
  } else {
    // 未缩放：只做轻微跟手反馈
    V.track.style.transition = 'none';
    V.track.style.transform = `translate3d(${dx * 0.28}px, ${dy * 0.28}px, 0) scale(1)`;
  }
}

function onPointerUp(e) {
  if (!V.pointers.has(e.pointerId)) return;
  V.pointers.delete(e.pointerId);
  V.stage.classList.remove('grabbing');

  if (V.pointers.size < 2) V.pinchStart = null;

  const ds = V.dragStart;
  if (!ds) return;
  V.dragStart = null;

  const dx = e.clientX - ds.x;
  const dy = e.clientY - ds.y;

  if (V.zoom <= 1.01) {
    V.track.style.transition = 'transform .22s cubic-bezier(.22,.61,.36,1)';
    applyTransform();
    if (Math.abs(dx) > 70 || Math.abs(dy) > 110) {
      const dir = Math.abs(dx) > Math.abs(dy) ? -Math.sign(dx) : -Math.sign(dy);
      showAt(V.idx + dir);
      return;
    }
  } else {
    constrain();
    applyTransform();
  }
  if (!ds.moved) {
    // 单击：切换控制条
    toggleChrome();
  }
}

function showChrome() {
  clearTimeout(V.chromeTimer);
  V.el.classList.remove('chrome-hidden');
  V.chromeTimer = setTimeout(() => {
    if (!V.infoOpen) V.el.classList.add('chrome-hidden');
  }, 2600);
}
function toggleChrome() {
  V.el.classList.toggle('chrome-hidden');
  if (!V.el.classList.contains('chrome-hidden')) showChrome();
}

// ------------------------------------------------------------------ 信息
function toggleInfo(force) {
  V.infoOpen = force === undefined ? !V.infoOpen : force;
  $('#vInfoPanel').hidden = !V.infoOpen;
  $('#vInfo').classList.toggle('on', V.infoOpen);
  V.el.classList.toggle('info-open', V.infoOpen);
  if (V.infoOpen) {
    const it = state.filtered[V.idx];
    if (it) renderInfo(it);
    V.el.classList.remove('chrome-hidden');
  } else {
    showChrome();
  }
}

function renderInfo(it) {
  const rows = [];
  const add = (k, v) => { if (v !== undefined && v !== null && v !== '') rows.push(`<div class="info-row"><dt>${k}</dt><dd>${v}</dd></div>`); };

  const isVid = it.t === 'vid';
  const badge = it.live ? '<div class="info-badge">◉ 实况照片</div>' : isVid ? '<div class="info-badge">▶ 视频</div>' : '';

  add('拍摄时间', fmtTime(it.ts));
  add('尺寸', it.w && it.h ? `${it.w} × ${it.h}` : '—');
  add('文件大小', fmtSize(it.size));
  add('格式', (it.ext || '').replace('.', '').toUpperCase());
  if (it.make || it.model) add('设备', [it.make, it.model].filter(Boolean).join(' '));
  if (it.lens) add('镜头', esc(it.lens));
  if (it.fnum) add('光圈', `ƒ/${it.fnum}`);
  if (it.expo) add('快门', fmtExposure(it.expo));
  if (it.iso) add('感光度', `ISO ${it.iso}`);
  if (it.focal) add('焦距', `${Math.round(it.focal)} mm`);
  if (it.gps) {
    const [lat, lon] = it.gps;
    add('位置', `<a class="info-map" target="_blank" rel="noopener" href="https://www.apple.com/maps/?ll=${lat},${lon}">${fmtCoords(lat, lon)} ↗</a>`);
  }
  if (it.live) {
    add('实况时长', `${(it.live.dur || 1.6).toFixed(1)} 秒`);
    add('实况文件', fmtSize(it.live.size));
  }
  if (isVid) {
    add('时长', fmtDur(it.dur));
    add('编码', (it.codec || '').toUpperCase());
  }

  const thumbSrc = isVid ? `/api/poster?id=${enc(it.id)}` : `/api/thumb?id=${enc(it.id)}`;
  $('#vInfoBody').innerHTML =
    badge +
    `<img class="info-thumb" src="${thumbSrc}" alt="">` +
    `<div class="info-sec"><h4>详细信息</h4>${rows.join('')}</div>` +
    `<div class="info-sec"><h4>文件</h4>` +
    `<div class="info-row"><dt>名称</dt><dd>${esc(it.name)}</dd></div>` +
    `<div class="info-row"><dt>路径</dt><dd>${esc(it.id)}</dd></div>` +
    `</div>`;
}

// ------------------------------------------------------------------ 收藏
async function toggleFavCurrent() {
  const it = state.filtered[V.idx];
  if (!it) return;
  await setFav(it.id, !state.favs.has(it.id));
  $('#vFav').classList.toggle('on', state.favs.has(it.id));
  renderInfo(it);
}

async function setFav(id, on) {
  if (on) state.favs.add(id);
  else state.favs.delete(id);
  updateFavUI();
  try {
    await fetch('/api/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, fav: on }),
    });
  } catch { toast('收藏保存失败'); }
  toast(on ? '已加入收藏' : '已取消收藏');
}

function updateFavUI() {
  $('#cntFav').textContent = state.favs.size ? state.favs.size.toLocaleString() : '';
}

// ------------------------------------------------------------------ 幻灯片
function toggleSlideshow() {
  if (V.slideTimer) return stopSlideshow();
  toast('幻灯片已开始，按 S 或空格停止');
  $('#vPlay').classList.add('on');
  V.el.classList.add('chrome-hidden');
  const tick = () => {
    if (V.idx >= state.filtered.length - 1) return stopSlideshow();
    showAt(V.idx + 1);
  };
  tick();
  V.slideTimer = setInterval(tick, settings.slide);
}

function stopSlideshow() {
  if (V.slideTimer) clearInterval(V.slideTimer);
  V.slideTimer = null;
  $('#vPlay').classList.remove('on');
}

// ------------------------------------------------------------------ 提示
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('on'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('on');
    setTimeout(() => { el.hidden = true; }, 200);
  }, 1600);
}

// ------------------------------------------------------------------ 悬停预览
function initHoverPreview() {
  const content = $('#content');
  const vid = document.createElement('video');
  vid.muted = true;
  vid.playsInline = true;
  vid.loop = false;
  vid.className = 'hover-vid';
  let timer = null;
  let currentCell = null;

  const clear = () => {
    clearTimeout(timer);
    timer = null;
    vid.pause();
    vid.removeAttribute('src');
    if (currentCell) {
      const old = currentCell;
      setTimeout(() => { if (old.contains(vid)) old.removeChild(vid); }, 0);
    }
    currentCell = null;
  };

  content.addEventListener('pointerover', (e) => {
    if (!settings.hoverLive) return;
    const cell = e.target.closest?.('.cell');
    if (!cell || cell === currentCell) return;
    clear();
    if (document.body.classList.contains('viewing')) return;
    const it = state.filtered[Number(cell.dataset.idx)];
    if (!it || !it.live) return;
    currentCell = cell;
    timer = setTimeout(() => {
      vid.src = `/api/live?id=${enc(it.id)}`;
      cell.appendChild(vid);
      vid.currentTime = 0;
      vid.play().catch(() => {});
    }, 420);
  });

  content.addEventListener('pointerout', (e) => {
    const cell = e.target.closest?.('.cell');
    if (cell && cell === currentCell) clear();
  });
  $('#scroller').addEventListener('scroll', () => clear(), { passive: true });
}

// ------------------------------------------------------------------ 交互绑定
function bindUI() {
  // 侧栏导航
  $('#sideNav').addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item');
    if (!b) return;
    state.view = b.dataset.view;
    if (state.view !== 'library') state.device = '';
    render();
  });

  $('#yearList').addEventListener('click', (e) => {
    const b = e.target.closest('.year-item');
    if (!b) return;
    jumpToYear(b.dataset.year);
  });

  $('#deviceList').addEventListener('click', (e) => {
    const b = e.target.closest('.year-item');
    if (!b) return;
    state.device = state.device === b.dataset.device ? '' : b.dataset.device;
    if (state.view !== 'library') state.view = 'library';
    render();
  });

  // 视图模式
  $('#modeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    switchMode(b.dataset.mode);
  });

  // 网格密度
  const dr = $('#densityRange');
  dr.addEventListener('input', () => setCols(Number(dr.value)));
  $('#zoomIn').onclick = () => setCols(state.cols + 1);
  $('#zoomOut').onclick = () => setCols(state.cols - 1);

  // 搜索
  let sTimer = null;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(sTimer);
    sTimer = setTimeout(() => {
      state.query = e.target.value;
      render();
    }, 160);
  });

  // 网格点击
  $('#content').addEventListener('click', (e) => {
    const card = e.target.closest('.year-card');
    if (card) {
      yearFocus = card.dataset.year;
      state.mode = 'month';
      render();
      requestAnimationFrame(() => scrollToKey(card.dataset.year));
      return;
    }
    const mh = e.target.closest('.grp.month > .grp-h');
    if (mh) {
      const key = mh.parentElement.dataset.key;
      state.mode = 'day';
      render();
      requestAnimationFrame(() => scrollToKey(key));
      return;
    }
    const cell = e.target.closest('.cell');
    if (cell) openViewer(Number(cell.dataset.idx));
  });

  // 回到顶部
  $('#scroller').addEventListener('scroll', onScroll, { passive: true });
  $('#scrollTop').onclick = () => $('#scroller').scrollTo({ top: 0, behavior: 'smooth' });

  // 侧栏（窄屏）
  $('#openSidebar').onclick = () => $('#sidebar').classList.add('open');
  $('#closeSidebar').onclick = () => $('#sidebar').classList.remove('open');

  // 设置
  $('#btnSettings').onclick = () => openSettings();
  $('#settingsClose').onclick = () => { $('#settings').hidden = true; };
  $('#settings').addEventListener('click', (e) => { if (e.target.id === 'settings') $('#settings').hidden = true; });
  $('#setTheme').onchange = (e) => { settings.theme = e.target.value; saveSettings(); applyTheme(); };
  $('#setHoverLive').onchange = (e) => { settings.hoverLive = e.target.checked; saveSettings(); };
  $('#setAutoLive').onchange = (e) => { settings.autoLive = e.target.checked; saveSettings(); };
  $('#setSlide').onchange = (e) => { settings.slide = Number(e.target.value); saveSettings(); };
  $('#setBadges').onchange = (e) => { settings.badges = e.target.checked; saveSettings(); render(); };

  $('#btnSlideshow').onclick = () => {
    if (!state.filtered.length) return;
    openViewer(0);
    setTimeout(() => toggleSlideshow(), 60);
  };

  $('#btnInfo').onclick = () => {
    if (!state.filtered.length) return;
    if (V.el.hidden) openViewer(V.idx >= 0 ? V.idx : 0);
    toggleInfo(true);
  };

  document.addEventListener('keydown', onKeyDown);
}

function setCols(n) {
  state.cols = clamp(Math.round(n), 2, 12);
  localStorage.setItem('pv.cols', String(state.cols));
  $('#densityRange').value = state.cols;
  const top = $('#scroller').scrollTop;
  render();
  $('#scroller').scrollTop = top;
}

let scrollRaf = 0;
function onScroll() {
  const sc = $('#scroller');
  $('#scrollTop').hidden = sc.scrollTop < 900;
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    markSidebarYear();
  });
}

function jumpToYear(year) {
  if (state.mode === 'year') state.mode = 'month';
  state.view = 'library';
  state.device = '';
  state.query = '';
  $('#search').value = '';
  render();
  requestAnimationFrame(() => scrollToKey(year));
}

function scrollToKey(prefix) {
  let target =
    document.querySelector(`.grp[data-key^="${prefix}"], .grp[data-key="${prefix}"]`) ||
    document.querySelector(`.year-card[data-year="${String(prefix).slice(0, 4)}"]`);
  if (!target) return;
  target.scrollIntoView({ block: 'start' });
  // content-visibility 估算高度可能导致偏差，做一次纠正
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const r = target.getBoundingClientRect();
      const top = $('#scroller').getBoundingClientRect().top;
      if (Math.abs(r.top - top) > 8) {
        $('#scroller').scrollTop += r.top - top;
      }
    });
  });
}

function onResize() {
  // 网格自适应无需重排，CSS 已用 fr 单位
  if (!V.el.hidden) constrain();
}

function onKeyDown(e) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (typing) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }

  if (!V.el.hidden) {
    switch (e.key) {
      case 'Escape': e.preventDefault(); closeViewer(); break;
      case 'ArrowLeft': e.preventDefault(); showAt(V.idx - 1); break;
      case 'ArrowRight': e.preventDefault(); showAt(V.idx + 1); break;
      case ' ': e.preventDefault(); {
        const it = state.filtered[V.idx];
        if (it?.live) playLive(true);
        else if (it?.t === 'vid') { V.vid.paused ? V.vid.play() : V.vid.pause(); }
        else toggleSlideshow();
        break;
      }
      case 'f': case 'F': toggleFavCurrent(); break;
      case 'i': case 'I': toggleInfo(); break;
      case 's': case 'S': toggleSlideshow(); break;
      case '0': zoomTo(1, innerWidth / 2, innerHeight / 2); break;
      case '+': case '=': zoomTo(V.zoom * 1.35, innerWidth / 2, innerHeight / 2); break;
      case '-': case '_': zoomTo(V.zoom / 1.35, innerWidth / 2, innerHeight / 2); break;
      case 'Home': showAt(0); break;
      case 'End': showAt(state.filtered.length - 1); break;
    }
    return;
  }

  if (e.key === 'Escape') { $('#settings').hidden = true; return; }
  if (e.key === '/' ) { e.preventDefault(); $('#search').focus(); return; }
  if (e.key === '-' || e.key === '_') { setCols(state.cols - 1); return; }
  if (e.key === '+' || e.key === '=') { setCols(state.cols + 1); return; }
}

function openSettings() {
  $('#settings').hidden = false;
  $('#setTheme').value = settings.theme;
  $('#setHoverLive').checked = settings.hoverLive;
  $('#setAutoLive').checked = settings.autoLive;
  $('#setSlide').value = String(settings.slide);
  $('#setBadges').checked = settings.badges;
}

// ------------------------------------------------------------------ 启动
attachMediaObservers();
initViewer();
initHoverPreview();
bindUI();
boot();
