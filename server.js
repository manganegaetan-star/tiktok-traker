
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.static(__dirname));

// Clé YouTube à définir dans les variables d'environnement.
// Google Cloud Run : Variables et secrets → YOUTUBE_API_KEY
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

// Cache des statistiques vidéo : 4 secondes
const VIDEO_CACHE_DURATION = 4000;

// Cache des statistiques de profil : 5 minutes
const PROFILE_CACHE_DURATION = 5 * 60 * 1000;

const cache = {};
const profileCache = {};

// Empêche plusieurs requêtes identiques simultanées
const pendingRequests = new Map();

// ---------------------------------------------------------
// OUTILS
// ---------------------------------------------------------

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

        if (
            host === "youtube.com" ||
            host.endsWith(".youtube.com") ||
            host === "youtu.be"
        ) {
            return "youtube";
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

        if (url.protocol === "https:") {
            return value;
        }

        return null;

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

// ---------------------------------------------------------
// TIKWM : REQUÊTE API
// ---------------------------------------------------------

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

// ---------------------------------------------------------
// TIKTOK : STATISTIQUES DU PROFIL
// ---------------------------------------------------------

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

                // Différentes structures possibles
                // selon la réponse de TikWM.
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

                // L'échec du profil ne doit pas
                // empêcher les statistiques vidéo.
                return null;
            }
        }
    );
}

// ---------------------------------------------------------
// TIKTOK : STATISTIQUES VIDÉO
// ---------------------------------------------------------

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
                // Même endpoint TikWM que ton ancien code.
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

                // Informations du créateur
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

                // Récupération facultative du profil.
                const profile = await getTikTokProfile(
                    username
                );

                // Informations complètes de la vidéo.
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

// ---------------------------------------------------------
// YOUTUBE : EXTRACTION DE L'ID
// ---------------------------------------------------------

function extractYouTubeId(url) {
    try {
        const parsed = new URL(url);

        if (detectPlatform(url) !== "youtube") {
            return null;
        }

        let id = null;

        if (parsed.hostname === "youtu.be") {
            id = parsed.pathname.split("/")[1];

        } else if (parsed.pathname === "/watch") {
            id = parsed.searchParams.get("v");

        } else {
            id = parsed.pathname.match(
                /^\/(?:embed|shorts|live)\/([^/]+)/
            )?.[1];
        }

        return /^[a-zA-Z0-9_-]{11}$/.test(id || "")
            ? id
            : null;

    } catch {
        return null;
    }
}

// ---------------------------------------------------------
// YOUTUBE : STATISTIQUES VIDÉO
// ---------------------------------------------------------

