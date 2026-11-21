// =====================================================
// YOUTUBE — connexion OAuth Google (lecture seule) + stats
// -----------------------------------------------------
// API officielle : YouTube Data API v3, autorisation
// « youtube.readonly » (lecture seule, aucune publication).
// Quota gratuit ~10 000 unités/jour pour tout le site :
// chaque lecture coûte 1 unité, d'où des caches d'1 minute.
//
// Variable d'environnement nécessaire :
//   GOOGLE_CLIENT_SECRET  code secret du client OAuth « TikTok Pulse »
//
// Firestore :
//   comptes/{googleId}/youtube/{channelId} { nom, pseudo, avatar, jeton (chiffré), ajouteLe, majLe }
//   liensYoutube/{channelId}               { compte: googleId }
// Compte affiché : cookie chiffré « tp_active » { p: "youtube", id }.
// =====================================================

const crypto = require("crypto");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const YT = "https://www.googleapis.com/youtube/v3";
const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

const ACTIVE_COOKIE = "tp_active";
const YT_STATE_COOKIE = "tp_yt_state";

const ME_CACHE_MS = 60 * 1000;
const LIST_CACHE_MS = 5 * 60 * 1000;
const VIDEO_CACHE_MS = 55 * 1000;

module.exports = function createYouTube(d) {
    const tokenCache = new Map(); // channelId → { accessToken, expires }

    const clientSecret = () => process.env.GOOGLE_CLIENT_SECRET?.trim() || null;
    const ready = () => Boolean(clientSecret());

    function readActive(req, secret) {
        const raw = d.readCookie(req, ACTIVE_COOKIE);
        const a = raw && secret ? d.unseal(raw, secret) : null;
        return a && (a.p === "youtube" || a.p === "tiktok") ? a : null;
    }

    function setActive(req, res, secret, p, id) {
        d.setCookie(req, res, ACTIVE_COOKIE, d.seal({ p, id }, secret), 365 * 86400);
    }

    function clearActive(req, res) {
        d.clearCookie(req, res, ACTIVE_COOKIE);
    }

    async function googleToken(params) {
        const r = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: d.GOOGLE_CLIENT_ID, client_secret: clientSecret(), ...params }),
            signal: AbortSignal.timeout(d.TIMEOUT_MS)
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || `Jeton Google HTTP ${r.status}`);
        return j;
    }

    function revoke(token) {
        if (!token) return;
        fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: "POST", signal: AbortSignal.timeout(d.TIMEOUT_MS) }).catch(() => {});
    }

    async function ytCall(accessToken, path) {
        const r = await fetch(`${YT}${path}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(d.TIMEOUT_MS)
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
            const e = new Error(j.error?.message || `API YouTube HTTP ${r.status}`);
            e.status = r.status;
            e.reason = j.error?.errors?.[0]?.reason;
            throw e;
        }
        return j;
    }

    // Jeton d'accès valide pour la chaîne (rafraîchi si besoin).
    async function accessFor(store, uid, channelId, secret) {
        const hit = tokenCache.get(channelId);
        if (hit && hit.expires > Date.now() + 60000) return hit.accessToken;

        const ref = store.collection("comptes").doc(uid).collection("youtube").doc(channelId);
        const doc = await ref.get();
        if (!doc.exists) return null;

        const saved = d.unseal(doc.get("jeton"), secret);
        if (!saved?.refreshToken) return null;

        const t = await googleToken({ grant_type: "refresh_token", refresh_token: saved.refreshToken });
        const expires = Date.now() + (t.expires_in || 3600) * 1000;
        tokenCache.set(channelId, { accessToken: t.access_token, expires });
        return t.access_token;
    }

    // Compte YouTube affiché pour cette requête (ou null).
    async function sessionFor(req, res) {
        const c = d.config(req);
        const a = readActive(req, c.secret);
        if (!a || a.p !== "youtube") return null;

        const google = d.readGoogle(req, c.secret);
        const store = d.db();
        if (!google || !store || !ready()) return { error: 401 };

        try {
            const token = await accessFor(store, google.uid, a.id, c.secret);
            if (!token) { clearActive(req, res); return { error: 401 }; }
            return { uid: google.uid, channelId: a.id, accessToken: token };
        } catch (error) {
            console.warn("[YOUTUBE] Jeton impossible :", error.message);
            tokenCache.delete(a.id);
            return { error: 401 };
        }
    }

    function isoDuration(s) {
        const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s || "");
        if (!m) return null;
        return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
    }

    const num = x => (x === undefined || x === null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));
    const thumb = t => t?.maxres?.url || t?.high?.url || t?.medium?.url || t?.default?.url || null;

    function cleanVideo(v) {
        return {
            id: v.id,
            title: v.snippet?.title || "Vidéo YouTube",
            cover: thumb(v.snippet?.thumbnails),
            shareUrl: `https://www.youtube.com/watch?v=${v.id}`,
            createTime: v.snippet?.publishedAt ? Math.floor(Date.parse(v.snippet.publishedAt) / 1000) : null,
            duration: isoDuration(v.contentDetails?.duration),
            views: num(v.statistics?.viewCount),
            likes: num(v.statistics?.likeCount),
            comments: num(v.statistics?.commentCount),
            shares: null,
            favorites: null,
            platform: "youtube"
        };
    }

    async function channel(yt) {
        return d.cached(`yt:me:${yt.channelId}`, ME_CACHE_MS, async () => {
            const j = await ytCall(yt.accessToken, `/channels?part=snippet,statistics,contentDetails&id=${encodeURIComponent(yt.channelId)}`);
            const ch = j.items?.[0];
            if (!ch) throw Object.assign(new Error("Chaîne introuvable"), { status: 404 });
            return ch;
        });
    }

    async function me(yt) {
        const ch = await channel(yt);
        const s = ch.statistics || {};
        return {
            platform: "youtube",
            username: (ch.snippet?.customUrl || "").replace(/^@/, "") || null,
            nickname: ch.snippet?.title || null,
            avatar: thumb(ch.snippet?.thumbnails),
            bio: ch.snippet?.description || null,
            verified: false,
            followers: s.hiddenSubscriberCount ? null : num(s.subscriberCount),
            following: null,
            likes: null,
            videos: num(s.videoCount),
            channelViews: num(s.viewCount)
        };
    }

    async function videos(yt, limit, cursor) {
        const ch = await channel(yt);
        const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
        if (!uploads) return { videos: [], cursor: null, hasMore: false };

        return d.cached(`yt:list:${yt.channelId}:${cursor || 0}:${limit}`, LIST_CACHE_MS, async () => {
            const pl = await ytCall(yt.accessToken, `/playlistItems?part=contentDetails&maxResults=${limit}&playlistId=${encodeURIComponent(uploads)}` +
                (cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""));
            const ids = (pl.items || []).map(i => i.contentDetails?.videoId).filter(Boolean);
            if (!ids.length) return { videos: [], cursor: null, hasMore: false };

            const vs = await ytCall(yt.accessToken, `/videos?part=snippet,statistics,contentDetails&id=${ids.join(",")}`);
            const byId = new Map((vs.items || []).map(v => [v.id, v]));
            return {
                videos: ids.map(id => byId.get(id)).filter(Boolean).map(cleanVideo),
                cursor: pl.nextPageToken || null,
                hasMore: Boolean(pl.nextPageToken)
            };
        });
    }

    async function video(yt, id) {
        return d.cached(`yt:video:${yt.channelId}:${id}`, VIDEO_CACHE_MS, async () => {
            const j = await ytCall(yt.accessToken, `/videos?part=snippet,statistics,contentDetails&id=${encodeURIComponent(id)}`);
            const v = j.items?.[0];
            if (!v || v.snippet?.channelId !== yt.channelId) return null;
            return cleanVideo(v);
        });
    }

    async function list(store, uid) {
        const snap = await store.collection("comptes").doc(uid).collection("youtube").get();
        return snap.docs;
    }

    async function unlink(store, uid, channelId, secret) {
        const ref = store.collection("comptes").doc(uid).collection("youtube").doc(channelId);
        const doc = await ref.get();
        if (!doc.exists) return false;
        revoke(d.unseal(doc.get("jeton"), secret)?.refreshToken);
        tokenCache.delete(channelId);
        await Promise.all([ref.delete(), store.collection("liensYoutube").doc(channelId).delete()]);
        for (const k of [...d.cache.keys()]) if (k.includes(channelId)) d.cache.delete(k);
        return true;
    }

    // ---------- Routes OAuth ----------
    function mountRoutes(app, { maxFor, countAll }) {
        // Départ vers Google (consentement YouTube, lecture seule).
        app.get("/auth/youtube", (req, res) => {
            const c = d.config(req);
            const google = c.secret ? d.readGoogle(req, c.secret) : null;

            if (!google) return res.redirect("/connexion.html");
            if (!ready()) return res.redirect("/relier.html?info=" + encodeURIComponent("La connexion YouTube n'est pas encore activée sur le serveur."));

            const state = crypto.randomBytes(24).toString("base64url");
            d.setCookie(req, res, YT_STATE_COOKIE, d.seal({ state, t: Date.now() }, c.secret), 600);

            const url = new URL(AUTH_URL);
            url.searchParams.set("client_id", d.GOOGLE_CLIENT_ID);
            url.searchParams.set("redirect_uri", `${req.protocol}://${req.get("host")}/auth/youtube/callback`);
            url.searchParams.set("response_type", "code");
            url.searchParams.set("scope", SCOPE);
            url.searchParams.set("access_type", "offline");
            url.searchParams.set("prompt", "consent select_account");
            url.searchParams.set("include_granted_scopes", "true");
            url.searchParams.set("state", state);
            if (google.email) url.searchParams.set("login_hint", google.email);
            res.redirect(url.href);
        });

        // Retour de Google : on relie la chaîne au compte TikTok Pulse.
        app.get("/auth/youtube/callback", async (req, res) => {
            const c = d.config(req);
            const google = c.secret ? d.readGoogle(req, c.secret) : null;
            const store = d.db();
            const back = msg => res.redirect("/relier.html?info=" + encodeURIComponent(msg));

            const raw = d.readCookie(req, YT_STATE_COOKIE);
            const saved = raw ? d.unseal(raw, c.secret) : null;
            d.clearCookie(req, res, YT_STATE_COOKIE);

            if (!google || !store) return res.redirect("/connexion.html");
            if (req.query.error) return back("Connexion YouTube annulée.");

            const code = typeof req.query.code === "string" ? req.query.code : null;
            const state = typeof req.query.state === "string" ? req.query.state : "";
            if (!code || !saved || Date.now() - saved.t > 600000 || state.length !== saved.state.length ||
                !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(saved.state))) {
                return back("La connexion YouTube a expiré. Réessaie.");
            }

            try {
                const t = await googleToken({
                    grant_type: "authorization_code",
                    code,
                    redirect_uri: `${req.protocol}://${req.get("host")}/auth/youtube/callback`
                });

                const j = await ytCall(t.access_token, "/channels?part=snippet&mine=true");
                const ch = j.items?.[0];
                if (!ch) { revoke(t.access_token); return back("Ce compte Google n'a pas de chaîne YouTube."); }
                if (!t.refresh_token) { revoke(t.access_token); return back("Google n'a pas donné l'accès durable. Réessaie."); }

                const linkRef = store.collection("liensYoutube").doc(ch.id);
                const accountRef = store.collection("comptes").doc(google.uid);
                const ytRef = accountRef.collection("youtube").doc(ch.id);

                const [link, account, existing] = await Promise.all([linkRef.get(), accountRef.get(), ytRef.get()]);
                if (link.exists && link.get("compte") !== google.uid) {
                    revoke(t.refresh_token);
                    return back("Cette chaîne YouTube est déjà reliée à un autre compte TikTok Pulse.");
                }
                if (!existing.exists) {
                    const premium = account.exists && account.get("premium") === true;
                    if ((await countAll(store, google.uid)) >= maxFor(premium)) {
                        revoke(t.refresh_token);
                        return back(premium ? "Limite de comptes reliés atteinte." : "Passe au premium pour relier plusieurs comptes.");
                    }
                }

                const old = existing.exists ? existing.data() : {};
                await Promise.all([
                    linkRef.set({ compte: google.uid }),
                    ytRef.set({
                        nom: ch.snippet?.title || null,
                        pseudo: (ch.snippet?.customUrl || "").replace(/^@/, "") || null,
                        avatar: thumb(ch.snippet?.thumbnails),
                        jeton: d.seal({ refreshToken: t.refresh_token }, c.secret),
                        ajouteLe: old.ajouteLe || new Date(),
                        majLe: new Date()
                    })
                ]);

                tokenCache.set(ch.id, { accessToken: t.access_token, expires: Date.now() + (t.expires_in || 3600) * 1000 });
                setActive(req, res, c.secret, "youtube", ch.id);
                console.log("[YOUTUBE] Chaîne reliée");
                res.redirect("/");
            } catch (error) {
                console.warn("[YOUTUBE] Liaison impossible :", error.message);
                back("Connexion YouTube impossible pour le moment. Réessaie.");
            }
        });
    }

    return { ACTIVE_COOKIE, ready, readActive, setActive, clearActive, sessionFor, me, videos, video, list, unlink, revoke, mountRoutes };
};
