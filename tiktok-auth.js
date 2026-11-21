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
// Lecture mise en cache 1 min pour rester dans le quota gratuit.
// Sans Firestore (ex. en local), tout le monde est gratuit.
// =====================================================

const PREMIUM_CACHE_MS = 60 * 1000;
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
            // 1) Compte TikTok relié à un compte Google : premium du compte Google.
            const link = await store.collection("liensTiktok").doc(openId).get();

            if (link.exists) {
                const owner = await store.collection("comptes").doc(link.get("compte")).get();
                value = owner.exists && owner.get("premium") === true;
            } else {
                // 2) Sinon : ancienne fiche « utilisateurs » (premium activé à la main).
                const ref = store.collection("utilisateurs").doc(openId);
                const snap = await ref.get();

                if (snap.exists) {
                    value = snap.get("premium") === true;
                } else {
                    await ref.set({ pseudo: username || null, creeLe: new Date(), premium: false });
                }
            }
        } catch (error) {
            console.warn("Lecture premium impossible :", error.message);
        }
    }

    premiumCache.set(openId, { value, expires: Date.now() + PREMIUM_CACHE_MS });
    return value;
}

// =====================================================
// COMPTE GOOGLE (premium) + COMPTES TIKTOK RELIÉS
// -----------------------------------------------------
// Google n'est demandé que pour passer premium.
// comptes/{googleId}                 { email, nom, photo, premium, creeLe }
// comptes/{googleId}/tiktok/{openId} { pseudo, nom, avatar, jeton (chiffré), ajouteLe }
// liensTiktok/{openId}               { compte: googleId }  (un TikTok = un seul compte Google)
// Pour activer le premium : comptes/{googleId} → premium = true.
// =====================================================

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim() ||
    "792698279689-06tnp0anb1f27d6ii1761p21bhrmm5hq.apps.googleusercontent.com";
const GOOGLE_COOKIE = "tp_google";
const MAX_TIKTOK_FREE = 1;
const MAX_TIKTOK_PREMIUM = 5;

let googleVerifier;

async function verifyGoogleToken(credential) {
    if (!googleVerifier) {
        const { OAuth2Client } = require("google-auth-library");
        googleVerifier = new OAuth2Client(GOOGLE_CLIENT_ID);
    }

    const ticket = await googleVerifier.verifyIdToken({
        idToken: credential,
        audience: GOOGLE_CLIENT_ID
    });
    const p = ticket.getPayload();

    if (!p?.sub || !p.email_verified) throw new Error("Compte Google non vérifié");

    return { uid: p.sub, email: p.email, nom: p.name || null, photo: p.picture || null };
}

function readGoogle(req, secret) {
    const raw = readCookie(req, GOOGLE_COOKIE);
    const g = raw && secret ? unseal(raw, secret) : null;
    return g && g.uid ? g : null;
}

// Relie (ou met à jour) un compte TikTok au compte Google.
// Retourne un message lisible si c'est impossible, sinon null.
async function linkTikTok(store, uid, session, profile, secret) {
    const linkRef = store.collection("liensTiktok").doc(session.openId);
    const accountRef = store.collection("comptes").doc(uid);
    const tiktokRef = accountRef.collection("tiktok").doc(session.openId);

    return store.runTransaction(async t => {
        const [link, account, existing, all] = await Promise.all([
            t.get(linkRef), t.get(accountRef), t.get(tiktokRef), t.get(accountRef.collection("tiktok"))
        ]);

        if (link.exists && link.get("compte") !== uid) {
            return "Ce compte TikTok est déjà relié à un autre compte Google.";
        }

        if (!existing.exists) {
            const premium = account.exists && account.get("premium") === true;
            const max = premium ? MAX_TIKTOK_PREMIUM : MAX_TIKTOK_FREE;

            if (all.size >= max) {
                return premium
                    ? `Tu as atteint la limite de ${MAX_TIKTOK_PREMIUM} comptes TikTok.`
                    : "Passe au premium pour relier plusieurs comptes TikTok.";
            }
        }

        const old = existing.exists ? existing.data() : {};

        t.set(linkRef, { compte: uid });
        t.set(tiktokRef, {
            pseudo: profile?.username || old.pseudo || null,
            nom: profile?.display_name || old.nom || null,
            avatar: profile?.avatar_url || old.avatar || null,
            jeton: seal(session, secret),
            ajouteLe: old.ajouteLe || new Date(),
            majLe: new Date()
        });

        return null;
    });
}

