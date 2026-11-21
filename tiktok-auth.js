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
const createYouTube = require("./youtube");

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
        const [link, account, existing, all, yall] = await Promise.all([
            t.get(linkRef), t.get(accountRef), t.get(tiktokRef), t.get(accountRef.collection("tiktok")), t.get(accountRef.collection("youtube"))
        ]);

        if (link.exists && link.get("compte") !== uid) {
            return "Ce compte TikTok est déjà relié à un autre compte Google.";
        }

        if (!existing.exists) {
            const premium = account.exists && account.get("premium") === true;
            const max = premium ? MAX_TIKTOK_PREMIUM : MAX_TIKTOK_FREE;

            if (all.size + yall.size >= max) {
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
    "/connexion.html", "/premium.css", "/pulse-ui.js", "/relier.html",
    "/confidentialite.html", "/conditions.html",
    "/test"
]);

function isPublicPath(path) {
    return (
        PUBLIC_PATHS.has(path) ||
        path.startsWith("/auth/") ||
        /^\/tiktok[A-Za-z0-9]{10,64}\.txt$/.test(path) ||
        /^\/google[0-9a-f]{16}\.html$/.test(path)
    );
}

module.exports = function mountTikTokAuth(app) {
    const youtube = createYouTube({
        config, seal, unseal, readCookie, setCookie, clearCookie, db, readGoogle, cached, cache,
        TIMEOUT_MS, GOOGLE_CLIENT_ID
    });

    // Compte YouTube affiché (cookie) + compte Google connecté.
    function youtubeShown(req) {
        const c = config(req);
        if (!c.secret) return false;
        const a = youtube.readActive(req, c.secret);
        return Boolean(a?.p === "youtube" && readGoogle(req, c.secret));
    }

    // Verrou global : à placer AVANT les autres routes.
    app.use((req, res, next) => {
        if (isPublicPath(req.path) || readSession(req) || youtubeShown(req)) return next();

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
            connected: Boolean(readSession(req) || youtubeShown(req)),
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
            youtube.clearActive(req, res);

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
        youtube.clearActive(req, res);

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

    // ---------- Compte Google (premium) + comptes reliés (TikTok, YouTube) ----------

    const maxFor = premium => (premium ? MAX_TIKTOK_PREMIUM : MAX_TIKTOK_FREE);

    async function countAll(store, uid) {
        const ref = store.collection("comptes").doc(uid);
        const [t, y] = await Promise.all([ref.collection("tiktok").get(), ref.collection("youtube").get()]);
        return t.size + y.size;
    }

    youtube.mountRoutes(app, { maxFor, countAll });

    // Affiche un compte relié (TikTok le plus récent, sinon YouTube) ; sinon page « Relier un compte ».
    async function activateAny(req, res, store, uid, secret) {
        const session = await pickStoredSession(store, uid, secret);
        if (session) {
            setCookie(req, res, SESSION_COOKIE, seal(session, secret), (session.refreshExpires - Date.now()) / 1000);
            youtube.clearActive(req, res);
            return "/";
        }

        const yts = await youtube.list(store, uid);
        if (yts.length) {
            clearCookie(req, res, SESSION_COOKIE);
            youtube.setActive(req, res, secret, "youtube", yts[0].id);
            return "/";
        }

        clearCookie(req, res, SESSION_COOKIE);
        youtube.clearActive(req, res);
        return "/relier.html";
    }

    async function googlePremium(uid) {
        const k = "g:" + uid;
        const hit = premiumCache.get(k);
        if (hit && hit.expires > Date.now()) return hit.value;

        let value = false;
        try {
            const a = await db()?.collection("comptes").doc(uid).get();
            value = Boolean(a?.exists && a.get("premium") === true);
        } catch (error) {
            console.warn("Lecture premium impossible :", error.message);
        }
        premiumCache.set(k, { value, expires: Date.now() + PREMIUM_CACHE_MS });
        return value;
    }

    // Compte affiché : YouTube (cookie tp_active) ou TikTok (session).
    async function requireAccount(req, res, next) {
        const yt = await youtube.sessionFor(req, res);

        if (yt && !yt.error) {
            req.youtube = yt;
            res.set("Cache-Control", "no-store");
            return next();
        }

        if (yt?.error) {
            if (!readSession(req)) return res.status(401).json({ error: "Reconnecte ton compte YouTube" });
            youtube.clearActive(req, res);
        }

        return requireSession(req, res, next);
    }

    function ytError(res, error) {
        console.warn("[YOUTUBE API]", error.status || "", error.reason || "", error.message);
        if (error.status === 401) return res.status(401).json({ error: "Reconnecte ton compte YouTube" });
        if (error.reason === "quotaExceeded") return res.status(429).json({ error: "Quota YouTube du jour atteint, réessaie plus tard" });
        if (error.status === 404) return res.status(404).json({ error: error.message });
        return res.status(502).json({ error: error.message });
    }

    app.get("/auth/google/config", (req, res) => {
        res.json({ clientId: GOOGLE_CLIENT_ID, youtube: youtube.ready() });
    });

    // Connexion directe avec Google (page de connexion).
    // → s'il a un compte relié : connecté directement ;
    // → sinon : page « Relier un compte ».
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
            const next = await activateAny(req, res, store, google.uid, c.secret);
            res.json({ next, needTikTok: next === "/relier.html" });
        } catch (error) {
            console.warn("[GOOGLE] Connexion impossible :", error.message);
            res.status(500).json({ error: "Connexion impossible, réessaie" });
        }
    });

    // Compte Google connecté (cookie), sans exiger d'autre session : page « Relier un compte ».
    app.get("/auth/google/me", async (req, res) => {
        const c = config(req);
        const google = c.ready ? readGoogle(req, c.secret) : null;
        const store = db();

        res.set("Cache-Control", "no-store");
        if (!google || !store) return res.json({ google: null });

        try {
            const account = await store.collection("comptes").doc(google.uid).get();
            if (!account.exists) { clearCookie(req, res, GOOGLE_COOKIE); return res.json({ google: null }); }

            const premium = account.get("premium") === true;
            res.json({
                google: { email: account.get("email"), nom: account.get("nom"), photo: account.get("photo"), premium },
                count: await countAll(store, google.uid),
                max: maxFor(premium),
                youtube: youtube.ready()
            });
        } catch (error) {
            console.warn("[GOOGLE] Lecture du compte impossible :", error.message);
            res.json({ google: null });
        }
    });

    // Déjà connecté à Google (cookie) mais sans compte affiché : on reprend un compte relié.
    app.post("/auth/google/resume", async (req, res) => {
        const c = config(req);
        const google = c.ready ? readGoogle(req, c.secret) : null;
        const store = db();

        res.set("Cache-Control", "no-store");
        if (!google || !store) return res.json({ next: null });

        try {
            const next = await activateAny(req, res, store, google.uid, c.secret);
            res.json({ next, needTikTok: next === "/relier.html" });
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
            premiumCache.delete("g:" + google.uid);
            setCookie(req, res, GOOGLE_COOKIE, seal(google, c.secret), 365 * 86400);
            res.json({ success: true, warning: problem });
        } catch (error) {
            console.warn("[GOOGLE] Création du compte impossible :", error.message);
            res.status(500).json({ error: "Impossible de créer le compte, réessaie" });
        }
    });

    app.post("/auth/google/logout", (req, res) => {
        clearCookie(req, res, GOOGLE_COOKIE);
        youtube.clearActive(req, res);
        res.json({ success: true });
    });

    // Compte Google + comptes reliés (sélecteur, onglet Compte).
    app.get("/api/comptes", requireAccount, async (req, res) => {
        const c = config(req);
        const google = readGoogle(req, c.secret);
        const store = db();

        if (!google || !store) return res.json({ google: null, comptes: [] });

        try {
            const accountRef = store.collection("comptes").doc(google.uid);
            const [account, tk, yts] = await Promise.all([
                accountRef.get(), accountRef.collection("tiktok").get(), youtube.list(store, google.uid)
            ]);

            if (!account.exists) {
                clearCookie(req, res, GOOGLE_COOKIE);
                return res.json({ google: null, comptes: [] });
            }

            const premium = account.get("premium") === true;
            const activeYt = req.youtube?.channelId || null;
            const activeTk = req.tiktok?.openId || null;

            res.json({
                google: { email: account.get("email"), nom: account.get("nom"), photo: account.get("photo"), premium },
                max: maxFor(premium),
                youtube: youtube.ready(),
                comptes: [
                    ...tk.docs.map(d => ({
                        platform: "tiktok", id: d.id, openId: d.id,
                        pseudo: d.get("pseudo"), nom: d.get("nom"), avatar: d.get("avatar"),
                        actif: !activeYt && d.id === activeTk
                    })),
                    ...yts.map(d => ({
                        platform: "youtube", id: d.id,
                        pseudo: d.get("pseudo"), nom: d.get("nom"), avatar: d.get("avatar"),
                        actif: d.id === activeYt
                    }))
                ]
            });
        } catch (error) {
            console.warn("[COMPTES]", error.message);
            res.status(500).json({ error: "Comptes indisponibles" });
        }
    });

    function target(req) {
        const b = req.body || {};
        const platform = b.platform === "youtube" ? "youtube" : "tiktok";
        const id = typeof b.id === "string" ? b.id : typeof b.openId === "string" ? b.openId : "";
        return { platform, id };
    }

    // Passer sur un autre compte relié, sans se reconnecter (premium).
    app.post("/auth/switch", async (req, res) => {
        const c = config(req);
        const google = c.ready ? readGoogle(req, c.secret) : null;
        const { platform, id } = target(req);
        const store = db();

        res.set("Cache-Control", "no-store");
        if (!google || !store || !id) return res.status(400).json({ error: "Changement impossible" });

        try {
            const accountRef = store.collection("comptes").doc(google.uid);
            const account = await accountRef.get();
            if (!account.exists || account.get("premium") !== true) {
                return res.status(403).json({ error: "Le premium permet de passer d'un compte à l'autre" });
            }

            if (platform === "youtube") {
                const doc = await accountRef.collection("youtube").doc(id).get();
                if (!doc.exists) return res.status(404).json({ error: "Compte introuvable" });
                youtube.setActive(req, res, c.secret, "youtube", id);
                return res.json({ success: true });
            }

            const doc = await accountRef.collection("tiktok").doc(id).get();
            const session = doc.exists ? unseal(doc.get("jeton"), c.secret) : null;

            if (!session || Date.now() >= session.refreshExpires) {
                return res.status(409).json({ error: "Ce compte doit être reconnecté", reconnect: true });
            }

            setCookie(req, res, SESSION_COOKIE, seal(session, c.secret),
                (session.refreshExpires - Date.now()) / 1000);
            youtube.clearActive(req, res);
            res.json({ success: true });
        } catch (error) {
            console.warn("[COMPTES] Changement impossible :", error.message);
            res.status(500).json({ error: "Changement impossible" });
        }
    });

    // Délier un compte (premium ou non, compte Google requis).
    // Si c'est le compte affiché : on bascule sur un autre compte relié,
    // ou, s'il n'en reste aucun, on renvoie vers « Relier un compte ».
    app.post("/api/comptes/delier", async (req, res) => {
        const c = config(req);
        const google = c.ready ? readGoogle(req, c.secret) : null;
        const { platform, id } = target(req);
        const store = db();

        res.set("Cache-Control", "no-store");
        if (!google || !store || !id) {
            return res.status(400).json({ error: "Connecte ton compte Google pour gérer tes comptes reliés" });
        }

        const active = youtube.readActive(req, c.secret);
        const activeYt = active?.p === "youtube" ? active.id : null;
        const currentTk = readSession(req)?.openId || null;

        try {
            let wasShown = false;

            if (platform === "youtube") {
                if (!(await youtube.unlink(store, google.uid, id, c.secret))) return res.status(404).json({ error: "Compte introuvable" });
                wasShown = activeYt === id;
            } else {
                const ref = store.collection("comptes").doc(google.uid).collection("tiktok").doc(id);
                const doc = await ref.get();
                if (!doc.exists) return res.status(404).json({ error: "Compte introuvable" });

                const s = unseal(doc.get("jeton"), c.secret);
                if (s) revokeToken(c, s.accessToken);

                await Promise.all([
                    ref.delete(),
                    store.collection("liensTiktok").doc(id).delete(),
                    store.collection("utilisateurs").doc(id).delete()
                ]);
                premiumCache.delete(id);
                wasShown = !activeYt && id === currentTk;
                if (id === currentTk) clearCookie(req, res, SESSION_COOKIE);
            }

            if (!wasShown) return res.json({ success: true, next: null });
            res.json({ success: true, next: await activateAny(req, res, store, google.uid, c.secret) });
        } catch (error) {
            console.warn("[COMPTES] Déliaison impossible :", error.message);
            res.status(500).json({ error: "Impossible de délier ce compte" });
        }
    });

    // Supprimer le compte TikTok Pulse : tout est effacé et l'utilisateur est déconnecté.
    app.post("/api/compte/supprimer", requireAccount, async (req, res) => {
        const c = config(req);
        const google = readGoogle(req, c.secret);
        const store = db();
        const currentTk = req.tiktok?.openId || null;

        if (!store) return res.status(503).json({ error: "Base de données indisponible" });

        const logoutAll = () => {
            if (req.tiktok) revokeToken(c, req.tiktok.accessToken);
            clearCookie(req, res, GOOGLE_COOKIE);
            clearCookie(req, res, SESSION_COOKIE);
            youtube.clearActive(req, res);
        };

        // Sans compte Google : on efface la fiche TikTok et on déconnecte.
        if (!google) {
            try {
                if (currentTk) {
                    await store.collection("utilisateurs").doc(currentTk).delete();
                    premiumCache.delete(currentTk);
                    for (const k of [...cache.keys()]) if (k.includes(currentTk)) cache.delete(k);
                }
                logoutAll();
                return res.json({ success: true, next: "/connexion.html" });
            } catch (error) {
                console.warn("[COMPTES] Suppression impossible :", error.message);
                return res.status(500).json({ error: "Suppression impossible, réessaie" });
            }
        }

        try {
            const accountRef = store.collection("comptes").doc(google.uid);
            const account = await accountRef.get();

            // Abonnement premium en cours : il faut d'abord le résilier (ou attendre sa fin).
            if (account.exists && account.get("premium") === true) {
                return res.status(409).json({ error: "Le premium est actif : résilie-le ou attends la fin de la période en cours pour supprimer ton compte." });
            }

            // YouTube : accès révoqués, chaînes déliées.
            for (const d of await youtube.list(store, google.uid)) {
                await youtube.unlink(store, google.uid, d.id, c.secret);
            }

            // TikTok : comptes reliés, fiches et jetons (révoqués).
            const list = await accountRef.collection("tiktok").get();
            const batch = store.batch();
            const ids = new Set(currentTk ? [currentTk] : []);

            for (const d of list.docs) {
                const s = unseal(d.get("jeton"), c.secret);
                if (s && d.id !== currentTk) revokeToken(c, s.accessToken);
                batch.delete(d.ref);
                batch.delete(store.collection("liensTiktok").doc(d.id));
                ids.add(d.id);
            }
            for (const id of ids) {
                batch.delete(store.collection("utilisateurs").doc(id));
                premiumCache.delete(id);
                for (const k of [...cache.keys()]) if (k.includes(id)) cache.delete(k);
            }

            batch.delete(accountRef);
            await batch.commit();
            premiumCache.delete("g:" + google.uid);

            logoutAll();
            res.json({ success: true, next: "/connexion.html" });
        } catch (error) {
            console.warn("[COMPTES] Suppression impossible :", error.message);
            res.status(500).json({ error: "Suppression impossible, réessaie" });
        }
    });

    // Profil du créateur connecté
    app.get("/api/me", requireAccount, async (req, res) => {
        if (req.youtube) {
            try { return res.json({ ...(await youtube.me(req.youtube)), premium: await googlePremium(req.youtube.uid) }); }
            catch (error) { return ytError(res, error); }
        }

        try {
            const data = await cached(`user:${req.tiktok.openId}`, USER_CACHE_MS, () =>
                apiCall(req.tiktok, `/user/info/?fields=${USER_FIELDS}`));

            const u = data.user || {};
            const premium = await premiumStatus(req.tiktok.openId, u.username);

            res.json({
                platform: "tiktok",
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
    app.get("/api/me/videos", requireAccount, async (req, res) => {
        if (req.youtube) {
            const limit = Math.min(20, Math.max(1, Number.parseInt(req.query.limit, 10) || 6));
            const cursor = /^[A-Za-z0-9_-]{1,120}$/.test(req.query.cursor || "") ? req.query.cursor : null;
            try { return res.json(await youtube.videos(req.youtube, limit, cursor)); }
            catch (error) { return ytError(res, error); }
        }

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
    app.get("/api/me/video/:id", requireAccount, async (req, res) => {
        const id = req.params.id;

        if (req.youtube) {
            if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return res.status(400).json({ error: "Identifiant invalide" });
            try {
                const v = await youtube.video(req.youtube, id);
                return v ? res.json(v) : res.status(404).json({ error: "Vidéo introuvable sur cette chaîne" });
            } catch (error) { return ytError(res, error); }
        }

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
