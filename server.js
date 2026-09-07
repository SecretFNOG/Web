'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const auth = require('./auth');
const { getStatus } = require('./status');

const ROOT = __dirname;
loadConfig();

const config = {
  port: Number(process.env.PORT || 3000),
  sessionSecret: process.env.SESSION_SECRET,
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    redirectUri: process.env.DISCORD_REDIRECT_URI,
  },
  apiUrl: (process.env.SECRET_API_URL || '').replace(/\/+$/, ''),
  healthPath: process.env.SECRET_API_HEALTH_PATH || '/status',
  discordInvite: process.env.DISCORD_INVITE || '#',
};

function loadConfig() {
  auth.loadEnv(path.join(ROOT, '.env'));
  const local = path.join(ROOT, '.env.local');
  if (fs.existsSync(local)) auth.loadEnv(local);
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    console.warn('[secret-web] SESSION_SECRET not set — using a random secret (sessions reset on restart).');
  }
}

let tiersCache = { mtime: 0, data: null };
function getTiers() {
  const file = path.join(ROOT, 'config', 'tiers.json');
  const mtime = fs.statSync(file).mtimeMs;
  if (!tiersCache.data || tiersCache.mtime !== mtime) {
    tiersCache = { mtime, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  return tiersCache.data;
}

const views = {};
function view(name) {
  if (!views[name]) views[name] = fs.readFileSync(path.join(ROOT, 'views', name + '.html'), 'utf8');
  return views[name];
}

function money(amount) {
  const t = getTiers();
  return t.currency.symbol + amount.toFixed(2);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const AVATAR_SIZES = '';

function renderUserNav(user) {
  if (!user) return '';
  const name = user.global_name || user.username;
  const avatar = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
    : `https://cdn.discordapp.com/embed/avatars/${BigInt(user.id) % 6n}.png?size=64`;
  return (
    `<a class="nav-user" href="/logout" title="Signed in as ${escapeHtml(name)} — sign out">` +
    `<span class="nav-username">${escapeHtml(name)}</span>` +
    `<img class="nav-avatar" src="${avatar}" alt="" width="26" height="26" />` +
    '</a>'
  );
}

function navLinks(active) {
  const links = [
    ['/', 'Home'],
    ['/store', 'Store'],
    ['/status', 'Status'],
  ];
  return links
    .map(([href, label]) => `<a class="nav-link${active === href ? ' active' : ''}" href="${href}">${label}</a>`)
    .join('');
}

function page(name, { user, active, title, description, content }) {
  const base = view('base');
  return base
    .replaceAll('{{title}}', title ? `${title} · Secret` : 'Secret')
    .replaceAll('{{description}}', description || 'Secret — a private Chapter 5 Season 1 (28.30) experience.')
    .replaceAll('{{navLinks}}', navLinks(active))
    .replaceAll('{{userNav}}', renderUserNav(user, active))
    .replaceAll('{{content}}', content);
}

function tierRow(tier) {
  const price = getTiers().currency.symbol + tier.price.toFixed(2);
  const perks = tier.perks.map(escapeHtml).join('\n');
  return (
    `<article class="tier-row">` +
    `<div class="tier-icon icon-${tier.icon}" title="${escapeHtml(perks)}"></div>` +
    `<div class="tier-info"><h3 class="tier-name">${escapeHtml(tier.name)}</h3>` +
    `<p class="tier-blurb">${escapeHtml(tier.blurb)}</p></div>` +
    `<div class="tier-price">${price}</div>` +
    `<a class="tier-buy" href="/api/store/checkout?tier=${encodeURIComponent(tier.id)}">Purchase</a>` +
    '</article>'
  );
}

function storePage() {
  const data = getTiers();
  const rows = data.tiers.map(tierRow).join('');
  const note = data.note ? `<p class="store-note">${escapeHtml(data.note)}</p>` : '';
  return (
    '<main class="page"><header class="page-head"><h1>Store</h1>' +
    '<p>Support Secret and unlock exclusive perks.</p></header>' +
    `<section class="tiers">${rows}</section>${note}` +
    '</main>'
  );
}

function statusPage() {
  return (
    '<main class="page narrow">' +
    '<div class="status-top"><a class="back-link" href="/">&#8592; back to home</a></div>' +
    '<div class="brand-wordmark">Secret</div>' +
    '<section id="status-banner" class="status-banner state-offline"><span class="dot down"></span>' +
    '<span class="banner-text">Checking status…</span><span id="status-updated" class="banner-updated"></span></section>' +
    '<h2 class="status-heading">Services</h2>' +
    '<section id="services" class="status-list"></section>' +
    '<script src="/static/status.js" defer></script>' +
    '</main>'
  );
}

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp(
    '^' +
      pattern
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/:(\w+)/g, (_, k) => {
          keys.push(k);
          return '([^/]+)';
        }) +
      '$',
  );
  routes.push({ method, regex, keys, handler });
}

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    return { handler: r.handler, params };
  }
  return null;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendView(res, name, locals) {
  send(res, 200, page(name, locals), { 'content-type': 'text/html; charset=utf-8' });
}

