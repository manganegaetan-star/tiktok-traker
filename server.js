const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

/*
|--------------------------------------------------------------------------
| CONFIGURATION
|--------------------------------------------------------------------------
|
| Mets ta clé dans la variable d'environnement :
|
| Windows :
|   set YOUTUBE_API_KEY=TA_CLE
|
| Linux / macOS :
|   export YOUTUBE_API_KEY=TA_CLE
|
*/
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

const PORT = process.env.PORT || 3000;

const cache = new Map();

const CACHE_STATS = 3000;
const CACHE_SEARCH = 30000;

/*
|--------------------------------------------------------------------------
| OUTILS
|--------------------------------------------------------------------------
*/

function cacheGet(key) {
    const item = cache.get(key);

    if (!item) return null;

    if (Date.now() - item.time > item.ttl) {
        cache.delete(key);
        return null;
    }

    return item.data;
}

function cacheSet(key, data, ttl) {
    cache.set(key, {
        data,
        time: Date.now(),
        ttl
    });
}

function cleanUsername(value) {
    return String(value || "")
        .trim()
        .replace(/^@/, "")
        .replace(/\/+$/, "");
}

function isTikTokUrl(url) {
    return /(^|\.)tiktok\.com/i.test(url);
}

function isYouTubeUrl(url) {
    return /(youtube\.com|youtu\.be)/i.test(url);
}

function detectPlatform(value) {
    if (isTikTokUrl(value)) return "tiktok";
    if (isYouTubeUrl(value)) return "youtube";
    return null;
}

/*
|--------------------------------------------------------------------------
| FETCH AVEC USER AGENT
|--------------------------------------------------------------------------
*/

async function fetchText(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
            "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
            "Accept":
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            ...(options.headers || {})
        }
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    return response.text();
}

/*
|--------------------------------------------------------------------------
| YOUTUBE
|--------------------------------------------------------------------------
*/

function extractYouTubeId(url) {
    const patterns = [
        /[?&]v=([a-zA-Z0-9_-]{11})/,
        /youtu\.be\/([a-zA-Z0-9_-]{11})/,
        /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
        /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
        /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/
    ];

    for (const pattern of patterns) {
        const match = String(url).match(pattern);

        if (match) {
            return match[1];
        }
    }

    return null;
}

function extractYouTubeHandle(value) {
    try {
        const url = new URL(value);

        const match = url.pathname.match(/^\/@([^/]+)/);

        if (match) {
            return match[1];
        }

        const channelMatch = url.pathname.match(/^\/channel\/([^/]+)/);

        if (channelMatch) {
            return {
                channelId: channelMatch[1]
            };
        }

        const userMatch = url.pathname.match(/^\/user\/([^/]+)/);

        if (userMatch) {
            return {
                username: userMatch[1]
            };
        }
    } catch (_) {
        // Ce n'est pas une URL.
    }

    if (String(value).trim().startsWith("@")) {
        return {
            handle: cleanUsername(value)
        };
    }

    return {
        handle: cleanUsername(value)
    };
}

async function youtubeRequest(endpoint, params) {
    if (!YOUTUBE_API_KEY) {
        throw new Error(
            "YOUTUBE_API_KEY n'est pas configurée sur le serveur."
        );
    }

    const url = new URL(
        `https://www.googleapis.com/youtube/v3/${endpoint}`
    );

    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }

    url.searchParams.set("key", YOUTUBE_API_KEY);

    const response = await fetch(url);

    const json = await response.json();

    if (!response.ok || json.error) {
        throw new Error(
            json?.error?.message ||
            `Erreur YouTube HTTP ${response.status}`
        );
    }

    return json;
}

/*
|--------------------------------------------------------------------------
| YOUTUBE — VIDÉO
|--------------------------------------------------------------------------
*/