// Garde le jeton stocké à jour (après un rafraîchissement).
async function updateStoredToken(session, secret) {
    const store = db();
    if (!store) return;

    try {
        const link = await store.collection("liensTiktok").doc(session.openId).get();
        if (!link.exists) return;

        await store.collection("comptes").doc(link.get("compte"))
            .collection("tiktok").doc(session.openId)
            .update({ jeton: seal(session, secret), majLe: new Date() });
    } catch (error) {
        console.warn("Mise à jour du jeton stocké impossible :", error.message);
    }
}

// Cookie Google à partir de la fiche du compte.
function googleFromAccount(uid, account) {
    return { uid, email: account.get("email") || null, nom: account.get("nom") || null, photo: account.get("photo") || null };
}

// Session TikTok stockée la plus récente et encore valide pour ce compte Google.
async function pickStoredSession(store, uid, secret) {
    const list = await store.collection("comptes").doc(uid).collection("tiktok").get();
    const docs = list.docs
        .map(d => ({ d, t: d.get("majLe")?.toMillis?.() || 0 }))
        .sort((a, b) => b.t - a.t);

    for (const { d } of docs) {
        const session = unseal(d.get("jeton"), secret);
        if (session && Date.now() < session.refreshExpires) return session;
    }

    return null;
}

// Crée ou met à jour la fiche du compte Google.
async function upsertGoogleAccount(store, google, legacyOpenId) {
    const accountRef = store.collection("comptes").doc(google.uid);
    const account = await accountRef.get();

    let legacyPremium = false;
    if (legacyOpenId) {
        const legacy = await store.collection("utilisateurs").doc(legacyOpenId).get();
        legacyPremium = legacy.exists && legacy.get("premium") === true;
    }

    await accountRef.set({
        email: google.email,
        nom: google.nom,
        photo: google.photo,
        derniereConnexion: new Date(),
        ...(account.exists ? {} : { creeLe: new Date(), premium: legacyPremium }),
        ...(account.exists && legacyPremium ? { premium: true } : {})
    }, { merge: true });
}