function redirect(res, location, cookies) {
  const headers = { location };
  if (cookies) headers['set-cookie'] = cookies;
  send(res, 302, '', headers);
}

function cookieOptions(maxAge) {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` + (config.secureCookies ? '; Secure' : '');
}

function appendCookies(res, cookies) {
  for (const c of cookies) res.appendHeader('set-cookie', c);
}

function getUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const payload = auth.verify(cookies[auth.SESSION_COOKIE], config.sessionSecret);
  return payload ? auth.userFromSession(payload) : null;
}

function clearSessionCookie(res) {
  res.setHeader('set-cookie', `${auth.SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

route('GET', '/', (ctx) => {
  if (!ctx.user) return redirect(ctx.res, '/login');
  const content = view('home').replaceAll('{{discordInvite}}', config.discordInvite);
  sendView(ctx.res, 'home', {
    user: ctx.user,
    active: '/',
    title: null,
    content,
  });
});

function startOAuth(ctx, next) {
  if (!next.startsWith('/') || next.startsWith('//')) next = '/';
  const state = crypto.randomBytes(16).toString('hex');
  const cookies = [];
  if (next !== '/') cookies.push(`${auth.NEXT_COOKIE}=${encodeURIComponent(next)}; ${cookieOptions(600)}`);
  cookies.push(`${auth.STATE_COOKIE}=${state}; ${cookieOptions(600)}`);
  appendCookies(ctx.res, cookies);
  redirect(ctx.res, auth.authorizeUrl(config.discord, state));
}

route('GET', '/login', (ctx) => {
  if (ctx.user) return redirect(ctx.res, '/');
  const next = ctx.url.searchParams.get('next') || '/';
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  send(
    ctx.res,
    200,
    view('login').replaceAll('{{nextQuery}}', safeNext === '/' ? '' : '?next=' + encodeURIComponent(safeNext)),
    { 'content-type': 'text/html; charset=utf-8' },
  );
});

route('GET', '/oauth/start', (ctx) => {
  startOAuth(ctx, ctx.url.searchParams.get('next') || '/');
});

route('GET', '/auth/discord/callback', async (ctx) => {
  const cookies = parseCookies(ctx.req.headers.cookie);
  const url = ctx.url;
  const apiBase = process.env.DISCORD_API_BASE || 'https://discord.com/api';
  const fail = (msg) => {
    sendView(ctx.res, 'base', {
      user: null,
      active: null,
      title: 'Sign-in failed',
      content: `<main class="gate"><div class="gate-card"><p>${escapeHtml(msg)}</p><a class="btn btn-discord" href="/">Back to home</a></div></main>`,
    });
  };
  if (url.searchParams.get('error')) return fail('Authorisation was cancelled or denied.');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || state !== cookies[auth.STATE_COOKIE]) return fail('Invalid OAuth state.');
  try {
    const token = await auth.exchangeCode(config.discord, code, apiBase);
    const user = await auth.fetchDiscordUser(token.access_token, apiBase);
    const next = cookies[auth.NEXT_COOKIE];
    appendCookies(ctx.res, [
      `${auth.SESSION_COOKIE}=${auth.sessionCookieValue(user, config.sessionSecret)}; ${cookieOptions(auth.SESSION_TTL)}`,
      `${auth.STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      `${auth.NEXT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    ]);
    redirect(ctx.res, next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
  } catch (err) {
    console.error('[secret-web] OAuth callback failed:', err.message);
    fail('Discord sign-in could not be completed. Please try again.');
  }
});

route('GET', '/logout', (ctx) => {
  clearSessionCookie(ctx.res);
  redirect(ctx.res, '/');
});

route('GET', '/store', (ctx) => {
  if (!ctx.user) return redirect(ctx.res, '/login?next=/store');
  sendView(ctx.res, 'base', {
    user: ctx.user,
    active: '/store',
    title: 'Store',
    description: 'Support Secret — donator tiers and perks.',
    content: storePage(),
  });
});

route('GET', '/status', (ctx) => {
  if (!ctx.user) return redirect(ctx.res, '/login?next=/status');
  sendView(ctx.res, 'base', {
    user: ctx.user,
    active: '/status',
    title: 'Status',
    description: 'Live server status for Secret.',
    content: statusPage(),
  });
});

route('GET', '/api/store/checkout', (ctx) => {
  const tierId = ctx.url.searchParams.get('tier');
  const tier = getTiers().tiers.find((t) => t.id === tierId);
  if (!tier) return send(ctx.res, 404, 'unknown tier', { 'content-type': 'text/plain' });
  send(
    ctx.res,
    200,
    JSON.stringify({ ok: true, tier: tier.id, message: 'Payments are not open yet.' }),
    { 'content-type': 'application/json' },
  );
});

route('GET', '/api/status', async (ctx) => {
  if (!ctx.user) return send(ctx.res, 401, JSON.stringify({ error: 'unauthorised' }), { 'content-type': 'application/json' });
  const s = await getStatus(config.apiUrl, config.healthPath);
  send(ctx.res, 200, JSON.stringify(s), { 'content-type': 'application/json; charset=utf-8' });
});

route('GET', '/healthz', (ctx) => {
  send(ctx.res, 200, 'ok', { 'content-type': 'text/plain' });
});

const STATIC_DIRS = { '/static/': path.join(ROOT, 'static'), '/assets/': path.join(ROOT, 'Assets') };
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

function serveStatic(pathname, res) {
  for (const [prefix, dir] of Object.entries(STATIC_DIRS)) {
    if (!pathname.startsWith(prefix)) continue;
    const rel = pathname.slice(prefix.length);
    if (rel.includes('..') || rel.includes('\\') || path.isAbsolute(rel)) return false;
    const file = path.join(dir, rel);
    if (!file.startsWith(dir)) return false;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (serveStatic(pathname, res)) return;
    const ctx = { req, res, url, user: getUser(req), params: {} };
    const m = matchRoute(req.method, pathname);
    if (!m) return send(res, 404, view404(ctx.user), { 'content-type': 'text/html; charset=utf-8' });
    ctx.params = m.params;
    await m.handler(ctx);
  } catch (err) {
    console.error('[secret-web] error handling', req.method, pathname, err);
    if (!res.headersSent) send(res, 500, 'Internal Server Error', { 'content-type': 'text/plain' });
    else res.end();
  }
});

function view404(user) {
  return page('base', {
    user: user,
    active: null,
    title: 'Not found',
    content:
      '<main class="gate"><div class="gate-card"><p>Page not found.</p><a class="btn btn-ghost" href="/">Back to home</a></div></main>',
  });
}

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[secret-web] listening on http://0.0.0.0:${config.port}`);
  console.log(
    `[secret-web] discord oauth: ${
      auth.isPlaceholder(config.discord.clientId)
        ? 'NOT CONFIGURED (placeholders in .env)'
        : 'configured'
    }`,
  );
  console.log(`[secret-web] status API: ${config.apiUrl || 'NOT CONFIGURED'}${config.healthPath}`);
});
