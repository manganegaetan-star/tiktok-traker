
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());

// ==============================
// CONFIGURATION
// ==============================

const PORT = Number(process.env.PORT || 3000);

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const TIKTOK_REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI;

// Protection de la route qui lance la connexion TikTok
const ADMIN_AUTH_KEY = process.env.ADMIN_AUTH_KEY;

// Répertoire privé pour les tokens
const DATA_DIR = path.resolve(
    process.env.PRIVATE_DATA_DIR ||
    path.join(__dirname, "..", "tiktok-pulse-private")
);

const TOKEN_FILE = path.join(DATA_DIR, "tiktok-tokens.json");

const cache = new Map();
const pendingStates = new Map();

const CACHE_DURATION = 20000;

// ==============================
// STOCKAGE DES TOKENS
// ==============================

function saveTokens(tokens) {
    fs.mkdirSync(DATA_DIR, {
        recursive: true,
        mode: 0o700
    });

    fs.writeFileSync(
        TOKEN_FILE,
        JSON.stringify(tokens, null, 2),
        { mode: 0o600 }
    );
}

function loadTokens() {
    try {
        return JSON.parse(
            fs.readFileSync(TOKEN_FILE, "utf8")
        );
    } catch {
        return null;
    }
}

let tiktokTokens = loadTokens();

function updateTokens(json, previous = {}) {
    const now = Date.now();

    const tokens = {
        access_token: json.access_token,
        refresh_token:
            json.refresh_token ||
            previous.refresh_token,
        open_id: json.open_id || previous.open_id,
        scope: json.scope || previous.scope,
        access_expires_at:
            now + Number(json.expires_in || 86400) * 1000,
        refresh_expires_at:
            now + Number(json.refresh_expires_in || 31536000) * 1000
    };

    saveTokens(tokens);
    tiktokTokens = tokens;

    return tokens;
}

// ==============================
// OUTILS
// ==============================

function getCached(key) {
    const item = cache.get(key);

    if (
        item &&
        Date.now() - item.time < CACHE_DURATION
    ) {
        return item.data;
    }

    return null;
}

function setCached(key, data) {
    cache.set(key, {
        data,
        time: Date.now()
    });
}

function extractTikTokId(url) {
    try {
        const parsed = new URL(url);

        if (
            parsed.hostname !== "tiktok.com" &&
            !parsed.hostname.endsWith(".tiktok.com")
        ) {
            return null;
        }

        return parsed.pathname.match(/\/video\/(\d+)/)?.[1] || null;
    } catch {
        return null;
    }
}

function extractYouTubeId(url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();

        if (
            host === "youtu.be" ||
            host === "www.youtu.be"
        ) {
            const id = parsed.pathname.split("/")[1];

            return /^[\w-]{11}$/.test(id) ? id : null;
        }

        if (
            host === "youtube.com" ||
            host === "www.youtube.com" ||
            host === "m.youtube.com"
        ) {
            const match = parsed.pathname.match(
                /^\/(?:shorts|embed|live)\/([\w-]{11})/
            );

            const id = match?.[1] ||
                parsed.searchParams.get("v");

            return /^[\w-]{11}$/.test(id || "")
                ? id
                : null;
        }

        return null;
    } catch {
        return null;
    }
}

function detectPlatform(url) {
    if (extractTikTokId(url)) return "tiktok";
    if (extractYouTubeId(url)) return "youtube";

    return null;
}

async function readJson(response) {
    const text = await response.text();

    try {
        return JSON.parse(text);
    } catch {
        throw new Error(
            `Réponse JSON invalide (HTTP ${response.status})`
        );
    }
}

// ==============================
// TIKTOK OAUTH : CONNEXION
// ==============================

