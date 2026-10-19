/**
 * 照片阅读器 · 本地服务
 * =====================
 * 零依赖 Node HTTP 服务：静态页面 + 索引 API + 媒体流派发 + 收藏持久化。
 *
 *   node server.js [--port 7788] [--host 127.0.0.1]
 *
 * 目录约定：
 *   public/   前端页面
 *   cache/    构建产物（index.json / thumbs / view / live / poster）
 *   data/     用户数据（收藏）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CACHE_DIR = path.join(ROOT, 'cache');
const DATA_DIR = path.join(ROOT, 'data');
const PHOTOS_DIR = process.env.PHOTOS_DIR || 'D:\\老电脑里的\\icloud\\photos';

const FAV_FILE = path.join(DATA_DIR, 'favorites.json');

// ------------------------------------------------------------------ 参数
const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = Number(getArg('port', process.env.PORT || 7788));
const HOST = getArg('host', '127.0.0.1');

// ------------------------------------------------------------------ MIME
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.woff2': 'font/woff2',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

// ------------------------------------------------------------- 索引缓存
let indexCache = null; // { buf, gz, etag, mtimeMs }

async function loadIndex() {
  const file = path.join(CACHE_DIR, 'index.json');
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return null;
  }
  if (indexCache && indexCache.mtimeMs === st.mtimeMs) return indexCache;
  const buf = await fsp.readFile(file);
  const gz = zlib.gzipSync(buf, { level: 6 });
  indexCache = { buf, gz, etag: `"${st.mtimeMs.toString(36)}-${buf.length}"`, mtimeMs: st.mtimeMs };
  return indexCache;
}

// --------------------------------------------------------- 收藏持久化
let favSet = new Set();
let favLoaded = false;
let favWriteChain = Promise.resolve();

async function loadFavorites() {
  if (favLoaded) return;
  favLoaded = true;
  try {
    const raw = await fsp.readFile(FAV_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) favSet = new Set(arr.filter((x) => typeof x === 'string'));
  } catch {
    favSet = new Set();
  }
}

function saveFavorites() {
  favWriteChain = favWriteChain.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = FAV_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify([...favSet]), 'utf8');
    await fsp.rename(tmp, FAV_FILE);
  }).catch((e) => console.error('[favorites] 写入失败', e.message));
  return favWriteChain;
}

// ------------------------------------------------------------- 路径安全
function safeJoin(baseDir, rel) {
  const norm = String(rel).replace(/\\/g, '/');
  if (!norm || norm.includes('\0')) return null;
  const abs = path.resolve(baseDir, norm);
  const base = path.resolve(baseDir);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

const decodeId = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

// ------------------------------------------------------------- 响应工具
function sendJSON(res, status, obj, headers = {}) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

async function statOrNull(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

/** 带 Range 的文件流发送（视频拖动必需）
 *  silent=true 时若文件不存在则只返回 false，不写响应，便于上层继续尝试其它候选。 */
async function sendFile(req, res, absPath, { cacheControl = 'public, max-age=86400', etag = null, silent = false } = {}) {
  const st = await statOrNull(absPath);
  if (!st || !st.isFile()) {
    if (silent) return false;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('未找到');
    return false;
  }
  const mime = mimeOf(absPath);
  const range = req.headers.range;
  const baseHeaders = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
    'Last-Modified': st.mtime.toUTCString(),
  };
  if (etag) baseHeaders.ETag = etag;

  // 条件请求
  if (etag && req.headers['if-none-match'] === etag) {
    res.writeHead(304, baseHeaders);
    res.end();
    return true;
  }

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] === '' ? null : parseInt(m[1], 10);
      let end = m[2] === '' ? null : parseInt(m[2], 10);
      if (start === null && end !== null) {
        start = Math.max(0, st.size - end);
        end = st.size - 1;
      } else {
        if (start === null) start = 0;
        if (end === null || end >= st.size) end = st.size - 1;
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        res.end();
        return true;
      }
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Content-Length': end - start + 1,
      });
      if (req.method === 'HEAD') return res.end(), true;
      fs.createReadStream(absPath, { start, end }).pipe(res);
      return true;
    }
  }

  res.writeHead(200, { ...baseHeaders, 'Content-Length': st.size });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(absPath).pipe(res);
  return true;
}

