// =====================================================
// TIKTOK PULSE — éléments d'interface communs
// - Icônes SVG (un seul jeu, trait fin) : <span data-icon="chart"></span>
// - Barre d'onglets Direct / Analyse / Compte : <body data-nav="direct">
// =====================================================
(function () {
  'use strict';

  const P = {
    chart: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    star: '<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9L12 3z"/>',
    trophy: '<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M17 5h3v2a3 3 0 0 1-3 3"/><path d="M7 5H4v2a3 3 0 0 0 3 3"/>',
    calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    timer: '<path d="M10 2h4"/><path d="M12 14l3-3"/><circle cx="12" cy="14" r="8"/>',
    hash: '<path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    trend: '<path d="M22 7l-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    heart: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z"/>',
    share: '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/>',
    bookmark: '<path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    percent: '<path d="M19 5L5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
    zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
    up: '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
    swap: '<path d="M8 3L4 7l4 4"/><path d="M4 7h16"/><path d="M16 21l4-4-4-4"/><path d="M20 17H4"/>',
    live: '<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19.1 4.9a10 10 0 0 1 0 14.2M4.9 19.1a10 10 0 0 1 0-14.2"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
    back: '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>'
  };


  const BRANDS = {"tiktok": "<svg class=\"brand-ico\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path fill=\"#25F4EE\" d=\"M9.4 9.6v-.9a7 7 0 0 0-.9-.1 6.6 6.6 0 0 0-3.8 12 6.6 6.6 0 0 1 4.7-11z\"/><path fill=\"#25F4EE\" d=\"M9.6 19.8a3 3 0 0 0 3-2.9V2.7h2.7a5 5 0 0 1-.1-1h-3.6v14.3a3 3 0 0 1-3 2.9 3 3 0 0 1-1.4-.4 3 3 0 0 0 2.4 1.3zM20.4 7.5v-.9a5 5 0 0 1-2.7-.8 5 5 0 0 0 2.7 1.7z\"/><path fill=\"#FE2C55\" d=\"M17.7 5.8a5 5 0 0 1-1.2-3.3h-1a5 5 0 0 0 2.2 3.3zM8.5 12.8a3 3 0 0 0-1.4 5.7 3 3 0 0 1 3.3-4.9V9.9a6 6 0 0 0-.9-.1h-.2v2.8a3 3 0 0 0-.8.2z\"/><path fill=\"#FE2C55\" d=\"M20.4 7.5v2.8a8.5 8.5 0 0 1-5-1.6v7.2a6.6 6.6 0 0 1-10.3 5.5 6.6 6.6 0 0 0 11.4-4.5V9.7a8.5 8.5 0 0 0 5 1.6V7.6a5 5 0 0 1-1.1-.1z\"/><path fill=\"#fff\" d=\"M15.4 16.9V9.7a8.5 8.5 0 0 0 5 1.6V8.5a5 5 0 0 1-2.7-1.7 5 5 0 0 1-2.2-3.3h-2.7v14.3a3 3 0 0 1-5.6 1.7 3 3 0 0 1 1.4-5.7 3 3 0 0 1 .9.1v-2.8a6.6 6.6 0 0 0-4.7 11.2 6.6 6.6 0 0 0 10.6-5.4z\"/></svg>", "youtube": "<svg class=\"brand-ico\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path fill=\"#FF0033\" d=\"M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12a31 31 0 0 0 .5 4.8 3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .5-4.8 31 31 0 0 0-.5-4.8z\"/><path fill=\"#fff\" d=\"M9.8 15.1V8.9l5.4 3.1-5.4 3.1z\"/></svg>", "facebook": "<svg class=\"brand-ico\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"11\" fill=\"#0866FF\"/><path fill=\"#fff\" d=\"M13.4 22.9v-7.5h2.5l.4-2.9h-2.9v-1.9c0-.8.3-1.4 1.5-1.4h1.5V6.6c-.3 0-1.2-.1-2.2-.1-2.2 0-3.7 1.3-3.7 3.8v2.2H8v2.9h2.5v7.5\"/></svg>"};
  function brand(name) { return BRANDS[name] || ''; }

  function icon(name, cls) {
    const body = P[name];
    if (!body) return '';
    return '<svg class="ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }

  function hydrate(root) {
    (root || document).querySelectorAll('[data-icon]:not([data-icon-done])').forEach(el => {
      el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
      el.setAttribute('data-icon-done', '');
    });
  }


  // Sélecteur de compte (premium avec plusieurs comptes reliés).
  function chip(a) {
    const frag = document.createDocumentFragment();
    const img = document.createElement('img');
    img.alt = ''; img.referrerPolicy = 'no-referrer';
    if (typeof a.avatar === 'string' && /^https:\/\//i.test(a.avatar)) img.src = a.avatar;
    const t = document.createElement('span');
    t.textContent = a.pseudo ? '@' + a.pseudo : (a.nom || 'Compte');
    frag.append(img, t);
    return frag;
  }

  async function picker(el) {
    if (!el) return;
    let d;
    try {
      const r = await fetch('/api/comptes', { cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) return;
      d = await r.json();
    } catch { return; }
    if (!d.google || !d.google.premium || !d.comptes || d.comptes.length < 2) return;

    const cur = d.comptes.find(a => a.actif) || d.comptes[0];
    el.textContent = '';
    el.classList.add('picker');
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'picker-btn';
    btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
    btn.title = 'Changer de compte';
    btn.append(chip(cur));
    btn.insertAdjacentHTML('beforeend', icon('chevron'));
    const menu = document.createElement('div');
    menu.className = 'picker-menu'; menu.setAttribute('role', 'listbox'); menu.hidden = true;

    d.comptes.forEach(a => {
      const item = document.createElement('button');
      item.type = 'button'; item.className = 'picker-item' + (a.actif ? ' on' : '');
      item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(!!a.actif));
      item.insertAdjacentHTML('beforeend', brand('tiktok'));
      item.append(chip(a));
      if (a.actif) item.insertAdjacentHTML('beforeend', icon('check'));
      item.addEventListener('click', async () => {
        if (a.actif) { menu.hidden = true; return; }
        item.disabled = true;
        try {
          const r = await fetch('/auth/switch', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ openId: a.openId }) });
          const out = await r.json().catch(() => ({}));
          if (!r.ok) { if (out.reconnect) location.href = '/relier.html'; else alert(out.error || 'Changement impossible'); return; }
          try { sessionStorage.clear(); } catch { /* ignore */ }
          location.reload();
        } finally { item.disabled = false; }
      });
      menu.append(item);
    });

    const add = document.createElement('a');
    add.className = 'picker-item add'; add.href = '/relier.html';
    add.innerHTML = icon('plus') + '<span>Ajouter un compte</span>';
    menu.append(add);

    btn.addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); });
    document.addEventListener('click', e => { if (!el.contains(e.target)) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
    el.append(btn, menu);
  }

  function nav() {
    const current = document.body.dataset.nav;
    if (!current || document.querySelector('.pnav')) return;
    const tabs = [
      ['direct', '/', 'live', 'Direct'],
      ['analyse', '/analyse.html', 'chart', 'Analyse'],
      ['compte', '/mon-compte.html', 'user', 'Compte']
    ];
    const el = document.createElement('nav');
    el.className = 'pnav';
    el.setAttribute('aria-label', 'Navigation');
    el.innerHTML = tabs.map(([key, href, ic, label]) =>
      '<a href="' + href + '"' + (key === current ? ' aria-current="page"' : '') + '>' + icon(ic) + '<span>' + label + '</span></a>'
    ).join('');
    document.body.prepend(el);
    document.body.classList.add('has-pnav');
  }

  window.PulseUI = { icon, brand, hydrate, picker };
  const start = () => { nav(); hydrate(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
