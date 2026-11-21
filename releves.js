// =====================================================
// RELEVÉS (premium uniquement)
// -----------------------------------------------------
// Cloud Scheduler appelle POST /cron/releve toutes les 10 minutes
// (jeton OIDC Google vérifié). Pour chaque compte Google PREMIUM :
//   - TikTok : un relevé toutes les 10 minutes ;
//   - YouTube : un relevé par heure (quota de l'API YouTube).
//
// Stockage : un « cahier » par jour et par compte relié.
//   historique/{plateforme}_{id}              { uid, platform, accountId, maj }
//   historique/{plateforme}_{id}/jours/{AAAA-MM-JJ}
//       { d, releves: [ { t, f, l, cv, v: { idVidéo: "vues|likes|coms" } } ], compact }
// Après 48 h, un cahier est allégé à 1 relevé par heure ; gardé ~13 mois.
// Pas de premium (ou premium terminé) = tout l'historique est supprimé.
// =====================================================

const { FieldValue } = require("@google-cloud/firestore");
const { formuleOfDoc, isPaid } = require("./formules");

const FINE_HOURS = 48;           // relevés de 10 min gardés 48 h
const KEEP_DAYS = 15;            // puis 1 par heure, 14 jours (2 semaines comparées)
const VIDEOS_PER_SNAPSHOT = 20;  // les 20 vidéos les plus récentes
const AGG_CACHE_MS = 5 * 60 * 1000;
const SUMMARY_DAYS = 15;         // la page lit 15 cahiers au plus

