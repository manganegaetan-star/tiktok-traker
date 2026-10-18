
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "10kb" }));
app.use(express.static(__dirname));

// =====================================================
// CONFIGURATION
// =====================================================

const PORT = process.env.PORT || 3000;

// Statistiques vidéo : 4 secondes
const VIDEO_CACHE_DURATION = 4000;

// Statistiques du créateur : 30 secondes
const PROFILE_CACHE_DURATION = 30000;

// Sessions : expiration après 35 secondes
const SESSION_TIMEOUT = 35000;

// Durée maximale des requêtes TikWM
const REQUEST_TIMEOUT = 12000;

// Limite de requêtes externes
const MAX_CACHE_ITEMS = 1000;

// =====================================================
// STOCKAGE TEMPORAIRE
// =====================================================

const videoCache = new Map();
const profileCache = new Map();

const pendingRequests = new Map();

const activeSessions = new Map();

// =====================================================
// OUTILS
// =====================================================

function numberOrNull(value) {
    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }

    const number = Number(value);

    return Number.isFinite(number)
        ? number
        : null;
}

function safeImageUrl(value) {
    if (typeof value !== "string") {
        return null;
    }

    try {
        const url = new URL(value);

        return url.protocol === "https:"
            ? url.href
            : null;

    } catch {
        return null;
    }
}

function getCache(storage, key, duration) {
    const item = storage.get(key);

    if (!item) {
        return null;
    }

    if (Date.now() - item.time >= duration) {
        storage.delete(key);
        return null;
    }

    return item.data;
}

