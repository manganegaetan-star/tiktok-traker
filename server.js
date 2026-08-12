const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ============================================================
// CONFIGURATION
// ============================================================

const YOUTUBE_API_KEY =
    process.env.YOUTUBE_API_KEY ||
    "AIzaSyDQNrpnW3W6Ezu34Ngcv7_mFYoefhNYa2A";

const PORT = process.env.PORT || 3000;

// Cache général
const cache = new Map();

const CACHE_STATS_MS = 3000;
const CACHE_SEARCH_MS = 30000;


// ============================================================
// OUTILS
// ============================================================

function cacheGet(key, duration) {
    const item = cache.get(key);

    if (!item) return null;

    if (Date.now() - item.time > duration) {
        cache.delete(key);
        return null;
    }

    return item.data;
}

function cacheSet(key, data) {
    cache.set(key, {
        data,
        time: Date.now()
    });
}

function cleanUsername(username) {
    return String(username || "")
        .trim()
        .replace(/^@/, "")
        .replace(/^https?:\/\/(www\.)?tiktok\.com\/@?/i, "")
        .replace(/^https?:\/\/(www\.)?youtube\.com\/@?/i, "")
        .replace(/^https?:\/\/(www\.)?youtube\.com\/channel\//i, "")
        .split(/[/?#]/)[0]
        .trim();
}

function detectPlatform(url) {
    if (/tiktok\.com/i.test(url)) return "tiktok";
    if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
    return null;
}


// ============================================================
// TIKTOK — STATISTIQUES D'UNE VIDÉO
// ============================================================

async function getTikTokStats(url) {

    const cached = cacheGet(
        `stats:${url}`,
        CACHE_STATS_MS
    );

    if (cached) return cached;

    try {

        const response = await fetch(url, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                    "AppleWebKit/537.36 (KHTML, like Gecko) " +
                    "Chrome/120.0.0.0 Safari/537.36",

                "Accept-Language":
                    "fr-FR,fr;q=0.9,en;q=0.8"
            }
        });

        const html = await response.text();

        const views =
            html.match(/"playCount":(\d+)/);

        const likes =
            html.match(/"diggCount":(\d+)/);

        const shares =
            html.match(/"shareCount":(\d+)/);

        const comments =
            html.match(/"commentCount":(\d+)/);

        const title =
            html.match(/"desc":"(.*?)"/);

        const createTime =
            html.match(/"createTime":(\d+)/);

        const data = {
            platform: "tiktok",

            views: views
                ? Number(views[1])
                : 0,

            likes: likes
                ? Number(likes[1])
                : 0,

            shares: shares
                ? Number(shares[1])
                : 0,

            comments: comments
                ? Number(comments[1])
                : 0,

            title: title
                ? title[1]
                    .replace(/\\"/g, '"')
                    .replace(/\\n/g, " ")
                : "Titre introuvable",

            createTime: createTime
                ? Number(createTime[1])
                : 0
        };

        cacheSet(
            `stats:${url}`,
            data
        );

        console.log(
            "Stats TikTok récupérées:",
            data
        );

        return data;

    } catch (error) {

        console.log(
            "Erreur fetch TikTok:",
            error.message
        );

        return {
            platform: "tiktok",
            views: 0,
            likes: 0,
            shares: 0,
            comments: 0,
            title: "Erreur TikTok",
            error: error.message
        };
    }
}


// ============================================================
// TIKTOK — RECHERCHE PAR PROFIL PUBLIC
// ============================================================

async function searchTikTokProfile(username) {

    username = cleanUsername(username);

    if (!username) {
        throw new Error(
            "Nom d'utilisateur TikTok manquant."
        );
    }

    const cacheKey =
        `tiktok-profile:${username.toLowerCase()}`;

    const cached =
        cacheGet(
            cacheKey,
            CACHE_SEARCH_MS
        );

    if (cached) return cached;

    const profileUrl =
        `https://www.tiktok.com/@${encodeURIComponent(username)}`;

    try {

        const response = await fetch(
            profileUrl,
            {
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                        "AppleWebKit/537.36 (KHTML, like Gecko) " +
                        "Chrome/120.0.0.0 Safari/537.36",

                    "Accept":
                        "text/html,application/xhtml+xml," +
                        "application/xml;q=0.9,*/*;q=0.8",

                    "Accept-Language":
                        "fr-FR,fr;q=0.9,en;q=0.8"
                }
            }
        );

        if (!response.ok) {

            throw new Error(
                `TikTok a répondu avec le statut ${response.status}`
            );
        }

        const html =
            await response.text();

        const result = {

            platform: "tiktok",

            username,

            profileUrl,

            nickname: username,

            avatar: "",

            followers: 0,

            following: 0,

            likes: 0,

            videos: []
        };


        // --------------------------------------------------------
        // Récupération des données JSON de la page
        // --------------------------------------------------------

        let jsonData = null;

        const patterns = [

            /<script[^>]+id=["']SIGI_STATE["'][^>]*>([\s\S]*?)<\/script>/i,

            /<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i

        ];

        for (const pattern of patterns) {

            const match =
                html.match(pattern);

            if (!match) continue;

            try {

                jsonData =
                    JSON.parse(match[1]);

                break;

            } catch (e) {
                // Continue
            }
        }


        // --------------------------------------------------------
        // Recherche récursive des vidéos
        // --------------------------------------------------------

        const foundVideos = [];

        function walk(value, depth = 0) {

            if (!value || depth > 25)
                return;

            if (Array.isArray(value)) {

                for (const item of value) {
                    walk(item, depth + 1);
                }

                return;
            }

            if (
                typeof value !== "object"
            ) {
                return;
            }


            if (
                value.id &&
                (
                    value.video ||
                    value.stats ||
                    value.desc
                )
            ) {

                const id =
                    String(value.id);

                if (/^\d+$/.test(id)) {

                    const stats =
                        value.stats || {};

                    const video =
                        value.video || {};

                    let author =
                        username;

                    if (value.author) {

                        if (
                            typeof value.author ===
                            "object"
                        ) {

                            author =
                                value.author.uniqueId ||
                                value.author.unique_id ||
                                username;

                        } else {

                            author =
                                String(value.author);
                        }
                    }


                    const videoUrl =
                        `https://www.tiktok.com/@${author}/video/${id}`;


                    foundVideos.push({

                        id,

                        url: videoUrl,

                        title:
                            value.desc ||
                            value.description ||
                            "Vidéo TikTok",

                        views:
                            Number(
                                stats.playCount ??
                                stats.play_count ??
                                value.playCount ??
                                0
                            ) || 0,

                        likes:
                            Number(
                                stats.diggCount ??
                                stats.digg_count ??
                                value.diggCount ??
                                0
                            ) || 0,

                        comments:
                            Number(
                                stats.commentCount ??
                                stats.comment_count ??
                                value.commentCount ??
                                0
                            ) || 0,

                        shares:
                            Number(
                                stats.shareCount ??
                                stats.share_count ??
                                value.shareCount ??
                                0
                            ) || 0,

                        createTime:
                            Number(
                                value.createTime ??
                                value.create_time ??
                                0
                            ) || 0,

                        thumbnail:
                            video.cover ||
                            video.originCover ||
                            video.dynamicCover ||
                            ""
                    });
                }
            }


            for (
                const key of Object.keys(value)
            ) {

                walk(
                    value[key],
                    depth + 1
                );
            }
        }


        if (jsonData) {
            walk(jsonData);
        }


        // --------------------------------------------------------
        // Déduplication
        // --------------------------------------------------------

        const seen =
            new Set();

        const videos =
            [];

        for (
            const video of foundVideos
        ) {

            if (seen.has(video.id))
                continue;

            seen.add(video.id);

            videos.push(video);
        }


        result.videos =
            videos.slice(0, 30);


        // --------------------------------------------------------
        // Recherche du profil
        // --------------------------------------------------------

        function findUser(
            value,
            depth = 0
        ) {

            if (!value || depth > 25)
                return null;

            if (Array.isArray(value)) {

                for (
                    const item of value
                ) {

                    const found =
                        findUser(
                            item,
                            depth + 1
                        );

                    if (found)
                        return found;
                }

                return null;
            }

            if (
                typeof value !== "object"
            ) {
                return null;
            }

            const id =
                value.uniqueId ||
                value.unique_id;

            if (
                id &&
                String(id).toLowerCase() ===
                username.toLowerCase()
            ) {

                return value;
            }


            for (
                const key of Object.keys(value)
            ) {

                const found =
                    findUser(
                        value[key],
                        depth + 1
                    );

                if (found)
                    return found;
            }

            return null;
        }


        const user =
            jsonData
                ? findUser(jsonData)
                : null;


        if (user) {

            result.nickname =
                user.nickname ||
                user.nickName ||
                username;

            result.avatar =
                user.avatarLarger ||
                user.avatarMedium ||
                user.avatarThumb ||
                "";

            result.followers =
                Number(
                    user.followerCount ??
                    user.fans ??
                    0
                ) || 0;

            result.following =
                Number(
                    user.followingCount ??
                    user.following ??
                    0
                ) || 0;

            result.likes =
                Number(
                    user.heartCount ??
                    user.totalFavorited ??
                    user.heart ??
                    0
                ) || 0;
        }


        // --------------------------------------------------------
        // Fallback HTML
        // --------------------------------------------------------

        if (
            result.nickname === username
        ) {

            const match =
                html.match(
                    /"nickname":"([^"]+)"/
                );

            if (match) {
                result.nickname =
                    match[1];
            }
        }


        if (!result.followers) {

            const match =
                html.match(
                    /"followerCount":(\d+)/
                );

            if (match) {
                result.followers =
                    Number(match[1]);
            }
        }


        if (!result.following) {

            const match =
                html.match(
                    /"followingCount":(\d+)/
                );

            if (match) {
                result.following =
                    Number(match[1]);
            }
        }


        if (!result.likes) {

            const match =
                html.match(
                    /"heartCount":(\d+)/
                );

            if (match) {
                result.likes =
                    Number(match[1]);
            }
        }


        cacheSet(
            cacheKey,
            result
        );


        console.log(
            `TikTok @${username}: ${result.videos.length} vidéos`
        );


        return result;

    } catch (error) {

        console.error(
            "Erreur recherche TikTok:",
            error.message
        );

        throw error;
    }
}


