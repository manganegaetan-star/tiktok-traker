// =====================================================
// STUDIO — génération avec les IA choisies par le créateur, et SES clés API
// Formule Créateur uniquement. Fournisseurs : Claude (Anthropic), ChatGPT (OpenAI), Grok (xAI).
//   comptes/{uid}.studio = { cles: { claude, openai, grok } (chiffrées), fins: {…}, budget (USD / mois) }
//   comptes/{uid}/studio/{AAAA-MM} = { total (USD), appels, detail.{type} }
// Chaque appel payant vérifie le plafond du mois, puis ajoute le coût réel
// (calculé à partir de l'usage renvoyé par l'IA, sinon le prix public).
// =====================================================
const { FieldValue } = require("@google-cloud/firestore");
const AnthropicSDK = require("@anthropic-ai/sdk");
const Anthropic = AnthropicSDK.default || AnthropicSDK;

const XAI = "https://api.x.ai/v1";
const OPENAI = "https://api.openai.com/v1";
const TICKS_PER_USD = 1e10;
const DEFAULT_BUDGET = 10;

// Catalogue des modèles proposés (prix publics de novembre 2026, par million de tokens ou par unité).
// est : coût estimé d'un script ou d'une série d'idées (affiché avant l'appel).
const CATALOG = {
    texte: {
        claude: {
            nom: "Claude", modeles: {
                "claude-opus-5-5": { label: "Claude Opus 5.5", in: 4, out: 20, est: 0.12, fallback: true },
                "claude-sonnet-5-5": { label: "Claude Sonnet 5.5", in: 2, out: 10, est: 0.06, fallback: true },
                "claude-haiku-5-5": { label: "Claude Haiku 5.5", in: 0.10, out: 0.50, est: 0.004 }
            }
        },
        openai: {
            nom: "ChatGPT", modeles: {
                "gpt-6.2-sol": { label: "GPT-6.2 Sol", in: 2, out: 10, est: 0.05 },
                "gpt-6-luna": { label: "GPT-6 Luna", in: 0.10, out: 0.50, est: 0.003 }
            }
        },
        grok: {
            nom: "Grok", modeles: {
                "grok-4.3": { label: "Grok 4.3", in: 1.25, out: 2.50, est: 0.01 }
            }
        }
    },
    image: {
        openai: {
            nom: "ChatGPT", modeles: {
                "gpt-image-2": { label: "GPT Image 2 · qualité moyenne", quality: "medium", par: 0.05, outRate: 30 },
                "gpt-image-2-high": { label: "GPT Image 2 · haute qualité", model: "gpt-image-2", quality: "high", par: 0.19, outRate: 30 },
                "gpt-image-1-mini": { label: "GPT Image 1 mini · économique", quality: "medium", par: 0.015, outRate: 8 }
            }
        },
        grok: {
            nom: "Grok", modeles: {
                "grok-imagine-image": { label: "Grok Imagine", par: 0.02 },
                "grok-imagine-image-2.0": { label: "Grok Imagine 2.0", par: 0.04 }
            }
        }
    },
    video: {
        grok: {
            nom: "Grok", modeles: {
                "grok-imagine-video-1.5-lite": { label: "Grok Imagine Vidéo 1.5 lite (Éco)", parSec: 0.02 },
                "grok-imagine-video-1.5": { label: "Grok Imagine Vidéo 1.5 (Max)", parSec: 0.08 }
            }
        }
    }
};
const PROVIDERS = ["claude", "openai", "grok"];

// Tarifs Claude par modèle ($ / million de tokens) : sert si l'API a répondu avec un modèle de repli.
const CLAUDE_RATES = {
    "claude-opus-5-5": [4, 20], "claude-opus-5": [5, 25], "claude-opus-4-8": [5, 25], "claude-opus-4-7": [5, 25],
    "claude-sonnet-5-5": [2, 10], "claude-sonnet-5": [2, 10], "claude-haiku-5-5": [0.10, 0.50],
    "claude-fable-5-2": [8, 40], "claude-fable-5-1": [10, 50]
};
// Tarifs des images OpenAI ($ / million de tokens) : texte en entrée, image en entrée, image en sortie.
const OPENAI_IMAGE_RATES = { "gpt-image-2": [5, 8, 30], "gpt-image-1-mini": [2, 2.5, 8] };

