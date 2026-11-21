// =====================================================
// RELEVÉ HORAIRE (premium uniquement)
// -----------------------------------------------------
// Toutes les heures, Cloud Scheduler appelle POST /cron/releve
// (jeton OIDC Google vérifié). Pour chaque compte Google PREMIUM,
// on enregistre un instantané de chaque compte relié :
//   historique/{plateforme}_{id}                 { uid, platform, accountId, maj }
//   historique/{plateforme}_{id}/heures/{AAAAMMJJHH} { t, followers, likes, channelViews, videos: { id: [vues, likes, coms] } }
//   historique/{plateforme}_{id}/jours/{AAAAMMJJ}    (même contenu, 1 par jour, au-delà de 30 jours)
// Pas de premium (ou premium terminé) = tout l'historique est supprimé.
// =====================================================

const HOURLY_DAYS = 30;          // relevés horaires gardés 30 jours
const DAILY_DAYS = 400;          // puis 1 relevé par jour, ~13 mois
const VIDEOS_PER_SNAPSHOT = 20;  // les 20 vidéos les plus récentes
const AGG_CACHE_MS = 10 * 60 * 1000;

module.exports = function createReleves(d) {
    const aggCache = new Map();

    const key = (platform, id) => `${platform}_${String(id).replace(/\//g, "_")}`;
    const hourKey = date => date.toISOString().slice(0, 13).replace(/[-T]/g, "");   // AAAAMMJJHH (UTC)
    const dayKey = date => date.toISOString().slice(0, 10).replace(/-/g, "");       // AAAAMMJJ (UTC)

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
        await deleteCollection(ref.collection("heures"));
        await deleteCollection(ref.collection("jours"));
        await ref.delete();
        aggCache.delete(key(platform, id));
    }

    // ---------- Instantanés ----------
    async function snapshotTikTok(store, uid, doc, secret, c) {
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

        const videos = {};
        for (const v of list.videos || []) {
            videos[String(v.id)] = [Number(v.view_count) || 0, Number(v.like_count) || 0, Number(v.comment_count) || 0];
        }

        return {
            followers: user.follower_count ?? null,
            likes: user.likes_count ?? null,
            channelViews: null,
            videos
        };
    }

    async function snapshotYouTube(store, uid, doc, secret) {
        const yt = await d.youtube.sessionForChannel(store, uid, doc.id, secret);
        if (!yt) return null;

        const me = await d.youtube.me(yt);
        const list = await d.youtube.videos(yt, VIDEOS_PER_SNAPSHOT, null);

        const videos = {};
        for (const v of list.videos || []) videos[v.id] = [v.views || 0, v.likes || 0, v.comments || 0];

        return { followers: me.followers, likes: null, channelViews: me.channelViews, videos };
    }

    async function writeSnapshot(store, uid, platform, id, data, now) {
        const ref = store.collection("historique").doc(key(platform, id));
        await ref.set({ uid, platform, accountId: id, maj: now }, { merge: true });
        await ref.collection("heures").doc(hourKey(now)).set({ t: now, ...data });
        aggCache.delete(key(platform, id));
    }

    // Au-delà de 30 jours : on garde 1 relevé par jour.
    async function compact(store, platform, id, now) {
        const ref = store.collection("historique").doc(key(platform, id));
        const old = await ref.collection("heures")
            .where("t", "<", new Date(now - HOURLY_DAYS * 86400000)).orderBy("t").limit(200).get();
        if (old.empty) return;

        const batch = store.batch();
        const seenDays = new Set();
        for (const doc of old.docs) {
            const t = doc.get("t").toDate();
            const dk = dayKey(t);
            if (!seenDays.has(dk)) {
                seenDays.add(dk);
                batch.set(ref.collection("jours").doc(dk), doc.data(), { merge: false });
            }
            batch.delete(doc.ref);
        }
        await batch.commit();

        const tooOld = await ref.collection("jours")
            .where("t", "<", new Date(now - DAILY_DAYS * 86400000)).limit(200).get();
        if (!tooOld.empty) {
            const b2 = store.batch();
            tooOld.docs.forEach(doc => b2.delete(doc.ref));
            await b2.commit();
        }
    }

    // Le relevé complet (appelé toutes les heures).
    async function run() {
        const store = d.db();
        const c = d.config(null);
        if (!store || !c.secret) return { ok: false, reason: "config" };

        const now = new Date();
        const res = { ok: true, comptes: 0, releves: 0, erreurs: 0, supprimes: 0 };
        const premiumUids = new Set();

        const comptes = await store.collection("comptes").get();
        for (const compte of comptes.docs) {
            if (compte.get("premium") !== true) continue;
            premiumUids.add(compte.id);
            res.comptes++;

            const [tk, yt] = await Promise.all([
                compte.ref.collection("tiktok").get(),
                compte.ref.collection("youtube").get()
            ]);

            const jobs = [
                ...tk.docs.map(doc => ["tiktok", doc, () => snapshotTikTok(store, compte.id, doc, c.secret, c)]),
                ...yt.docs.map(doc => ["youtube", doc, () => snapshotYouTube(store, compte.id, doc, c.secret)])
            ];

            for (const [platform, doc, take] of jobs) {
                try {
                    const data = await take();
                    if (!data) { res.erreurs++; continue; }
                    await writeSnapshot(store, compte.id, platform, doc.id, data, now);
                    await compact(store, platform, doc.id, now);
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
    function sumGain(a, b) {
        // vues gagnées entre deux instantanés (vidéos présentes dans les deux)
        let g = 0;
        for (const [id, v] of Object.entries(b.videos || {})) {
            const o = a.videos?.[id];
            if (o) g += Math.max(0, v[0] - o[0]);
        }
        return g;
    }

    function at(points, ms) {
        // instantané le plus proche (avant ou égal) d'une date
        let best = null;
        for (const p of points) if (p.t <= ms) best = p; else break;
        return best;
    }

    const hourFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Europe/Paris" });
    const parisHour = ms => Number(hourFmt.format(new Date(ms))) % 24;

    async function summary(platform, id) {
        const k = key(platform, id);
        const hit = aggCache.get(k);
        if (hit && hit.expires > Date.now()) return hit.value;

        const store = d.db();
        const ref = store.collection("historique").doc(k);
        const [hours, days] = await Promise.all([
            ref.collection("heures").orderBy("t").get(),
            ref.collection("jours").orderBy("t").get()
        ]);

        const toPoint = doc => ({ t: doc.get("t").toDate().getTime(), followers: doc.get("followers"), likes: doc.get("likes"), channelViews: doc.get("channelViews"), videos: doc.get("videos") || {} });
        const hourly = hours.docs.map(toPoint);
        const daily = days.docs.map(toPoint);
        const all = [...daily, ...hourly].sort((a, b) => a.t - b.t);

        if (!all.length) {
            const value = { empty: true };
            aggCache.set(k, { value, expires: Date.now() + 60000 });
            return value;
        }

        const last = all[all.length - 1];
        const now = last.t;
        const gain = ms => { const p = at(all, now - ms); return p && p !== last ? sumGain(p, last) : null; };
        const fGain = ms => { const p = at(all, now - ms); return p && p !== last && p.followers != null && last.followers != null ? last.followers - p.followers : null; };

        // Heures de vues : vues gagnées entre deux relevés horaires consécutifs, par heure (heure de Paris).
        const byHour = Array.from({ length: 24 }, () => ({ sum: 0, n: 0 }));
        for (let i = 1; i < hourly.length; i++) {
            const a = hourly[i - 1], b = hourly[i];
            if (b.t - a.t > 90 * 60000) continue; // trou dans les relevés : ignoré
            const h = parisHour(a.t);
            byHour[h].sum += sumGain(a, b);
            byHour[h].n++;
        }

        // Vidéos qui décollent : vues gagnées sur 24 h.
        const ref24 = at(all, now - 24 * 3600000);
        const rising = ref24 && ref24 !== last
            ? Object.entries(last.videos)
                .map(([vid, v]) => ({ id: vid, views: v[0], gain: ref24.videos?.[vid] ? v[0] - ref24.videos[vid][0] : null }))
                .filter(r => r.gain != null && r.gain > 0)
                .sort((a, b) => b.gain - a.gain).slice(0, 5)
            : [];

        // Courbe des abonnés : tous les relevés des 7 derniers jours, puis 1 point par jour.
        const seenDays = new Set();
        const curve = all.filter(p => {
            if (p.followers == null) return false;
            if (p.t >= now - 7 * 86400000) return true;
            const dk = dayKey(new Date(p.t));
            if (seenDays.has(dk)) return false;
            seenDays.add(dk);
            return true;
        }).map(p => [p.t, p.followers]);

        const value = {
            empty: false,
            since: all[0].t,
            lastUpdate: last.t,
            count: hourly.length,
            followers: last.followers,
            views: { h24: gain(24 * 3600000), d7: gain(7 * 86400000), d30: gain(30 * 86400000) },
            followersGain: { h24: fGain(24 * 3600000), d7: fGain(7 * 86400000), d30: fGain(30 * 86400000) },
            hours: byHour.map(h => (h.n ? Math.round(h.sum / h.n) : null)),
            rising,
            curve
        };
        aggCache.set(k, { value, expires: Date.now() + AGG_CACHE_MS });
        return value;
    }

    return { run, summary, deleteHistory, key };
};