// ============================================================
// YOUTUBE — EXTRACTION ID
// ============================================================

function extractYouTubeId(url) {

    const patterns = [

        /(?:v=|\/embed\/|\/shorts\/)([a-zA-Z0-9_-]{11})/,

        /youtu\.be\/([a-zA-Z0-9_-]{11})/

    ];

    for (
        const pattern of patterns
    ) {

        const match =
            url.match(pattern);

        if (match)
            return match[1];
    }

    return null;
}


// ============================================================
// YOUTUBE — STATISTIQUES VIDÉO
// ============================================================

async function getYouTubeStats(url) {

    const cached =
        cacheGet(
            `stats:${url}`,
            CACHE_STATS_MS
        );

    if (cached)
        return cached;


    const videoId =
        extractYouTubeId(url);


    if (!videoId) {

        return {

            platform: "youtube",

            views: 0,

            likes: 0,

            shares: 0,

            title: "Lien YouTube invalide",

            error:
                "ID vidéo introuvable dans l'URL"
        };
    }


    try {

        const apiUrl =
            `https://www.googleapis.com/youtube/v3/videos` +
            `?part=snippet,statistics` +
            `&id=${videoId}` +
            `&key=${YOUTUBE_API_KEY}`;


        const response =
            await fetch(apiUrl);


        const json =
            await response.json();


        if (
            !json.items ||
            json.items.length === 0
        ) {

            return {

                platform: "youtube",

                views: 0,

                likes: 0,

                shares: 0,

                title: "Vidéo introuvable",

                error:
                    json.error
                        ? json.error.message
                        : "Aucun résultat"
            };
        }


        const item =
            json.items[0];

        const stats =
            item.statistics;

        const snippet =
            item.snippet;


        const data = {

            platform: "youtube",

            views:
                Number(stats.viewCount) || 0,

            likes:
                Number(stats.likeCount) || 0,

            shares: 0,

            title:
                snippet.title ||
                "Titre introuvable",

            createTime:
                Math.floor(
                    new Date(
                        snippet.publishedAt
                    ).getTime() / 1000
                )
        };


        cacheSet(
            `stats:${url}`,
            data
        );


        return data;

    } catch (error) {

        return {

            platform: "youtube",

            views: 0,

            likes: 0,

            shares: 0,

            title: "Erreur YouTube",

            error: error.message
        };
    }
}