app.get("/auth/tiktok", (req, res) => {
    if (
        !ADMIN_AUTH_KEY ||
        req.query.key !== ADMIN_AUTH_KEY
    ) {
        return res.status(403).send(
            "Accès administrateur refusé."
        );
    }

    if (
        !TIKTOK_CLIENT_KEY ||
        !TIKTOK_CLIENT_SECRET ||
        !TIKTOK_REDIRECT_URI
    ) {
        return res.status(500).send(
            "Configuration TikTok incomplète."
        );
    }

    const state = crypto.randomBytes(32).toString("hex");

    pendingStates.set(state, Date.now() + 600000);

    const params = new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        response_type: "code",
        scope: "user.info.basic,video.list",
        redirect_uri: TIKTOK_REDIRECT_URI,
        state
    });

    res.redirect(
        "https://www.tiktok.com/v2/auth/authorize/?" +
        params.toString()
    );
});

// ==============================
// TIKTOK OAUTH : CALLBACK
// ==============================

app.get("/auth/tiktok/callback", async (req, res) => {
    const { code, state, error, error_description } = req.query;

    if (error) {
        return res.status(400).send(
            "Autorisation TikTok refusée : " +
            String(error_description || error)
        );
    }

    const expiresAt = pendingStates.get(state);

    if (!state || !expiresAt || Date.now() > expiresAt) {
        return res.status(403).send(
            "État OAuth invalide ou expiré."
        );
    }

    pendingStates.delete(state);

    if (!code) {
        return res.status(400).send(
            "Code d'autorisation TikTok manquant."
        );
    }

    try {
        const body = new URLSearchParams({
            client_key: TIKTOK_CLIENT_KEY,
            client_secret: TIKTOK_CLIENT_SECRET,
            code: String(code),
            grant_type: "authorization_code",
            redirect_uri: TIKTOK_REDIRECT_URI
        });

        const response = await fetch(
            "https://open.tiktokapis.com/v2/oauth/token/",
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/x-www-form-urlencoded"
                },
                body,
                signal: AbortSignal.timeout(15000)
            }
        );

        const json = await readJson(response);

        if (!response.ok || !json.access_token) {
            throw new Error(
                json.error_description ||
                json.message ||
                json.error ||
                "Échange du code OAuth impossible"
            );
        }

        updateTokens(json);
        cache.clear();

        console.log("Compte TikTok connecté.");

        res.send(`
            <!DOCTYPE html>
            <html lang="fr">
            <head>
                <meta charset="UTF-8">
                <title>TikTok connecté</title>
            </head>
            <body>
                <h1>Compte TikTok connecté !</h1>
                <p>Tu peux retourner sur TikTok Pulse.</p>
            </body>
            </html>
        `);

    } catch (err) {
        console.error("Erreur callback TikTok :", err.message);

        res.status(500).send(
            "Erreur de connexion TikTok : " + err.message
        );
    }
});

// ==============================
// TIKTOK : RENOUVELLEMENT TOKEN
// ==============================

let refreshPromise = null;

async function refreshTikTokToken() {
    if (!tiktokTokens?.refresh_token) {
        throw new Error(
            "Compte TikTok non connecté. Utilise /auth/tiktok."
        );
    }

    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
        const body = new URLSearchParams({
            client_key: TIKTOK_CLIENT_KEY,
            client_secret: TIKTOK_CLIENT_SECRET,
            grant_type: "refresh_token",
            refresh_token: tiktokTokens.refresh_token
        });

        const response = await fetch(
            "https://open.tiktokapis.com/v2/oauth/token/",
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/x-www-form-urlencoded"
                },
                body,
                signal: AbortSignal.timeout(15000)
            }
        );

        const json = await readJson(response);

        if (!response.ok || !json.access_token) {
            throw new Error(
                json.error_description ||
                json.message ||
                json.error ||
                "Renouvellement TikTok impossible"
            );
        }

        updateTokens(json, tiktokTokens);

        console.log("Token TikTok renouvelé.");

        return tiktokTokens.access_token;
    })();

    try {
        return await refreshPromise;
    } finally {
        refreshPromise = null;
    }
}

