'use strict';

const RANK = { operational: 0, degraded: 1, offline: 2 };

function normalizeState(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (['ok', 'operational', 'up', 'online', 'healthy', 'green'].includes(v)) return 'operational';
  if (['degraded', 'warn', 'warning', 'slow', 'partial'].includes(v)) return 'degraded';
  if (['down', 'offline', 'outage', 'error', 'fail', 'failing', 'red'].includes(v)) return 'offline';
  return null;
}

function worstOf(states) {
  let worst = 'operational';
  for (const s of states) if (RANK[s] > RANK[worst]) worst = s;
  return worst;
}

// 2xx (optionally {"status": ...}) -> operational
// reachable but non-2xx / reported degraded    -> degraded
// unreachable, DNS failure or timeout          -> offline
async function checkEndpoint(base, healthPath, timeoutMs = 5000) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (!base) return { state: 'offline', latencyMs: 0, services: null, detail: 'not configured' };
    const url = new URL(healthPath, base);
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    const latencyMs = Date.now() - started;
    let body = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON body is fine, HTTP code decides
    }
    if (!res.ok) return { state: 'degraded', latencyMs, services: null, detail: 'HTTP ' + res.status };
    const state = normalizeState(body && body.status) || 'operational';
    const services =
      body && Array.isArray(body.services)
        ? body.services.map((s) => ({
            name: String((s && s.name) || 'Service'),
            state: normalizeState(s && (s.status || s.state)) || 'operational',
          }))
        : null;
    return { state, latencyMs, services, detail: null };
  } catch (err) {
    return {
      state: 'offline',
      latencyMs: Date.now() - started,
      services: null,
      detail: err.name === 'AbortError' ? 'timed out' : 'unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function getStatus(apiUrl, healthPath) {
  const result = await checkEndpoint(apiUrl, healthPath);
  const services = [{ name: 'Secret API', state: result.state, latencyMs: result.latencyMs }];
  if (result.services) services.push(...result.services);
  return {
    state: worstOf(services.map((s) => s.state)),
    checkedAt: new Date().toISOString(),
    latencyMs: result.latencyMs,
    detail: result.detail,
    services,
  };
}

module.exports = { getStatus, normalizeState, worstOf };