// ============================================================
// YOUTUBE — RECHERCHE PAR NOM / @USERNAME
// ============================================================

async function searchYouTube(query) {

    query =
        String(query || "")
            .trim()
            .replace(/^@/, "");


    if (!query) {

        throw new Error(
            "Nom de chaîne YouTube manquant."
        );
    }


    if (
        !YOUTUBE_API_KEY ||
        YOUTUBE_API_KEY ===
        "TA_CLE_API_YOUTUBE_ICI"
    ) {

        throw new Error(
            "Clé YouTube API manquante."
        );
    }


    const cacheKey =
        `youtube-search:${query.toLowerCase()}`;


    const cached =
        cacheGet(
            cacheKey,
            CACHE_SEARCH_MS
        );


    if (cached)
        return cached;


    try {

        // --------------------------------------------------------
        // 1. Recherche de la chaîne
        // --------------------------------------------------------

        const channelSearchUrl =
            `https://www.googleapis.com/youtube/v3/search` +
            `?part=snippet` +
            `&q=${encodeURIComponent(query)}` +
            `&type=channel` +
            `&maxResults=1` +
            `&key=${YOUTUBE_API_KEY}`;


        const channelResponse =
            await fetch(channelSearchUrl);


        const channelJson =
            await channelResponse.json();


        if (
            channelJson.error
        ) {

            throw new Error(
                channelJson.error.message
            );
        }


        if (
            !channelJson.items ||
            !channelJson.items.length
        ) {

            throw new Error(
                "Chaîne YouTube introuvable."
            );
        }


        const channel =
            channelJson.items[0];


        const channelId =
            channel.id.channelId;


        // --------------------------------------------------------
        // 2. Informations de la chaîne
        // --------------------------------------------------------

        const channelUrl =
            `https://www.googleapis.com/youtube/v3/channels` +
            `?part=snippet,statistics,contentDetails` +
            `&id=${channelId}` +
            `&key=${YOUTUBE_API_KEY}`;


        const channelResponse2 =
            await fetch(channelUrl);


        const channelJson2 =
            await channelResponse2.json();


        const channelData =
            channelJson2.items &&
            channelJson2.items[0];


        // --------------------------------------------------------
        // 3. Recherche des dernières vidéos
        // --------------------------------------------------------

        const videosSearchUrl =
            `https://www.googleapis.com/youtube/v3/search` +
            `?part=snippet` +
            `&channelId=${channelId}` +
            `&type=video` +
            `&order=date` +
            `&maxResults=30` +
            `&key=${YOUTUBE_API_KEY}`;


        const videosResponse =
            await fetch(videosSearchUrl);


        const videosJson =
            await videosResponse.json();


        if (
            videosJson.error
        ) {

            throw new Error(
                videosJson.error.message
            );
        }


        const ids =
            (videosJson.items || [])
                .map(
                    item =>
                        item.id.videoId
                )
                .filter(Boolean);


        let statistics = [];


        if (ids.length) {

            const statsUrl =
                `https://www.googleapis.com/youtube/v3/videos` +
                `?part=snippet,statistics` +
                `&id=${ids.join(",")}` +
                `&key=${YOUTUBE_API_KEY}`;


            const statsResponse =
                await fetch(statsUrl);


            const statsJson =
                await statsResponse.json();


            statistics =
                statsJson.items || [];
        }


        // --------------------------------------------------------
        // 4. Format final
        // --------------------------------------------------------

        const videos =
            statistics.map(video => {

                const snippet =
                    video.snippet || {};

                const stats =
                    video.statistics || {};


                return {

                    id: video.id,

                    url:
                        `https://www.youtube.com/watch?v=${video.id}`,

                    title:
                        snippet.title ||
                        "Vidéo YouTube",

                    views:
                        Number(
                            stats.viewCount
                        ) || 0,

                    likes:
                        Number(
                            stats.likeCount
                        ) || 0,

                    comments:
                        Number(
                            stats.commentCount
                        ) || 0,

                    shares: 0,

                    createTime:
                        snippet.publishedAt
                            ? Math.floor(
                                new Date(
                                    snippet.publishedAt
                                ).getTime() / 1000
                            )
                            : 0,

                    thumbnail:
                        snippet.thumbnails?.high?.url ||
                        snippet.thumbnails?.medium?.url ||
                        snippet.thumbnails?.default?.url ||
                        ""
                };
            });


        const result = {

            platform: "youtube",

            channelId,

            username:
                channelData?.snippet?.customUrl ||
                query,

            nickname:
                channelData?.snippet?.title ||
                channel.snippet?.title ||
                query,

            profileUrl:
                `https://www.youtube.com/channel/${channelId}`,

            avatar:
                channelData
                    ?.snippet
                    ?.thumbnails
                    ?.high
                    ?.url ||
                channelData
                    ?.snippet
                    ?.thumbnails
                    ?.default
                    ?.url ||
                "",

            subscribers:
                Number(
                    channelData
                        ?.statistics
                        ?.subscriberCount
                ) || 0,

            videosCount:
                Number(
                    channelData
                        ?.statistics
                        ?.videoCount
                ) || 0,

            totalViews:
                Number(
                    channelData
                        ?.statistics
                        ?.viewCount
                ) || 0,

            videos
        };


        cacheSet(
            cacheKey,
            result
        );


        console.log(
            `YouTube ${query}: ${videos.length} vidéos`
        );


        return result;

    } catch (error) {

        console.error(
            "Erreur recherche YouTube:",
            error.message
        );

        throw error;
    }
}