async function getYouTubeStats(url) {
    const cacheKey = `stats:youtube:${url}`;

    const cached = cacheGet(cacheKey);

    if (cached) {
        return cached;
    }

    const videoId = extractYouTubeId(url);

    if (!videoId) {
        return {
            platform: "youtube",
            type: "video",
            views: 0,
            likes: 0,
            shares: 0,
            title: "Lien YouTube invalide",
            error: "ID vidéo introuvable dans l'URL"
        };
    }

    try {
        const json = await youtubeRequest("videos", {
            part: "snippet,statistics",
            id: videoId
        });

        if (!json.items || !json.items.length) {
            return {
                platform: "youtube",
                type: "video",
                views: 0,
                likes: 0,
                shares: 0,
                title: "Vidéo introuvable",
                error: "Aucune vidéo YouTube trouvée"
            };
        }

        const item = json.items[0];

        const stats = item.statistics || {};
        const snippet = item.snippet || {};

        const data = {
            platform: "youtube",
            type: "video",
            id: videoId,
            url,
            views: Number(stats.viewCount) || 0,
            likes: Number(stats.likeCount) || 0,
            shares: 0,
            title: snippet.title || "Vidéo YouTube",
            thumbnail:
                snippet.thumbnails?.high?.url ||
                snippet.thumbnails?.medium?.url ||
                snippet.thumbnails?.default?.url ||
                "",
            createTime: snippet.publishedAt
                ? Math.floor(
                    new Date(snippet.publishedAt).getTime() / 1000
                )
                : null
        };

        cacheSet(cacheKey, data, CACHE_STATS);

        return data;
    } catch (error) {
        console.error("Erreur YouTube stats :", error.message);

        return {
            platform: "youtube",
            type: "video",
            views: 0,
            likes: 0,
            shares: 0,
            title: "Erreur YouTube",
            error: error.message
        };
    }
}

/*
|--------------------------------------------------------------------------
| YOUTUBE — CHAÎNE / PROFIL
|--------------------------------------------------------------------------
*/

async function resolveYouTubeChannel(value) {
    const info = extractYouTubeHandle(value);

    if (info.channelId) {
        return info.channelId;
    }

    if (info.handle) {
        const json = await youtubeRequest("channels", {
            part: "snippet,statistics",
            forHandle: info.handle
        });

        if (json.items?.length) {
            return json.items[0].id;
        }
    }

    if (info.username) {
        const json = await youtubeRequest("channels", {
            part: "snippet,statistics",
            forUsername: info.username
        });

        if (json.items?.length) {
            return json.items[0].id;
        }
    }

    /*
     * Dernier recours :
     * recherche YouTube par nom.
     */
    const search = await youtubeRequest("search", {
        part: "snippet",
        q: cleanUsername(value),
        type: "channel",
        maxResults: "5"
    });

    if (search.items?.length) {
        return search.items[0].snippet.channelId;
    }

    return null;
}

async function searchYouTubeProfile(value) {
    const cacheKey =
        `search:youtube:${String(value).toLowerCase()}`;

    const cached = cacheGet(cacheKey);

    if (cached) {
        return cached;
    }

    try {
        const channelId = await resolveYouTubeChannel(value);

        if (!channelId) {
            return {
                platform: "youtube",
                type: "profile",
                found: false,
                message: "Chaîne YouTube introuvable."
            };
        }

        const channelData = await youtubeRequest("channels", {
            part: "snippet,statistics",
            id: channelId
        });

        if (!channelData.items?.length) {
            return {
                platform: "youtube",
                type: "profile",
                found: false,
                message: "Chaîne YouTube introuvable."
            };
        }

        const channel = channelData.items[0];

        const searchData = await youtubeRequest("search", {
            part: "snippet",
            channelId,
            type: "video",
            order: "date",
            maxResults: "12"
        });

        const videoIds =
            searchData.items
                ?.map(item => item.id?.videoId)
                .filter(Boolean)
                .join(",");

        let videoStats = [];

        if (videoIds) {
            const videos = await youtubeRequest("videos", {
                part: "snippet,statistics",
                id: videoIds
            });

            videoStats = videos.items || [];
        }

        const videos = videoStats.map(item => ({
            id: item.id,
            platform: "youtube",
            type: "video",
            url: `https://www.youtube.com/watch?v=${item.id}`,
            title: item.snippet?.title || "Vidéo YouTube",
            thumbnail:
                item.snippet?.thumbnails?.high?.url ||
                item.snippet?.thumbnails?.medium?.url ||
                item.snippet?.thumbnails?.default?.url ||
                "",
            views: Number(item.statistics?.viewCount) || 0,
            likes: Number(item.statistics?.likeCount) || 0,
            shares: 0,
            createTime: item.snippet?.publishedAt
                ? Math.floor(
                    new Date(item.snippet.publishedAt).getTime() / 1000
                )
                : null
        }));

        const result = {
            platform: "youtube",
            type: "profile",
            found: true,
            profile: {
                id: channel.id,
                title: channel.snippet?.title || "",
                description: channel.snippet?.description || "",
                avatar:
                    channel.snippet?.thumbnails?.high?.url ||
                    channel.snippet?.thumbnails?.medium?.url ||
                    channel.snippet?.thumbnails?.default?.url ||
                    "",
                subscribers:
                    Number(channel.statistics?.subscriberCount) || 0,
                videosCount:
                    Number(channel.statistics?.videoCount) || 0
            },
            videos
        };

        cacheSet(cacheKey, result, CACHE_SEARCH);

        return result;
    } catch (error) {
        console.error("Erreur recherche YouTube :", error.message);

        return {
            platform: "youtube",
            type: "profile",
            found: false,
            message: error.message
        };
    }
}