// ---------------------------------------------------------------- 路由
async function handleApi(req, res, urlObj) {
  const { pathname, searchParams } = urlObj;

  if (pathname === '/api/index') {
    const idx = await loadIndex();
    if (!idx) return sendJSON(res, 503, { error: '索引尚未生成，请先运行构建脚本' });
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      ETag: idx.etag,
      Vary: 'Accept-Encoding',
    };
    if (req.headers['if-none-match'] === idx.etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const body = acceptsGzip ? idx.gz : idx.buf;
    if (acceptsGzip) headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  if (pathname === '/api/status') {
    const parts = {};
    for (const f of ['progress.json', 'index.json']) {
      const st = await statOrNull(path.join(CACHE_DIR, f));
      parts[f] = st ? { size: st.size, mtime: st.mtimeMs } : null;
    }
    let progress = null;
    try {
      progress = JSON.parse(await fsp.readFile(path.join(CACHE_DIR, 'progress.json'), 'utf8'));
    } catch {
      /* 忽略 */
    }
    return sendJSON(res, 200, { ok: true, progress, files: parts });
  }

  if (pathname === '/api/favorites') {
    await loadFavorites();
    if (req.method === 'GET') {
      return sendJSON(res, 200, { favorites: [...favSet] });
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 1e6) req.destroy();
      });
      req.on('end', async () => {
        try {
          const msg = JSON.parse(body || '{}');
          const id = String(msg.id || '');
          if (!id) return sendJSON(res, 400, { error: 'bad id' });
          if (msg.fav === false) favSet.delete(id);
          else favSet.add(id);
          await saveFavorites();
          sendJSON(res, 200, { ok: true, fav: favSet.has(id), count: favSet.size });
        } catch (e) {
          sendJSON(res, 400, { error: e.message });
        }
      });
      return;
    }
    return sendJSON(res, 405, { error: 'method not allowed' });
  }

  // 媒体类
  const mediaRoutes = {
    '/api/thumb': { dir: 'thumbs', ext: '.jpg' },
    '/api/view': { dir: 'view', ext: '.jpg' },
    '/api/poster': { dir: 'poster', ext: '.jpg' },
    '/api/live': { dir: 'live', ext: '.mp4' },
  };
  if (mediaRoutes[pathname]) {
    const route = mediaRoutes[pathname];
    const id = decodeId(searchParams.get('id') || '');
    if (!id) return sendJSON(res, 400, { error: 'missing id' });
    const cached = safeJoin(path.join(CACHE_DIR, route.dir), id + route.ext);
    if (cached) {
      const ok = await sendFile(req, res, cached, {
        cacheControl: 'public, max-age=31536000, immutable',
        silent: true,
      });
      if (ok) return;
    }
    // 回退：直接给原始文件（构建未完成时仍可浏览）
    if (route.dir === 'thumbs' || route.dir === 'view' || route.dir === 'live') {
      const orig = safeJoin(PHOTOS_DIR, id);
      if (orig && (await sendFile(req, res, orig, { cacheControl: 'no-cache', silent: true }))) return;
    }
    return sendJSON(res, 404, { error: 'not generated', id });
  }

  if (pathname === '/api/full' || pathname === '/api/media') {
    const id = decodeId(searchParams.get('id') || '');
    if (!id) return sendJSON(res, 400, { error: 'missing id' });
    const ext = path.extname(id).toLowerCase();
    if (ext === '.heic' || ext === '.heif') {
      const view = safeJoin(path.join(CACHE_DIR, 'view'), id + '.jpg');
      if (view && (await sendFile(req, res, view, {
        cacheControl: 'public, max-age=31536000, immutable',
        silent: true,
      }))) return;
    }
    // 独立视频若已转码为浏览器友好的 MP4，优先使用
    if (['.mov', '.mp4', '.m4v'].includes(ext)) {
      const tc = safeJoin(path.join(CACHE_DIR, 'live'), id + '.mp4');
      if (tc && (await sendFile(req, res, tc, {
        cacheControl: 'public, max-age=31536000, immutable',
        silent: true,
      }))) return;
    }
    const orig = safeJoin(PHOTOS_DIR, id);
    if (orig && (await sendFile(req, res, orig, { cacheControl: 'public, max-age=604800' }))) return;
    return sendJSON(res, 404, { error: 'not found', id });
  }

  // 始终返回原始文件（用于「下载 / 另存为」）
  if (pathname === '/api/original') {
    const id = decodeId(searchParams.get('id') || '');
    if (!id) return sendJSON(res, 400, { error: 'missing id' });
    const orig = safeJoin(PHOTOS_DIR, id);
    if (!orig) return sendJSON(res, 403, { error: 'forbidden' });
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(orig))}`);
    if (await sendFile(req, res, orig, { cacheControl: 'no-cache' })) return;
    return sendJSON(res, 404, { error: 'not found', id });
  }

  if (pathname === '/api/stat') {
    const id = decodeId(searchParams.get('id') || '');
    const orig = id ? safeJoin(PHOTOS_DIR, id) : null;
    const st = orig ? await statOrNull(orig) : null;
    return sendJSON(res, 200, { exists: !!st, size: st ? st.size : 0 });
  }

  return sendJSON(res, 404, { error: 'unknown api' });
}

async function handleStatic(req, res, urlObj) {
  let pathname = urlObj.pathname;
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const abs = safeJoin(PUBLIC_DIR, pathname.replace(/^\/+/, ''));
  if (!abs) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  const st = await statOrNull(abs);
  if (!st || !st.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<meta charset="utf-8"><h1>404</h1><p>页面不存在</p>');
  }
  const isHtml = abs.endsWith('.html');
  return sendFile(req, res, abs, {
    cacheControl: isHtml ? 'no-cache' : 'no-cache, must-revalidate',
  });
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  let urlObj;
  try {
    urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400);
    return res.end('bad request');
  }

  // 仅允许本机访问
  try {
    if (urlObj.pathname.startsWith('/api/')) {
      await handleApi(req, res, urlObj);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      await handleStatic(req, res, urlObj);
    } else {
      res.writeHead(405);
      res.end('method not allowed');
    }
  } catch (err) {
    console.error('[server] 处理失败', req.url, err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('服务器内部错误');
    } else {
      res.destroy();
    }
  }
  if (process.env.PV_LOG) {
    console.log(`${req.method} ${decodeURIComponent(req.url)} ${res.statusCode} ${Date.now() - t0}ms`);
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

const OPEN_BROWSER = args.includes('--open');
let listenPort = PORT;
let retries = 0;

function showBanner(port) {
  const idxCount = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'index.json'), 'utf8')).count;
    } catch {
      return 0;
    }
  })();
  console.log('');
  console.log('  📷  照片阅读器已启动');
  console.log(`      地址   http://${HOST}:${port}`);
  console.log(`      媒体   ${idxCount ? idxCount.toLocaleString() + ' 项' : '索引未生成（请先构建）'}`);
  console.log(`      照片库 ${PHOTOS_DIR}`);
  console.log(`      收藏   ${favSet.size} 项`);
  console.log('      按 Ctrl+C 停止');
  console.log('');
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && retries < 12) {
    retries += 1;
    console.warn(`端口 ${listenPort} 已被占用，尝试 ${listenPort + 1} …`);
    listenPort += 1;
    setTimeout(() => server.listen(listenPort, HOST), 60);
    return;
  }
  console.error('启动失败：', err.message);
  process.exit(1);
});

server.listen(listenPort, HOST, async () => {
  await fsp.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  await loadFavorites();
  await loadIndex();
  showBanner(listenPort);
  if (OPEN_BROWSER) {
    const url = `http://${HOST}:${listenPort}`;
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : `open "${url}"`;
    require('child_process').exec(cmd, () => {});
  }
});

process.on('SIGINT', () => {
  console.log('\n正在停止…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});