module.exports = function createReleves(d) {
    const aggCache = new Map();

    const key = (platform, id) => `${platform}_${String(id).replace(/\//g, "_")}`;
    const dayKey = ms => new Date(ms).toISOString().slice(0, 10);   // AAAA-MM-JJ (UTC)

    const hourFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Europe/Paris" });
    const parisHour = ms => Number(hourFmt.format(new Date(ms))) % 24;
    const dayFmt = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/Paris" });
    const parisDay = ms => dayFmt.format(new Date(ms));                 // AAAA-MM-JJ (Paris)

    async function deleteCollection(ref) {
        for (;;) {
            const snap = await ref.limit(400).get();
            if (snap.empty) return;
            const batch = d.db().batch();
            snap.docs.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
        }
    }

    // Efface tout l'historique d'un compte relié.
    async function deleteHistory(platform, id) {
        const store = d.db();
        if (!store) return;
        const ref = store.collection("historique").doc(key(platform, id));
        await deleteCollection(ref.collection("jours"));
        await deleteCollection(ref.collection("heures")); // ancien format
        await ref.delete();
        aggCache.delete(key(platform, id));
    }

    // ---------- Instantanés ----------
    const packVideos = list => {
        const v = {};
        for (const x of list) v[x.id] = `${x.views || 0}|${x.likes || 0}|${x.comments || 0}`;
        return v;
    };

    async function snapshotTikTok(doc, secret, c) {
        let session = d.unseal(doc.get("jeton"), secret);
        if (!session || Date.now() >= session.refreshExpires) return null;

        if (Date.now() >= session.accessExpires) {
            session = await d.tokenRequest({
                client_key: c.clientKey,
                client_secret: c.clientSecret,
                grant_type: "refresh_token",
                refresh_token: session.refreshToken
            });
            await doc.ref.update({ jeton: d.seal(session, secret), majLe: new Date() });
        }

        const user = (await d.apiCall(session, `/user/info/?fields=${d.USER_FIELDS}`)).user || {};
        const list = await d.apiCall(session, `/video/list/?fields=${d.VIDEO_FIELDS}`, {
            method: "POST",
            body: { max_count: VIDEOS_PER_SNAPSHOT }
        });

        return {
            f: user.follower_count ?? null,
            l: user.likes_count ?? null,
            cv: null,
            v: packVideos((list.videos || []).map(x => ({ id: String(x.id), views: x.view_count, likes: x.like_count, comments: x.comment_count })))
        };
    }

    async function snapshotYouTube(store, uid, doc, secret) {
        const yt = await d.youtube.sessionForChannel(store, uid, doc.id, secret);
        if (!yt) return null;
        const me = await d.youtube.me(yt);
        const list = await d.youtube.videos(yt, VIDEOS_PER_SNAPSHOT, null);
        return { f: me.followers, l: null, cv: me.channelViews, v: packVideos(list.videos || []) };
    }

    async function writeSnapshot(store, uid, platform, id, data, now) {
        const ref = store.collection("historique").doc(key(platform, id));
        const dk = dayKey(now);
        await ref.set({ uid, platform, accountId: id, maj: new Date(now) }, { merge: true });
        await ref.collection("jours").doc(dk).set({ d: dk, releves: FieldValue.arrayUnion({ t: now, ...data }) }, { merge: true });
        aggCache.delete(key(platform, id));
    }

    // Après 48 h : 1 relevé par heure dans le cahier ; au-delà de ~13 mois : cahier supprimé.
    async function compact(store, platform, id, now) {
        const ref = store.collection("historique").doc(key(platform, id)).collection("jours");
        const candidates = (await ref.where("d", "<", dayKey(now - FINE_HOURS * 3600000)).orderBy("d", "desc").limit(3).get())
            .docs.filter(x => x.get("compact") !== true);

        for (const doc of candidates) {
            const seen = new Set();
            const kept = (doc.get("releves") || []).sort((a, b) => a.t - b.t).filter(r => {
                const h = Math.floor(r.t / 3600000);
                if (seen.has(h)) return false;
                seen.add(h);
                return true;
            });
            await doc.ref.set({ d: doc.get("d"), releves: kept, compact: true });
        }

        const tooOld = await ref.where("d", "<", dayKey(now - KEEP_DAYS * 86400000)).limit(20).get();
        if (!tooOld.empty) {
            const batch = store.batch();
            tooOld.docs.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
        }
    }

    // Le relevé complet (appelé toutes les 10 minutes).
    async function run() {
        const store = d.db();
        const c = d.config(null);
        if (!store || !c.secret) return { ok: false, reason: "config" };

        const now = Date.now();
        const youtubeTurn = new Date(now).getUTCMinutes() < 10;   // YouTube : 1 fois par heure
        const compactTurn = new Date(now).getUTCMinutes() < 10;   // nettoyage : 1 fois par heure
        const res = { ok: true, comptes: 0, releves: 0, erreurs: 0, supprimes: 0 };
        const premiumUids = new Set();

        const comptes = await store.collection("comptes").get();
        for (const compte of comptes.docs) {
            if (!isPaid(formuleOfDoc(compte))) continue;
            premiumUids.add(compte.id);
            res.comptes++;

            const [tk, yt] = await Promise.all([
                compte.ref.collection("tiktok").get(),
                youtubeTurn ? compte.ref.collection("youtube").get() : Promise.resolve({ docs: [] })
            ]);

            const jobs = [
                ...tk.docs.map(doc => ["tiktok", doc, () => snapshotTikTok(doc, c.secret, c)]),
                ...yt.docs.map(doc => ["youtube", doc, () => snapshotYouTube(store, compte.id, doc, c.secret)])
            ];

            for (const [platform, doc, take] of jobs) {
                try {
                    const data = await take();
                    if (!data) { res.erreurs++; continue; }
                    await writeSnapshot(store, compte.id, platform, doc.id, data, now);
                    if (compactTurn) await compact(store, platform, doc.id, now);
                    res.releves++;
                } catch (error) {
                    res.erreurs++;
                    console.warn(`[RELEVE] ${platform} impossible :`, error.message);
                }
            }
        }

        // Pas (ou plus) premium : l'historique est supprimé.
        const all = await store.collection("historique").get();
        for (const h of all.docs) {
            if (!premiumUids.has(h.get("uid"))) {
                await deleteHistory(h.get("platform"), h.get("accountId"));
                res.supprimes++;
            }
        }

        console.log("[RELEVE]", JSON.stringify(res));
        return res;
    }

    // ---------- Agrégats pour la page Analyse ----------
    const unpack = s => { const [a, b, c] = String(s).split("|").map(Number); return [a || 0, b || 0, c || 0]; };

    function sumGain(a, b) {
        // vues gagnées entre deux relevés (vidéos présentes dans les deux)
        let g = 0;
        for (const [id, v] of Object.entries(b.videos)) {
            const o = a.videos[id];
            if (o) g += Math.max(0, v[0] - o[0]);
        }
        return g;
    }

    function at(points, ms) {
        // relevé le plus proche (avant ou égal) d'une date
        let best = null;
        for (const p of points) if (p.t <= ms) best = p; else break;
        return best;
    }

    // Intervalles consécutifs exploitables (trou de plus de 90 min ignoré).
    function* pairs(points, maxGap = 90 * 60000) {
        for (let i = 1; i < points.length; i++) {
            const a = points[i - 1], b = points[i];
            if (b.t - a.t <= maxGap) yield [a, b];
        }
    }

    async function summary(platform, id) {
        const k = key(platform, id);
        const hit = aggCache.get(k);
        if (hit && hit.expires > Date.now()) return hit.value;

        const store = d.db();
        const snap = await store.collection("historique").doc(k).collection("jours")
            .where("d", ">=", dayKey(Date.now() - SUMMARY_DAYS * 86400000)).get();

        const all = [];
        for (const doc of snap.docs) {
            for (const r of doc.get("releves") || []) {
                const videos = {};
                for (const [vid, s] of Object.entries(r.v || {})) videos[vid] = unpack(s);
                all.push({ t: r.t, followers: r.f ?? null, likes: r.l ?? null, channelViews: r.cv ?? null, videos });
            }
        }
        all.sort((a, b) => a.t - b.t);

        if (!all.length) {
            const value = { empty: true };
            aggCache.set(k, { value, expires: Date.now() + 60000 });
            return value;
        }

        const last = all[all.length - 1];
        const now = last.t;
        const gain = ms => { const p = at(all, now - ms); return p && p !== last && now - p.t >= ms * 0.9 ? sumGain(p, last) : null; };
        const fGain = ms => { const p = at(all, now - ms); return p && p !== last && now - p.t >= ms * 0.9 && p.followers != null && last.followers != null ? last.followers - p.followers : null; };

        // Heures de vues : vues gagnées par heure de la journée (Paris), moyennées sur les jours suivis.
        const perDayHour = new Map();   // "AAAA-MM-JJ|h" → vues gagnées
        for (const [a, b] of pairs(all)) {
            const kk = parisDay(a.t) + "|" + parisHour(a.t);
            perDayHour.set(kk, (perDayHour.get(kk) || 0) + sumGain(a, b));
        }
        const byHour = Array.from({ length: 24 }, () => ({ sum: 0, n: 0 }));
        for (const [kk, g] of perDayHour) { const h = Number(kk.split("|")[1]); byHour[h].sum += g; byHour[h].n++; }

        // Vues gagnées heure par heure sur les dernières 24 h.
        const hourBuckets = new Map();
        for (const [a, b] of pairs(all)) {
            if (b.t <= now - 24 * 3600000) continue;
            const hs = Math.floor(a.t / 3600000) * 3600000;
            hourBuckets.set(hs, (hourBuckets.get(hs) || 0) + sumGain(a, b));
        }
        const last24 = [...hourBuckets].sort((a, b) => a[0] - b[0]).map(([t, g]) => ({ t, gain: g }));

        // Vues gagnées par jour (Paris) et par jour de la semaine.
        const perDay = new Map();
        for (const [a, b] of pairs(all, 26 * 3600000)) {
            const dk = parisDay(a.t);
            perDay.set(dk, (perDay.get(dk) || 0) + sumGain(a, b));
        }
        const today = parisDay(now);
        const dayGains = [...perDay].filter(([dk]) => dk !== today).sort().slice(-30).map(([dd, g]) => ({ d: dd, gain: g }));
        const wd = Array.from({ length: 7 }, () => ({ sum: 0, n: 0 }));
        for (const { d: dd, gain: g } of dayGains) { const w = new Date(dd + "T12:00:00Z").getUTCDay(); wd[w].sum += g; wd[w].n++; }

        const topBy = ref => ref && ref !== last
            ? Object.entries(last.videos)
                .map(([vid, v]) => ({ id: vid, views: v[0], gain: ref.videos[vid] ? v[0] - ref.videos[vid][0] : null }))
                .filter(r => r.gain != null && r.gain > 0)
                .sort((a, b) => b.gain - a.gain).slice(0, 5)
            : [];

        const ref7 = at(all, now - 7 * 86400000);
        const p14 = at(all, now - 14 * 86400000);
        const prevWeek = p14 && ref7 && p14 !== ref7 && now - p14.t >= 13 * 86400000
            ? { views: sumGain(p14, ref7), followers: p14.followers != null && ref7.followers != null ? ref7.followers - p14.followers : null }
            : null;

        // Courbe des abonnés : tous les relevés des 7 derniers jours, puis 1 point par jour.
        const seenDays = new Set();
        const curve = all.filter(p => {
            if (p.followers == null) return false;
            if (p.t >= now - 7 * 86400000) return true;
            const dk = parisDay(p.t);
            if (seenDays.has(dk)) return false;
            seenDays.add(dk);
            return true;
        }).map(p => [p.t, p.followers]);

        const value = {
            empty: false,
            platform,
            since: all[0].t,
            lastUpdate: last.t,
            count: all.length,
            followers: last.followers,
            views: { h24: gain(24 * 3600000), d7: gain(7 * 86400000) },
            followersGain: { h24: fGain(24 * 3600000), d7: fGain(7 * 86400000) },
            hours: byHour.map(h => (h.n ? Math.round(h.sum / h.n) : null)),
            hourSamples: byHour.reduce((m, h) => Math.min(m, h.n), Infinity),
            hoursN: byHour.map(h => h.n),
            weekdays: wd.map(x => (x.n ? Math.round(x.sum / x.n) : null)),
            weekdaysN: wd.map(x => x.n),
            days: dayGains,
            last24,
            top7: topBy(ref7),
            prevWeek,
            rising: topBy(at(all, now - 24 * 3600000)),
            curve
        };
        aggCache.set(k, { value, expires: Date.now() + AGG_CACHE_MS });
        return value;
    }

    return { run, summary, deleteHistory, key };
};
