const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

/*
=========================================================
CONFIGURATION
=========================================================
*/

const PORT = process.env.PORT || 3000;

const YOUTUBE_API_KEY =
    process.env.YOUTUBE_API_KEY || "AIzaSyDQNrpnW3W6Ezu34Ngcv7_mFYoefhNYa2A";

/*
=========================================================
CACHE
=========================================================
*/

const cache = new Map();

const CACHE_TTL_STATS = 3000;
const CACHE_TTL_PROFILE = 15000;

function getCache(key) {
    const item = cache.get(key);

    if (!item) return null;

    if (Date.now() - item.time > item.ttl) {
        cache.delete(key);
        return null;
    }

    return item.data;
}

function setCache(key, data, ttl) {
    cache.set(key, {
        data,
        time: Date.now(),
        ttl
    });
}

/*
=========================================================
UTILITAIRES
=========================================================
*/

function cleanNumber(value) {
    if (value === null || value === undefined) return 0;

    if (typeof value === "number") {
        return Number.isFinite(value) ? value : 0;
    }

    const n = Number(
        String(value)
            .replace(/[^\d.-]/g, "")
    );

    return Number.isFinite(n) ? n : 0;
}

function decodeHtml(str = "") {
    return str
        .replace(/\\u002F/g, "/")
        .replace(/\\u0026/g, "&")
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/\\n/g, " ")
        .replace(/\\r/g, " ")
        .trim();
}

