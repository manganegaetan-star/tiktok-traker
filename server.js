
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

app.use(cors());
app.use(express.json({ limit: "10kb" }));
app.use(express.static(__dirname));

// =====================================================
// CONFIGURATION
// =====================================================

const PORT = process.env.PORT || 3000;

// Cache des statistiques vidéo : 4 secondes
const VIDEO_CACHE_DURATION = 4000;

// Cache des statistiques de profil : 5 minutes
const PROFILE_CACHE_DURATION = 5 * 60 * 1000;

// Sessions : expiration après 35 secondes
const SESSION_TIMEOUT = 35 * 1000;

// Cache des statistiques
const cache = {};
const profileCache = {};

// Empêche les requêtes identiques simultanées
const pendingRequests = new Map();

// Sessions actives
const activeSessions = new Map();

// =====================================================
// OUTILS
// =====================================================

function numberOrNull(value) {
    if (
        value === undefined ||
        value === null ||
        value === "" ||
        !Number.isFinite(Number(value))
    ) {
        return null;
    }

    return Number(value);
}

function formatError(platform, message) {
    return {
        platform,
        views: null,
        likes: null,
        shares: null,
        comments: null,
        favorites: null,
        title: "Statistiques indisponibles",
        cover: null,
        author: null,
        profile: null,
        error: message
    };
}

function detectPlatform(url) {
    try {
        const parsed = new URL(url);

        if (
            parsed.protocol !== "https:" &&
            parsed.protocol !== "http:"
        ) {
            return null;
        }

        const host = parsed.hostname.toLowerCase();

        if (
            host === "tiktok.com" ||
            host.endsWith(".tiktok.com")
        ) {
            return "tiktok";
        }

        return null;
    } catch {
        return null;
    }
}

function safeImageUrl(value) {
    if (typeof value !== "string") {
        return null;
    }

    try {
        const url = new URL(value);

        return url.protocol === "https:"
            ? value
            : null;
    } catch {
        return null;
    }
}

function getCache(storage, key, duration) {
    const item = storage[key];

    if (
        item &&
        Date.now() - item.time < duration
    ) {
        return item.data;
    }

    return null;
}

function setCache(storage, key, data) {
    storage[key] = {
        data,
        time: Date.now()
    };
}

async function deduplicate(key, callback) {
    if (pendingRequests.has(key)) {
        return pendingRequests.get(key);
    }

    const promise = Promise.resolve().then(callback);

    pendingRequests.set(key, promise);

    try {
        return await promise;
    } finally {
        pendingRequests.delete(key);
    }
}

// =====================================================
// TIKWM : REQUÊTE API
// =====================================================