/*
|--------------------------------------------------------------------------
| TIKTOK
|--------------------------------------------------------------------------
*/

/*
 * TikTok change régulièrement son HTML.
 *
 * On récupère les différents blocs JSON que TikTok embarque
 * actuellement / historiquement dans ses pages.
 */

function extractJsonScript(html, id) {
    const regex = new RegExp(
        `<script[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/script>`,
        "i"
    );

    const match = html.match(regex);

    if (!match) return null;

    try {
        return JSON.parse(match[1]);
    } catch (_) {
        return null;
    }
}

function extractJsonFromScripts(html) {
    const results = [];

    const scripts = [
        ...html.matchAll(
            /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi
        )
    ];

    for (const match of scripts) {
        try {
            results.push(JSON.parse(match[1]));
        } catch (_) {
            // JSON non valide, on continue.
        }
    }

    return results;
}

function deepFindObjectsByKeys(root, requiredKeys) {
    const found = [];
    const visited = new Set();

    function walk(value) {
        if (!value || typeof value !== "object") return;

        if (visited.has(value)) return;
        visited.add(value);

        if (!Array.isArray(value)) {
            const keys = Object.keys(value);

            if (requiredKeys.every(key => keys.includes(key))) {
                found.push(value);
            }
        }

        if (Array.isArray(value)) {
            for (const child of value) {
                walk(child);
            }
        } else {
            for (const child of Object.values(value)) {
                walk(child);
            }
        }
    }

    walk(root);

    return found;
}

function findFirstDeep(root, predicate) {
    let result = null;

    const visited = new Set();

    function walk(value) {
        if (result !== null) return;

        if (!value || typeof value !== "object") return;

        if (visited.has(value)) return;
        visited.add(value);

        try {
            if (predicate(value)) {
                result = value;
                return;
            }
        } catch (_) {}

        if (Array.isArray(value)) {
            for (const child of value) {
                walk(child);
                if (result !== null) return;
            }
        } else {
            for (const child of Object.values(value)) {
                walk(child);
                if (result !== null) return;
            }
        }
    }

    walk(root);

    return result;
}

function getTikTokProfileUrl(username) {
    return `https://www.tiktok.com/@${encodeURIComponent(
        cleanUsername(username)
    )}`;
}

function normalizeTikTokVideo(video) {
    if (!video || typeof video !== "object") return null;

    const id =
        video.id ||
        video.videoId ||
        video.aweme_id ||
        video.awemeId;

    if (!id) return null;

    const stats = video.stats || video.statistics || {};

    const title =
        video.desc ||
        video.description ||
        video.title ||
        "";

    const views =
        Number(
            stats.playCount ??
            stats.play_count ??
            video.playCount ??
            video.play_count ??
            0
        ) || 0;

    const likes =
        Number(
            stats.diggCount ??
            stats.digg_count ??
            video.diggCount ??
            video.likeCount ??
            0
        ) || 0;

    const shares =
        Number(
            stats.shareCount ??
            stats.share_count ??
            video.shareCount ??
            0
        ) || 0;

    let thumbnail = "";

    if (typeof video.cover === "string") {
        thumbnail = video.cover;
    }

    if (!thumbnail && typeof video.originCover === "string") {
        thumbnail = video.originCover;
    }

    if (!thumbnail && typeof video.cover?.urlList?.[0] === "string") {
        thumbnail = video.cover.urlList[0];
    }

    if (
        !thumbnail &&
        typeof video.video?.cover?.urlList?.[0] === "string"
    ) {
        thumbnail = video.video.cover.urlList[0];
    }

    const createTime =
        Number(
            video.createTime ??
            video.create_time ??
            0
        ) || null;

    return {
        id: String(id),
        platform: "tiktok",
        type: "video",
        url: `https://www.tiktok.com/@_/video/${id}`,
        title: title || "Vidéo TikTok",
        thumbnail,
        views,
        likes,
        shares,
        createTime
    };
}

