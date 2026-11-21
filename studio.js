// =====================================================
// TIKTOK PULSE — Studio d'automatisation (formule Créateur)
// 1. Prompt pour l'IA du créateur (Claude / ChatGPT), construit avec ses vraies stats
// 2. Réponse collée → découpage en scènes (prompts image + prompts Grok)
// 3. Clips Grok (avec leurs voix) ou images déposés scène par scène
// 4. Montage 9:16 dans le navigateur (sous-titres, musique) → vidéo à télécharger
// Rien n'est envoyé au serveur : le projet est gardé sur l'appareil (IndexedDB).
// =====================================================
(function () {
  'use strict';

  const W = 1080, H = 1920, FPS = 30;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => new Intl.NumberFormat('fr-FR').format(n || 0);

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

  let project = null;          // { titre, hook, description, hashtags[], scenes[] }
  const media = new Map();     // index de scène → { blob, type: 'video'|'image', url }
  let music = null;            // { blob, url, name }

  async function save() { await put('project', project); }

  // ---------- 1. Prompt avec les vraies stats ----------
  async function api(path) {
    const r = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) throw new Error('Erreur ' + r.status);
    return r.json();
  }

  async function buildPrompt() {
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

    return `Tu es scénariste pour mon compte ${me.platform === 'youtube' ? 'YouTube Shorts' : 'TikTok'} « ${me.nickname || me.username || 'mon compte'} » (${fmt(me.followers)} abonnés).
Je fais des histoires courtes en épisodes, en images générées par IA puis animées avec Grok Imagine (qui génère aussi les voix des personnages).

Voici mes vidéos qui marchent le mieux (mes vraies statistiques) :
${lines || '- (pas encore de vidéos)'}${hours}

Écris le prochain épisode dans le même style que mes vidéos qui marchent le mieux.
Règles :
- 6 à 10 scènes, environ 6 secondes chacune (durée d'un clip Grok), vidéo verticale 9:16 ;
- un hook très fort dans la première scène, un rebondissement ou un cliffhanger à la fin ;
- garde exactement la même description physique des personnages d'une scène à l'autre ;
- dialogues courts et naturels (une ou deux répliques par scène), en français.

Réponds UNIQUEMENT avec ce JSON, sans texte autour :
{
  "titre": "titre de la vidéo",
  "hook": "phrase d'accroche de la première seconde",
  "description": "description TikTok (1 à 2 phrases)",
  "hashtags": ["#tag1", "#tag2"],
  "personnages": [{"nom": "…", "description": "apparence physique détaillée, vêtements"}],
  "scenes": [
    {
      "n": 1,
      "duree": 6,
      "image": "prompt détaillé pour l'image de départ (ChatGPT) : décor, cadrage, personnages, lumière, style, format vertical 9:16",
      "grok": "prompt pour Grok Imagine : action, mouvement de caméra, émotion, et la réplique exacte entre guillemets avec qui la dit",
      "dialogue": "Nom : réplique (pour les sous-titres)"
    }
  ]
}`;
  }

  // ---------- 2. Réponse de l'IA → scènes ----------
  function parseAnswer(text) {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('Je ne trouve pas de JSON dans la réponse. Demande à ton IA de répondre uniquement avec le JSON.');
    let j;
    try { j = JSON.parse(text.slice(a, b + 1)); }
    catch { throw new Error('Le JSON de la réponse est incomplet ou mal formé. Recolle la réponse entière.'); }
    if (!Array.isArray(j.scenes) || !j.scenes.length) throw new Error('La réponse ne contient aucune scène.');
    const persos = Array.isArray(j.personnages) ? j.personnages : [];
    return {
      titre: String(j.titre || 'Nouvelle vidéo'),
      hook: String(j.hook || ''),
      description: String(j.description || ''),
      hashtags: Array.isArray(j.hashtags) ? j.hashtags.map(String) : [],
      personnages: persos.map(p => ({ nom: String(p.nom || ''), description: String(p.description || '') })),
      scenes: j.scenes.slice(0, 20).map((s, i) => ({
        n: i + 1,
        duree: Math.min(15, Math.max(2, Number(s.duree) || 6)),
        image: String(s.image || ''),
        grok: String(s.grok || ''),
        dialogue: String(s.dialogue || '')
      }))
    };
  }

  // ---------- Affichage ----------
  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select();
      try { document.execCommand('copy'); } catch { /* ignore */ } t.remove();
    }
    if (btn) { const o = btn.innerHTML; btn.innerHTML = PulseUI.icon('check') + ' Copié'; setTimeout(() => { btn.innerHTML = o; }, 1400); }
  }

  function persoText() {
    return (project.personnages || []).map(p => `${p.nom} : ${p.description}`).join(' ; ');
  }

  function renderScenes() {
    const list = $('stScenes');
    list.innerHTML = '';
    $('stProject').classList.toggle('hidden', !project);
    if (!project) return;
    $('stTitle').textContent = project.titre;
    $('stHook').textContent = project.hook ? 'Hook : ' + project.hook : '';

    project.scenes.forEach((s, i) => {
      const m = media.get(i);
      const el = document.createElement('article');
      el.className = 'st-scene' + (m ? ' ok' : '');
      el.innerHTML = `
        <div class="st-drop" tabindex="0" role="button" aria-label="Déposer le clip de la scène ${s.n}">
          ${m ? (m.type === 'video' ? `<video src="${m.url}" muted playsinline preload="metadata"></video>` : `<img src="${m.url}" alt="">`) : `<span>${PulseUI.icon('plus')}<b>Clip Grok</b><small>ou image</small></span>`}
          <input type="file" accept="video/*,image/*" hidden>
        </div>
        <div class="st-info">
          <div class="st-n">Scène ${s.n} · ${s.duree} s${m ? ' · <em>' + (m.type === 'video' ? 'clip ajouté' : 'image ajoutée') + '</em>' : ''}</div>
          <p class="st-dia">${esc(s.dialogue || '(sans dialogue)')}</p>
          <div class="st-btns">
            <button type="button" class="btn" data-c="image">${PulseUI.icon('copy')} Prompt image</button>
            <button type="button" class="btn" data-c="grok">${PulseUI.icon('copy')} Prompt Grok</button>
            ${m ? `<button type="button" class="btn st-x" data-c="remove">Retirer</button>` : ''}
          </div>
        </div>`;
      const drop = el.querySelector('.st-drop');
      const input = drop.querySelector('input');
      drop.addEventListener('click', () => input.click());
      drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
      drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) addMedia(i, e.dataTransfer.files[0]); });
      input.addEventListener('change', () => { if (input.files[0]) addMedia(i, input.files[0]); });
      el.querySelector('[data-c=image]').addEventListener('click', e => copy(s.image + (persoText() ? '\nPersonnages : ' + persoText() : ''), e.currentTarget));
      el.querySelector('[data-c=grok]').addEventListener('click', e => copy(s.grok, e.currentTarget));
      el.querySelector('[data-c=remove]')?.addEventListener('click', () => removeMedia(i));
      list.append(el);
    });

    const done = project.scenes.filter((_, i) => media.has(i)).length;
    $('stCount').textContent = `${done} / ${project.scenes.length} scènes prêtes`;
    $('stMake').disabled = done === 0;
    $('stDesc').textContent = [project.description, (project.hashtags || []).join(' ')].filter(Boolean).join('\n\n');
  }

  async function addMedia(i, file) {
    const type = file.type.startsWith('video') ? 'video' : file.type.startsWith('image') ? 'image' : null;
    if (!type) { PulseUI.dialog({ title: 'Fichier non reconnu', text: 'Dépose une vidéo (clip Grok) ou une image.', cancel: null }); return; }
    const old = media.get(i); if (old) URL.revokeObjectURL(old.url);
    media.set(i, { blob: file, type, url: URL.createObjectURL(file) });
    await put('media:' + i, { blob: file, type });
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
    const scenes = project.scenes.map((s, i) => ({ s, m: media.get(i) })).filter(x => x.m);
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
    void total; void elapsedImg;

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

  // ---------- Démarrage ----------
  async function init() {
    project = await get('project');
    for (let i = 0; i < (project?.scenes?.length || 0); i++) {
      const m = await get('media:' + i);
      if (m && m.blob) media.set(i, { blob: m.blob, type: m.type, url: URL.createObjectURL(m.blob) });
    }
    const mu = await get('music');
    if (mu && mu.blob) { music = { blob: mu.blob, name: mu.name, url: URL.createObjectURL(mu.blob) }; $('stMusicName').textContent = mu.name; }
    renderScenes();

    $('stPrompt').addEventListener('click', async e => {
      const b = e.currentTarget; b.disabled = true;
      try { await copy(await buildPrompt(), b); } finally { b.disabled = false; }
    });
    $('stParse').addEventListener('click', async () => {
      const text = $('stAnswer').value.trim();
      if (!text) return;
      try {
        const next = parseAnswer(text);
        if (project && media.size && !(await PulseUI.dialog({ title: 'Remplacer le projet en cours ?', text: 'Les clips déjà déposés seront retirés.', ok: 'Remplacer', danger: true }))) return;
        for (const i of [...media.keys()]) await removeMedia(i);
        project = next; await save();
        $('stAnswer').value = '';
        renderScenes();
        $('stProject').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) { PulseUI.dialog({ title: 'Réponse non reconnue', text: err.message, cancel: null }); }
    });
    $('stNew').addEventListener('click', async () => {
      if (!(await PulseUI.dialog({ title: 'Nouveau projet ?', text: 'Le projet en cours et ses clips seront effacés de cet appareil.', ok: 'Effacer', danger: true }))) return;
      for (const i of [...media.keys()]) await removeMedia(i);
      project = null; await del('project'); renderScenes();
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

  window.PulseStudio = { init };
})();
