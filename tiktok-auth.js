// =====================================================
// CONNEXION TIKTOK (Login Kit) + DISPLAY API OFFICIELLE
// -----------------------------------------------------
// Un créateur se connecte avec son compte TikTok :
// on obtient alors les chiffres EXACTS de ses vidéos
// via l'API officielle, sans tikwm.
//
// Variables d'environnement nécessaires :
//   TIKTOK_CLIENT_KEY      clé de l'app (developers.tiktok.com)
//   TIKTOK_CLIENT_SECRET   secret de l'app
// Facultatives :
//   TIKTOK_REDIRECT_URI    par défaut https://<domaine du site>/auth/tiktok/callback
//   SESSION_SECRET         par défaut dérivé de TIKTOK_CLIENT_SECRET
//
// Les jetons TikTok sont chiffrés (AES-256-GCM) dans un
// cookie HttpOnly : aucune base de données nécessaire, et
// ça fonctionne même avec plusieurs instances Cloud Run.
// =====================================================

const crypto = require("crypto");

const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const API = "https://open.tiktokapis.com/v2";

const SCOPES = [
    "user.info.basic",
    "user.info.profile",
    "user.info.stats",
    "video.list"
].join(",");

const USER_FIELDS = [
    "open_id", "avatar_url", "avatar_large_url", "display_name",
    "username", "bio_description", "is_verified",
    "follower_count", "following_count", "likes_count", "video_count"
].join(",");

const VIDEO_FIELDS = [
    "id", "title", "video_description", "cover_image_url", "share_url",
    "create_time", "duration",
    "view_count", "like_count", "comment_count", "share_count"
].join(",");

const SESSION_COOKIE = "tp_session";
const STATE_COOKIE = "tp_oauth_state";
const TIMEOUT_MS = 12000;

// Le site actualise toutes les 10 s : caches juste en dessous,
// pour que chaque relevé soit frais sans appels en double.
const USER_CACHE_MS = 9000;
const LIST_CACHE_MS = 60000;
const VIDEO_CACHE_MS = 9000;

const cache = new Map();

function config(req) {
    const clientKey = process.env.TIKTOK_CLIENT_KEY?.trim();
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET?.trim();

    // Clé de chiffrement des cookies : SESSION_SECRET si fourni,
    // sinon dérivée du client secret (changer le secret TikTok
    // déconnecte donc tout le monde, ce qui est voulu).
    const explicit = process.env.SESSION_SECRET?.trim();
    const secret = explicit && explicit.length >= 32
        ? explicit
        : clientSecret
            ? crypto.createHash("sha256").update("tp-session:" + clientSecret).digest("hex")
            : null;

    const redirectUri =
        process.env.TIKTOK_REDIRECT_URI?.trim() ||
        (req ? `${req.protocol}://${req.get("host")}/auth/tiktok/callback` : null);

    return {
        clientKey,
        clientSecret,
        redirectUri,
        secret,
        ready: Boolean(clientKey && clientSecret && secret && redirectUri)
    };
}

// Session valide (cookie déchiffrable, refresh token non expiré) ?
function readSession(req) {
    const c = config(req);
    if (!c.ready) return null;

    const raw = readCookie(req, SESSION_COOKIE);
    const session = raw ? unseal(raw, c.secret) : null;

    return session && Date.now() < session.refreshExpires ? session : null;
}

// -----------------------------------------------------
// Cookies chiffrés
// -----------------------------------------------------

function key(secret) {
    return crypto.createHash("sha256").update(secret).digest();
}

function seal(data, secret) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key(secret), iv);
    const body = Buffer.concat([
        cipher.update(JSON.stringify(data), "utf8"),
        cipher.final()
    ]);

    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function unseal(value, secret) {
    try {
        const raw = Buffer.from(value, "base64url");
        const decipher = crypto.createDecipheriv(
            "aes-256-gcm", key(secret), raw.subarray(0, 12)
        );

        decipher.setAuthTag(raw.subarray(12, 28));

        return JSON.parse(Buffer.concat([
            decipher.update(raw.subarray(28)),
            decipher.final()
        ]).toString("utf8"));
    } catch {
        return null;
    }
}