async function getTikTokAccessToken() {
    if (!tiktokTokens?.access_token) {
        throw new Error(
            "Compte TikTok non connecté."
        );
    }

    // Renouvellement 5 minutes avant expiration
    if (
        Date.now() >=
        tiktokTokens.access_expires_at - 300000
    ) {
        return refreshTikTokToken();
    }

    return tiktokTokens.access_token;
}

// ==============================
// TIKTOK : STATISTIQUES OFFICIELLES
// ==============================

async function getTikTokStats(url) {
    const videoId = extractTikTokId(url);

    if (!videoId) {
        return {
            platform: "tiktok",
            views: null,
            likes: null,
            shares: null,
            comments: null,
            title: "Lien TikTok invalide",
            error: "ID vidéo introuvable"
        };
    }

    const cacheKey = `tiktok:${videoId}`;
    const cached = getCached(cacheKey);

    if (cached) return cached;

    try {
        const accessToken = await getTikTokAccessToken();

        const fields = [
            "id",
            "title",
            "video_description",
            "create_time",
            "view_count",
            "like_count",
            "comment_count",
            "share_count"
        ].join(",");

        const endpoint =
            "https://open.tiktokapis.com/v2/video/query/" +
            "?fields=" + encodeURIComponent(fields);

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                filters: {
                    video_ids: [videoId]
                }
            }),
            signal: AbortSignal.timeout(15000)
        });

        const json = await readJson(response);

        if (
            !response.ok ||
            (json.error && json.error.code !== "ok")
        ) {
            throw new Error(
                json.error?.message ||
                `TikTok HTTP ${response.status}`
            );
        }

        const video = json.data?.videos?.find(
            item => String(item.id) === videoId
        );

        if (!video) {
            throw new Error(
                "Vidéo introuvable. Elle doit appartenir au compte TikTok connecté et être accessible via Display API."
            );
        }

        const data = {
            platform: "tiktok",
            views: Number(video.view_count ?? 0),
            likes: Number(video.like_count ?? 0),
            shares: Number(video.share_count ?? 0),
            comments: Number(video.comment_count ?? 0),
            title:
                video.title ||
                video.video_description ||
                "Sans titre",
            createTime: Number(video.create_time) || null,
            source: "tiktok_official"
        };

        setCached(cacheKey, data);

        console.log("Stats TikTok :", data);

        return data;

    } catch (err) {
        console.error("Erreur TikTok :", err.message);

        return {
            platform: "tiktok",
            views: null,
            likes: null,
            shares: null,
            comments: null,
            title: "Statistiques indisponibles",
            error: err.message
        };
    }
}

// ==============================
// YOUTUBE DATA API V3
// ==============================

async function getYouTubeStats(url) {
    const videoId = extractYouTubeId(url);

    if (!videoId) {
        return {
            platform: "youtube",
            views: null,
            likes: null,
            shares: null,
            title: "Lien YouTube invalide",
            error: "ID vidéo introuvable"
        };
    }

    const cacheKey = `youtube:${videoId}`;
    const cached = getCached(cacheKey);

    if (cached) return cached;

    try {
        if (!YOUTUBE_API_KEY) {
            throw new Error(
                "YOUTUBE_API_KEY manquante dans .env"
            );
        }

        const params = new URLSearchParams({
            part: "snippet,statistics",
            id: videoId,
            key: YOUTUBE_API_KEY
        });

        const response = await fetch(
            "https://www.googleapis.com/youtube/v3/videos?" +
            params.toString(),
            {
                signal: AbortSignal.timeout(15000)
            }
        );

        const json = await readJson(response);

        if (!response.ok || json.error) {
            throw new Error(
                json.error?.message ||
                `YouTube HTTP ${response.status}`
            );
        }

        const item = json.items?.[0];

        if (!item) {
            throw new Error("Vidéo YouTube introuvable");
        }

        const stats = item.statistics || {};
        const snippet = item.snippet || {};

        const publishedAt = Date.parse(
            snippet.publishedAt || ""
        );

        const data = {
            platform: "youtube",
            views: Number(stats.viewCount ?? 0),
            likes: Number(stats.likeCount ?? 0),
            shares: 0,
            comments: Number(stats.commentCount ?? 0),
            title: snippet.title || "Sans titre",
            createTime: Number.isFinite(publishedAt)
                ? Math.floor(publishedAt / 1000)
                : null,
            source: "youtube_official"
        };

        setCached(cacheKey, data);

        console.log("Stats YouTube :", data);

        return data;

    } catch (err) {
        console.error("Erreur YouTube :", err.message);

        return {
            platform: "youtube",
            views: null,
            likes: null,
            shares: null,
            comments: null,
            title: "Statistiques indisponibles",
            error: err.message
        };
    }
}

