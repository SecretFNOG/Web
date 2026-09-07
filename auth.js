'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const SESSION_COOKIE = 'secret_session';
const STATE_COOKIE = 'secret_oauth';
const NEXT_COOKIE = 'secret_next';
const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

function isPlaceholder(value) {
  if (!value) return true;
  return /^your|^change[-_]?me|^placeholder|^xxx/i.test(String(value).trim());
}

function hmac(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest();
}

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + hmac(body, secret).toString('base64url');
}

function verify(token, secret) {
  if (typeof token !== 'string' || !secret) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  let given;
  try {
    given = Buffer.from(token.slice(dot + 1), 'base64url');
  } catch {
    return null;
  }
  const expected = hmac(body, secret);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function sessionFromUser(user) {
  const now = Math.floor(Date.now() / 1000);
  return {
    uid: String(user.id),
    username: user.username,
    global_name: user.global_name || null,
    avatar: user.avatar || null,
    iat: now,
    exp: now + SESSION_TTL,
  };
}

function userFromSession(payload) {
  return {
    id: payload.uid,
    username: payload.username,
    global_name: payload.global_name,
    avatar: payload.avatar,
  };
}

function sessionCookieValue(user, secret) {
  return sign(sessionFromUser(user), secret);
}

function authorizeUrl({ clientId, redirectUri }, state) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify',
    state,
  });
  return 'https://discord.com/api/oauth2/authorize?' + params.toString();
}

async function exchangeCode({ clientId, clientSecret, redirectUri }, code, apiBase = 'https://discord.com/api') {
  const res = await fetch(apiBase + '/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error('token exchange failed with HTTP ' + res.status);
  const data = await res.json();
  if (!data.access_token) throw new Error('token exchange returned no access token');
  return data;
}

async function fetchDiscordUser(accessToken, apiBase = 'https://discord.com/api') {
  const res = await fetch(apiBase + '/users/@me', {
    headers: { authorization: 'Bearer ' + accessToken },
  });
  if (!res.ok) throw new Error('failed to fetch Discord user with HTTP ' + res.status);
  const u = await res.json();
  return { id: String(u.id), username: u.username, global_name: u.global_name, avatar: u.avatar };
}

module.exports = {
  SESSION_COOKIE,
  STATE_COOKIE,
  NEXT_COOKIE,
  SESSION_TTL,
  loadEnv,
  isPlaceholder,
  sign,
  verify,
  sessionCookieValue,
  userFromSession,
  authorizeUrl,
  exchangeCode,
  fetchDiscordUser,
};