function findTikTokVideosFromObject(root) {
    const videos = [];

    const candidates = deepFindObjectsByKeys(root, [
        "id"
    ]);

    for (const candidate of candidates) {
        const normalized = normalizeTikTokVideo(candidate);

        if (normalized) {
            videos.push(normalized);
        }
    }

    return videos;
}

function uniqueVideos(videos) {
    const map = new Map();

    for (const video of videos) {
        if (!video?.id) continue;

        if (!map.has(video.id)) {
            map.set(video.id, video);
        }
    }

    return [...map.values()];
}

function extractTikTokProfileFromHtml(html, username) {
    const jsonRoots = [];

    const ids = [
        "__UNIVERSAL_DATA_FOR_REHYDRATION__",
        "SIGI_STATE",
        "__NEXT_DATA__"
    ];

    for (const id of ids) {
        const data = extractJsonScript(html, id);

        if (data) {
            jsonRoots.push(data);
        }
    }

    jsonRoots.push(...extractJsonFromScripts(html));

    let nickname = "";
    let avatar = "";
    let followers = 0;
    let following = 0;
    let likesTotal = 0;

    /*
     * Recherche du bloc utilisateur.
     */
    for (const root of jsonRoots) {
        const user = findFirstDeep(root, obj => {
            return (
                obj &&
                typeof obj === "object" &&
                (
                    obj.uniqueId === cleanUsername(username) ||
                    obj.unique_id === cleanUsername(username)
                )
            );
        });

        if (user) {
            nickname =
                user.nickname ||
                user.nickName ||
                nickname;

            followers =
                Number(
                    user.followerCount ??
                    user.follower_count ??
                    0
                ) || followers;

            following =
                Number(
                    user.followingCount ??
                    user.following_count ??
                    0
                ) || following;

            likesTotal =
                Number(
                    user.heartCount ??
                    user.heart_count ??
                    0
                ) || likesTotal;

            avatar =
                user.avatarLarger ||
                user.avatarMedium ||
                user.avatarThumb ||
                avatar;

            if (user.avatarLarger?.urlList?.[0]) {
                avatar = user.avatarLarger.urlList[0];
            }

            if (user.avatarMedium?.urlList?.[0]) {
                avatar = user.avatarMedium.urlList[0];
            }
        }
    }

    /*
     * Recherche de toutes les vidéos embarquées.
     */
    let videos = [];

    for (const root of jsonRoots) {
        videos.push(...findTikTokVideosFromObject(root));
    }

    /*
     * Quelques structures TikTok utilisent directement
     * une liste itemList.
     */
    for (const root of jsonRoots) {
        const itemLists = deepFindObjectsByKeys(root, [
            "itemList"
        ]);

        for (const block of itemLists) {
            if (Array.isArray(block.itemList)) {
                for (const item of block.itemList) {
                    const normalized = normalizeTikTokVideo(item);

                    if (normalized) {
                        videos.push(normalized);
                    }
                }
            }
        }
    }

    videos = uniqueVideos(videos)
        .slice(0, 24);

    /*
     * Fallback :
     * si les objets JSON sont absents, on tente de récupérer
     * les IDs vidéo directement dans le HTML.
     */
    if (!videos.length) {
        const idMatches = [
            ...html.matchAll(
                /"id":"(\d{10,25})"/g
            )
        ];

        for (const match of idMatches) {
            const id = match[1];

            videos.push({
                id,
                platform: "tiktok",
                type: "video",
                url: `https://www.tiktok.com/@${cleanUsername(username)}/video/${id}`,
                title: "Vidéo TikTok",
                thumbnail: "",
                views: 0,
                likes: 0,
                shares: 0,
                createTime: null
            });
        }

        videos = uniqueVideos(videos).slice(0, 24);
    }

    /*
     * On peut avoir un profil valide sans réussir à extraire
     * les vidéos.
     */
    const profileDetected =
        nickname ||
        avatar ||
        followers > 0 ||
        videos.length > 0 ||
        html.includes(`@${cleanUsername(username)}`);

    if (!profileDetected) {
        return null;
    }

    return {
        platform: "tiktok",
        type: "profile",
        found: true,
        profile: {
            username: cleanUsername(username),
            nickname:
                nickname ||
                cleanUsername(username),
            avatar,
            followers,
            following,
            likes: likesTotal,
            url: getTikTokProfileUrl(username)
        },
        videos
    };
}