module.exports = function mountStudio(app, d) {
    const { db, config, seal, unseal, readGoogle, formuleOfDoc } = d;
    const month = () => new Date().toISOString().slice(0, 7);

    // Compte Google + formule Créateur requis.
    async function ctx(req, res) {
        const c = config(req);
        const google = c.ready ? readGoogle(req, c.secret) : null;
        const store = db();
        if (!google || !store) { res.status(401).json({ error: "Connecte ton compte Google" }); return null; }
        const ref = store.collection("comptes").doc(google.uid);
        const account = await ref.get();
        if (formuleOfDoc(account) !== "createur") { res.status(403).json({ error: "Réservé à la formule Créateur" }); return null; }
        const st = account.get("studio") || {};
        const keys = {};
        PROVIDERS.forEach(p => { const v = st.cles?.[p]; if (v) keys[p] = unseal(v, c.secret)?.key || null; });
        return { c, ref, st, keys, budget: Number.isFinite(Number(st.budget)) && st.budget !== undefined ? Number(st.budget) : DEFAULT_BUDGET };
    }

    async function spent(ref) {
        const s = await ref.collection("studio").doc(month()).get();
        return s.exists ? Number(s.get("total")) || 0 : 0;
    }
    // Coût d'un appel : total du mois, et moyenne réelle par modèle (unités : images, secondes de vidéo, ou appels de texte).
    async function record(ref, usd, kind, model, units) {
        await ref.collection("studio").doc(month()).set({
            total: FieldValue.increment(usd), appels: FieldValue.increment(1),
            detail: { [kind]: FieldValue.increment(usd) }, maj: new Date()
        }, { merge: true });
        if (model && units > 0) {
            await ref.set({ studio: { moyennes: { [kind + ":" + model]: { n: FieldValue.increment(units), total: FieldValue.increment(usd) } } } }, { merge: true });
        }
    }
    async function checkBudget(x, res, estimate) {
        const total = await spent(x.ref);
        if (total + estimate > x.budget + 1e-9) {
            res.status(402).json({ error: `Plafond du mois atteint : ${total.toFixed(2)} $ dépensés sur ${x.budget.toFixed(2)} $. Augmente-le dans les réglages du Studio pour continuer.` });
            return false;
        }
        return true;
    }
    function needKey(x, res, p) {
        if (x.keys[p]) return true;
        res.status(400).json({ error: `Ajoute ta clé API ${CATALOG.texte[p]?.nom || p} dans les réglages du Studio.` });
        return false;
    }

    async function http(base, key, path, opts = {}) {
        const r = await fetch(base + path, {
            method: opts.body ? "POST" : "GET",
            headers: { Authorization: "Bearer " + key, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
            body: opts.body ? JSON.stringify(opts.body) : undefined,
            signal: AbortSignal.timeout(opts.timeout || 60000)
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
            const msg = j?.error?.message || (typeof j?.error === "string" ? j.error : null) || j?.message || "HTTP " + r.status;
            const e = new Error(msg); e.status = r.status; throw e;
        }
        return j;
    }

    // Message clair : quelle IA, quelle étape, et ce que l'IA a répondu exactement.
    const LABEL = { claude: "Claude", openai: "ChatGPT (OpenAI)", grok: "Grok (xAI)" };
    function fail(res, error, what, p) {
        const status = error.status ?? (error instanceof Anthropic.APIError ? error.status : undefined);
        console.warn(`[STUDIO] ${what} :`, status || "", error.message);
        const who = p ? LABEL[p] : "L'IA";
        const raw = String(error.message || "").replace(/\s+/g, " ").slice(0, 300);
        let hint = "";
        if (status === 401 || status === 403) hint = "Ta clé API est refusée : vérifie qu'elle est correcte et active.";
        else if (status === 402 || /credit|quota|billing|balance|insufficient/i.test(raw)) hint = "Ton compte n'a sans doute plus de crédit : ajoute du crédit sur la console de ce fournisseur.";
        else if (status === 429) hint = "Trop de demandes d'un coup, ou limite de ton compte atteinte (souvent : pas de crédit sur un nouveau compte). Attends un peu ou vérifie ton crédit.";
        else if (status === 400) hint = "La demande a été refusée (contenu, format ou modèle non disponible pour ton compte).";
        else if (status >= 500) hint = "Le service est en panne ou surchargé. Réessaie dans quelques minutes.";
        const code = status === 401 || status === 403 || status === 400 ? 400 : status === 429 ? 429 : 502;
        res.status(code).json({ error: `${who} · ${what} : ${hint}${raw ? `

Réponse de l'IA : « ${raw} »` : ""}`.trim() });
    }

    // ---------- Réglages ----------
    app.get("/api/studio/config", async (req, res) => {
        res.set("Cache-Control", "no-store");
        try {
            const x = await ctx(req, res); if (!x) return;
            const fins = {};
            PROVIDERS.forEach(p => { if (x.keys[p]) fins[p] = x.st.fins?.[p] || "••••"; });
            const moyennes = {};
            Object.entries(x.st.moyennes || {}).forEach(([k, v]) => { if (v && v.n > 0) moyennes[k] = { parUnite: v.total / v.n, n: v.n }; });
            const h = x.st.habitudes || {};
            const clips = Number(h.clips) || 0, regen = Number(h.regenerations) || 0;
            const habitudes = { clips, regenerations: regen, facteur: clips - regen > 0 ? clips / (clips - regen) : null };
            res.json({ cles: fins, choix: x.st.choix || null, budget: x.budget, depense: await spent(x.ref), mois: month(), catalogue: CATALOG, moyennes, habitudes });
        } catch (error) { fail(res, error, "config"); }
    });

    async function validateKey(p, key) {
        if (p === "grok") {
            const info = await http(XAI, key, "/api-key", { timeout: 12000 });
            if (info.api_key_blocked || info.api_key_disabled || info.team_blocked) { const e = new Error("clé bloquée"); e.status = 403; throw e; }
        } else if (p === "openai") {
            await http(OPENAI, key, "/models", { timeout: 12000 });
        } else {
            const client = new Anthropic({ apiKey: key, timeout: 12000, maxRetries: 0 });
            await client.models.list({ limit: 1 });
        }
    }

    app.post("/api/studio/cle", async (req, res) => {
        const p = req.body?.fournisseur;
        const key = typeof req.body?.cle === "string" ? req.body.cle.trim() : "";
        if (!PROVIDERS.includes(p)) return res.status(400).json({ error: "Fournisseur inconnu" });
        try {
            const x = await ctx(req, res); if (!x) return;
            if (!key) {
                await x.ref.set({ studio: { cles: { [p]: FieldValue.delete() }, fins: { [p]: FieldValue.delete() } } }, { merge: true });
                return res.json({ ok: true });
            }
            if (!/^[A-Za-z0-9_\-]{20,300}$/.test(key)) return res.status(400).json({ error: "Cette clé n'a pas le bon format." });
            await validateKey(p, key);
            await x.ref.set({ studio: { cles: { [p]: seal({ key }, x.c.secret) }, fins: { [p]: key.slice(-4) } } }, { merge: true });
            res.json({ ok: true, fin: key.slice(-4) });
        } catch (error) { fail(res, error, "vérification de la clé", p); }
    });

    // Choix de l'IA de chaque étape : « abonnement » ou un modèle du catalogue.
    app.post("/api/studio/choix", async (req, res) => {
        const choix = {};
        for (const step of ["texte", "image", "video"]) {
            const v = req.body?.[step];
            if (v?.p === "abonnement") choix[step] = { p: "abonnement", m: null };
            else if (CATALOG[step]?.[v?.p]?.modeles?.[v?.m]) choix[step] = { p: v.p, m: v.m };
            else return res.status(400).json({ error: "Choix invalide pour « " + step + " »" });
        }
        try {
            const x = await ctx(req, res); if (!x) return;
            await x.ref.set({ studio: { choix } }, { merge: true });
            res.json({ ok: true, choix });
        } catch (error) { fail(res, error, "choix"); }
    });

    app.post("/api/studio/budget", async (req, res) => {
        const v = Number(req.body?.budget);
        if (!Number.isFinite(v) || v < 0 || v > 1000) return res.status(400).json({ error: "Plafond entre 0 et 1000 $." });
        try {
            const x = await ctx(req, res); if (!x) return;
            await x.ref.set({ studio: { budget: Math.round(v * 100) / 100 } }, { merge: true });
            res.json({ ok: true, budget: v });
        } catch (error) { fail(res, error, "budget"); }
    });

    // ---------- Texte (idées, script) ----------
    const SYSTEM = "Tu es scénariste de séries courtes verticales (TikTok, YouTube Shorts) en français. Tu réponds uniquement avec le JSON demandé, sans texte autour.";

    async function writeText(x, p, modelId, prompt) {
        const m = CATALOG.texte[p].modeles[modelId];
        if (p === "claude") {
            const client = new Anthropic({ apiKey: x.keys.claude, timeout: 120000, maxRetries: 2 });
            const params = { model: modelId, max_tokens: 16000, system: SYSTEM, messages: [{ role: "user", content: prompt }] };
            // Opus / Sonnet : si Claude refuse, l'API relance automatiquement sur un modèle de repli.
            const r = m.fallback
                ? await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
                : await client.messages.create(params);
            if (r.stop_reason === "refusal") { const e = new Error("Claude a refusé cette demande. Reformule ton idée."); e.status = 422; throw e; }
            const text = r.content.filter(b => b.type === "text").map(b => b.text).join("");
            const [rin, rout] = CLAUDE_RATES[r.model] || [m.in, m.out];
            const u = r.usage || {};
            const usd = ((u.input_tokens || 0) * rin + (u.cache_creation_input_tokens || 0) * rin * 1.25
                + (u.cache_read_input_tokens || 0) * rin * 0.1 + (u.output_tokens || 0) * rout) / 1e6;
            return { text, usd: usd || m.est, source: usd ? "tokens" : "estimation" };
        }
        const base = p === "openai" ? OPENAI : XAI;
        const j = await http(base, x.keys[p], "/chat/completions", {
            body: { model: modelId, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }], max_completion_tokens: 16000 },
            timeout: 120000
        });
        const ticks = Number(j.usage?.cost_in_usd_ticks);
        if (Number.isFinite(ticks) && ticks > 0) return { text: j.choices?.[0]?.message?.content || "", usd: ticks / TICKS_PER_USD, source: "exact" };
        const usd = ((j.usage?.prompt_tokens || 0) * m.in + (j.usage?.completion_tokens || 0) * m.out) / 1e6;
        return { text: j.choices?.[0]?.message?.content || "", usd: usd || m.est, source: usd ? "tokens" : "estimation" };
    }

    app.post("/api/studio/texte", async (req, res) => {
        const p = req.body?.fournisseur, modelId = req.body?.modele, kind = req.body?.type === "idees" ? "idees" : "script";
        const prompt = String(req.body?.prompt || "").slice(0, 20000);
        const m = CATALOG.texte[p]?.modeles?.[modelId];
        if (!m || !prompt) return res.status(400).json({ error: "Modèle ou demande invalide" });
        try {
            const x = await ctx(req, res); if (!x) return;
            if (!needKey(x, res, p)) return;
            if (!(await checkBudget(x, res, m.est))) return;
            const out = await writeText(x, p, modelId, prompt);
            await record(x.ref, out.usd, kind, p + ":" + modelId, 1);
            res.json({ texte: out.text, cout: out.usd, source: out.source });
        } catch (error) {
            if (error.status === 422) return res.status(422).json({ error: error.message });
            fail(res, error, "texte", p);
        }
    });

    // ---------- Image de départ (9:16) ----------
    app.post("/api/studio/image", async (req, res) => {
        const p = req.body?.fournisseur, modelId = req.body?.modele;
        const prompt = String(req.body?.prompt || "").slice(0, 8000);
        const m = CATALOG.image[p]?.modeles?.[modelId];
        if (!m || !prompt) return res.status(400).json({ error: "Modèle ou prompt invalide" });
        try {
            const x = await ctx(req, res); if (!x) return;
            if (!needKey(x, res, p)) return;
            if (!(await checkBudget(x, res, m.par))) return;
            let b64, mime = "image/jpeg", usd = m.par, source = "estimation";
            if (p === "openai") {
                const j = await http(OPENAI, x.keys.openai, "/images/generations", {
                    body: { model: m.model || modelId, prompt, n: 1, size: "1024x1536", quality: m.quality, output_format: "jpeg" },
                    timeout: 180000
                });
                b64 = j.data?.[0]?.b64_json;
                const u = j.usage || {};
                const [tin, iin, iout] = OPENAI_IMAGE_RATES[m.model || modelId] || [5, 8, m.outRate];
                const outTok = Number(u.output_tokens);
                if (Number.isFinite(outTok) && outTok > 0) {
                    const textIn = u.input_tokens_details?.text_tokens ?? (u.input_tokens || 0);
                    const imgIn = u.input_tokens_details?.image_tokens || 0;
                    usd = (textIn * tin + imgIn * iin + outTok * iout) / 1e6;
                    source = "tokens";
                }
            } else {
                const j = await http(XAI, x.keys.grok, "/images/generations", {
                    body: { model: modelId, prompt, n: 1, aspect_ratio: "9:16", response_format: "b64_json" },
                    timeout: 180000
                });
                b64 = j.data?.[0]?.b64_json;
                mime = j.data?.[0]?.mime_type || mime;
                const ticks = Number(j.usage?.cost_in_usd_ticks);
                if (Number.isFinite(ticks) && ticks > 0) { usd = ticks / TICKS_PER_USD; source = "exact"; }
            }
            if (!b64) throw new Error("aucune image reçue (contenu refusé par la modération ?)");
            await record(x.ref, usd, "images", p + ":" + modelId, 1);
            res.json({ image: `data:${mime};base64,${b64}`, cout: usd, source });
        } catch (error) { fail(res, error, "image", p); }
    });

    // ---------- Clip vidéo (image → vidéo avec les voix, Grok) ----------
    app.post("/api/studio/video", async (req, res) => {
        const image = typeof req.body?.image === "string" ? req.body.image : "";
        const prompt = String(req.body?.prompt || "").slice(0, 4000);
        const modelId = req.body?.modele;
        const m = CATALOG.video.grok.modeles[modelId];
        const duration = Math.min(15, Math.max(1, Math.round(Number(req.body?.duree) || 6)));
        if (!m) return res.status(400).json({ error: "Modèle vidéo invalide" });
        if (!/^data:image\/(png|jpeg|webp);base64,/.test(image) || image.length > 15e6) return res.status(400).json({ error: "Image de départ manquante ou trop lourde" });
        try {
            const x = await ctx(req, res); if (!x) return;
            if (!needKey(x, res, "grok")) return;
            const estimate = duration * m.parSec;
            if (!(await checkBudget(x, res, estimate))) return;
            const j = await http(XAI, x.keys.grok, "/videos/generations", {
                body: { model: modelId, prompt, image: { url: image }, duration, resolution: "720p" },
                timeout: 60000
            });
            if (!j.request_id) throw new Error("pas d'identifiant de génération");
            // Habitudes : combien de clips sont des régénérations (pour des devis réalistes).
            await x.ref.set({ studio: { habitudes: { clips: FieldValue.increment(1), regenerations: FieldValue.increment(req.body?.regen === true ? 1 : 0) } } }, { merge: true });
            res.json({ id: j.request_id, estimation: estimate });
        } catch (error) { fail(res, error, "vidéo", "grok"); }
    });

    const counted = new Set();
    app.get("/api/studio/video/:id", async (req, res) => {
        const id = String(req.params.id);
        if (!/^[A-Za-z0-9_\-]{6,120}$/.test(id)) return res.status(400).json({ error: "Identifiant invalide" });
        res.set("Cache-Control", "no-store");
        try {
            const x = await ctx(req, res); if (!x) return;
            if (!needKey(x, res, "grok")) return;
            const j = await http(XAI, x.keys.grok, "/videos/" + encodeURIComponent(id), { timeout: 30000 });
            if (j.status === "done") {
                if (!j.video?.url) return res.json({ status: "failed", error: "Vidéo refusée par la modération de Grok." });
                let usd = null, source = null;
                const k = x.ref.id + ":" + id;
                if (!counted.has(k)) {
                    counted.add(k);
                    const m = CATALOG.video.grok.modeles[j.model] || CATALOG.video.grok.modeles["grok-imagine-video-1.5-lite"];
                    const ticks = Number(j.usage?.cost_in_usd_ticks);
                    const secs = Number(j.video.duration) || 6;
                    source = Number.isFinite(ticks) && ticks > 0 ? "exact" : "estimation";
                    usd = source === "exact" ? ticks / TICKS_PER_USD : secs * m.parSec;
                    const modelKey = "grok:" + (CATALOG.video.grok.modeles[j.model] ? j.model : "grok-imagine-video-1.5-lite");
                    await record(x.ref, usd, "videos", modelKey, secs);
                }
                return res.json({ status: "done", cout: usd, source, duree: j.video.duration });
            }
            if (j.status === "failed" || j.status === "expired") return res.json({ status: "failed", error: j.error?.message || "Génération échouée." });
            res.json({ status: "pending", progress: j.progress || 0 });
        } catch (error) { fail(res, error, "suivi de la vidéo", "grok"); }
    });

    app.get("/api/studio/video/:id/fichier", async (req, res) => {
        const id = String(req.params.id);
        if (!/^[A-Za-z0-9_\-]{6,120}$/.test(id)) return res.status(400).end();
        try {
            const x = await ctx(req, res); if (!x) return;
            if (!needKey(x, res, "grok")) return;
            const j = await http(XAI, x.keys.grok, "/videos/" + encodeURIComponent(id), { timeout: 30000 });
            const url = j.video?.url;
            if (!url || !/^https:\/\//.test(url)) return res.status(404).json({ error: "Vidéo indisponible" });
            const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
            if (!r.ok) return res.status(502).json({ error: "Téléchargement impossible" });
            res.set("Content-Type", r.headers.get("content-type") || "video/mp4");
            res.set("Cache-Control", "no-store");
            res.send(Buffer.from(await r.arrayBuffer()));
        } catch (error) { fail(res, error, "téléchargement de la vidéo", "grok"); }
    });
};
module.exports.CATALOG = CATALOG;