function setCache(storage, key, data) {
    if (storage.size >= MAX_CACHE_ITEMS) {
        const oldest = storage.keys().next().value;

        if (oldest !== undefined) {
            storage.delete(oldest);
        }
    }

    storage.set(key, {
        data,
        time: Date.now()
    });
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

function formatError(message) {
    return {
        platform: "tiktok",
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

function normalizeUsername(value) {
    if (typeof value !== "string") {
        return null;
    }

    const username = value.trim().replace(/^@/, "");

    return /^[a-zA-Z0-9._]{1,30}$/.test(username)
        ? username
        : null;
}

// =====================================================
// VALIDATION DES LIENS TIKTOK
// =====================================================

function parseTikTokUrl(value) {
    try {
        if (typeof value !== "string") {
            return null;
        }

        const url = new URL(value.trim());

        if (
            url.protocol !== "https:" &&
            url.protocol !== "http:"
        ) {
            return null;
        }

        const host = url.hostname.toLowerCase();

        if (
            host !== "tiktok.com" &&
            !host.endsWith(".tiktok.com")
        ) {
            return null;
        }

        return url;

    } catch {
        return null;
    }
}

function extractVideoId(url) {
    return url.pathname.match(
        /\/(?:@[^/]+\/)?video\/(\d+)/
    )?.[1] || null;
}

// =====================================================
// API TIKWM
// =====================================================

async function fetchTikWM(endpoint, parameters = {}) {
    const apiUrl = new URL(
        "https://www.tikwm.com" + endpoint
    );

    for (const [key, value] of Object.entries(parameters)) {
        if (value !== undefined && value !== null) {
            apiUrl.searchParams.set(
                key,
                String(value)
            );
        }
    }

    const response = await fetch(apiUrl, {
        headers: {
            Accept: "application/json"
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT)
    });

    if (!response.ok) {
        throw new Error(
            `TikWM HTTP ${response.status}`
        );
    }

    const json = await response.json();

    if (
        Number(json.code) !== 0 ||
        !json.data
    ) {
        throw new Error(
            json.msg ||
            "Données TikWM indisponibles"
        );
    }

    return json.data;
}

// =====================================================
// EXTRACTION DES STATISTIQUES DU CRÉATEUR
// =====================================================

function extractProfile(data, fallbackUsername) {
    if (!data || typeof data !== "object") {
        return null;
    }

    // TikWM peut renvoyer plusieurs structures.
    const root = data.userInfo || data;

    const user =
        root.user ||
        data.user ||
        root;

    const stats =
        root.stats ||
        data.stats ||
        root.statistics ||
        data.statistics ||
        {};

    const username = normalizeUsername(
        user.uniqueId ||
        user.unique_id ||
        user.username ||
        fallbackUsername
    );

    const profile = {
        username,

        nickname:
            user.nickname ||
            user.nickName ||
            null,

        avatar: safeImageUrl(
            user.avatarLarger ||
            user.avatarMedium ||
            user.avatarThumb ||
            user.avatar ||
            user.avatar_larger ||
            user.avatar_medium ||
            user.avatar_thumb
        ),

        bio:
            user.signature ||
            user.bio ||
            null,

        verified:
            typeof user.verified === "boolean"
                ? user.verified
                : null,

        followers: numberOrNull(
            stats.followerCount ??
            stats.follower_count ??
            stats.followers
        ),

        following: numberOrNull(
            stats.followingCount ??
            stats.following_count ??
            stats.following
        ),

        likes: numberOrNull(
            stats.heartCount ??
            stats.heart_count ??
            stats.heart ??
            stats.diggCount ??
            stats.likes
        ),

        videos: numberOrNull(
            stats.videoCount ??
            stats.video_count ??
            stats.videos
        )
    };

    const hasStats = [
        profile.followers,
        profile.following,
        profile.likes,
        profile.videos
    ].some(value => value !== null);

    return hasStats ? profile : null;
}

// =====================================================
// RÉCUPÉRATION DU PROFIL TIKTOK
// =====================================================

async function getTikTokProfile(username) {
    username = normalizeUsername(username);

    if (!username) {
        return null;
    }

    const key = username.toLowerCase();

    const cached = getCache(
        profileCache,
        key,
        PROFILE_CACHE_DURATION
    );

    if (cached) {
        return cached;
    }

    return deduplicate(
        "profile:" + key,
        async () => {
            try {
                const data = await fetchTikWM(
                    "/api/user/info",
                    {
                        unique_id: username
                    }
                );

                const profile = extractProfile(
                    data,
                    username
                );

                if (!profile) {
                    console.warn(
                        "[PROFILE] Aucune statistique exploitable :",
                        username
                    );

                    return null;
                }

                setCache(
                    profileCache,
                    key,
                    profile
                );

                console.log(
                    "[PROFILE] Statistiques récupérées :",
                    {
                        username: profile.username,
                        followers: profile.followers,
                        following: profile.following,
                        likes: profile.likes,
                        videos: profile.videos
                    }
                );

                return profile;

            } catch (error) {
                console.warn(
                    "[PROFILE] Erreur :",
                    username,
                    error.message
                );

                // Une erreur du profil ne doit pas
                // bloquer les statistiques vidéo.
                return null;
            }
        }
    );
}

// =====================================================
// RÉCUPÉRATION DES STATISTIQUES VIDÉO
// =====================================================

async function getTikTokVideo(url) {
    const parsed = parseTikTokUrl(url);

    if (!parsed) {
        return formatError(
            "Lien TikTok invalide"
        );
    }

    const videoId = extractVideoId(parsed);

    if (!videoId) {
        return formatError(
            "ID vidéo introuvable dans le lien TikTok"
        );
    }

    const cacheKey = "video:" + videoId;

    const cached = getCache(
        videoCache,
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
                    {
                        url: parsed.href
                    }
                );

                if (String(video.id) !== videoId) {
                    throw new Error(
                        "ID de vidéo différent de celui demandé"
                    );
                }

                if (video.play_count == null) {
                    throw new Error(
                        "Nombre de vues indisponible"
                    );
                }

                const authorData = video.author || {};

                const username = normalizeUsername(
                    authorData.unique_id ||
                    authorData.uniqueId
                );

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

                const data = {
                    platform: "tiktok",

                    id: String(video.id),

                    views: numberOrNull(
                        video.play_count
                    ),

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

                    source: "tikwm"
                };

                setCache(
                    videoCache,
                    cacheKey,
                    data
                );

                return data;

            } catch (error) {
                console.error(
                    "[VIDEO] Erreur TikWM :",
                    error.message
                );

                return formatError(
                    error.message
                );
            }
        }
    );
}

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
            error: "Lien TikTok manquant"
        });
    }

    if (!parseTikTokUrl(url)) {
        return res.status(400).json(
            formatError("Lien TikTok invalide")
        );
    }

    res.set("Cache-Control", "no-store");

    try {
        const video = await getTikTokVideo(url);

        if (video.error) {
            return res.json(video);
        }

        // IMPORTANT :
        // Le profil est récupéré indépendamment
        // du cache des statistiques vidéo.
        //
        // Ainsi, le profil peut être actualisé
        // toutes les 30 secondes, même si les
        // vues sont récupérées toutes les 5 secondes.

        const username = video.author?.username;

        const profile = username
            ? await getTikTokProfile(username)
            : null;

        const result = {
            ...video,
            profile
        };

        return res.json(result);

    } catch (error) {
        console.error(
            "[STATS] Erreur :",
            error.message
        );

        return res.status(500).json(
            formatError(
                "Erreur interne du serveur"
            )
        );
    }
});