function readCookie(req, name) {
    const header = req.headers.cookie || "";

    for (const part of header.split(";")) {
        const i = part.indexOf("=");

        if (i > 0 && part.slice(0, i).trim() === name) {
            return decodeURIComponent(part.slice(i + 1).trim());
        }
    }

    return null;
}

function setCookie(req, res, name, value, maxAgeSeconds) {
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https";

    res.append("Set-Cookie", [
        `${name}=${encodeURIComponent(value)}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
        secure ? "Secure" : null
    ].filter(Boolean).join("; "));
}

function clearCookie(req, res, name) {
    setCookie(req, res, name, "", 0);
}

// -----------------------------------------------------
// Appels TikTok
// -----------------------------------------------------

async function tokenRequest(params) {
    const response = await fetch(`${API}/oauth/token/`, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Cache-Control": "no-cache"
        },
        body: new URLSearchParams(params),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });

    const json = await response.json().catch(() => ({}));

    if (!response.ok || json.error || !json.access_token) {
        throw new Error(
            json.error_description || json.error ||
            `Jeton TikTok HTTP ${response.status}`
        );
    }

    return {
        openId: json.open_id,
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        accessExpires: Date.now() + (json.expires_in - 60) * 1000,
        refreshExpires: Date.now() + json.refresh_expires_in * 1000,
        scope: json.scope
    };
}

// =====================================================
// STATUT PREMIUM (Firestore)
// -----------------------------------------------------
// Collection « utilisateurs », un document par compte TikTok
// (id = open_id) : { pseudo, creeLe, premium }.
// Le document est créé à la première visite avec premium: false.
// Pour passer quelqu'un en premium : console Firestore →
// utilisateurs → son document → premium = true.
// Lecture mise en cache 5 min pour rester dans le quota gratuit.
// Sans Firestore (ex. en local), tout le monde est gratuit.
// =====================================================

const PREMIUM_CACHE_MS = 5 * 60 * 1000;
const premiumCache = new Map();
let firestore;

function db() {
    if (firestore === undefined) {
        try {
            const { Firestore } = require("@google-cloud/firestore");
            firestore = new Firestore();
        } catch (error) {
            console.warn("Firestore indisponible :", error.message);
            firestore = null;
        }
    }
    return firestore;
}

async function premiumStatus(openId, username) {
    const hit = premiumCache.get(openId);
    if (hit && hit.expires > Date.now()) return hit.value;

    let value = false;
    const store = db();

    if (store && openId) {
        try {
            const ref = store.collection("utilisateurs").doc(openId);
            const snap = await ref.get();

            if (snap.exists) {
                value = snap.get("premium") === true;
            } else {
                await ref.set({ pseudo: username || null, creeLe: new Date(), premium: false });
            }
        } catch (error) {
            console.warn("Lecture premium impossible :", error.message);
        }
    }

    premiumCache.set(openId, { value, expires: Date.now() + PREMIUM_CACHE_MS });
    return value;
}

async function apiCall(session, path, { method = "GET", body } = {}) {
    const response = await fetch(`${API}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${session.accessToken}`,
            ...(body ? { "Content-Type": "application/json" } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });

    const json = await response.json().catch(() => ({}));
    const code = json.error?.code;

    if (!response.ok || (code && code !== "ok")) {
        const error = new Error(
            json.error?.message || `API TikTok HTTP ${response.status}`
        );

        error.code = code;
        error.status = response.status;
        throw error;
    }

    return json.data;
}

async function cached(cacheKey, ms, loader) {
    const hit = cache.get(cacheKey);

    if (hit && Date.now() - hit.time < ms) return hit.data;

    const data = await loader();

    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, { data, time: Date.now() });

    return data;
}

function cleanVideo(v) {
    const num = x => (Number.isFinite(Number(x)) ? Number(x) : null);
    const https = u => (typeof u === "string" && u.startsWith("https://") ? u : null);

    return {
        id: String(v.id),
        title: v.title || v.video_description || "Vidéo TikTok",
        cover: https(v.cover_image_url),
        shareUrl: https(v.share_url),
        createTime: num(v.create_time),
        duration: num(v.duration),
        views: num(v.view_count),
        likes: num(v.like_count),
        comments: num(v.comment_count),
        shares: num(v.share_count)
    };
}

// -----------------------------------------------------
// Favoris : l'API officielle ne les fournit pas. On lit le
// compteur affiché sur la page publique de la vidéo du
// créateur connecté (sa propre vidéo), au plus une fois par
// minute et par vidéo. En cas d'échec : null (« — »).
// -----------------------------------------------------

const FAV_CACHE_MS = 60 * 1000;
const FAV_FAIL_MS = 5 * 60 * 1000;
const favCache = new Map();

async function fetchFavorites(videoId, username) {
    const hit = favCache.get(videoId);
    if (hit && Date.now() < hit.until) return hit.value;

    let value = null;

    try {
        if (!username || !/^[a-zA-Z0-9._]{1,30}$/.test(username)) throw new Error("username");

        const response = await fetch(
            `https://www.tiktok.com/@${username}/video/${videoId}`,
            {
                headers: {
                    Accept: "text/html,application/xhtml+xml",
                    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
                },
                signal: AbortSignal.timeout(6000)
            }
        );

        if (!response.ok) throw new Error("HTTP " + response.status);

        const html = await response.text();
        const m = html.match(/<script\b(?=[^>]*\bid=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'])[^>]*>([\s\S]*?)<\/script\s*>/i);
        const item = m && JSON.parse(m[1])?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct;

        if (!item || String(item.id) !== String(videoId)) throw new Error("page");

        const n = Number(item.statsV2?.collectCount ?? item.stats?.collectCount);
        value = Number.isFinite(n) ? n : null;
    } catch (error) {
        console.warn("[FAVORIS]", videoId, error.message);
    }

    favCache.set(videoId, { value, until: Date.now() + (value === null ? FAV_FAIL_MS : FAV_CACHE_MS) });
    if (favCache.size > 2000) favCache.delete(favCache.keys().next().value);

    return value;
}

function usernameFromShareUrl(url) {
    return typeof url === "string" ? url.match(/tiktok\.com\/@([a-zA-Z0-9._]{1,30})\//)?.[1] || null : null;
}

// -----------------------------------------------------
// Routes
// -----------------------------------------------------

// Pages et routes accessibles SANS connexion. Tout le reste
// du site exige d'être connecté avec TikTok.
const PUBLIC_PATHS = new Set([
    "/connexion.html", "/premium.css",
    "/confidentialite.html", "/conditions.html",
    "/test"
]);

function isPublicPath(path) {
    return (
        PUBLIC_PATHS.has(path) ||
        path.startsWith("/auth/") ||
        /^\/tiktok[A-Za-z0-9]{10,64}\.txt$/.test(path)
    );
}

module.exports = function mountTikTokAuth(app) {
    // Verrou global : à placer AVANT les autres routes.
    app.use((req, res, next) => {
        if (isPublicPath(req.path) || readSession(req)) return next();

        res.set("Cache-Control", "no-store");

        const wantsPage =
            req.method === "GET" &&
            (req.path === "/" || req.path.endsWith(".html"));

        if (wantsPage) {
            return res.redirect("/connexion.html");
        }

        return res.status(401).json({ error: "Connexion requise" });
    });

    // Session : lit le cookie, rafraîchit le jeton si besoin.
    async function requireSession(req, res, next) {
        const c = config(req);

        if (!c.ready) {
            return res.status(503).json({ error: "Connexion TikTok non configurée" });
        }

        const raw = readCookie(req, SESSION_COOKIE);
        let session = raw ? unseal(raw, c.secret) : null;

        if (!session || Date.now() >= session.refreshExpires) {
            clearCookie(req, res, SESSION_COOKIE);
            return res.status(401).json({ error: "Non connecté" });
        }

        if (Date.now() >= session.accessExpires) {
            try {
                session = await tokenRequest({
                    client_key: c.clientKey,
                    client_secret: c.clientSecret,
                    grant_type: "refresh_token",
                    refresh_token: session.refreshToken
                });

                setCookie(req, res, SESSION_COOKIE, seal(session, c.secret),
                    (session.refreshExpires - Date.now()) / 1000);
            } catch (error) {
                console.warn("[AUTH] Rafraîchissement échoué :", error.message);
                clearCookie(req, res, SESSION_COOKIE);
                return res.status(401).json({ error: "Session expirée, reconnecte-toi" });
            }
        }

        req.tiktok = session;
        res.set("Cache-Control", "no-store");
        next();
    }

    function apiError(req, res, error) {
        console.warn("[DISPLAY API]", error.code || "", error.message);

        // Jeton refusé par TikTok (accès révoqué, expiré…) : on
        // supprime le cookie, sinon la page de connexion croirait
        // encore l'utilisateur connecté (boucle de redirections).
        if (error.code === "access_token_invalid" || error.status === 401) {
            clearCookie(req, res, SESSION_COOKIE);
            return res.status(401).json({ error: "Session expirée, reconnecte-toi" });
        }

        if (error.code === "scope_not_authorized") {
            return res.status(403).json({ error: "Autorisation manquante : reconnecte-toi et accepte toutes les permissions" });
        }

        if (error.code === "rate_limit_exceeded") {
            return res.status(429).json({ error: "Trop de requêtes, réessaie dans un instant" });
        }

        return res.status(502).json({ error: error.message });
    }

    // Indique au front si la connexion est disponible.
    app.get("/auth/status", (req, res) => {
        res.set("Cache-Control", "no-store");
        res.json({
            enabled: config(req).ready,
            connected: Boolean(readSession(req))
        });
    });

    // 1) Départ vers TikTok
    app.get("/auth/tiktok", (req, res) => {
        const c = config(req);

        if (!c.ready) {
            return res.redirect("/connexion.html?erreur=config");
        }

        // Protection CSRF : valeur aléatoire vérifiée au retour.
        // (Pour une app web, TikTok n'exige pas de PKCE : le
        // client_secret reste côté serveur.)
        const state = crypto.randomBytes(24).toString("base64url");

        setCookie(req, res, STATE_COOKIE,
            seal({ state, t: Date.now() }, c.secret), 600);

        const url = new URL(AUTHORIZE_URL);
        url.searchParams.set("client_key", c.clientKey);
        url.searchParams.set("scope", SCOPES);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("redirect_uri", c.redirectUri);
        url.searchParams.set("state", state);

        res.redirect(url.href);
    });

    // 2) Retour de TikTok
    app.get("/auth/tiktok/callback", async (req, res) => {
        const c = config(req);
        const fail = reason => res.redirect(`/connexion.html?erreur=${reason}`);

        if (!c.ready) return fail("config");

        const raw = readCookie(req, STATE_COOKIE);
        const saved = raw ? unseal(raw, c.secret) : null;
        clearCookie(req, res, STATE_COOKIE);

        if (req.query.error) return fail("refus");

        const code = typeof req.query.code === "string" ? req.query.code : null;
        const state = typeof req.query.state === "string" ? req.query.state : "";

        if (
            !code || !saved || Date.now() - saved.t > 600000 ||
            state.length !== saved.state.length ||
            !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(saved.state))
        ) {
            return fail("state");
        }

        try {
            const session = await tokenRequest({
                client_key: c.clientKey,
                client_secret: c.clientSecret,
                code,
                grant_type: "authorization_code",
                redirect_uri: c.redirectUri
            });

            setCookie(req, res, SESSION_COOKIE, seal(session, c.secret),
                (session.refreshExpires - Date.now()) / 1000);

            console.log("[AUTH] Créateur connecté");
            res.redirect("/");
        } catch (error) {
            console.warn("[AUTH] Échange du code échoué :", error.message);
            fail("jeton");
        }
    });

    // 3) Déconnexion (révoque aussi l'accès chez TikTok)
    app.post("/auth/logout", async (req, res) => {
        const c = config(req);
        const raw = c.ready ? readCookie(req, SESSION_COOKIE) : null;
        const session = raw ? unseal(raw, c.secret) : null;

        clearCookie(req, res, SESSION_COOKIE);

        if (session) {
            fetch(`${API}/oauth/revoke/`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_key: c.clientKey,
                    client_secret: c.clientSecret,
                    token: session.accessToken
                }),
                signal: AbortSignal.timeout(TIMEOUT_MS)
            }).catch(() => {});
        }

        res.json({ success: true });
    });

    // Profil du créateur connecté
    app.get("/api/me", requireSession, async (req, res) => {
        try {
            const data = await cached(`user:${req.tiktok.openId}`, USER_CACHE_MS, () =>
                apiCall(req.tiktok, `/user/info/?fields=${USER_FIELDS}`));

            const u = data.user || {};
            const premium = await premiumStatus(req.tiktok.openId, u.username);

            res.json({
                premium,
                username: u.username || null,
                nickname: u.display_name || null,
                avatar: u.avatar_large_url || u.avatar_url || null,
                bio: u.bio_description || null,
                verified: Boolean(u.is_verified),
                followers: u.follower_count ?? null,
                following: u.following_count ?? null,
                likes: u.likes_count ?? null,
                videos: u.video_count ?? null
            });
        } catch (error) {
            apiError(req, res, error);
        }
    });

    // Liste de ses vidéos (paginée)
    app.get("/api/me/videos", requireSession, async (req, res) => {
        const cursor = /^\d{1,20}$/.test(req.query.cursor || "") ? Number(req.query.cursor) : undefined;
        // Nombre de vidéos demandées (1 à 20, 6 par défaut : les plus récentes).
        const limit = Math.min(20, Math.max(1, Number.parseInt(req.query.limit, 10) || 6));

        try {
            const data = await cached(`list:${req.tiktok.openId}:${cursor ?? 0}:${limit}`, LIST_CACHE_MS, () =>
                apiCall(req.tiktok, `/video/list/?fields=${VIDEO_FIELDS}`, {
                    method: "POST",
                    body: { max_count: limit, ...(cursor ? { cursor } : {}) }
                }));

            res.json({
                videos: (data.videos || []).map(cleanVideo),
                cursor: data.cursor ?? null,
                hasMore: Boolean(data.has_more)
            });
        } catch (error) {
            apiError(req, res, error);
        }
    });

    // Stats exactes d'une vidéo (suivi en direct)
    app.get("/api/me/video/:id", requireSession, async (req, res) => {
        const id = req.params.id;

        if (!/^\d{5,25}$/.test(id)) {
            return res.status(400).json({ error: "Identifiant invalide" });
        }

        try {
            const data = await cached(`video:${req.tiktok.openId}:${id}`, VIDEO_CACHE_MS, () =>
                apiCall(req.tiktok, `/video/query/?fields=${VIDEO_FIELDS}`, {
                    method: "POST",
                    body: { filters: { video_ids: [id] } }
                }));

            const video = data.videos?.[0];

            if (!video) {
                return res.status(404).json({ error: "Vidéo introuvable sur ce compte" });
            }

            const clean = cleanVideo(video);
            const username =
                usernameFromShareUrl(clean.shareUrl) ||
                cache.get(`user:${req.tiktok.openId}`)?.data?.user?.username;

            clean.favorites = await fetchFavorites(clean.id, username);

            res.json(clean);
        } catch (error) {
            apiError(req, res, error);
        }
    });

    setInterval(() => {
        const now = Date.now();

        for (const [k, item] of cache) {
            if (now - item.time > 5 * 60 * 1000) cache.delete(k);
        }
    }, 60000).unref();
};
