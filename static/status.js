(() => {
  const banner = document.getElementById('status-banner');
  const list = document.getElementById('services');
  const updated = document.getElementById('status-updated');
  if (!banner || !list) return;

  const LABEL = {
    operational: ['Operational', 'ok'],
    degraded: ['Degraded', 'warn'],
    offline: ['Offline', 'down'],
  };
  const BANNER = {
    operational: 'All Systems Operational.',
    degraded: 'Some systems are degraded.',
    offline: 'Systems are currently offline.',
  };

  let checkedAt = null;

  function render(d) {
    checkedAt = d.checkedAt ? new Date(d.checkedAt).getTime() : Date.now();
    const state = LABEL[d.state] ? d.state : 'offline';
    const dot = banner.querySelector('.dot');
    const text = banner.querySelector('.banner-text');
    banner.classList.remove('state-operational', 'state-degraded', 'state-offline');
    banner.classList.add('state-' + state);
    dot.className = 'dot ' + LABEL[state][1];
    text.textContent = BANNER[state];
    list.textContent = '';
    for (const row of d.services || []) {
      const l = LABEL[row.state] || LABEL.offline;
      const el = document.createElement('div');
      el.className = 'row';
      if (row.latencyMs != null) {
        const lat = document.createElement('span');
        lat.className = 'row-latency';
        lat.textContent = row.latencyMs + ' ms';
        el.appendChild(lat);
      }
      const dotEl = document.createElement('span');
      dotEl.className = 'dot ' + l[1];
      const name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = row.name;
      const stateEl = document.createElement('span');
      stateEl.className = 'row-state ' + l[1];
      stateEl.textContent = l[0];
      el.append(dotEl, name, stateEl);
      list.appendChild(el);
    }
    tick();
  }

  function tick() {
    if (!checkedAt || !updated) return;
    const s = Math.max(0, Math.round((Date.now() - checkedAt) / 1000));
    updated.textContent = s < 3 ? 'updated just now' : 'updated ' + s + 's ago';
  }

  async function refresh() {
    try {
      const res = await fetch('/api/status');
      if (res.status === 401) {
        location.href = '/login?next=/status';
        return;
      }
      if (res.ok) render(await res.json());
    } catch {
      // keep last known state on transient failures
    }
  }

  setInterval(tick, 1000);
  setInterval(refresh, 10000);
  refresh();
})();