async function getYouTubeStats(url) {
    const videoId = extractYouTubeId(url);

    if (!videoId) {
        return formatError(
            "youtube",
            "ID vidéo introuvable dans l'URL"
        );
    }

    const cacheKey = "youtube:" + videoId;

    const cached = getCache(
        cache,
        cacheKey,
        VIDEO_CACHE_DURATION
    );

    if (cached) {
        return cached;
    }

    if (!YOUTUBE_API_KEY) {
        return formatError(
            "youtube",
            "YOUTUBE_API_KEY manquante"
        );
    }

    return deduplicate(
        cacheKey,
        async () => {
            try {
                const apiUrl = new URL(
                    "https://www.googleapis.com/youtube/v3/videos"
                );

                apiUrl.searchParams.set(
                    "part",
                    "snippet,statistics"
                );

                apiUrl.searchParams.set(
                    "id",
                    videoId
                );

                apiUrl.searchParams.set(
                    "key",
                    YOUTUBE_API_KEY
                );

                const response = await fetch(
                    apiUrl,
                    {
                        signal: AbortSignal.timeout(15000)
                    }
                );

                const json = await response.json();

                if (!response.ok) {
                    throw new Error(
                        json.error?.message ||
                        `YouTube HTTP ${response.status}`
                    );
                }

                if (!json.items?.length) {
                    throw new Error(
                        "Vidéo YouTube introuvable"
                    );
                }

                const item = json.items[0];

                const stats = item.statistics || {};
                const snippet = item.snippet || {};

                const data = {
                    platform: "youtube",

                    id: videoId,

                    views: numberOrNull(
                        stats.viewCount
                    ),

                    likes: numberOrNull(
                        stats.likeCount
                    ),

                    shares: null,

                    comments: numberOrNull(
                        stats.commentCount
                    ),

                    favorites: null,

                    title:
                        snippet.title ||
                        "Titre introuvable",

                    createTime: snippet.publishedAt
                        ? Math.floor(
                            new Date(
                                snippet.publishedAt
                            ).getTime() / 1000
                        )
                        : null,

                    cover: safeImageUrl(
                        snippet.thumbnails?.maxres?.url ||
                        snippet.thumbnails?.high?.url ||
                        snippet.thumbnails?.medium?.url ||
                        snippet.thumbnails?.default?.url
                    ),

                    author: {
                        id:
                            snippet.channelId ||
                            null,

                        username: null,

                        nickname:
                            snippet.channelTitle ||
                            null,

                        avatar: null
                    },

                    profile: null,

                    source: "youtube"
                };

                console.log(
                    "Stats YouTube récupérées :",
                    {
                        id: data.id,
                        views: data.views,
                        likes: data.likes,
                        comments: data.comments
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
                    "Erreur YouTube :",
                    error.message
                );

                return formatError(
                    "youtube",
                    error.message
                );
            }
        }
    );
}

// ---------------------------------------------------------
// RÉCUPÉRATION AUTOMATIQUE SELON LA PLATEFORME
// ---------------------------------------------------------

async function fetchOne(url) {
    const platform = detectPlatform(url);

    if (platform === "tiktok") {
        return getTikTokStats(url);
    }

    if (platform === "youtube") {
        return getYouTubeStats(url);
    }

    return formatError(
        null,
        "Plateforme non reconnue (TikTok ou YouTube uniquement)"
    );
}

// ---------------------------------------------------------
// ROUTE /stats
// ---------------------------------------------------------

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

    const result = await fetchOne(url);

    res.json(result);
});

// ---------------------------------------------------------
// ROUTE /compare
// ---------------------------------------------------------

app.get("/compare", async (req, res) => {
    const urlA = req.query.urlA;
    const urlB = req.query.urlB;

    if (
        typeof urlA !== "string" ||
        typeof urlB !== "string" ||
        !urlA.trim() ||
        !urlB.trim()
    ) {
        return res.status(400).json({
            error: "Les deux liens (urlA et urlB) sont requis"
        });
    }

    const [a, b] = await Promise.all([
        fetchOne(urlA),
        fetchOne(urlB)
    ]);

    res.json({ a, b });
});

// ---------------------------------------------------------
// ROUTE DE TEST
// ---------------------------------------------------------

app.get("/test", (req, res) => {
    res.json({
        success: true,
        message: "TikTok Pulse fonctionne !",
        timestamp: new Date().toISOString()
    });
});

// ---------------------------------------------------------
// NETTOYAGE DU CACHE
// ---------------------------------------------------------

setInterval(() => {
    const now = Date.now();

    for (const key in cache) {
        if (
            now - cache[key].time > 60000
        ) {
            delete cache[key];
        }
    }

    for (const key in profileCache) {
        if (
            now - profileCache[key].time >
            PROFILE_CACHE_DURATION
        ) {
            delete profileCache[key];
        }
    }
}, 60000).unref();

// ---------------------------------------------------------
// DÉMARRAGE DU SERVEUR
// ---------------------------------------------------------

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(
        `TikTok Pulse lancé sur le port ${PORT}`
    );

    if (!YOUTUBE_API_KEY) {
        console.warn(
            "⚠️ YOUTUBE_API_KEY manquante : les statistiques YouTube ne fonctionneront pas."
        );
    }
});