async function searchTikTokProfile(value) {
    const username = cleanUsername(value);

    const cacheKey =
        `search:tiktok:${username.toLowerCase()}`;

    const cached = cacheGet(cacheKey);

    if (cached) {
        return cached;
    }

    if (!username) {
        return {
            platform: "tiktok",
            type: "profile",
            found: false,
            message: "Nom d'utilisateur TikTok manquant."
        };
    }

    try {
        const url = getTikTokProfileUrl(username);

        const html = await fetchText(url);

        const result =
            extractTikTokProfileFromHtml(
                html,
                username
            );

        if (!result) {
            return {
                platform: "tiktok",
                type: "profile",
                found: false,
                message:
                    "Profil TikTok introuvable ou données publiques non disponibles."
            };
        }

        cacheSet(cacheKey, result, CACHE_SEARCH);

        return result;
    } catch (error) {
        console.error(
            "Erreur recherche TikTok :",
            error.message
        );

        return {
            platform: "tiktok",
            type: "profile",
            found: false,
            message:
                "Impossible de récupérer ce profil TikTok.",
            error: error.message
        };
    }
}

/*
|--------------------------------------------------------------------------
| TIKTOK — STATS VIDÉO
|--------------------------------------------------------------------------
|
| On garde ici une récupération publique de la page vidéo.
|
*/

async function getTikTokStats(url) {
    const cacheKey = `stats:tiktok:${url}`;

    const cached = cacheGet(cacheKey);

    if (cached) {
        return cached;
    }

    try {
        const html = await fetchText(url);

        let views = 0;
        let likes = 0;
        let shares = 0;
        let title = "Vidéo TikTok";
        let createTime = null;
        let thumbnail = "";

        /*
         * Cherche les structures JSON.
         */
        const roots = [];

        const ids = [
            "__UNIVERSAL_DATA_FOR_REHYDRATION__",
            "SIGI_STATE",
            "__NEXT_DATA__"
        ];

        for (const id of ids) {
            const data = extractJsonScript(html, id);

            if (data) {
                roots.push(data);
            }
        }

        roots.push(...extractJsonFromScripts(html));

        for (const root of roots) {
            const candidates =
                deepFindObjectsByKeys(root, ["id"]);

            for (const candidate of candidates) {
                const normalized =
                    normalizeTikTokVideo(candidate);

                if (!normalized) continue;

                const requestedId =
                    extractTikTokVideoId(url);

                if (
                    requestedId &&
                    String(normalized.id) !==
                    String(requestedId)
                ) {
                    continue;
                }

                views = normalized.views;
                likes = normalized.likes;
                shares = normalized.shares;
                title = normalized.title;
                createTime = normalized.createTime;
                thumbnail = normalized.thumbnail;

                if (
                    views ||
                    likes ||
                    title !== "Vidéo TikTok"
                ) {
                    break;
                }
            }

            if (views || likes) break;
        }

        /*
         * Fallback regex.
         */
        if (!views) {
            const match =
                html.match(
                    /"playCount"\s*:\s*(\d+)/i
                );

            if (match) {
                views = Number(match[1]);
            }
        }

        if (!likes) {
            const match =
                html.match(
                    /"diggCount"\s*:\s*(\d+)/i
                );

            if (match) {
                likes = Number(match[1]);
            }
        }

        if (!shares) {
            const match =
                html.match(
                    /"shareCount"\s*:\s*(\d+)/i
                );

            if (match) {
                shares = Number(match[1]);
            }
        }

        if (title === "Vidéo TikTok") {
            const match =
                html.match(
                    /"desc"\s*:\s*"((?:\\.|[^"\\])*)"/
                );

            if (match) {
                try {
                    title =
                        JSON.parse(`"${match[1]}"`);
                } catch (_) {
                    title = match[1];
                }
            }
        }

        const data = {
            platform: "tiktok",
            type: "video",
            id: extractTikTokVideoId(url),
            url,
            views,
            likes,
            shares,
            title,
            thumbnail,
            createTime
        };

        cacheSet(cacheKey, data, CACHE_STATS);

        return data;
    } catch (error) {
        console.error(
            "Erreur fetch TikTok :",
            error.message
        );

        return {
            platform: "tiktok",
            type: "video",
            views: 0,
            likes: 0,
            shares: 0,
            title: "Erreur TikTok",
            error: error.message
        };
    }
}

function extractTikTokVideoId(url) {
    const match =
        String(url).match(
            /\/video\/(\d+)/
        );

    return match ? match[1] : null;
}

