// =====================================================
// TIKTOK PULSE — Studio d'automatisation (formule Créateur)
// Pour chaque étape (script, images, vidéo), le créateur choisit son IA :
//  - par l'API (Claude, ChatGPT, Grok) avec SA clé, prix annoncé avant, coût réel suivi ;
//  - ou « Mon abonnement » : prompts à copier, résultats à déposer (rien à payer en plus).
// Montage 9:16 dans le navigateur (sous-titres, musique) → vidéo à télécharger.
// Le projet, les images et les clips restent sur l'appareil (IndexedDB).
// =====================================================
(function () {
  'use strict';

  const W = 1080, H = 1920, FPS = 30;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => new Intl.NumberFormat('fr-FR').format(n || 0);
  const usd = n => (n == null ? '—' : (n > 0 && n < 0.1 ? n.toFixed(3) : n.toFixed(2)).replace('.', ',') + ' $');
  const SUB = 'abonnement';

  // ---------- Stockage local (IndexedDB) ----------
  const DB = 'tp_studio', STORE = 'kv';
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function kv(mode, fn) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
      tx.onerror = () => rej(tx.error);
    });
  }
  const get = k => kv('readonly', s => s.get(k)).catch(() => null);
  const put = (k, v) => kv('readwrite', s => s.put(v, k)).catch(() => null);
  const del = k => kv('readwrite', s => s.delete(k)).catch(() => null);

  let cfg = null;              // { cles: {p: fin}, budget, depense, catalogue }
  let choice = null;           // { texte: {p, m}, image: {p, m}, video: {p, m} }
  let project = null;
  const media = new Map();     // scène → { blob, type: 'video'|'image', url }  (ce qui est monté)
  const images = new Map();    // scène → data URL de l'image de départ (pour la vidéo par API)
  let music = null;
  let busy = false;

  async function save() { await put('project', project); }
  async function api(path, body) {
    const r = await fetch(path, {
      method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.error || 'Erreur ' + r.status); e.status = r.status; throw e; }
    return d;
  }
  const say = (title, text) => PulseUI.dialog({ title, text, cancel: null });
  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); }
    catch { const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); try { document.execCommand('copy'); } catch { /* ignore */ } t.remove(); }
    if (btn) { const o = btn.innerHTML; btn.innerHTML = PulseUI.icon('check') + ' Copié'; setTimeout(() => { btn.innerHTML = o; }, 1400); }
  }

  // ---------- Choix des IA ----------
  const DEFAULT_CHOICE = {
    texte: { p: 'claude', m: 'claude-opus-5-5' },
    image: { p: 'grok', m: 'grok-imagine-image' },
    video: { p: 'grok', m: 'grok-imagine-video-1.5-lite' }
  };
  const model = step => (choice[step].p === SUB ? null : cfg.catalogue[step]?.[choice[step].p]?.modeles?.[choice[step].m]);
  const isApi = step => choice[step].p !== SUB && !!model(step);
  const hasKey = p => !!cfg.cles?.[p];
  const PNAME = { claude: 'Claude', openai: 'ChatGPT', grok: 'Grok' };

  function loadChoice() {
    const c = cfg.choix;
    choice = JSON.parse(JSON.stringify(DEFAULT_CHOICE));
    ['texte', 'image', 'video'].forEach(st => {
      const v = c?.[st];
      if (v && (v.p === SUB || cfg.catalogue[st]?.[v.p]?.modeles?.[v.m])) choice[st] = v;
    });
  }
  async function saveChoice() {
    try { await api('/api/studio/choix', choice); cfg.choix = JSON.parse(JSON.stringify(choice)); }
    catch (e) { say('Choix non enregistré', e.message); }
  }
  // Réglages faits : choix enregistré et clés présentes pour les étapes par API.
  const missingKeys = () => [...new Set(['texte', 'image', 'video'].filter(isApi).map(st => choice[st].p))].filter(p => !hasKey(p));
  const configured = () => !!cfg.choix && !missingKeys().length;

  // Prix d'une unité (image, seconde de vidéo, script) : ta moyenne réelle si tu as déjà généré avec ce modèle.
  const KIND = { texte: 'script', image: 'images', video: 'videos' };
  function avgOf(step, p, m) {
    const k = (step === 'texte' ? ['script', 'idees'] : [KIND[step]]).map(kd => cfg.moyennes?.[`${kd}:${p}:${m}`]).find(Boolean);
    return k ? k.parUnite : null;
  }
  function unit(step) {
    if (!isApi(step)) return 0;
    const m = model(step), avg = avgOf(step, choice[step].p, choice[step].m);
    return avg ?? (step === 'texte' ? m.est : step === 'image' ? m.par : m.parSec);
  }
  const fromAvg = step => isApi(step) && avgOf(step, choice[step].p, choice[step].m) != null;
  // Nombre d'unités déjà générées avec le modèle choisi (pour dire sur quoi repose le devis).
  function countOf(step) {
    if (!isApi(step)) return 0;
    const kd = step === 'texte' ? 'script' : KIND[step];
    return cfg.moyennes?.[`${kd}:${choice[step].p}:${choice[step].m}`]?.n || 0;
  }
  function sourceText() {
    const parts = [];
    if (isApi('image')) parts.push(fromAvg('image') ? `${countOf('image')} image${countOf('image') > 1 ? 's' : ''} déjà générée${countOf('image') > 1 ? 's' : ''}` : '');
    if (isApi('video')) parts.push(fromAvg('video') ? `${Math.round(countOf('video'))} s de vidéo déjà générées` : '');
    const known = parts.filter(Boolean);
    return known.length ? `(d’après ton coût réel sur ${known.join(' et ')})` : '(prix publics : le devis s’affinera avec tes générations)';
  }
  // Régénérations : ta vraie habitude si on la connaît (au moins 5 clips), sinon une marge de ×1,5.
  function regenText(est) {
    const h = cfg.habitudes;
    if (h && h.clips >= 5 && h.facteur) {
      const f = h.facteur;
      return f > 1.05 ? `Avec tes régénérations habituelles (×${f.toFixed(2).replace('.', ',')}) : ≈ <b>${usd(est.total * f)}</b>.` : 'Tu régénères rarement tes scènes : ce devis devrait être juste.';
    }
    return `Compte jusqu’à ≈ ${usd(est.total * 1.5)} si tu régénères des scènes.`;
  }

  function priceHint(step, m) {
    if (step === 'texte') return '≈ ' + usd(m.est) + ' / script';
    if (step === 'image') return '≈ ' + usd(m.par) + ' / image';
    return usd(m.parSec) + ' / seconde';
  }

  function renderChoices() {
    const SUBLABEL = { texte: 'Mon abonnement · je copie-colle', image: 'Mon abonnement · je dépose mes images', video: 'Mon abonnement · je dépose mes clips' };
    ['texte', 'image', 'video'].forEach(step => {
      const sel = $('stIa-' + step);
      sel.innerHTML = '';
      const o = document.createElement('option'); o.value = SUB; o.textContent = SUBLABEL[step];
      sel.append(o);
      Object.entries(cfg.catalogue[step] || {}).forEach(([p, prov]) => {
        const g = document.createElement('optgroup'); g.label = prov.nom + ' · API';
        Object.entries(prov.modeles).forEach(([id, m]) => {
          const op = document.createElement('option'); op.value = p + '|' + id;
          op.textContent = `${m.label} · ${priceHint(step, m)}`;
          g.append(op);
        });
        sel.append(g);
      });
      sel.value = choice[step].p === SUB ? SUB : choice[step].p + '|' + choice[step].m;
    });
    renderKeys();
  }

  function renderKeys() {
    const needed = [...new Set(['texte', 'image', 'video'].filter(isApi).map(st => choice[st].p))];
    const box = $('stKeys');
    if (!box) return;
    box.innerHTML = '';
    if (!needed.length) { box.innerHTML = '<p class="st-help">Aucune clé nécessaire : tout se fait avec tes abonnements.</p>'; return; }
    needed.forEach(p => {
      const row = document.createElement('div');
      row.className = 'st-keyline' + (hasKey(p) ? ' ok' : ' missing');
      const link = { claude: 'https://platform.claude.com', openai: 'https://platform.openai.com/api-keys', grok: 'https://console.x.ai' }[p];
      row.innerHTML = hasKey(p)
        ? `<span><b>${PNAME[p]}</b> · clé ••••${esc(cfg.cles[p])} ${PulseUI.icon('check')}</span><button type="button" class="st-link" data-x>Retirer</button>`
        : `<span><b>${PNAME[p]}</b> · clé manquante (<a href="${link}" target="_blank" rel="noopener">obtenir une clé</a>)</span><input type="password" class="st-input" placeholder="Colle ta clé API ${PNAME[p]}" autocomplete="off"><button type="button" class="btn st-main" data-s>Enregistrer</button>`;
      row.querySelector('[data-s]')?.addEventListener('click', async e => {
        const input = row.querySelector('input'); const cle = input.value.trim(); if (!cle) return;
        e.currentTarget.disabled = true;
        try { const out = await api('/api/studio/cle', { fournisseur: p, cle }); cfg.cles[p] = out.fin; renderKeys(); }
        catch (err) { say('Clé refusée', err.message); e.currentTarget.disabled = false; }
      });
      row.querySelector('[data-x]')?.addEventListener('click', async () => {
        if (!(await PulseUI.dialog({ title: `Retirer ta clé ${PNAME[p]} ?`, text: 'Le Studio ne pourra plus utiliser cette IA par l’API tant que tu n’en remets pas une.', ok: 'Retirer', danger: true }))) return;
        try { await api('/api/studio/cle', { fournisseur: p, cle: '' }); delete cfg.cles[p]; renderKeys(); } catch (err) { say('Erreur', err.message); }
      });
      box.append(row);
    });
  }

  function afterChoice() {
    if (!$('stScenes')) return;
    renderScenes();
    $('stMoreIdeas').classList.toggle('hidden', !isApi('texte'));
    $('stIdeasSub').classList.toggle('hidden', isApi('texte'));
    if (isApi('texte') && hasKey(choice.texte.p)) loadIdeas(false);
  }

  // ---------- Coûts ----------
  async function refreshSpend(add) {
    if (add) cfg.depense += add;
    $('stSpent').textContent = usd(cfg.depense);
    $('stBudgetVal').textContent = usd(cfg.budget);
    $('stBudgetBar').style.width = Math.min(100, cfg.budget ? cfg.depense / cfg.budget * 100 : 100) + '%';
    $('stBudgetBar').classList.toggle('warn', cfg.depense >= cfg.budget * 0.8);
  }
  function learn(step, units, n) {
    if (!isApi(step) || !(units > 0) || !n) return;
    const kd = step === 'texte' ? 'script' : KIND[step];
    const k = `${kd}:${choice[step].p}:${choice[step].m}`;
    cfg.moyennes = cfg.moyennes || {};
    const a = cfg.moyennes[k] || { parUnite: 0, n: 0 };
    const total = a.parUnite * a.n + n;
    cfg.moyennes[k] = { n: a.n + units, parUnite: total / (a.n + units) };
  }
  function addCost(n) {
    if (!n) return;
    refreshSpend(n);
    if (!project) return;
    project.cout = (project.cout || 0) + n;
    $('stReal').textContent = usd(project.cout);
    save();
  }
  function estimate() {
    let imgs = 0, secs = 0;
    project.scenes.forEach((s, i) => {
      if (media.has(i)) return;
      if (isApi('video')) { if (images.has(i) || isApi('image')) { secs += s.duree; if (!images.has(i)) imgs++; } }
      else if (!images.has(i) && isApi('image')) imgs++;
    });
    const total = imgs * unit('image') + secs * unit('video');
    return { imgs, secs, total };
  }

  // ---------- Contexte : vraies stats du créateur ----------
  let contextCache = null;
  async function contexte() {
    if (contextCache) return contextCache;
    let me = {}, videos = [], hist = null;
    try { me = await api('/api/me'); } catch { /* ignore */ }
    try { videos = (await api('/api/me/videos?limit=20')).videos || []; } catch { /* ignore */ }
    try { hist = await api('/api/historique'); } catch { /* ignore */ }
    const top = [...videos].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 8);
    const lines = top.map(v => `- « ${v.title} » : ${fmt(v.views)} vues, ${v.duration || '?'} s`).join('\n');
    let hours = '';
    if (hist && !hist.empty && Array.isArray(hist.hours)) {
      const best = hist.hours.map((v, i) => [v, i]).filter(x => x[0] != null).sort((a, b) => b[0] - a[0]).slice(0, 3).map(x => `${x[1]} h`);
      if (best.length) hours = `\nMes vues arrivent surtout vers : ${best.join(', ')} (heure de Paris).`;
    }
    contextCache = `Mon compte ${me.platform === 'youtube' ? 'YouTube Shorts' : 'TikTok'} « ${me.nickname || me.username || 'mon compte'} » (${fmt(me.followers)} abonnés).
Je fais des histoires courtes en épisodes, en images générées par IA puis animées en vidéo (avec les voix des personnages).
Mes vidéos qui marchent le mieux (vraies statistiques) :
${lines || '- (pas encore de vidéos)'}${hours}`;
    return contextCache;
  }

  const IDEAS_ASK = `Propose 3 idées de prochain épisode dans le même style que mes vidéos qui marchent le mieux.
Réponds uniquement avec ce JSON :
{"idees":[{"titre":"…","pitch":"résumé en 2 phrases","hook":"accroche de la première seconde","pourquoi":"pourquoi ça devrait marcher d'après mes stats"}]}`;

  const SCRIPT_FORMAT = `Règles :
- 6 à 10 scènes de 4 à 8 secondes, vidéo verticale 9:16 ;
- un hook très fort dans la première scène, un rebondissement ou un cliffhanger à la fin ;
- garde exactement la même description physique des personnages d'une scène à l'autre ;
- dialogues courts et naturels (une ou deux répliques par scène), en français.
Réponds uniquement avec ce JSON :
{"titre":"…","hook":"…","description":"description TikTok (1 à 2 phrases)","hashtags":["#…"],
"personnages":[{"nom":"…","description":"apparence physique détaillée, vêtements"}],
"scenes":[{"n":1,"duree":6,"image":"prompt détaillé de l'image de départ : décor, cadrage, personnages (avec leur description), lumière, style réaliste, vertical 9:16","video":"action, mouvement de caméra, émotion, et la réplique exacte entre guillemets avec qui la dit","dialogue":"Nom : réplique"}]}`;

  function jsonOf(text) {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('La réponse ne contient pas de JSON. Réessaie (ou recolle la réponse entière).');
    try { return JSON.parse(text.slice(a, b + 1)); }
    catch { throw new Error('Le JSON de la réponse est incomplet ou mal formé. Réessaie.'); }
  }
  function toProject(j) {
    if (!Array.isArray(j.scenes) || !j.scenes.length) throw new Error('Le script ne contient aucune scène. Réessaie.');
    const persos = Array.isArray(j.personnages) ? j.personnages : [];
    return {
      titre: String(j.titre || 'Nouvelle vidéo'), hook: String(j.hook || ''), description: String(j.description || ''),
      hashtags: Array.isArray(j.hashtags) ? j.hashtags.map(String) : [],
      personnages: persos.map(p => ({ nom: String(p.nom || ''), description: String(p.description || '') })),
      scenes: j.scenes.slice(0, 12).map((s, i) => ({
        n: i + 1, duree: Math.min(10, Math.max(3, Math.round(Number(s.duree) || 6))),
        image: String(s.image || ''), video: String(s.video || s.grok || ''), dialogue: String(s.dialogue || '')
      })),
      cout: 0
    };
  }

  // Texte : par l'API choisie, ou en copier-coller avec l'abonnement du créateur.
  function pasteBox(title, prompt) {
    return new Promise(resolve => {
      const box = document.createElement('div');
      box.className = 'pdlg';
      box.innerHTML = `<div class="pdlg-card st-paste" role="dialog" aria-modal="true"><h2></h2>
        <p>1. Copie ce prompt dans ton IA (Claude, ChatGPT ou Grok, avec ton abonnement).<br>2. Colle sa réponse ci-dessous.</p>
        <button type="button" class="btn st-main" data-copy>${PulseUI.icon('copy')} Copier le prompt</button>
        <textarea class="st-area" rows="7" placeholder="Colle ici la réponse de ton IA…"></textarea>
        <div class="pdlg-btns"><button type="button" class="btn" data-no>Annuler</button><button type="button" class="btn pdlg-ok" data-ok>Valider</button></div></div>`;
      box.querySelector('h2').textContent = title;
      const done = v => { box.remove(); resolve(v); };
      box.querySelector('[data-copy]').addEventListener('click', e => copy(prompt, e.currentTarget));
      box.querySelector('[data-no]').addEventListener('click', () => done(null));
      box.querySelector('[data-ok]').addEventListener('click', () => { const t = box.querySelector('textarea').value.trim(); if (t) done(t); });
      document.body.append(box);
    });
  }
  async function askText(kind, prompt) {
    if (!isApi('texte')) {
      const t = await pasteBox(kind === 'idees' ? 'Idées avec ton abonnement' : 'Script avec ton abonnement', prompt);
      return t == null ? null : { texte: t, cout: 0 };
    }
    return api('/api/studio/texte', { fournisseur: choice.texte.p, modele: choice.texte.m, type: kind, prompt });
  }

  // ---------- Propositions ----------
  function renderIdeas(list) {
    const box = $('stIdeas');
    box.innerHTML = '';
    (list || []).forEach(it => {
      const el = document.createElement('article');
      el.className = 'st-idea';
      const cost = isApi('texte') ? ` <small>≈ ${usd(unit('texte'))}</small>` : '';
      el.innerHTML = `<h3>${esc(it.titre)}</h3><p>${esc(it.pitch)}</p>${it.hook ? `<p class="st-hook">« ${esc(it.hook)} »</p>` : ''}${it.pourquoi ? `<p class="st-why">${PulseUI.icon('trend')} ${esc(it.pourquoi)}</p>` : ''}
        <button type="button" class="btn st-main">${PulseUI.icon('zap')} Créer cet épisode${cost}</button>`;
      el.querySelector('button').addEventListener('click', () => writeScript(`${it.titre} — ${it.pitch} (hook : ${it.hook || ''})`));
      box.append(el);
    });
  }
  async function loadIdeas(force) {
    const today = new Date().toISOString().slice(0, 10);
    const cached = await get('idees');
    if (!force && cached && cached.jour === today) { renderIdeas(cached.liste); return; }
    if (isApi('texte') && !hasKey(choice.texte.p)) { $('stIdeas').innerHTML = `<p class="st-help">Ajoute ta clé ${PNAME[choice.texte.p]} dans « Tes IA » pour recevoir des propositions.</p>`; return; }
    if (isApi('texte')) $('stIdeas').innerHTML = `<p class="st-help">${esc(model('texte').label)} prépare 3 idées à partir de tes stats…</p>`;
    try {
      const out = await askText('idees', (await contexte()) + '\n\n' + IDEAS_ASK);
      if (!out) return;
      addCost(out.cout);
      const liste = (jsonOf(out.texte).idees || []).slice(0, 3);
      await put('idees', { jour: today, liste });
      renderIdeas(liste);
    } catch (e) { $('stIdeas').innerHTML = `<p class="st-help">${esc(e.message)}</p>`; }
  }

  async function writeScript(idee) {
    if (busy) return;
    if (project && project.scenes.length && !(await PulseUI.dialog({ title: 'Remplacer le projet en cours ?', text: 'Le script, les images et les clips actuels seront effacés de cet appareil.', ok: 'Remplacer', danger: true }))) return;
    busy = true;
    $('stScriptWait').classList.toggle('hidden', !isApi('texte'));
    try {
      const out = await askText('script', (await contexte()) + '\n\nÉcris cet épisode : ' + idee + '\n\n' + SCRIPT_FORMAT);
      if (!out) return;
      const next = toProject(jsonOf(out.texte));
      await clearProject();
      project = next;
      addCost(out.cout); learn('texte', 1, out.cout);
      await save();
      renderScenes();
      $('stProject').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { say('Script impossible', e.message); }
    finally { busy = false; $('stScriptWait').classList.add('hidden'); }
  }

  async function clearProject() {
    for (const i of [...media.keys()]) { URL.revokeObjectURL(media.get(i).url); await del('media:' + i); }
    for (const i of [...images.keys()]) await del('img:' + i);
    media.clear(); images.clear();
    project = null; await del('project');
  }

  // ---------- Scènes ----------
  function persoText() { return (project.personnages || []).map(p => `${p.nom} : ${p.description}`).join(' ; '); }
  const imagePrompt = s => `${s.image}\nPersonnages : ${persoText()}\nFormat vertical 9:16, style photo réaliste, cinématographique.`;
  const videoPrompt = s => `${s.video}\nDialogue en français : ${s.dialogue}`;

  function renderScenes() {
    const list = $('stScenes');
    list.innerHTML = '';
    $('stProject').classList.toggle('hidden', !project);
    if (!project) return;
    $('stTitle').textContent = project.titre;
    $('stHook').textContent = project.hook ? 'Hook : ' + project.hook : '';
    $('stReal').textContent = usd(project.cout || 0);
    const vApi = isApi('video'), iApi = isApi('image');

    project.scenes.forEach((s, i) => {
      const m = media.get(i), img = images.get(i);
      const el = document.createElement('article');
      el.className = 'st-scene' + (m ? ' ok' : '');
      el.dataset.i = i;
      // À gauche : l'image de départ ; à droite : le clip (aperçu lisible).
      const vidBox = m && m.type === 'video'
        ? `<video src="${m.url}" controls playsinline preload="metadata"></video>`
        : `<span>${PulseUI.icon('film')}<b>Clip</b><small>${vApi ? 'généré ici' : 'à déposer'}</small></span>`;
      const imgSrc = img || (m && m.type === 'image' ? m.url : null);
      const imgBox = imgSrc ? `<img src="${imgSrc}" alt="Image de départ de la scène ${s.n}">`
        : `<span>${PulseUI.icon('plus')}<b>Image</b><small>${iApi ? 'générée ici' : 'à déposer'}</small></span>`;
      const status = m ? '<em>clip prêt</em>' : img ? 'image prête' : '';
      const genCost = (vApi ? s.duree * unit('video') : 0) + (!img && iApi ? unit('image') : 0);
      const canGen = vApi && (img || iApi) || (!vApi && iApi && !img);
      el.innerHTML = `
        <div class="st-drop st-img${imgSrc ? ' full' : ''}" tabindex="0" role="button" aria-label="Image de départ de la scène ${s.n}">${imgBox}<input type="file" accept="image/*" hidden></div>
        <div class="st-info">
          <div class="st-n">Scène ${s.n} · ${s.duree} s${status ? ' · ' + status : ''}${s.cout ? ` · <span class="st-cost">coût réel ${usd(s.cout)}</span>` : ''}</div>
          <p class="st-dia">${esc(s.dialogue || '(sans dialogue)')}</p>
          <div class="st-btns">
            ${!iApi ? `<button type="button" class="btn" data-c="cimg">${PulseUI.icon('copy')} Prompt image</button>` : ''}
            ${!vApi ? `<button type="button" class="btn" data-c="cvid">${PulseUI.icon('copy')} Prompt vidéo</button>` : ''}
            ${canGen ? `<button type="button" class="btn" data-c="gen">${PulseUI.icon(m ? 'refresh' : 'zap')} ${m ? 'Régénérer' : 'Générer'} <small>≈ ${usd(m ? s.duree * unit('video') : genCost)}</small></button>` : ''}
            ${m ? `<button type="button" class="btn st-x" data-c="remove">Retirer le clip</button>` : ''}
          </div>
        </div>
        <div class="st-drop st-vid${m && m.type === 'video' ? ' full' : ''}" tabindex="0" role="button" aria-label="Clip de la scène ${s.n}">${vidBox}<div class="st-state" hidden></div><input type="file" accept="video/*" hidden></div>`;
      el.querySelectorAll('.st-drop').forEach(drop => {
        const input = drop.querySelector('input');
        const kind = drop.classList.contains('st-vid') ? 'video' : 'image';
        // Case remplie : le clip se lit (contrôles), on remplace par glisser-déposer.
        drop.addEventListener('click', e => { if (drop.classList.contains('full') && kind === 'video') return; if (e.target.tagName !== 'INPUT') input.click(); });
        drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
        drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
        drop.addEventListener('dragleave', () => drop.classList.remove('over'));
        drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) addFile(i, e.dataTransfer.files[0], kind); });
        input.addEventListener('change', () => { if (input.files[0]) addFile(i, input.files[0], kind); });
      });
      el.querySelector('[data-c=cimg]')?.addEventListener('click', e => copy(imagePrompt(s), e.currentTarget));
      el.querySelector('[data-c=cvid]')?.addEventListener('click', e => copy(videoPrompt(s), e.currentTarget));
      el.querySelector('[data-c=gen]')?.addEventListener('click', async () => {
        if (busy) return;
        if (m && !(await PulseUI.dialog({ title: 'Régénérer la scène ' + s.n + ' ?', text: `Un nouveau clip sera créé à partir de la même image. Coût estimé : ${usd(s.duree * unit('video'))}.`, ok: 'Régénérer' }))) return;
        busy = true;
        try { await genScene(i, true); } catch (e) { say('Scène ' + s.n, e.message); }
        finally { busy = false; renderScenes(); }
      });
      el.querySelector('[data-c=remove]')?.addEventListener('click', () => removeMedia(i));
      list.append(el);
    });

    const done = project.scenes.filter((_, i) => media.has(i)).length;
    const est = estimate();
    $('stCount').textContent = `${done} / ${project.scenes.length} scènes prêtes`;
    const steps = [];
    if (!iApi) steps.push('crée les images avec ton abonnement (bouton « Prompt image »)');
    if (!vApi) steps.push('anime-les dans Grok avec ton abonnement (bouton « Prompt vidéo ») et dépose les clips');
    else if (!iApi) steps.push('dépose chaque image : le clip sera généré par l’API');
    $('stQuote').innerHTML = (est.imgs || est.secs)
      ? `Reste à générer par l’API : <b>${est.imgs} image${est.imgs > 1 ? 's' : ''}</b>${est.secs ? ` + <b>${est.secs} s de vidéo</b>` : ''} ≈ <b>${usd(est.total)}</b> ${sourceText()}. ${regenText(est)}${steps.length ? '<br>Avec ton abonnement : ' + steps.join(', ') + '.' : ''}`
      : done === project.scenes.length ? 'Toutes les scènes sont prêtes.' : 'Avec ton abonnement : ' + steps.join(', ') + '.';
    const canAll = est.imgs + est.secs > 0;
    $('stGenAll').classList.toggle('hidden', !canAll);
    $('stGenAll').innerHTML = `${PulseUI.icon('zap')} Tout générer${vApi ? ' et monter' : ''} <small>≈ ${usd(est.total)}</small>`;
    $('stMake').disabled = !project.scenes.some((_, i) => media.has(i) || images.has(i));
    $('stDesc').textContent = [project.description, (project.hashtags || []).join(' ')].filter(Boolean).join('\n\n');
  }

  function sceneState(i, text) {
    const st = document.querySelector(`.st-scene[data-i="${i}"] .st-state`);
    if (st) { st.hidden = !text; st.textContent = text || ''; }
  }

  async function genScene(i, forceVideo) {
    const s = project.scenes[i];
    let img = images.get(i);
    if (!img && isApi('image')) {
      sceneState(i, 'Image…');
      const out = await api('/api/studio/image', { fournisseur: choice.image.p, modele: choice.image.m, prompt: imagePrompt(s) });
      img = out.image; images.set(i, img); await put('img:' + i, img); addCost(out.cout); learn('image', 1, out.cout);
      s.cout = (s.cout || 0) + (out.cout || 0); save();
      if (!isApi('video')) { renderScenes(); return; }
      renderScenes();
    }
    if (!isApi('video')) return;
    if (!img) throw new Error('Dépose d’abord l’image de départ de cette scène.');
    if (media.has(i) && !forceVideo) return;
    sceneState(i, 'Vidéo…');
    const regen = media.has(i);
    const start = await api('/api/studio/video', { image: img, prompt: videoPrompt(s), duree: s.duree, modele: choice.video.m, regen });
    cfg.habitudes = cfg.habitudes || { clips: 0, regenerations: 0 };
    cfg.habitudes.clips++; if (regen) cfg.habitudes.regenerations++;
    const firsts = cfg.habitudes.clips - cfg.habitudes.regenerations;
    cfg.habitudes.facteur = firsts > 0 ? cfg.habitudes.clips / firsts : null;
    const t0 = Date.now();
    for (;;) {
      await new Promise(r => setTimeout(r, 5000));
      const st = await api('/api/studio/video/' + encodeURIComponent(start.id));
      if (st.status === 'done') {
        if (st.cout) { addCost(st.cout); learn('video', Number(st.duree) || s.duree, st.cout); s.cout = (s.cout || 0) + st.cout; save(); }
        break;
      }
      if (st.status === 'failed') throw new Error(st.error || 'Génération échouée.');
      sceneState(i, 'Vidéo… ' + (st.progress ? Math.round(st.progress) + ' %' : Math.round((Date.now() - t0) / 1000) + ' s'));
      if (Date.now() - t0 > 10 * 60000) throw new Error('La génération prend trop de temps. Réessaie.');
    }
    sceneState(i, 'Téléchargement…');
    const r = await fetch('/api/studio/video/' + encodeURIComponent(start.id) + '/fichier', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('Téléchargement du clip impossible.');
    await setMedia(i, await r.blob(), 'video');
  }

  async function genAll() {
    if (busy || !project) return;
    const est = estimate();
    if (!(est.imgs + est.secs)) return;
    const missing = ['texte', 'image', 'video'].filter(st => st !== 'texte' && isApi(st) && !hasKey(choice[st].p));
    if (missing.length) { say('Clé manquante', `Ajoute ta clé ${missing.map(st => PNAME[choice[st].p]).join(' et ')} dans « Tes IA ».`); return; }
    const left = Math.max(0, cfg.budget - cfg.depense);
    const what = [est.imgs ? `${est.imgs} image${est.imgs > 1 ? 's' : ''} (${model('image')?.label || ''})` : '', est.secs ? `${est.secs} s de vidéo (${model('video').label})` : ''].filter(Boolean).join(' + ');
    if (!(await PulseUI.dialog({ title: 'Lancer la génération ?', text: `${what} ≈ ${usd(est.total)} sur tes comptes API ${sourceText()}.${cfg.habitudes?.clips >= 5 && cfg.habitudes.facteur > 1.05 ? ` Avec tes régénérations habituelles : ≈ ${usd(est.total * cfg.habitudes.facteur)}.` : ''} Il te reste ${usd(left)} sur ton plafond du mois.`, ok: 'Générer (≈ ' + usd(est.total) + ')' }))) return;
    busy = true;
    $('stGenAll').disabled = true;
    try {
      for (let i = 0; i < project.scenes.length; i++) {
        if (media.has(i)) continue;
        if (isApi('video') && !images.has(i) && !isApi('image')) continue;   // image à déposer d'abord
        try { await genScene(i, false); renderScenes(); }
        catch (e) {
          renderScenes();
          if (e.status === 402) { say('Plafond atteint', e.message); return; }
          say('Scène ' + project.scenes[i].n, e.message + ' Les autres scènes continuent.');
        }
      }
      busy = false;
      const waiting = project.scenes.filter((_, i) => !media.has(i) && !images.has(i) && !isApi('image')).map(s => s.n);
      if (waiting.length) say('Images à déposer', `Dépose l’image de départ des scènes ${waiting.join(', ')} : leurs clips seront ensuite générés.`);
      else if (project.scenes.every((_, i) => media.has(i))) make();
    } finally { busy = false; $('stGenAll').disabled = false; renderScenes(); }
  }

  function blobToDataUrl(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  }
  async function setMedia(i, blob, type) {
    const old = media.get(i); if (old) URL.revokeObjectURL(old.url);
    media.set(i, { blob, type, url: URL.createObjectURL(blob) });
    await put('media:' + i, { blob, type });
  }
  async function addFile(i, file, slot) {
    const type = file.type.startsWith('video') ? 'video' : file.type.startsWith('image') ? 'image' : null;
    if (!type) { say('Fichier non reconnu', 'Dépose une vidéo ou une image.'); return; }
    if (slot && slot !== type) { say('Mauvaise case', slot === 'video' ? 'Dépose la vidéo à droite (le clip), et l’image à gauche.' : 'Dépose l’image à gauche (l’image de départ), et le clip à droite.'); return; }
    if (type === 'image') {
      // Image de départ : le clip sera généré par l'API à partir d'elle.
      const url = await blobToDataUrl(file);
      images.set(i, url); await put('img:' + i, url);
    } else {
      await setMedia(i, file, type);
    }
    renderScenes();
  }
  async function removeMedia(i) {
    const old = media.get(i); if (old) URL.revokeObjectURL(old.url);
    media.delete(i); await del('media:' + i); renderScenes();
  }

  // ---------- 4. Montage ----------
  function subtitleChunks(text) {
    const clean = String(text || '').replace(/^[^:]{1,30}:\s*/, '').trim();   // retire « Nom : »
    if (!clean) return [];
    const words = clean.split(/\s+/);
    const out = [];
    for (let k = 0; k < words.length; k += 5) out.push(words.slice(k, k + 5).join(' '));
    return out;
  }

  function drawCover(ctx, src, sw, sh, zoom) {
    const s = Math.max(W / sw, H / sh) * (zoom || 1);
    const w = sw * s, h = sh * s;
    ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
  }

  function drawSubtitle(ctx, text) {
    if (!text) return;
    ctx.save();
    ctx.font = '800 68px "Space Grotesk", "DM Sans", Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = 14; ctx.strokeStyle = '#000';
    ctx.fillStyle = '#fff';
    const maxW = W - 160, words = text.split(' '), lines = [];
    let cur = '';
    words.forEach(w => { const t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; });
    if (cur) lines.push(cur);
    const y0 = H * 0.72 - (lines.length - 1) * 40;
    lines.forEach((l, k) => { ctx.strokeText(l, W / 2, y0 + k * 80); ctx.fillText(l, W / 2, y0 + k * 80); });
    ctx.restore();
  }

  function pickMime() {
    const c = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return c.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }

  let making = false;
  async function make() {
    if (making || !project) return;
    const scenes = project.scenes.map((s, i) => ({ s, m: media.get(i) || (images.get(i) ? { type: 'image', url: images.get(i) } : null) })).filter(x => x.m);
    if (!scenes.length) return;
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
      PulseUI.dialog({ title: 'Navigateur non compatible', text: 'Le montage demande un navigateur récent (Chrome ou Edge sur ordinateur).', cancel: null });
      return;
    }
    making = true;
    $('stMake').disabled = true;
    $('stOut').classList.add('hidden');
    const subs = $('stSubs').checked;
    const canvas = $('stCanvas');
    const ctx = canvas.getContext('2d');
    $('stRender').classList.remove('hidden');

    // Son : voix des clips + musique, mixés dans une seule piste.
    const ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    let musicEl = null;
    if (music) {
      musicEl = new Audio(music.url); musicEl.loop = true;
      const g = ac.createGain(); g.gain.value = Number($('stVol').value) / 100;
      ac.createMediaElementSource(musicEl).connect(g).connect(dest);
    }
    const stream = new MediaStream([...canvas.captureStream(FPS).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mime = pickMime();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
    const chunks = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise(r => { rec.onstop = r; });

    const total = scenes.reduce((t, x) => t + (x.m.type === 'image' ? x.s.duree : 0), 0);
    let elapsedImg = 0;
    const setProg = (k, frac) => { $('stProg').style.width = Math.round(((k + frac) / scenes.length) * 100) + '%'; $('stProgTxt').textContent = `Scène ${k + 1} / ${scenes.length}`; };

    try {
      await ac.resume();
      rec.start(1000);
      if (musicEl) { musicEl.currentTime = 0; musicEl.play().catch(() => {}); }

      for (let k = 0; k < scenes.length; k++) {
        const { s, m } = scenes[k];
        const parts = subs ? subtitleChunks(s.dialogue) : [];
        if (m.type === 'video') {
          const v = document.createElement('video');
          v.src = m.url; v.playsInline = true; v.preload = 'auto';
          await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('Clip illisible (scène ' + s.n + ')')); });
          const src = ac.createMediaElementSource(v); src.connect(dest);
          await v.play();
          await new Promise(res => {
            const tick = () => {
              const d = v.duration || s.duree;
              const p = Math.min(1, v.currentTime / d);
              ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
              drawCover(ctx, v, v.videoWidth || W, v.videoHeight || H);
              if (parts.length) drawSubtitle(ctx, parts[Math.min(parts.length - 1, Math.floor(p * parts.length))]);
              setProg(k, p);
              if (v.ended || v.paused && v.currentTime >= d - 0.05) { src.disconnect(); res(); } else requestAnimationFrame(tick);
            };
            v.onended = () => {};
            requestAnimationFrame(tick);
          });
        } else {
          const img = new Image(); img.src = m.url;
          await img.decode().catch(() => {});
          const d = s.duree * 1000, t0 = performance.now();
          await new Promise(res => {
            const tick = () => {
              const p = Math.min(1, (performance.now() - t0) / d);
              ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
              drawCover(ctx, img, img.naturalWidth || W, img.naturalHeight || H, 1 + 0.08 * p);   // léger zoom
              if (parts.length) drawSubtitle(ctx, parts[Math.min(parts.length - 1, Math.floor(p * parts.length))]);
              setProg(k, p);
              if (p >= 1) res(); else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          });
          elapsedImg += s.duree;
        }
      }
      rec.stop();
      await stopped;
    } catch (e) {
      try { rec.state !== 'inactive' && rec.stop(); } catch { /* ignore */ }
      PulseUI.dialog({ title: 'Montage interrompu', text: e.message || 'Une erreur est survenue.', cancel: null });
      making = false; $('stMake').disabled = false; musicEl?.pause(); ac.close(); return;
    }
    musicEl?.pause();
    ac.close();

    const type = (mime || 'video/webm').split(';')[0];
    const blob = new Blob(chunks, { type });
    const url = URL.createObjectURL(blob);
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const name = (project.titre || 'video').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'video';
    $('stVideo').src = url;
    const a = $('stDl'); a.href = url; a.download = name + '.' + ext;
    $('stFormat').textContent = ext === 'mp4' ? 'MP4' : 'WebM (pense à le convertir en MP4 si TikTok le refuse)';
    $('stOut').classList.remove('hidden');
    $('stRender').classList.add('hidden');
    making = false; $('stMake').disabled = false;
  }

  // Résumé des IA choisies (page Automatisation).
  function renderSummary() {
    const lab = st => isApi(st) ? model(st).label : 'mon abonnement';
    $('stIaSummary').innerHTML = `Script : <b>${esc(lab('texte'))}</b> · Images : <b>${esc(lab('image'))}</b> · Vidéo : <b>${esc(lab('video'))}</b>`;
  }

  // Réglages « Studio » dans Paramètres.
  async function initSettings() {
    try { cfg = await api('/api/studio/config'); } catch { return; }
    cfg.cles = cfg.cles || {};
    loadChoice();
    $('studio').classList.remove('hidden');
    $('stBudgetIn').value = cfg.budget;
    refreshSpend();
    renderChoices();
    ['texte', 'image', 'video'].forEach(step => $('stIa-' + step).addEventListener('change', async e => {
      const v = e.target.value;
      choice[step] = v === SUB ? { p: SUB, m: null } : { p: v.split('|')[0], m: v.split('|')[1] };
      await saveChoice(); renderKeys();
    }));
    if (!cfg.choix) saveChoice();   // premier passage : enregistre le choix proposé par défaut
    $('stBudgetSave').addEventListener('click', async () => {
      const v = Number(String($('stBudgetIn').value).replace(',', '.'));
      try { await api('/api/studio/budget', { budget: v }); cfg.budget = v; refreshSpend(); say('Plafond enregistré', `Le Studio s’arrêtera à ${usd(v)} de dépenses API ce mois-ci.`); }
      catch (e) { say('Plafond', e.message); }
    });
    if (location.hash === '#studio') $('studio').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- Démarrage ----------
  async function init() {
    try { cfg = await api('/api/studio/config'); }
    catch (e) { $('stMain').innerHTML = `<p class="st-help">${esc(e.message)}</p>`; $('stMain').classList.remove('hidden'); return; }
    cfg.cles = cfg.cles || {};
    loadChoice();

    project = await get('project');
    for (let i = 0; i < (project?.scenes?.length || 0); i++) {
      const m = await get('media:' + i);
      if (m && m.blob) media.set(i, { blob: m.blob, type: m.type, url: URL.createObjectURL(m.blob) });
      const im = await get('img:' + i);
      if (im) images.set(i, im);
    }
    const mu = await get('music');
    if (mu && mu.blob) { music = { blob: mu.blob, name: mu.name, url: URL.createObjectURL(mu.blob) }; $('stMusicName').textContent = mu.name; }

    // Réglages pas encore faits (ou clé manquante) : on invite à les faire dans Paramètres.
    if (!configured()) {
      const miss = missingKeys();
      $('stInviteText').textContent = !cfg.choix
        ? 'Choisis d’abord l’IA de chaque étape (script, images, vidéo) : avec ton abonnement en copier-coller, ou par API pour tout automatiser.'
        : `Il manque ta clé API ${miss.map(p => PNAME[p]).join(' et ')} pour les étapes que tu as choisies.`;
      $('stInvite').classList.remove('hidden');
      return;
    }
    $('stMain').classList.remove('hidden');
    refreshSpend();
    renderSummary();
    afterChoice();
    if (!isApi('texte')) { const c = await get('idees'); if (c) renderIdeas(c.liste); }

    $('stMoreIdeas').addEventListener('click', () => loadIdeas(true));
    $('stSubIdeas').addEventListener('click', () => loadIdeas(true));
    $('stOwnGo').addEventListener('click', () => { const t = $('stOwn').value.trim(); if (t) writeScript(t); });

    $('stGenAll').addEventListener('click', genAll);
    $('stNew').addEventListener('click', async () => {
      if (!(await PulseUI.dialog({ title: 'Nouveau projet ?', text: 'Le projet en cours, ses images et ses clips seront effacés de cet appareil.', ok: 'Effacer', danger: true }))) return;
      await clearProject(); renderScenes();
    });
    $('stMusic').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      if (music) URL.revokeObjectURL(music.url);
      music = { blob: f, name: f.name, url: URL.createObjectURL(f) };
      await put('music', { blob: f, name: f.name });
      $('stMusicName').textContent = f.name;
    });
    $('stMusicX').addEventListener('click', async () => { if (music) URL.revokeObjectURL(music.url); music = null; await del('music'); $('stMusicName').textContent = 'Aucune'; });
    $('stMake').addEventListener('click', make);
    $('stCopyDesc').addEventListener('click', e => copy($('stDesc').textContent, e.currentTarget));
  }

  window.PulseStudio = { init, initSettings };
})();