// =====================================================
// SESSIONS ACTIVES
// =====================================================

function cleanExpiredSessions() {
    const now = Date.now();

    for (const [id, lastSeen] of activeSessions) {
        if (now - lastSeen > SESSION_TIMEOUT) {
            activeSessions.delete(id);
        }
    }
}

function getOnlineCount() {
    cleanExpiredSessions();

    return activeSessions.size;
}

// POST /presence
//
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

    if (typeof active !== "boolean") {
        return res.status(400).json({
            error: "Le champ active doit être un booléen"
        });
    }

    cleanExpiredSessions();

    if (active) {
        activeSessions.set(
            sessionId,
            Date.now()
        );
    } else {
        activeSessions.delete(sessionId);
    }

    res.set("Cache-Control", "no-store");

    return res.json({
        success: true,
        online: getOnlineCount()
    });
});

// GET /presence

app.get("/presence", (req, res) => {
    res.set("Cache-Control", "no-store");

    return res.json({
        online: getOnlineCount()
    });
});

// =====================================================
// ROUTE DE TEST
// =====================================================

app.get("/test", (req, res) => {
    res.set("Cache-Control", "no-store");

    res.json({
        success: true,
        name: "TikTok Pulse",
        platform: "tiktok",
        timestamp: new Date().toISOString(),
        online: getOnlineCount(),
        cache: {
            videoSeconds: VIDEO_CACHE_DURATION / 1000,
            profileSeconds: PROFILE_CACHE_DURATION / 1000
        }
    });
});

// =====================================================
// NETTOYAGE AUTOMATIQUE
// =====================================================

setInterval(() => {
    const now = Date.now();

    for (const [key, item] of videoCache) {
        if (
            now - item.time > VIDEO_CACHE_DURATION
        ) {
            videoCache.delete(key);
        }
    }

    for (const [key, item] of profileCache) {
        if (
            now - item.time > PROFILE_CACHE_DURATION
        ) {
            profileCache.delete(key);
        }
    }

    cleanExpiredSessions();

}, 15000).unref();

// =====================================================
// DÉMARRAGE
// =====================================================

app.listen(PORT, "0.0.0.0", () => {
    console.log("==================================");
    console.log("       TIKTOK PULSE");
    console.log("==================================");
    console.log(`Serveur : port ${PORT}`);
    console.log("Plateforme : TikTok");
    console.log("Source : TikWM");
    console.log("Cache vidéo : 4 secondes");
    console.log("Cache profil : 30 secondes");
    console.log("Sessions actives : activées");
    console.log("==================================");
});