// ==============================
// ROUTE : STATISTIQUES
// ==============================

async function fetchStats(url) {
    const platform = detectPlatform(url);

    if (platform === "tiktok") {
        return getTikTokStats(url);
    }

    if (platform === "youtube") {
        return getYouTubeStats(url);
    }

    return {
        platform: null,
        views: null,
        likes: null,
        shares: null,
        title: "Plateforme non reconnue",
        error: "Lien TikTok ou YouTube invalide"
    };
}

app.get("/stats", async (req, res) => {
    const url = req.query.url;

    if (typeof url !== "string" || !url) {
        return res.status(400).json({
            error: "Lien manquant"
        });
    }

    const result = await fetchStats(url);

    res.json(result);
});

// ==============================
// ROUTE : COMPARAISON
// ==============================

app.get("/compare", async (req, res) => {
    const { urlA, urlB } = req.query;

    if (
        typeof urlA !== "string" ||
        typeof urlB !== "string" ||
        !urlA ||
        !urlB
    ) {
        return res.status(400).json({
            error: "Les deux liens urlA et urlB sont requis"
        });
    }

    const [a, b] = await Promise.all([
        fetchStats(urlA),
        fetchStats(urlB)
    ]);

    res.json({ a, b });
});

// ==============================
// ROUTE : ÉTAT DE CONNEXION
// ==============================

app.get("/auth/tiktok/status", (req, res) => {
    res.json({
        connected: Boolean(tiktokTokens?.access_token),
        tokenExpired: tiktokTokens
            ? Date.now() >= tiktokTokens.access_expires_at
            : null,
        configured: Boolean(
            TIKTOK_CLIENT_KEY &&
            TIKTOK_CLIENT_SECRET &&
            TIKTOK_REDIRECT_URI
        )
    });
});

// ==============================
// NETTOYAGE DU CACHE
// ==============================

setInterval(() => {
    const now = Date.now();

    for (const [key, value] of cache.entries()) {
        if (now - value.time > 60000) {
            cache.delete(key);
        }
    }

    for (const [state, expiresAt] of pendingStates.entries()) {
        if (now > expiresAt) {
            pendingStates.delete(state);
        }
    }
}, 60000).unref();

// ==============================
// FICHIERS STATIQUES
// ==============================

// À garder après les routes API et OAuth.
// En production, place idéalement ton HTML/CSS/JS dans /public.
const PUBLIC_DIR = path.join(__dirname, "public");

if (fs.existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR));
} else {
    app.use(express.static(__dirname, {
        dotfiles: "deny"
    }));
}

// ==============================
// DÉMARRAGE
// ==============================

app.listen(PORT, () => {
    console.log("==============================");
    console.log("TikTok Pulse démarré");
    console.log(`Port : ${PORT}`);
    console.log(
        "TikTok connecté :",
        Boolean(tiktokTokens?.access_token)
    );
    console.log("==============================");

    if (!YOUTUBE_API_KEY) {
        console.warn("Clé YouTube manquante.");
    }

    if (
        !TIKTOK_CLIENT_KEY ||
        !TIKTOK_CLIENT_SECRET ||
        !TIKTOK_REDIRECT_URI
    ) {
        console.warn("Configuration TikTok incomplète.");
    }

    if (!ADMIN_AUTH_KEY) {
        console.warn(
            "ADMIN_AUTH_KEY manquante : connexion OAuth désactivée."
        );
    }
});
