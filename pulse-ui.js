// =====================================================
// TIKTOK PULSE — éléments d'interface communs
// - Icônes SVG (un seul jeu, trait fin) : <span data-icon="chart"></span>
// - Menu du site (latéral sur ordinateur, barre du bas sur téléphone) : <body data-nav="direct">
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
    plus: '<path d="M12 5v14M5 12h14"/>',
    cookie: '<path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5z"/><path d="M8.5 8.5v.01M16 15.5v.01M12 12v.01M11 17v.01M7 14v.01"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
    film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4M3 12h18"/>'
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
    t.textContent = a.nom || (a.pseudo ? '@' + a.pseudo : 'Compte');
    if (a.nom && a.pseudo) t.title = '@' + a.pseudo;
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
      item.insertAdjacentHTML('beforeend', brand(a.platform || 'tiktok'));
      item.append(chip(a));
      if (a.actif) item.insertAdjacentHTML('beforeend', icon('check'));
      item.addEventListener('click', async () => {
        if (a.actif) { menu.hidden = true; return; }
        item.disabled = true;
        try {
          const r = await fetch('/auth/switch', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: a.platform || 'tiktok', id: a.id || a.openId }) });
          const out = await r.json().catch(() => ({}));
          if (!r.ok) { if (out.reconnect) location.href = '/relier.html'; else await dialog({ title: 'Changement impossible', text: out.error || 'Réessaie dans un instant.', cancel: null }); return; }
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

  // Menu du site. Pour ajouter une page : une ligne dans MENU.
  //   key : valeur de <body data-nav="…"> ;
  //   plan : vignette de la formule (gratuit, pro, createur) ;
  //   mobile: false : absent de la barre du bas ; mobileAt : position dans la barre du bas.
  const PLANS = { gratuit: 'Gratuit', pro: 'Statistiques', createur: 'Créateur' };
  const SHORT = { pro: 'Stats' };
  const MENU = [
    { title: 'Mes stats', items: [
      { key: 'direct', href: '/', icon: 'live', label: 'En direct', short: 'Direct', live: true, plan: 'gratuit' },
      { key: 'analyse', href: '/analyse.html', icon: 'chart', label: 'Analyse complète', short: 'Analyse', plan: 'pro' }
    ] },
    { title: 'Mes vidéos', items: [
      { key: 'automatisation', href: '/automatisation.html', icon: 'film', label: 'Automatisation', short: 'Auto', plan: 'createur' }
    ] },
    { title: 'Mon compte', items: [
      { key: 'tarifs', href: '/tarifs.html', icon: 'star', label: 'Abonnement', short: 'Tarifs', mobileAt: 3 },
      { key: 'parametres', href: '/parametres.html', icon: 'gear', label: 'Paramètres', mobile: false },
      { key: 'compte', href: '/mon-compte.html', icon: 'user', label: 'Mon compte', short: 'Compte', also: ['parametres'] }
    ] },
    { title: 'Légal', small: true, items: [
      { key: 'cgu', href: '/conditions.html', icon: 'file', label: 'Conditions d’utilisation', mobile: false },
      { key: 'confidentialite', href: '/confidentialite.html', icon: 'shield', label: 'Confidentialité', mobile: false },
      { key: 'cookies', href: '#cookies', icon: 'cookie', label: 'Gérer les cookies', mobile: false, action: 'cookies' }
    ] }
  ];

  function link(it, current, compact) {
    const a = document.createElement(it.soon ? 'span' : it.action ? 'button' : 'a');
    if (it.action) { a.type = 'button'; a.addEventListener('click', e => { e.preventDefault(); cookies(true); }); }
    a.className = 'pn-item' + (it.soon ? ' soon' : '');
    if (!it.soon && !it.action) a.href = it.href;
    if (it.key === current || (compact && (it.also || []).includes(current))) a.setAttribute('aria-current', 'page');
    if (it.soon) a.setAttribute('aria-disabled', 'true');
    a.dataset.key = it.key;
    a.innerHTML = '<span class="pn-ic">' + icon(it.icon) + (it.live && compact ? '<i class="pn-live"></i>' : '') + '</span><span class="pn-label">' + (compact && it.short ? it.short : it.label) + (it.live && !compact ? '<i class="pn-live"></i>' : '') + '</span>'
      + (it.plan && !compact ? '<span class="pn-tag plan-' + it.plan + '">' + PLANS[it.plan] + '</span>' : '')
      + (it.plan && compact ? '<span class="pn-tag plan-' + it.plan + '">' + (SHORT[it.plan] || PLANS[it.plan]) + '</span>' : '');
    return a;
  }

  // ---------- Cookies : choix enregistré une fois par compte ----------
  // Essentiels : toujours actifs (connexion, sécurité, mémorisation de ce choix).
  // Préférences : chaque réglage mémorisé dans le stockage local peut être accepté ou refusé séparément.
  const CONSENT_KEY = 'tp_consent';
  const PREFS = [
    { id: 'suivi', match: k => k.startsWith('tp_suivi:'), label: 'Vidéo suivie',
      desc: 'En revenant sur « En direct », tu retrouves la vidéo que tu suivais, pour chacun de tes comptes.' },
    { id: 'ouverture', match: k => k === 'tp_open', label: 'Vidéo à l’ouverture',
      desc: 'Ton choix entre « dernière suivie » et « dernière publiée », réglé dans Paramètres.' },
    { id: 'periode', match: k => k === 'tp_hperiod', label: 'Période de l’analyse',
      desc: '« 24 heures » ou « 7 jours » par défaut quand tu ouvres l’Analyse complète.' }
  ];
  function readConsent() { try { return JSON.parse(localStorage.getItem(CONSENT_KEY) || 'null'); } catch { return null; } }
  function allowed(id) {
    const c = readConsent();
    if (!c) return true;
    if (c.detail && typeof c.detail[id] === 'boolean') return c.detail[id];
    return c.prefs !== false;
  }
  // Sans argument : vrai si toutes les préférences sont acceptées.
  function prefsAllowed(id) { return id ? allowed(id) : PREFS.every(p => allowed(p.id)); }
  function prefOf(k) { return PREFS.find(p => p.match(k)); }

  // Préférence refusée : on ne l'enregistre pas.
  (function guardStorage() {
    try {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (this === window.localStorage && typeof k === 'string' && k !== CONSENT_KEY) {
          const p = prefOf(k);
          if (p && !allowed(p.id)) return;
        }
        return orig.call(this, k, v);
      };
    } catch { /* ignore */ }
  })();
  function clearRefused() {
    try { Object.keys(localStorage).forEach(k => { const p = prefOf(k); if (p && !allowed(p.id)) localStorage.removeItem(k); }); } catch { /* ignore */ }
  }

  async function saveConsent(detail) {
    const prefs = PREFS.some(p => detail[p.id]);
    try { localStorage.setItem(CONSENT_KEY, JSON.stringify({ prefs, detail, t: Date.now() })); } catch { /* ignore */ }
    clearRefused();
    try { await fetch('/auth/consentement', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefs, detail }) }); } catch { /* ignore */ }
  }

  function cookies(manage) {
    if (document.querySelector('.pcookie')) return;
    const box = document.createElement('div');
    // Bloque le site tant qu'aucun choix n'est fait (sauf sur les pages légales, pour pouvoir les lire).
    const wall = !manage && !['cgu', 'confidentialite'].includes(document.body.dataset.nav);
    box.className = 'pcookie' + (wall ? ' pcookie-wall' : '');
    if (wall) document.documentElement.classList.add('pcookie-lock');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Cookies');
    box.innerHTML = '<div class="pcookie-card">'
      + '<div class="pcookie-head">' + icon('cookie') + '<b>Cookies et stockage</b></div>'
      + '<p>TikTok Pulse utilise uniquement des cookies essentiels (connexion, sécurité) et, si tu l’acceptes, un stockage de tes préférences d’affichage. Aucun cookie publicitaire ni de mesure d’audience. <a href="/confidentialite.html#cookies">En savoir plus</a></p>'
      + '<div class="pcookie-opts">'
      + '<div class="pcookie-opt ess"><span><b>Essentiels</b><small>Sans eux, le site ne peut pas fonctionner. Toujours actifs.</small>'
      + '<details><summary>Voir à quoi ils servent</summary><ul>'
      + '<li><b>Connexion TikTok</b> : garde ta session ouverte pour afficher tes statistiques sans te reconnecter à chaque page.</li>'
      + '<li><b>Compte TikTok Pulse</b> : te reconnaît avec ton compte Google, ton abonnement et tes comptes reliés.</li>'
      + '<li><b>Compte affiché</b> : retient quel compte (TikTok ou YouTube) tu regardes quand tu en as plusieurs.</li>'
      + '<li><b>Sécurité de connexion</b> : vérifie, pendant 10 minutes, que c’est bien toi qui reviens de TikTok, Google ou YouTube (protection contre le détournement de compte).</li>'
      + '<li><b>Ton choix de cookies</b> : pour ne pas te le redemander.</li>'
      + '</ul><p>Tout est chiffré, rien n’est publicitaire ni partagé.</p></details></span><input type="checkbox" checked disabled aria-label="Essentiels, toujours actifs"></div>'
      + '<div class="pcookie-opt"><span><b>Préférences</b><small>Mémorise tes réglages d’affichage sur cet appareil. Si tu refuses, le site marche pareil : tu refais juste tes choix à chaque visite.</small>'
      + '<details><summary>Voir à quoi elles servent et choisir</summary><div class="pcookie-subs">'
      + PREFS.map(p => '<label class="pcookie-sub"><span><b>' + p.label + '</b><small>' + p.desc + '</small></span><input type="checkbox" data-pref="' + p.id + '"></label>').join('')
      + '</div></details></span><input type="checkbox" id="pcPrefs" aria-label="Toutes les préférences"></div>'
      + '</div>'
      + '<div class="pcookie-btns"><button type="button" class="btn" data-a="refuse">Continuer avec l’essentiel</button><button type="button" class="btn" data-a="save">Enregistrer mon choix</button><button type="button" class="btn pcookie-ok" data-a="accept">Tout accepter</button></div>'
      + '</div>';
    document.body.append(box);
    const all = box.querySelector('#pcPrefs');
    const subs = [...box.querySelectorAll('[data-pref]')];
    // Première fois : rien n'est coché d'avance (le consentement doit être un vrai choix).
    const first = !readConsent();
    subs.forEach(c => { c.checked = !first && allowed(c.dataset.pref); });
    const sync = () => { const n = subs.filter(c => c.checked).length; all.checked = n === subs.length; all.indeterminate = n > 0 && n < subs.length; };
    sync();
    all.addEventListener('change', () => { subs.forEach(c => { c.checked = all.checked; }); sync(); });
    subs.forEach(c => c.addEventListener('change', sync));
    box.addEventListener('click', async e => {
      const b = e.target.closest('button[data-a]'); if (!b) return;
      const a = b.dataset.a;
      const detail = {};
      PREFS.forEach(p => { detail[p.id] = a === 'accept' ? true : a === 'refuse' ? false : subs.find(c => c.dataset.pref === p.id).checked; });
      box.remove();
      document.documentElement.classList.remove('pcookie-lock');
      await saveConsent(detail);
      if (manage) location.reload();
    });
  }

  async function consentCheck() {
    // Déjà choisi pour ce compte (ou sur cet appareil hors connexion) : on ne redemande pas.
    let d = null;
    try { const r = await fetch('/auth/consentement', { cache: 'no-store', credentials: 'same-origin' }); if (r.ok) d = await r.json(); } catch { /* ignore */ }
    if (d && d.choix) {
      try { localStorage.setItem(CONSENT_KEY, JSON.stringify({ prefs: d.choix.prefs, detail: d.choix.detail || null, t: d.choix.date || Date.now() })); } catch { /* ignore */ }
      clearRefused();
      return;
    }
    const local = readConsent();
    if (local) {
      // Choix fait avant la connexion : on le rattache au compte.
      if (d && d.compte) {
        const detail = {};
        PREFS.forEach(p => { detail[p.id] = allowed(p.id); });
        saveConsent(detail);
      }
      return;
    }
    cookies(false);
  }

  // Sélecteur du compte affiché : en haut du menu (ordinateur) et de la barre du haut (téléphone).
  let comptesData = null;
  async function comptes() {
    if (comptesData) return comptesData;
    comptesData = (async () => {
      let d = null;
      try { const r = await fetch('/api/comptes', { cache: 'no-store', credentials: 'same-origin' }); if (r.ok) d = await r.json(); } catch { /* ignore */ }
      if (d && d.comptes && d.comptes.length) return d;
      // Sans compte Google : le compte connecté seul.
      try {
        const r = await fetch('/api/me', { cache: 'no-store', credentials: 'same-origin' });
        if (r.ok) { const m = await r.json(); return { google: d && d.google, comptes: [{ platform: m.platform || 'tiktok', id: '', pseudo: m.username, nom: m.nickname, avatar: m.avatar, actif: true }] }; }
      } catch { /* ignore */ }
      return null;
    })();
    return comptesData;
  }

  async function switcher(el) {
    const d = await comptes();
    if (!d || !d.comptes || !d.comptes.length) { el.remove(); return; }
    const cur = d.comptes.find(a => a.actif) || d.comptes[0];
    const canSwitch = !!(d.google && d.google.premium) && d.comptes.length > 1;
    el.textContent = '';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'psw-btn';
    btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false');
    btn.title = 'Compte affiché';
    btn.insertAdjacentHTML('beforeend', brand(cur.platform || 'tiktok'));
    btn.append(chip(cur));
    btn.insertAdjacentHTML('beforeend', icon('chevron'));
    const menu = document.createElement('div');
    menu.className = 'psw-menu'; menu.setAttribute('role', 'menu'); menu.hidden = true;
    const head = document.createElement('div'); head.className = 'psw-title'; head.textContent = canSwitch ? 'Changer de compte' : 'Compte affiché';
    menu.append(head);
    d.comptes.forEach(a => {
      const item = document.createElement('button');
      item.type = 'button'; item.className = 'picker-item' + (a.actif ? ' on' : '');
      item.setAttribute('role', 'menuitem');
      item.insertAdjacentHTML('beforeend', brand(a.platform || 'tiktok'));
      item.append(chip(a));
      if (a.actif) item.insertAdjacentHTML('beforeend', icon('check'));
      else if (!canSwitch) { item.disabled = true; item.title = 'Passe à la formule Statistiques pour changer de compte en un clic'; }
      item.addEventListener('click', async () => {
        if (a.actif || !canSwitch) { menu.hidden = true; return; }
        item.disabled = true;
        try {
          const r = await fetch('/auth/switch', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: a.platform || 'tiktok', id: a.id || a.openId }) });
          const out = await r.json().catch(() => ({}));
          if (!r.ok) { if (out.reconnect) location.href = '/relier.html'; else await dialog({ title: 'Changement impossible', text: out.error || 'Réessaie dans un instant.', cancel: null }); return; }
          try { sessionStorage.clear(); } catch { /* ignore */ }
          location.reload();
        } finally { item.disabled = false; }
      });
      menu.append(item);
    });
    const add = document.createElement('a');
    add.className = 'picker-item add'; add.href = '/relier.html';
    add.innerHTML = icon('plus') + '<span>Ajouter un compte</span>';
    const manage = document.createElement('a');
    manage.className = 'picker-item'; manage.href = '/parametres.html';
    manage.innerHTML = icon('gear') + '<span>Gérer mes comptes</span>';
    menu.append(add, manage);
    btn.addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); });
    document.addEventListener('click', e => { if (!el.contains(e.target)) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
    el.append(btn, menu);
  }

  // Fenêtre de confirmation / d'information du site (remplace confirm() et alert()).
  // dialog({ title, text, ok, cancel, danger }) → Promise<boolean>. cancel: null = simple information.
  function dialog(o) {
    o = o || {};
    return new Promise(resolve => {
      const prev = document.activeElement;
      const box = document.createElement('div');
      box.className = 'pdlg';
      box.innerHTML = '<div class="pdlg-card" role="alertdialog" aria-modal="true" aria-labelledby="pdlgT" aria-describedby="pdlgX">'
        + '<h2 id="pdlgT"></h2><p id="pdlgX"></p><div class="pdlg-btns"></div></div>';
      box.querySelector('h2').textContent = o.title || 'TikTok Pulse';
      box.querySelector('p').textContent = o.text || '';
      const btns = box.querySelector('.pdlg-btns');
      const done = v => { box.remove(); document.removeEventListener('keydown', key, true); if (prev && prev.focus) prev.focus(); resolve(v); };
      if (o.cancel !== null) {
        const c = document.createElement('button'); c.type = 'button'; c.className = 'btn'; c.textContent = o.cancel || 'Annuler';
        c.addEventListener('click', () => done(false)); btns.append(c);
      }
      const ok = document.createElement('button'); ok.type = 'button';
      ok.className = 'btn ' + (o.danger ? 'pdlg-danger' : 'pdlg-ok'); ok.textContent = o.ok || 'OK';
      ok.addEventListener('click', () => done(true)); btns.append(ok);
      box.addEventListener('click', e => { if (e.target === box) done(o.cancel === null); });
      const key = e => { if (e.key === 'Escape') { e.preventDefault(); done(o.cancel === null); } };
      document.addEventListener('keydown', key, true);
      document.body.append(box);
      ok.focus();
    });
  }

  async function logout() {
    if (!(await dialog({ title: 'Se déconnecter ?', text: 'Tu seras déconnecté de TikTok Pulse sur cet appareil. Tes comptes et ton abonnement restent enregistrés.', ok: 'Me déconnecter' }))) return;
    try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* ignore */ }
    try { sessionStorage.clear(); } catch { /* ignore */ }
    location.replace('/connexion.html');
  }

  function nav() {
    const current = document.body.dataset.nav;
    if (!current || document.querySelector('.pside')) return;

    // Ordinateur : menu latéral.
    const side = document.createElement('nav');
    side.className = 'pside';
    side.setAttribute('aria-label', 'Menu');
    side.innerHTML = '<a class="pside-brand" href="/"><span class="brand-mark">↗</span><span>TikTok <b>Pulse</b></span></a><div class="psw"></div>';
    MENU.forEach(g => {
      const sec = document.createElement('div');
      sec.className = 'pside-group' + (g.small ? ' small' : '');
      sec.innerHTML = '<div class="pside-title">' + g.title + '</div>';
      g.items.forEach(it => sec.append(link(it, current)));
      side.append(sec);
    });
    const foot = document.createElement('div');
    foot.className = 'pside-foot';
    foot.innerHTML = '<a class="pside-account" href="/mon-compte.html"><span class="pn-ava">' + icon('user') + '</span><span class="pn-who"><b>Mon compte</b><small>Gratuit</small></span></a>'
      + '<button class="pside-out" type="button" title="Me déconnecter" aria-label="Me déconnecter">' + icon('logout') + '</button>';
    foot.querySelector('.pside-out').addEventListener('click', logout);
    side.append(foot);

    // Téléphone : barre du bas (pages disponibles + Compte).
    const bar = document.createElement('nav');
    bar.className = 'pbar';
    bar.setAttribute('aria-label', 'Navigation');
    const all = MENU.flatMap(g => g.items).filter(it => it.mobile !== false);
    const mob = all.filter(it => it.mobileAt == null);
    all.filter(it => it.mobileAt != null).forEach(it => mob.splice(it.mobileAt, 0, it));
    mob.forEach(it => bar.append(link(it, current, true)));

    // Téléphone : petite barre du haut (logo + compte affiché).
    const top = document.createElement('header');
    top.className = 'ptop';
    top.innerHTML = '<a class="pside-brand" href="/"><span class="brand-mark">↗</span><span>TikTok <b>Pulse</b></span></a>'
      + '<div class="ptop-right"><div class="psw"></div><a class="ptop-gear" href="/parametres.html" aria-label="Paramètres" title="Paramètres"' + (current === 'parametres' ? ' aria-current="page"' : '') + '>' + icon('gear') + '</a></div>';

    document.body.prepend(side, top, bar);
    const mobile = window.matchMedia('(max-width: 900px)').matches;
    (mobile ? side : top).querySelector('.psw').remove();
    const swEl = (mobile ? top : side).querySelector('.psw');

    // Visiteur non connecté : pas de sélecteur, et « Se connecter » à la place du compte.
    fetch('/auth/status', { cache: 'no-store', credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : null))
      .then(st => {
        if (st && st.connected) { switcher(swEl); return; }
        swEl.remove();
        const acc = foot.querySelector('.pside-account');
        acc.href = '/connexion.html';
        acc.querySelector('.pn-who b').textContent = 'Non connecté';
        acc.querySelector('.pn-who small').textContent = 'Se connecter';
        foot.querySelector('.pside-out').remove();
        foot.dataset.anon = '1';
      })
      .catch(() => switcher(swEl));
    document.body.classList.add('has-pnav');

    // Formule et nom du compte Google (badge PRO, pied du menu).
    fetch('/auth/google/me', { cache: 'no-store', credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const g = d && d.google;
        const paid = !!(g && g.premium);
        const has = !paid ? 'gratuit' : g.formule === 'createur' ? 'createur' : 'pro';
        document.querySelectorAll('.pn-tag.pro').forEach(t => { t.hidden = has === 'createur' || (has === 'pro' && t.classList.contains('plan-pro')); });
        const plan = !paid ? 'Gratuit' : g.formule === 'createur' ? 'Créateur' : 'Statistiques';
        if (foot.dataset.anon) return;
        const who = foot.querySelector('.pn-who');
        who.querySelector('b').textContent = (g && g.nom) || 'Mon compte';
        const sm = who.querySelector('small');
        sm.textContent = plan;
        sm.classList.toggle('paid', paid);
        if (g && typeof g.photo === 'string' && /^https:\/\//i.test(g.photo)) {
          const img = document.createElement('img');
          img.alt = ''; img.referrerPolicy = 'no-referrer'; img.src = g.photo;
          const ava = foot.querySelector('.pn-ava'); ava.textContent = ''; ava.append(img);
        }
      })
      .catch(() => { document.querySelectorAll('.pn-tag.pro').forEach(t => { t.hidden = false; }); });

    // Pages du menu préchargées au survol / toucher : le changement est quasi instantané.
    if (HTMLScriptElement.supports && HTMLScriptElement.supports('speculationrules')) {
      const rules = document.createElement('script');
      rules.type = 'speculationrules';
      rules.textContent = JSON.stringify({ prefetch: [{ source: 'list', urls: ['/', '/analyse.html', '/automatisation.html', '/tarifs.html', '/mon-compte.html', '/parametres.html'], eagerness: 'moderate' }] });
      document.head.append(rules);
    }
  }

  // Bouton « Continuer avec Google » du site (connexion par redirection, sans le bouton de Google).
  // mode : 'connexion' (page de connexion) ou 'lier' (relier le compte TikTok connecté).
  function googleButton(mode) {
    const url = '/auth/google/start?mode=' + (mode === 'lier' ? 'lier' : 'connexion') + '&retour=' + encodeURIComponent(location.pathname);
    return '<a class="g-btn" href="' + url + '"><svg viewBox="0 0 24 24" aria-hidden="true" class="g-logo"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.4 14.4a7.2 7.2 0 0 1 0-4.6V6.7h-4a12 12 0 0 0 0 10.8l4-3.1z"/><path fill="#EA4335" d="M12 4.8c1.7 0 3.3.6 4.5 1.8l3.4-3.4A12 12 0 0 0 1.4 6.7l4 3.1C6.3 6.9 8.9 4.8 12 4.8z"/></svg><span>Continuer avec Google</span></a>';
  }

  window.PulseUI = { icon, brand, hydrate, picker, cookies, prefsAllowed, dialog, confirm: dialog, googleButton };
  const start = () => { nav(); hydrate(); consentCheck(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