async function fetchTikWM(endpoint, parameters = {}) {
    const apiUrl = new URL(
        "https://www.tikwm.com" + endpoint
    );

    for (const [key, value] of Object.entries(parameters)) {
        if (value !== undefined && value !== null) {
            apiUrl.searchParams.set(key, String(value));
        }
    }

    const response = await fetch(apiUrl, {
        signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
        throw new Error(
            `TikWM HTTP ${response.status}`
        );
    }

    const json = await response.json();

    if (json.code !== 0 || !json.data) {
        throw new Error(
            json.msg ||
            "Données TikWM introuvables"
        );
    }

    return json.data;
}

// =====================================================
// TIKTOK : STATISTIQUES DU PROFIL
// =====================================================

async function getTikTokProfile(username) {
    if (!username) {
        return null;
    }

    const cached = getCache(
        profileCache,
        username,
        PROFILE_CACHE_DURATION
    );

    if (cached) {
        return cached;
    }

    return deduplicate(
        "profile:" + username,
        async () => {
            try {
                const data = await fetchTikWM(
                    "/api/user/info",
                    {
                        unique_id: username
                    }
                );

                const userInfo =
                    data.userInfo ||
                    data;

                const user =
                    userInfo.user ||
                    data.user ||
                    {};

                const stats =
                    userInfo.stats ||
                    data.stats ||
                    {};

                const profile = {
                    username:
                        user.uniqueId ||
                        user.unique_id ||
                        username,

                    nickname:
                        user.nickname ||
                        null,

                    avatar: safeImageUrl(
                        user.avatarLarger ||
                        user.avatarMedium ||
                        user.avatarThumb ||
                        user.avatar
                    ),

                    bio:
                        user.signature ||
                        null,

                    verified:
                        typeof user.verified === "boolean"
                            ? user.verified
                            : null,

                    followers: numberOrNull(
                        stats.followerCount ??
                        stats.follower_count
                    ),

                    following: numberOrNull(
                        stats.followingCount ??
                        stats.following_count
                    ),

                    likes: numberOrNull(
                        stats.heartCount ??
                        stats.heart_count
                    ),

                    videos: numberOrNull(
                        stats.videoCount ??
                        stats.video_count
                    )
                };

                const hasStats = [
                    profile.followers,
                    profile.following,
                    profile.likes,
                    profile.videos
                ].some(value => value !== null);

                if (!hasStats) {
                    return null;
                }

                setCache(
                    profileCache,
                    username,
                    profile
                );

                return profile;

            } catch (error) {
                console.warn(
                    "Profil TikTok indisponible :",
                    error.message
                );

                return null;
            }
        }
    );
}

// =====================================================
// TIKTOK : STATISTIQUES VIDÉO
// =====================================================

async function getTikTokStats(url) {
    const videoId = url.match(/\/video\/(\d+)/)?.[1];

    if (!videoId) {
        return formatError(
            "tiktok",
            "ID vidéo introuvable"
        );
    }

    const cacheKey = "tiktok:" + videoId;

    const cached = getCache(
        cache,
        cacheKey,
        VIDEO_CACHE_DURATION
    );

    if (cached) {
        return cached;
    }

    return deduplicate(
        cacheKey,
        async () => {
            try {
                const video = await fetchTikWM(
                    "/api/",
                    { url }
                );

                if (String(video.id) !== videoId) {
                    throw new Error(
                        "Les statistiques ne correspondent pas à la vidéo demandée"
                    );
                }

                if (video.play_count == null) {
                    throw new Error(
                        "Nombre de vues indisponible"
                    );
                }

                const authorData = video.author || {};

                const username =
                    authorData.unique_id ||
                    authorData.uniqueId ||
                    null;

                const author = {
                    id:
                        authorData.id ||
                        null,

                    username,

                    nickname:
                        authorData.nickname ||
                        username ||
                        null,

                    avatar: safeImageUrl(
                        authorData.avatar ||
                        authorData.avatar_thumb
                    )
                };

                const profile = await getTikTokProfile(
                    username
                );

                const data = {
                    platform: "tiktok",

                    id: String(video.id),

                    views: Number(video.play_count),

                    likes: numberOrNull(
                        video.digg_count
                    ),

                    shares: numberOrNull(
                        video.share_count
                    ),

                    comments: numberOrNull(
                        video.comment_count
                    ),

                    favorites: numberOrNull(
                        video.collect_count
                    ),

                    title:
                        video.title ||
                        "Vidéo TikTok",

                    createTime: numberOrNull(
                        video.create_time
                    ),

                    duration: numberOrNull(
                        video.duration
                    ),

                    cover: safeImageUrl(
                        video.cover ||
                        video.origin_cover
                    ),

                    author,

                    profile,

                    source: "tikwm"
                };

                console.log(
                    "TikTok stats (TikWM) :",
                    {
                        id: data.id,
                        views: data.views,
                        likes: data.likes,
                        comments: data.comments,
                        shares: data.shares,
                        favorites: data.favorites
                    }
                );

                setCache(
                    cache,
                    cacheKey,
                    data
                );

                return data;

            } catch (error) {
                console.error(
                    "Erreur TikWM :",
                    error.message
                );

                return formatError(
                    "tiktok",
                    error.message
                );
            }
        }
    );
}

// =====================================================
// COMPTEUR DE SESSIONS ACTIVES
// =====================================================

// Chaque onglet possède son propre identifiant.
// Le navigateur devra conserver cet identifiant
// pendant toute la durée de la session.

function cleanExpiredSessions() {
    const now = Date.now();

    for (const [sessionId, lastSeen] of activeSessions) {
        if (now - lastSeen > SESSION_TIMEOUT) {
            activeSessions.delete(sessionId);
        }
    }
}

function getOnlineCount() {
    cleanExpiredSessions();
    return activeSessions.size;
}

// Enregistrer ou actualiser une session active.
//
// POST /presence
// Body :
// {
//     "sessionId": "identifiant-unique",
//     "active": true
// }

app.post("/presence", (req, res) => {
    const { sessionId, active } = req.body || {};

    if (
        typeof sessionId !== "string" ||
        sessionId.length < 16 ||
        sessionId.length > 128 ||
        !/^[a-zA-Z0-9_-]+$/.test(sessionId)
    ) {
        return res.status(400).json({
            error: "Identifiant de session invalide"
        });
    }

    cleanExpiredSessions();

    if (active === true) {
        activeSessions.set(
            sessionId,
            Date.now()
        );
    } else if (active === false) {
        activeSessions.delete(sessionId);
    } else {
        return res.status(400).json({
            error: "Le champ active doit être true ou false"
        });
    }

    return res.json({
        success: true,
        online: getOnlineCount()
    });
});

// Récupérer le nombre de sessions en ligne.
//
// GET /presence

app.get("/presence", (req, res) => {
    res.set("Cache-Control", "no-store");

    res.json({
        online: getOnlineCount()
    });
});

// =====================================================
// ROUTE /stats
// =====================================================

app.get("/stats", async (req, res) => {
    const url = req.query.url;

    if (
        typeof url !== "string" ||
        !url.trim()
    ) {
        return res.status(400).json({
            error: "Lien manquant"
        });
    }

    if (detectPlatform(url) !== "tiktok") {
        return res.status(400).json(
            formatError(
                null,
                "Lien TikTok invalide"
            )
        );
    }

    const result = await getTikTokStats(url);

    res.json(result);
});

// =====================================================
// ROUTE DE TEST
// =====================================================

app.get("/test", (req, res) => {
    res.json({
        success: true,
        message: "TikTok Pulse fonctionne !",
        timestamp: new Date().toISOString(),
        online: getOnlineCount()
    });
});

// =====================================================
// NETTOYAGE AUTOMATIQUE
// =====================================================

setInterval(() => {
    const now = Date.now();

    // Nettoyage du cache vidéo
    for (const key in cache) {
        if (
            now - cache[key].time > 60000
        ) {
            delete cache[key];
        }
    }

    // Nettoyage du cache profil
    for (const key in profileCache) {
        if (
            now - profileCache[key].time >
            PROFILE_CACHE_DURATION
        ) {
            delete profileCache[key];
        }
    }

    // Nettoyage des sessions
    cleanExpiredSessions();

}, 15000).unref();

// =====================================================
// DÉMARRAGE DU SERVEUR
// =====================================================

app.listen(PORT, "0.0.0.0", () => {
    console.log(
        `TikTok Pulse lancé sur le port ${PORT}`
    );

    console.log(
        "Statistiques : TikTok uniquement"
    );

    console.log(
        "Compteur de sessions actives activé"
    );

    console.log(
        `Expiration des sessions : ${SESSION_TIMEOUT / 1000}s`
    );
});