function revokeToken(c, accessToken) {
    return fetch(`${API}/oauth/revoke/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_key: c.clientKey, client_secret: c.clientSecret, token: accessToken }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    }).catch(() => {});
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
                updateStoredToken(session, c.secret);
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
            connected: Boolean(readSession(req)),
            google: Boolean(readGoogle(req, config(req).secret))
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

        // « Ajouter un compte TikTok » : forcer le choix du compte.
        if (req.query.ajout === "1") url.searchParams.set("disable_auto_auth", "1");

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

            // Connecté à Google : on relie ce compte TikTok au compte Google.
            const google = readGoogle(req, c.secret);
            const store = google ? db() : null;

            // Pas connecté à Google mais ce compte TikTok est relié : on restaure Google.
            if (!google && db()) {
                try {
                    const link = await db().collection("liensTiktok").doc(session.openId).get();
                    if (link.exists) {
                        const uid = link.get("compte");
                        const account = await db().collection("comptes").doc(uid).get();
                        if (account.exists) {
                            setCookie(req, res, GOOGLE_COOKIE, seal(googleFromAccount(uid, account), c.secret), 365 * 86400);
                            updateStoredToken(session, c.secret);
                        }
                    }
                } catch (error) {
                    console.warn("[COMPTES] Restauration Google impossible :", error.message);
                }
            }

            if (store) {
                try {
                    const profile = (await apiCall(session, "/user/info/?fields=open_id,username,display_name,avatar_url")).user;
                    const problem = await linkTikTok(store, google.uid, session, profile, c.secret);
                    premiumCache.delete(session.openId);
                    if (problem) return res.redirect("/?info=" + encodeURIComponent(problem));
                } catch (error) {
                    console.warn("[COMPTES] Liaison impossible :", error.message);
                }
            }

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
        clearCookie(req, res, GOOGLE_COOKIE);

        // Compte relié à un compte Google : on garde l'accès (sélecteur de comptes).
        let linked = false;
        if (session && db()) {
            try { linked = (await db().collection("liensTiktok").doc(session.openId).get()).exists; }
            catch { /* on révoque par prudence */ }
        }

        if (session && !linked) {
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

    // ---------- Compte Google (premium) ----------

    app.get("/auth/google/config", (req, res) => {
        res.json({ clientId: GOOGLE_CLIENT_ID });
    });

    // Connexion directe avec Google (page de connexion).
    // → s'il a un compte TikTok relié : connecté directement ;
    // → sinon : il doit connecter un compte TikTok (relié automatiquement).
    app.post("/auth/google/login", async (req, res) => {
        const c = config(req);
        const store = db();
        const credential = typeof req.body?.credential === "string" ? req.body.credential : "";

        res.set("Cache-Control", "no-store");
        if (!c.ready || !store) return res.status(503).json({ error: "Connexion indisponible pour le moment" });
        if (!credential) return res.status(400).json({ error: "Jeton Google manquant" });

        let google;
        try {
            google = await verifyGoogleToken(credential);
        } catch (error) {
            console.warn("[GOOGLE] Jeton refusé :", error.message);
            return res.status(401).json({ error: "Connexion Google refusée" });
        }

        try {
            await upsertGoogleAccount(store, google, null);
            setCookie(req, res, GOOGLE_COOKIE, seal(google, c.secret), 365 * 86400);

            const session = await pickStoredSession(store, google.uid, c.secret);
            if (session) {
                setCookie(req, res, SESSION_COOKIE, seal(session, c.secret),
                    (session.refreshExpires - Date.now()) / 1000);
                return res.json({ next: "/" });
            }

            res.json({ next: "/auth/tiktok", needTikTok: true });
        } catch (error) {
            console.warn("[GOOGLE] Connexion impossible :", error.message);
            res.status(500).json({ error: "Connexion impossible, réessaie" });
        }
    });

    // Déjà connecté à Google (cookie) mais plus à TikTok : on reprend le dernier compte relié.
    app.post("/auth/google/resume", async (req, res) => {
        const c = config(req);
        const google = c.ready ? readGoogle(req, c.secret) : null;
        const store = db();

        res.set("Cache-Control", "no-store");
        if (!google || !store) return res.json({ next: null });

        try {
            const session = await pickStoredSession(store, google.uid, c.secret);
            if (!session) return res.json({ next: "/auth/tiktok", needTikTok: true });

            setCookie(req, res, SESSION_COOKIE, seal(session, c.secret),
                (session.refreshExpires - Date.now()) / 1000);
            res.json({ next: "/" });
        } catch (error) {
            console.warn("[GOOGLE] Reprise impossible :", error.message);
            res.json({ next: null });
        }
    });

    // Connexion Google (« Sign in with Google ») + liaison du compte TikTok actuel.
    app.post("/auth/google", requireSession, async (req, res) => {
        const c = config(req);
        const store = db();
        const credential = typeof req.body?.credential === "string" ? req.body.credential : "";

        if (!store) return res.status(503).json({ error: "Base de données indisponible" });
        if (!credential) return res.status(400).json({ error: "Jeton Google manquant" });

        let google;
        try {
            google = await verifyGoogleToken(credential);
        } catch (error) {
            console.warn("[GOOGLE] Jeton refusé :", error.message);
            return res.status(401).json({ error: "Connexion Google refusée" });
        }

        try {
            // Premium déjà activé à la main sur l'ancienne fiche : transféré au compte Google.
            await upsertGoogleAccount(store, google, req.tiktok.openId);

            const profile = (await cached(`user:${req.tiktok.openId}`, USER_CACHE_MS, () =>
                apiCall(req.tiktok, `/user/info/?fields=${USER_FIELDS}`))).user;
            const problem = await linkTikTok(store, google.uid, req.tiktok, profile, c.secret);

            premiumCache.delete(req.tiktok.openId);
            setCookie(req, res, GOOGLE_COOKIE, seal(google, c.secret), 365 * 86400);
            res.json({ success: true, warning: problem });
        } catch (error) {
            console.warn("[GOOGLE] Création du compte impossible :", error.message);
            res.status(500).json({ error: "Impossible de créer le compte, réessaie" });
        }
    });

    app.post("/auth/google/logout", (req, res) => {
        clearCookie(req, res, GOOGLE_COOKIE);
        res.json({ success: true });
    });

    // Compte Google + comptes TikTok reliés (pour le sélecteur).
    app.get("/api/comptes", requireSession, async (req, res) => {
        const c = config(req);
        const google = readGoogle(req, c.secret);
        const store = db();

        if (!google || !store) return res.json({ google: null, comptes: [] });

        try {
            const accountRef = store.collection("comptes").doc(google.uid);
            const [account, list] = await Promise.all([accountRef.get(), accountRef.collection("tiktok").get()]);

            if (!account.exists) {
                clearCookie(req, res, GOOGLE_COOKIE);
                return res.json({ google: null, comptes: [] });
            }

            const premium = account.get("premium") === true;
            res.json({
                google: { email: account.get("email"), nom: account.get("nom"), photo: account.get("photo"), premium },
                max: premium ? MAX_TIKTOK_PREMIUM : MAX_TIKTOK_FREE,
                comptes: list.docs.map(d => ({
                    openId: d.id,
                    pseudo: d.get("pseudo"),
                    nom: d.get("nom"),
                    avatar: d.get("avatar"),
                    actif: d.id === req.tiktok.openId
                }))
            });
        } catch (error) {
            console.warn("[COMPTES]", error.message);
            res.status(500).json({ error: "Comptes indisponibles" });
        }
    });

    // Passer sur un autre compte TikTok relié, sans se reconnecter.
    app.post("/auth/switch", requireSession, async (req, res) => {
        const c = config(req);
        const google = readGoogle(req, c.secret);
        const openId = typeof req.body?.openId === "string" ? req.body.openId : "";
        const store = db();

        if (!google || !store || !openId) return res.status(400).json({ error: "Changement impossible" });

        try {
            const doc = await store.collection("comptes").doc(google.uid).collection("tiktok").doc(openId).get();
            const session = doc.exists ? unseal(doc.get("jeton"), c.secret) : null;

            if (!session || Date.now() >= session.refreshExpires) {
                return res.status(409).json({ error: "Ce compte doit être reconnecté", reconnect: true });
            }

            setCookie(req, res, SESSION_COOKIE, seal(session, c.secret),
                (session.refreshExpires - Date.now()) / 1000);
            res.json({ success: true });
        } catch (error) {
            console.warn("[COMPTES] Changement impossible :", error.message);
            res.status(500).json({ error: "Changement impossible" });
        }
    });

    // Délier un compte TikTok (pas celui en cours d'utilisation).
    app.post("/api/comptes/delier", requireSession, async (req, res) => {
        const c = config(req);
        const google = readGoogle(req, c.secret);
        const openId = typeof req.body?.openId === "string" ? req.body.openId : "";
        const store = db();

        if (!google || !store || !openId || openId === req.tiktok.openId) {
            return res.status(400).json({ error: "Impossible de délier ce compte" });
        }

        try {
            const ref = store.collection("comptes").doc(google.uid).collection("tiktok").doc(openId);
            const doc = await ref.get();
            if (!doc.exists) return res.status(404).json({ error: "Compte introuvable" });

            const s = unseal(doc.get("jeton"), c.secret);
            if (s) revokeToken(c, s.accessToken);

            await Promise.all([ref.delete(), store.collection("liensTiktok").doc(openId).delete()]);
            premiumCache.delete(openId);
            res.json({ success: true });
        } catch (error) {
            console.warn("[COMPTES] Déliaison impossible :", error.message);
            res.status(500).json({ error: "Impossible de délier ce compte" });
        }
    });

    // Supprimer le compte TikTok Pulse (compte Google + liaisons + jetons stockés).
    app.post("/api/compte/supprimer", requireSession, async (req, res) => {
        const c = config(req);
        const google = readGoogle(req, c.secret);
        const store = db();

        if (!google || !store) return res.status(400).json({ error: "Aucun compte à supprimer" });

        try {
            const accountRef = store.collection("comptes").doc(google.uid);
            const list = await accountRef.collection("tiktok").get();
            const batch = store.batch();

            for (const d of list.docs) {
                const s = unseal(d.get("jeton"), c.secret);
                if (s && d.id !== req.tiktok.openId) revokeToken(c, s.accessToken);
                batch.delete(d.ref);
                batch.delete(store.collection("liensTiktok").doc(d.id));
                premiumCache.delete(d.id);
            }

            batch.delete(accountRef);
            batch.delete(store.collection("utilisateurs").doc(req.tiktok.openId));
            await batch.commit();

            clearCookie(req, res, GOOGLE_COOKIE);
            res.json({ success: true });
        } catch (error) {
            console.warn("[COMPTES] Suppression impossible :", error.message);
            res.status(500).json({ error: "Suppression impossible, réessaie" });
        }
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