// ============================================================
// ROUTE STATS EXISTANTE
// ============================================================

app.get(
    "/stats",
    async (req, res) => {

        const url =
            req.query.url;


        if (!url) {

            return res.json({
                error: "Lien manquant"
            });
        }


        const platform =
            detectPlatform(url);


        let result;


        if (
            platform === "youtube"
        ) {

            result =
                await getYouTubeStats(url);

        } else if (
            platform === "tiktok"
        ) {

            result =
                await getTikTokStats(url);

        } else {

            return res.json({
                error:
                    "Plateforme non reconnue (TikTok ou YouTube uniquement)"
            });
        }


        res.json(result);
    }
);


// ============================================================
// ROUTE COMPARAISON EXISTANTE
// ============================================================

app.get(
    "/compare",
    async (req, res) => {

        const urlA =
            req.query.urlA;

        const urlB =
            req.query.urlB;


        if (!urlA || !urlB) {

            return res.json({
                error:
                    "Les deux liens (urlA et urlB) sont requis"
            });
        }


        async function fetchOne(url) {

            const platform =
                detectPlatform(url);


            if (
                platform === "youtube"
            ) {

                return getYouTubeStats(url);
            }


            if (
                platform === "tiktok"
            ) {

                return getTikTokStats(url);
            }


            return {

                platform: null,

                views: 0,

                likes: 0,

                shares: 0,

                title:
                    "Plateforme non reconnue",

                error:
                    "URL invalide"
            };
        }


        const [a, b] =
            await Promise.all([
                fetchOne(urlA),
                fetchOne(urlB)
            ]);


        res.json({
            a,
            b
        });
    }
);