/*
|--------------------------------------------------------------------------
| RECHERCHE AUTOMATIQUE
|--------------------------------------------------------------------------
*/

function looksLikeVideoUrl(value) {
    return (
        /\/video\/\d+/i.test(value) ||
        /[?&]v=[a-zA-Z0-9_-]{11}/i.test(value) ||
        /youtu\.be\/[a-zA-Z0-9_-]{11}/i.test(value) ||
        /\/shorts\/[a-zA-Z0-9_-]{11}/i.test(value)
    );
}

app.get("/search", async (req, res) => {
    const raw = String(req.query.q || "").trim();

    if (!raw) {
        return res.json({
            error: "Recherche vide."
        });
    }

    const platformFromUrl = detectPlatform(raw);

    /*
     * URL vidéo => suivi direct.
     */
    if (
        platformFromUrl &&
        looksLikeVideoUrl(raw)
    ) {
        if (platformFromUrl === "youtube") {
            return res.json(
                await getYouTubeStats(raw)
            );
        }

        return res.json(
            await getTikTokStats(raw)
        );
    }

    /*
     * URL de profil ou @username.
     */
    let platform = platformFromUrl;

    if (!platform) {
        /*
         * Sans URL, @username est compatible avec les deux.
         *
         * On essaie d'abord TikTok, puis YouTube.
         */
        if (raw.startsWith("@")) {
            const tiktok =
                await searchTikTokProfile(raw);

            if (tiktok.found) {
                return res.json(tiktok);
            }

            const youtube =
                await searchYouTubeProfile(raw);

            return res.json(youtube);
        }

        return res.json({
            error:
                "Utilise un lien vidéo ou un nom d'utilisateur commençant par @."
        });
    }

    if (platform === "tiktok") {
        return res.json(
            await searchTikTokProfile(raw)
        );
    }

    if (platform === "youtube") {
        return res.json(
            await searchYouTubeProfile(raw)
        );
    }

    return res.json({
        error: "Recherche impossible."
    });
});

/*
|--------------------------------------------------------------------------
| ROUTE STATS — COMPATIBILITÉ
|--------------------------------------------------------------------------
*/

app.get("/stats", async (req, res) => {
    const url = String(req.query.url || "").trim();

    if (!url) {
        return res.json({
            error: "Lien manquant"
        });
    }

    const platform = detectPlatform(url);

    if (platform === "youtube") {
        return res.json(
            await getYouTubeStats(url)
        );
    }

    if (platform === "tiktok") {
        return res.json(
            await getTikTokStats(url)
        );
    }

    return res.json({
        error:
            "Plateforme non reconnue (TikTok ou YouTube uniquement)"
    });
});

/*
|--------------------------------------------------------------------------
| COMPARE — COMPATIBILITÉ
|--------------------------------------------------------------------------
*/

app.get("/compare", async (req, res) => {
    const urlA = String(req.query.urlA || "").trim();
    const urlB = String(req.query.urlB || "").trim();

    if (!urlA || !urlB) {
        return res.json({
            error:
                "Les deux liens urlA et urlB sont requis."
        });
    }

    async function fetchOne(url) {
        const platform = detectPlatform(url);

        if (platform === "youtube") {
            return getYouTubeStats(url);
        }

        if (platform === "tiktok") {
            return getTikTokStats(url);
        }

        return {
            platform: null,
            views: 0,
            likes: 0,
            shares: 0,
            title: "URL invalide",
            error: "Plateforme non reconnue."
        };
    }

    const [a, b] = await Promise.all([
        fetchOne(urlA),
        fetchOne(urlB)
    ]);

    res.json({ a, b });
});

/*
|--------------------------------------------------------------------------
| NETTOYAGE CACHE
|--------------------------------------------------------------------------
*/

setInterval(() => {
    const now = Date.now();

    for (const [key, item] of cache.entries()) {
        if (now - item.time > item.ttl) {
            cache.delete(key);
        }
    }
}, 60000);

/*
|--------------------------------------------------------------------------
| SERVER
|--------------------------------------------------------------------------
*/

app.listen(PORT, () => {
    console.log(
        `🚀 TikTok Pulse lancé sur http://localhost:${PORT}`
    );

    if (!YOUTUBE_API_KEY) {
        console.log(
            "⚠️ YOUTUBE_API_KEY n'est pas configurée."
        );
    } else {
        console.log(
            "✓ YouTube API configurée."
        );
    }
});