function normalizeTikTokUsername(input) {
    let value = String(input || "").trim();

    value = value.replace(/^@/, "");

    const match = value.match(
        /tiktok\.com\/@([^/?#]+)/i
    );

    if (match) {
        return match[1];
    }

    return value.split(/[/?#\s]/)[0];
}

function detectPlatform(url) {
    const value = String(url || "").trim();

    if (/tiktok\.com/i.test(value)) {
        return "tiktok";
    }

    if (/youtube\.com|youtu\.be/i.test(value)) {
        return "youtube";
    }

    return null;
}

/*
=========================================================
FETCH
=========================================================
*/

async function fetchText(url, options = {}) {
    const response = await fetch(url, {
        redirect: "follow",
        ...options
    });

    const text = await response.text();

    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status} sur ${new URL(url).hostname}`
        );
    }

    return text;
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
        redirect: "follow",
        ...options
    });

    const text = await response.text();

    let json;

    try {
        json = JSON.parse(text);
    } catch {
        throw new Error(
            `Réponse JSON invalide (${response.status})`
        );
    }

    if (!response.ok) {
        throw new Error(
            json?.error?.message ||
            json?.message ||
            `HTTP ${response.status}`
        );
    }

    return json;
}

/*
=========================================================
YOUTUBE
=========================================================
*/

function extractYouTubeId(url) {

    const patterns = [
        /(?:v=|\/embed\/|\/shorts\/|\/live\/)([a-zA-Z0-9_-]{11})/,
        /youtu\.be\/([a-zA-Z0-9_-]{11})/
    ];

    for (const pattern of patterns) {
        const match = String(url).match(pattern);

        if (match) {
            return match[1];
        }
    }

    return null;
}

function extractYouTubeHandle(input) {

    const value = String(input || "").trim();

    const match = value.match(
        /youtube\.com\/@([^/?#]+)/i
    );

    if (match) {
        return match[1];
    }

    if (value.startsWith("@")) {
        return value.substring(1);
    }

    return null;
}

function extractYouTubeChannelId(input) {

    const match = String(input || "").match(
        /youtube\.com\/channel\/([a-zA-Z0-9_-]+)/i
    );

    return match ? match[1] : null;
}

async function youtubeRequest(endpoint, params) {

    if (
        !YOUTUBE_API_KEY ||
        YOUTUBE_API_KEY === "TA_CLE_YOUTUBE_ICI"
    ) {
        throw new Error(
            "YOUTUBE_API_KEY n'est pas configurée."
        );
    }

    const url =
        "https://www.googleapis.com/youtube/v3/" +
        endpoint +
        "?" +
        new URLSearchParams({
            ...params,
            key: YOUTUBE_API_KEY
        }).toString();

    return fetchJson(url);
}

async function getYouTubeStats(url) {

    const cacheKey = `yt:stats:${url}`;

    const cached = getCache(cacheKey);

    if (cached) {
        return cached;
    }

    const videoId = extractYouTubeId(url);

    if (!videoId) {
        return {
            platform: "youtube",
            views: 0,
            likes: 0,
            shares: 0,
            title: "Lien YouTube invalide",
            error: "ID vidéo introuvable"
        };
    }

    try {

        const json = await youtubeRequest(
            "videos",
            {
                part: "snippet,statistics",
                id: videoId
            }
        );

        if (!json.items?.length) {

            return {
                platform: "youtube",
                views: 0,
                likes: 0,
                shares: 0,
                title: "Vidéo introuvable",
                error: json.error?.message || "Aucun résultat"
            };
        }

        const item = json.items[0];

        const stats = item.statistics || {};
        const snippet = item.snippet || {};

        const data = {
            platform: "youtube",
            id: videoId,
            url: `https://www.youtube.com/watch?v=${videoId}`,
            views: cleanNumber(stats.viewCount),
            likes: cleanNumber(stats.likeCount),
            shares: 0,
            title: snippet.title || "Vidéo YouTube",
            createTime: snippet.publishedAt
                ? Math.floor(
                    new Date(snippet.publishedAt).getTime() / 1000
                )
                : null,
            thumbnail:
                snippet.thumbnails?.high?.url ||
                snippet.thumbnails?.medium?.url ||
                snippet.thumbnails?.default?.url ||
                null
        };

        setCache(
            cacheKey,
            data,
            CACHE_TTL_STATS
        );

        return data;

    } catch (error) {

        console.error(
            "Erreur YouTube stats:",
            error.message
        );

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

/*
---------------------------------------------------------
YouTube : récupérer une chaîne
---------------------------------------------------------
*/

async function getYouTubeChannel(input) {

    const handle = extractYouTubeHandle(input);
    const channelId = extractYouTubeChannelId(input);

    let json;

    if (channelId) {

        json = await youtubeRequest(
            "channels",
            {
                part: "snippet,contentDetails,statistics",
                id: channelId
            }
        );

    } else if (handle) {

        json = await youtubeRequest(
            "channels",
            {
                part: "snippet,contentDetails,statistics",
                forHandle: handle
            }
        );

    } else {

        const query = String(input)
            .replace(/^@/, "")
            .trim();

        const search = await youtubeRequest(
            "search",
            {
                part: "snippet",
                q: query,
                type: "channel",
                maxResults: 5
            }
        );

        if (!search.items?.length) {
            throw new Error(
                "Chaîne YouTube introuvable."
            );
        }

        const first = search.items[0];

        json = await youtubeRequest(
            "channels",
            {
                part: "snippet,contentDetails,statistics",
                id: first.id.channelId
            }
        );
    }

    if (!json.items?.length) {
        throw new Error(
            "Chaîne YouTube introuvable."
        );
    }

    return json.items[0];
}

/*
---------------------------------------------------------
YouTube : dernières vidéos
---------------------------------------------------------
*/

async function getYouTubeProfile(input) {

    const cacheKey = `yt:profile:${input}`;

    const cached = getCache(cacheKey);

    if (cached) {
        return cached;
    }

    try {

        const channel =
            await getYouTubeChannel(input);

        const uploads =
            channel.contentDetails
                ?.relatedPlaylists
                ?.uploads;

        if (!uploads) {
            throw new Error(
                "Playlist des vidéos introuvable."
            );
        }

        const playlist =
            await youtubeRequest(
                "playlistItems",
                {
                    part: "snippet,contentDetails",
                    playlistId: uploads,
                    maxResults: 12
                }
            );

        const ids = (playlist.items || [])
            .map(item =>
                item.contentDetails?.videoId ||
                item.snippet?.resourceId?.videoId
            )
            .filter(Boolean);

        let stats = {};

        if (ids.length) {

            const statsResponse =
                await youtubeRequest(
                    "videos",
                    {
                        part: "snippet,statistics",
                        id: ids.join(",")
                    }
                );

            for (const item of statsResponse.items || []) {
                stats[item.id] = item;
            }
        }

        const videos =
            ids.map(id => {

                const item = stats[id];

                if (!item) return null;

                return {
                    platform: "youtube",
                    id,
                    url: `https://www.youtube.com/watch?v=${id}`,
                    title:
                        item.snippet?.title ||
                        "Vidéo YouTube",
                    views: cleanNumber(
                        item.statistics?.viewCount
                    ),
                    likes: cleanNumber(
                        item.statistics?.likeCount
                    ),
                    shares: 0,
                    createTime:
                        item.snippet?.publishedAt
                            ? Math.floor(
                                new Date(
                                    item.snippet.publishedAt
                                ).getTime() / 1000
                            )
                            : null,
                    thumbnail:
                        item.snippet?.thumbnails?.high?.url ||
                        item.snippet?.thumbnails?.medium?.url ||
                        item.snippet?.thumbnails?.default?.url ||
                        null
                };
            })
            .filter(Boolean);

        const data = {
            platform: "youtube",
            profile: {
                id: channel.id,
                name: channel.snippet?.title || "",
                handle:
                    channel.snippet?.customUrl ||
                    "",
                avatar:
                    channel.snippet?.thumbnails?.high?.url ||
                    channel.snippet?.thumbnails?.medium?.url ||
                    channel.snippet?.thumbnails?.default?.url ||
                    null,
                subscribers:
                    cleanNumber(
                        channel.statistics?.subscriberCount
                    )
            },
            videos
        };

        setCache(
            cacheKey,
            data,
            CACHE_TTL_PROFILE
        );

        return data;

    } catch (error) {

        console.error(
            "Erreur profil YouTube:",
            error.message
        );

        throw error;
    }
}

/*
=========================================================
TIKTOK
=========================================================
*/

/*
TikTok change régulièrement son HTML.

On utilise plusieurs méthodes :

1. JSON embarqué dans la page
2. données __UNIVERSAL_DATA_FOR_REHYDRATION__
3. endpoint user/detail
4. endpoint post/item_list
5. extraction directe des URLs /@user/video/ID

L'objectif est de ne pas dépendre d'une seule regex.
*/

const TIKTOK_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/131.0.0.0 Safari/537.36",
    "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language":
        "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache"
};

function extractTikTokId(url) {

    const match =
        String(url).match(
            /tiktok\.com\/@[^/]+\/video\/(\d+)/i
        );

    return match ? match[1] : null;
}

function findObjectsContainingKeys(
    root,
    requiredKeys,
    results = [],
    depth = 0
) {

    if (
        root === null ||
        root === undefined ||
        depth > 12
    ) {
        return results;
    }

    if (typeof root !== "object") {
        return results;
    }

    if (!Array.isArray(root)) {

        const keys = Object.keys(root);

        const hasAll =
            requiredKeys.every(key =>
                keys.includes(key)
            );

        if (hasAll) {
            results.push(root);
        }
    }

    if (results.length > 300) {
        return results;
    }

    for (const value of Object.values(root)) {

        findObjectsContainingKeys(
            value,
            requiredKeys,
            results,
            depth + 1
        );

        if (results.length > 300) {
            break;
        }
    }

    return results;
}

function safeJsonParse(value) {

    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function extractEmbeddedTikTokJson(html) {

    const roots = [];

    /*
    __UNIVERSAL_DATA_FOR_REHYDRATION__
    */

    const universalMatch =
        html.match(
            /<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i
        );

    if (universalMatch) {

        const parsed =
            safeJsonParse(
                decodeHtml(universalMatch[1])
            );

        if (parsed) {
            roots.push(parsed);
        }
    }

    /*
    SIGI_STATE
    */

    const sigiMatch =
        html.match(
            /<script[^>]+id=["']SIGI_STATE["'][^>]*>([\s\S]*?)<\/script>/i
        );

    if (sigiMatch) {

        const parsed =
            safeJsonParse(
                decodeHtml(sigiMatch[1])
            );

        if (parsed) {
            roots.push(parsed);
        }
    }

    /*
    JSON-LD
    */

    const jsonLdMatches =
        html.matchAll(
            /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
        );

    for (const match of jsonLdMatches) {

        const parsed =
            safeJsonParse(
                decodeHtml(match[1])
            );

        if (parsed) {
            roots.push(parsed);
        }
    }

    return roots;
}

function normalizeTikTokVideoObject(obj) {

    if (!obj || typeof obj !== "object") {
        return null;
    }

    const id =
        obj.id ||
        obj.videoId ||
        obj.aweme_id ||
        obj.awemeId;

    if (!id) {
        return null;
    }

    const videoId = String(id);

    if (!/^\d{8,30}$/.test(videoId)) {
        return null;
    }

    const title =
        obj.desc ||
        obj.description ||
        obj.title ||
        obj.text ||
        "Vidéo TikTok";

    const stats =
        obj.stats ||
        obj.statistics ||
        {};

    const views =
        cleanNumber(
            obj.playCount ??
            obj.play_count ??
            stats.playCount ??
            stats.play_count ??
            stats.viewCount ??
            stats.views
        );

    const likes =
        cleanNumber(
            obj.diggCount ??
            obj.digg_count ??
            stats.diggCount ??
            stats.digg_count ??
            stats.likeCount ??
            stats.likes
        );

    const shares =
        cleanNumber(
            obj.shareCount ??
            obj.share_count ??
            stats.shareCount ??
            stats.share_count ??
            stats.shares
        );

    const createTime =
        cleanNumber(
            obj.createTime ??
            obj.create_time ??
            obj.createTimestamp
        );

    let author =
        obj.author ||
        obj.authorInfo ||
        {};

    if (typeof author === "string") {
        author = {
            uniqueId: author
        };
    }

    const username =
        author.uniqueId ||
        author.unique_id ||
        author.nickname ||
        "";

    let url =
        obj.shareUrl ||
        obj.share_url ||
        obj.url ||
        "";

    if (!url && username) {
        url =
            `https://www.tiktok.com/@${username}/video/${videoId}`;
    }

    if (!url) {
        url =
            `https://www.tiktok.com/video/${videoId}`;
    }

    return {
        platform: "tiktok",
        id: videoId,
        url,
        title: decodeHtml(String(title)),
        views,
        likes,
        shares,
        createTime: createTime || null,
        thumbnail:
            obj.video?.cover ||
            obj.video?.originCover ||
            obj.video?.dynamicCover ||
            obj.cover ||
            obj.coverUrl ||
            null
    };
}

function extractTikTokVideosFromRoots(roots) {

    const videos = new Map();

    for (const root of roots) {

        const objects =
            findObjectsContainingKeys(
                root,
                ["id"]
            );

        for (const object of objects) {

            const video =
                normalizeTikTokVideoObject(
                    object
                );

            if (!video) continue;

            if (!videos.has(video.id)) {
                videos.set(video.id, video);
            }
        }
    }

    return [...videos.values()];
}

function extractTikTokVideoIdsFromHtml(
    html,
    username
) {

    const found = new Map();

    const patterns = [

        new RegExp(
            `tiktok\\.com/@${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/video/(\\d+)`,
            "gi"
        ),

        /\/video\/(\d{8,30})/gi,

        /"id":"(\d{8,30})"/gi,

        /"aweme_id":"(\d{8,30})"/gi
    ];

    for (const pattern of patterns) {

        for (const match of html.matchAll(pattern)) {

            const id = match[1];

            if (!found.has(id)) {

                found.set(id, {
                    platform: "tiktok",
                    id,
                    url:
                        `https://www.tiktok.com/@${username}/video/${id}`,
                    title: "Vidéo TikTok",
                    views: 0,
                    likes: 0,
                    shares: 0,
                    createTime: null,
                    thumbnail: null
                });
            }
        }
    }

    return [...found.values()];
}

async function getTikTokProfileHtml(
    username
) {

    const urls = [
        `https://www.tiktok.com/@${encodeURIComponent(username)}`,
        `https://www.tiktok.com/@${encodeURIComponent(username)}?lang=fr-FR`
    ];

    let lastError = null;

    for (const url of urls) {

        try {

            const html =
                await fetchText(
                    url,
                    {
                        headers: {
                            ...TIKTOK_HEADERS,
                            Referer: "https://www.tiktok.com/"
                        }
                    }
                );

            if (html && html.length > 1000) {
                return html;
            }

        } catch (error) {

            lastError = error;
        }
    }

    throw (
        lastError ||
        new Error(
            "Impossible de charger le profil TikTok."
        )
    );
}

async function getTikTokProfile(
    input
) {

    const username =
        normalizeTikTokUsername(input);

    if (!username) {
        throw new Error(
            "Pseudo TikTok invalide."
        );
    }

    const cacheKey =
        `tt:profile:${username.toLowerCase()}`;

    const cached =
        getCache(cacheKey);

    if (cached) {
        return cached;
    }

    let html = "";

    try {

        html =
            await getTikTokProfileHtml(
                username
            );

    } catch (error) {

        console.error(
            "TikTok profil HTML:",
            error.message
        );
    }

    let videos = [];

    /*
    -----------------------------------------------------
    MÉTHODE 1 : JSON embarqué
    -----------------------------------------------------
    */

    if (html) {

        const roots =
            extractEmbeddedTikTokJson(
                html
            );

        videos =
            extractTikTokVideosFromRoots(
                roots
            );
    }

    /*
    -----------------------------------------------------
    MÉTHODE 2 : URLs vidéo présentes dans le HTML
    -----------------------------------------------------
    */

    if (html && videos.length < 3) {

        const direct =
            extractTikTokVideoIdsFromHtml(
                html,
                username
            );

        for (const video of direct) {

            if (
                !videos.some(
                    item => item.id === video.id
                )
            ) {
                videos.push(video);
            }
        }
    }

    /*
    -----------------------------------------------------
    MÉTHODE 3 : endpoint public user/detail
    -----------------------------------------------------
    */

    let secUid = null;

    const detailUrls = [
        `https://www.tiktok.com/api/user/detail/?aid=1988&unique_id=${encodeURIComponent(username)}`,
        `https://www.tiktok.com/api/user/detail/?unique_id=${encodeURIComponent(username)}&aid=1988`
    ];

    for (const url of detailUrls) {

        try {

            const json =
                await fetchJson(
                    url,
                    {
                        headers: {
                            ...TIKTOK_HEADERS,
                            Accept: "application/json",
                            Referer:
                                `https://www.tiktok.com/@${username}`
                        }
                    }
                );

            const user =
                json?.userInfo?.user ||
                json?.user ||
                json?.data?.user ||
                {};

            secUid =
                user.secUid ||
                user.sec_uid ||
                json?.userInfo?.user?.secUid ||
                null;

            if (secUid) {
                break;
            }

        } catch (error) {

            console.log(
                "TikTok user/detail:",
                error.message
            );
        }
    }

    /*
    -----------------------------------------------------
    MÉTHODE 4 : endpoint post/item_list
    -----------------------------------------------------
    */

    if (secUid) {

        const postUrls = [
            "https://www.tiktok.com/api/post/item_list/",
            "https://www.tiktok.com/api/post/item_list/?aid=1988"
        ];

        for (const base of postUrls) {

            try {

                const separator =
                    base.includes("?")
                        ? "&"
                        : "?";

                const url =
                    `${base}${separator}` +
                    new URLSearchParams({
                        aid: "1988",
                        count: "30",
                        cursor: "0",
                        secUid,
                        device_platform: "webapp",
                        region: "FR",
                        language: "fr"
                    }).toString();

                const json =
                    await fetchJson(
                        url,
                        {
                            headers: {
                                ...TIKTOK_HEADERS,
                                Accept: "application/json",
                                Referer:
                                    `https://www.tiktok.com/@${username}`
                            }
                        }
                    );

                const items =
                    json?.itemList ||
                    json?.item_list ||
                    json?.data?.itemList ||
                    json?.data?.item_list ||
                    [];

                for (const item of items) {

                    const normalized =
                        normalizeTikTokVideoObject(
                            item
                        );

                    if (!normalized) continue;

                    if (
                        !videos.some(
                            video =>
                                video.id ===
                                normalized.id
                        )
                    ) {
                        videos.push(normalized);
                    }
                }

                if (videos.length) {
                    break;
                }

            } catch (error) {

                console.log(
                    "TikTok post/item_list:",
                    error.message
                );
            }
        }
    }

    /*
    -----------------------------------------------------
    NETTOYAGE + TRI
    -----------------------------------------------------
    */

    videos =
        videos
            .filter(video =>
                video &&
                video.id
            )
            .sort(
                (a, b) =>
                    (b.createTime || 0) -
                    (a.createTime || 0)
            )
            .slice(0, 12);

    /*
    -----------------------------------------------------
    Si TikTok nous a donné des vidéos mais sans stats,
    on essaie de récupérer chaque page vidéo.
    -----------------------------------------------------
    */

    if (videos.length) {

        for (const video of videos) {

            if (
                video.views ||
                video.likes ||
                video.shares ||
                video.title !== "Vidéo TikTok"
            ) {
                continue;
            }

            try {

                const stats =
                    await getTikTokStats(
                        video.url
                    );

                if (stats && !stats.error) {

                    Object.assign(
                        video,
                        {
                            views: stats.views,
                            likes: stats.likes,
                            shares: stats.shares,
                            title:
                                stats.title ||
                                video.title,
                            createTime:
                                stats.createTime ||
                                video.createTime,
                            thumbnail:
                                stats.thumbnail ||
                                video.thumbnail
                        }
                    );
                }

            } catch {
                // On garde les données déjà trouvées.
            }
        }
    }

    if (!videos.length) {

        throw new Error(
            "Aucune vidéo publique trouvée pour ce profil TikTok. " +
            "TikTok peut bloquer la récupération automatique du profil."
        );
    }

    const data = {
        platform: "tiktok",
        profile: {
            username,
            url:
                `https://www.tiktok.com/@${username}`
        },
        videos
    };

    setCache(
        cacheKey,
        data,
        CACHE_TTL_PROFILE
    );

    return data;
}

/*
---------------------------------------------------------
TikTok : vidéo individuelle
---------------------------------------------------------
*/

async function getTikTokStats(url) {

    const cacheKey =
        `tt:stats:${url}`;

    const cached =
        getCache(cacheKey);

    if (cached) {
        return cached;
    }

    const videoId =
        extractTikTokId(url);

    if (!videoId) {

        return {
            platform: "tiktok",
            views: 0,
            likes: 0,
            shares: 0,
            title: "Lien TikTok invalide",
            error: "ID vidéo introuvable"
        };
    }

    try {

        const html =
            await fetchText(
                url,
                {
                    headers: TIKTOK_HEADERS
                }
            );

        const roots =
            extractEmbeddedTikTokJson(
                html
            );

        let videos =
            extractTikTokVideosFromRoots(
                roots
            );

        let data =
            videos.find(
                video =>
                    video.id === videoId
            );

        if (!data) {

            const direct =
                extractTikTokVideoIdsFromHtml(
                    html,
                    normalizeTikTokUsername(url)
                );

            data =
                direct.find(
                    video =>
                        video.id === videoId
                );
        }

        if (!data) {

            data = {
                platform: "tiktok",
                id: videoId,
                url,
                views: 0,
                likes: 0,
                shares: 0,
                title: "Vidéo TikTok",
                createTime: null,
                thumbnail: null
            };
        }

        setCache(
            cacheKey,
            data,
            CACHE_TTL_STATS
        );

        return data;

    } catch (error) {

        console.error(
            "Erreur TikTok:",
            error.message
        );

        return {
            platform: "tiktok",
            views: 0,
            likes: 0,
            shares: 0,
            title: "Erreur TikTok",
            error: error.message
        };
    }
}

/*
=========================================================
RECHERCHE / DÉCOUVERTE
=========================================================
*/

function isTikTokProfileInput(input) {

    const value =
        String(input || "").trim();

    if (/^@[\w.-]+$/i.test(value)) {
        return true;
    }

    if (
        /tiktok\.com\/@[\w.-]+\/?$/i.test(
            value.replace(/\/$/, "")
        )
    ) {
        return true;
    }

    return false;
}

function isYouTubeProfileInput(input) {

    const value =
        String(input || "").trim();

    return (
        /^@[\w.-]+$/i.test(value) ||
        /youtube\.com\/@[\w.-]+/i.test(value) ||
        /youtube\.com\/channel\//i.test(value)
    );
}

async function discover(input) {

    const value =
        String(input || "").trim();

    if (!value) {
        throw new Error(
            "Recherche vide."
        );
    }

    const platform =
        detectPlatform(value);

    /*
    -----------------------------------------------------
    Vidéo directe
    -----------------------------------------------------
    */

    if (
        platform === "youtube" &&
        extractYouTubeId(value)
    ) {

        const video =
            await getYouTubeStats(value);

        return {
            type: "video",
            platform: "youtube",
            videos: [video]
        };
    }

    if (
        platform === "tiktok" &&
        extractTikTokId(value)
    ) {

        const video =
            await getTikTokStats(value);

        return {
            type: "video",
            platform: "tiktok",
            videos: [video]
        };
    }

    /*
    -----------------------------------------------------
    Profil YouTube
    -----------------------------------------------------
    */

    if (
        platform === "youtube" ||
        isYouTubeProfileInput(value)
    ) {

        const profile =
            await getYouTubeProfile(value);

        return {
            type: "profile",
            ...profile
        };
    }

    /*
    -----------------------------------------------------
    Profil TikTok
    -----------------------------------------------------
    */

    if (
        platform === "tiktok" ||
        isTikTokProfileInput(value)
    ) {

        const profile =
            await getTikTokProfile(value);

        return {
            type: "profile",
            ...profile
        };
    }

    /*
    -----------------------------------------------------
    Nom générique : on tente YouTube puis TikTok
    -----------------------------------------------------
    */

    try {

        const youtube =
            await getYouTubeProfile(value);

        return {
            type: "profile",
            ...youtube
        };

    } catch {
        // On continue vers TikTok.
    }

    return getTikTokProfile(value);
}

/*
=========================================================
ROUTES
=========================================================
*/

/*
Ancienne route /stats conservée
*/

app.get("/stats", async (req, res) => {

    const url =
        String(req.query.url || "").trim();

    if (!url) {
        return res.json({
            error: "Lien manquant"
        });
    }

    const platform =
        detectPlatform(url);

    try {

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
                "Plateforme non reconnue"
        });

    } catch (error) {

        return res.json({
            error: error.message
        });
    }
});

/*
Nouvelle route découverte
*/

app.get("/discover", async (req, res) => {

    const input =
        String(req.query.input || "").trim();

    if (!input) {

        return res.status(400).json({
            error: "Recherche vide"
        });
    }

    try {

        const result =
            await discover(input);

        res.json(result);

    } catch (error) {

        console.error(
            "Erreur /discover:",
            error.message
        );

        res.status(500).json({
            error: error.message
        });
    }
});

/*
Comparaison rétrocompatible
*/

app.get("/compare", async (req, res) => {

    const urlA =
        String(req.query.urlA || "").trim();

    const urlB =
        String(req.query.urlB || "").trim();

    if (!urlA || !urlB) {

        return res.status(400).json({
            error:
                "Les deux liens sont requis."
        });
    }

    try {

        const [a, b] =
            await Promise.all([
                getStatsAuto(urlA),
                getStatsAuto(urlB)
            ]);

        res.json({
            a,
            b
        });

    } catch (error) {

        res.status(500).json({
            error: error.message
        });
    }
});

async function getStatsAuto(url) {

    const platform =
        detectPlatform(url);

    if (platform === "youtube") {
        return getYouTubeStats(url);
    }

    if (platform === "tiktok") {
        return getTikTokStats(url);
    }

    throw new Error(
        "Plateforme non reconnue."
    );
}

/*
=========================================================
CLEAN CACHE
=========================================================
*/

setInterval(() => {

    const now = Date.now();

    for (const [key, item] of cache.entries()) {

        if (
            now - item.time >
            item.ttl
        ) {
            cache.delete(key);
        }
    }

}, 60000);

/*
=========================================================
START
=========================================================
*/

app.listen(PORT, () => {

    console.log(
        `TikTok Pulse lancé sur le port ${PORT}`
    );

    if (
        !YOUTUBE_API_KEY ||
        YOUTUBE_API_KEY === "TA_CLE_YOUTUBE_ICI"
    ) {

        console.log(
            "⚠️ YOUTUBE_API_KEY n'est pas configurée."
        );
    }
});