// ============================================================
// NOUVELLE ROUTE — RECHERCHE
// ============================================================

app.get(
    "/search",
    async (req, res) => {

        const platform =
            String(
                req.query.platform || ""
            ).toLowerCase();


        const username =
            String(
                req.query.username || ""
            ).trim();


        if (!username) {

            return res.status(400).json({
                error:
                    "Nom d'utilisateur manquant."
            });
        }


        try {

            let result;


            if (
                platform === "tiktok"
            ) {

                result =
                    await searchTikTokProfile(
                        username
                    );

            } else if (
                platform === "youtube"
            ) {

                result =
                    await searchYouTube(
                        username
                    );

            } else {

                return res.status(400).json({
                    error:
                        "Plateforme invalide. Utilise tiktok ou youtube."
                });
            }


            res.json(result);

        } catch (error) {

            console.error(
                "Erreur /search:",
                error.message
            );


            res.status(500).json({

                error:
                    error.message ||
                    "Erreur pendant la recherche."
            });
        }
    }
);


// ============================================================
// NETTOYAGE CACHE
// ============================================================

setInterval(
    () => {

        const now =
            Date.now();

        for (
            const [key, value]
            of cache.entries()
        ) {

            if (
                now - value.time >
                60000
            ) {

                cache.delete(key);
            }
        }

    },
    60000
);


// ============================================================
// SERVEUR
// ============================================================

app.listen(
    PORT,
    () => {

        console.log(
            `Serveur lancé sur le port ${PORT}`
        );

        if (
            YOUTUBE_API_KEY ===
            "TA_CLE_API_YOUTUBE_ICI"
        ) {

            console.log(
                "⚠️ Clé YouTube API non configurée."
            );
        }
    }
);
