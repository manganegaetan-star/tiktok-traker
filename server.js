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

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

const PORT = process.env.PORT || 3000;

const cache = new Map();

const CACHE_TIME = 3000;
const PROFILE_CACHE_TIME = 30000;

/*
=========================================================
UTILITAIRES
=========================================================
*/

function setCache(key, data, ttl = CACHE_TIME) {
    cache.set(key, {
        data,
        time: Date.now(),
        ttl
    });
}

function getCache(key) {
    const item = cache.get(key);

    if (!item) return null;

    if (Date.now() - item.time > item.ttl) {
        cache.delete(key);
        return null;
    }

    return item.data;
}

function cleanUrl(url) {
    return String(url || "").trim();
}

function formatError(message) {
    return {
        error: true,
        message
    };
}

/*
=========================================================
DÉTECTION PLATEFORME
=========================================================
*/

function detectPlatform(input) {
    const value = String(input || "").trim();

    if (!value) return null;

    if (
        /(^|\/)tiktok\.com/i.test(value) ||
        /(^|\/)www\.tiktok\.com/i.test(value)
    ) {
        return "tiktok";
    }

    if (
        /youtube\.com/i.test(value) ||
        /youtu\.be/i.test(value)
    ) {
        return "youtube";
    }

    /*
    Si ce n'est pas une URL, on considère que c'est
    un pseudo et la plateforme devra être précisée.
    */
    return null;
}

function isUrl(input) {
    try {
        const url = new URL(input);
        return ["http:", "https:"].includes(url.protocol);
    } catch {
        return false;
    }
}

/*
=========================================================
YOUTUBE
=========================================================
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

function extractYouTubeHandle(input) {
    const value = String(input || "").trim();

    if (!value) return null;

    /*
    @handle
    */
    if (value.startsWith("@")) {
        return value;
    }

    /*
    youtube.com/@handle
    */
    const handleMatch = value.match(
        /youtube\.com\/@([a-zA-Z0-9._-]+)/i
    );

    if (handleMatch) {
        return "@" + handleMatch[1];
    }

    return null;
}

async function youtubeRequest(params) {
    if (!YOUTUBE_API_KEY) {
        throw new Error(
            "YOUTUBE_API_KEY n'est pas configurée sur le serveur."
        );
    }

    const query = new URLSearchParams({
        ...params,
        key: YOUTUBE_API_KEY
    });

    const response = await fetch(
        `https://www.googleapis.com/youtube/v3/${params.endpoint}?${query.toString()}`
    );

    const json = await response.json();

    if (!response.ok || json.error) {
        throw new Error(
            json?.error?.message ||
            `Erreur YouTube API (${response.status})`
        );
    }

    return json;
}

/*
=========================================================
YOUTUBE : VIDÉO
=========================================================
*/

async function getYouTubeStats(url) {
    const cacheKey = "yt_stats_" + url;

    const cached = getCache(cacheKey);

    if (cached) return cached;

    const videoId = extractYouTubeId(url);

    if (!videoId) {
        return formatError(
            "Impossible de trouver l'identifiant de la vidéo YouTube."
        );
    }

    try {
        const json = await youtubeRequest({
            endpoint: "videos",
            part: "snippet,statistics",
            id: videoId
        });

        if (!json.items || json.items.length === 0) {
            return formatError("Vidéo YouTube introuvable.");
        }

        const item = json.items[0];

        const stats = item.statistics || {};
        const snippet = item.snippet || {};

        const data = {
            error: false,
            platform: "youtube",
            type: "video",

            id: videoId,

            url:
                `https://www.youtube.com/watch?v=${videoId}`,

            title:
                snippet.title || "Vidéo YouTube",

            views:
                Number(stats.viewCount) || 0,

            likes:
                Number(stats.likeCount) || 0,

            shares: 0,

            createTime:
                snippet.publishedAt
                    ? Math.floor(
                        new Date(snippet.publishedAt).getTime() / 1000
                    )
                    : null,

            thumbnail:
                snippet.thumbnails?.high?.url ||
                snippet.thumbnails?.medium?.url ||
                snippet.thumbnails?.default?.url ||
                "",

            channelTitle:
                snippet.channelTitle || ""
        };

        setCache(cacheKey, data);

        return data;

    } catch (error) {
        console.error(
            "Erreur YouTube stats:",
            error.message
        );

        return formatError(error.message);
    }
}

/*
=========================================================
YOUTUBE : CHANNEL ID
=========================================================
*/

async function getYouTubeChannelByHandle(handle) {
    try {
        /*
        Recherche par @handle via channels.list.
        */

        const json = await youtubeRequest({
            endpoint: "channels",
            part: "id,snippet,contentDetails,statistics",
            forHandle: handle.replace(/^@/, "")
        });

        if (json.items && json.items.length) {
            return json.items[0];
        }

        /*
        Fallback : recherche générale.
        */

        const search = await youtubeRequest({
            endpoint: "search",
            part: "snippet",
            q: handle.replace(/^@/, ""),
            type: "channel",
            maxResults: "5"
        });

        if (!search.items || !search.items.length) {
            return null;
        }

        const exact = search.items.find(item => {
            const title =
                item.snippet?.channelTitle ||
                "";

            return title.toLowerCase() ===
                handle.replace(/^@/, "").toLowerCase();
        });

        const selected = exact || search.items[0];

        const channelId =
            selected.snippet?.channelId ||
            selected.id?.channelId;

        if (!channelId) return null;

        const channelJson = await youtubeRequest({
            endpoint: "channels",
            part: "id,snippet,contentDetails,statistics",
            id: channelId
        });

        return channelJson.items?.[0] || null;

    } catch (error) {
        console.error(
            "Erreur recherche chaîne YouTube:",
            error.message
        );

        throw error;
    }
}

/*
=========================================================
YOUTUBE : VIDÉOS D'UNE CHAÎNE
=========================================================
*/

async function searchYouTubeProfile(input) {
    const handle = extractYouTubeHandle(input);

    if (!handle) {
        return formatError(
            "Pour rechercher un profil YouTube, utilise @pseudo ou une URL YouTube contenant /@pseudo."
        );
    }

    const cacheKey =
        "yt_profile_" +
        handle.toLowerCase();

    const cached = getCache(cacheKey);

    if (cached) return cached;

    try {
        const channel =
            await getYouTubeChannelByHandle(handle);

        if (!channel) {
            return formatError(
                "Chaîne YouTube introuvable."
            );
        }

        const uploadsPlaylist =
            channel.contentDetails?.relatedPlaylists?.uploads;

        if (!uploadsPlaylist) {
            return formatError(
                "Impossible de récupérer les vidéos publiques de cette chaîne."
            );
        }

        const videosJson = await youtubeRequest({
            endpoint: "playlistItems",
            part: "snippet,contentDetails",
            playlistId: uploadsPlaylist,
            maxResults: "25"
        });

        const items =
            videosJson.items || [];

        const ids = items
            .map(item =>
                item.contentDetails?.videoId
            )
            .filter(Boolean);

        let statisticsMap = {};

        if (ids.length) {
            const statsJson = await youtubeRequest({
                endpoint: "videos",
                part: "statistics",
                id: ids.join(",")
            });

            for (const item of statsJson.items || []) {
                statisticsMap[item.id] =
                    item.statistics || {};
            }
        }

        const videos = items.map(item => {
            const id =
                item.contentDetails?.videoId;

            const snippet =
                item.snippet || {};

            const stats =
                statisticsMap[id] || {};

            return {
                id,

                platform: "youtube",

                type: "video",

                url:
                    `https://www.youtube.com/watch?v=${id}`,

                title:
                    snippet.title ||
                    "Vidéo YouTube",

                description:
                    snippet.description ||
                    "",

                views:
                    Number(stats.viewCount) || 0,

                likes:
                    Number(stats.likeCount) || 0,

                shares: 0,

                createTime:
                    snippet.publishedAt
                        ? Math.floor(
                            new Date(
                                snippet.publishedAt
                            ).getTime() / 1000
                        )
                        : null,

                thumbnail:
                    snippet.thumbnails?.high?.url ||
                    snippet.thumbnails?.medium?.url ||
                    snippet.thumbnails?.default?.url ||
                    "",

                channelTitle:
                    snippet.channelTitle ||
                    channel.snippet?.title ||
                    ""
            };
        });

        const data = {
            error: false,

            platform: "youtube",

            type: "profile",

            profile: {
                id: channel.id,

                name:
                    channel.snippet?.title ||
                    handle,

                handle,

                subscribers:
                    Number(
                        channel.statistics?.subscriberCount
                    ) || 0,

                thumbnail:
                    channel.snippet?.thumbnails?.high?.url ||
                    channel.snippet?.thumbnails?.default?.url ||
                    ""
            },

            videos
        };

        setCache(
            cacheKey,
            data,
            PROFILE_CACHE_TIME
        );

        return data;

    } catch (error) {
        return formatError(error.message);
    }
}

/*
=========================================================
TIKTOK
=========================================================
*/

/*
TikTok n'offre pas une API publique simple permettant de
chercher librement les vidéos d'un profil avec une clé
comme YouTube.

On utilise ici le HTML public du profil comme fallback.

IMPORTANT :
TikTok change régulièrement sa structure.
Le code essaie plusieurs formats JSON connus au lieu
de dépendre d'une seule regex.
*/

function decodeHtmlEntities(str) {
    return String(str || "")
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

function extractTikTokHandle(input) {
    const value = String(input || "").trim();

    if (!value) return null;

    if (value.startsWith("@")) {
        return value.substring(1);
    }

    const match = value.match(
        /tiktok\.com\/@([^/?#]+)/i
    );

    if (match) {
        return match[1];
    }

    return null;
}

function normalizeTikTokVideo(raw, fallbackUser = "") {
    if (!raw) return null;

    const id =
        raw.id ||
        raw.video?.id ||
        raw.aweme_id ||
        raw.awemeId;

    if (!id) return null;

    const desc =
        raw.desc ||
        raw.description ||
        raw.video?.desc ||
        "";

    const stats =
        raw.stats ||
        raw.statistics ||
        {};

    const author =
        raw.author ||
        {};

    const playCount =
        stats.playCount ??
        stats.play_count ??
        raw.playCount ??
        0;

    const diggCount =
        stats.diggCount ??
        stats.digg_count ??
        raw.diggCount ??
        0;

    const shareCount =
        stats.shareCount ??
        stats.share_count ??
        raw.shareCount ??
        0;

    const createTime =
        raw.createTime ??
        raw.create_time ??
        null;

    let thumbnail =
        raw.video?.cover ||
        raw.video?.originCover ||
        raw.cover ||
        "";

    /*
    Certains résultats ont l'image sous forme d'URL
    encodée.
    */

    thumbnail =
        decodeHtmlEntities(thumbnail);

    return {
        id: String(id),

        platform: "tiktok",

        type: "video",

        url:
            `https://www.tiktok.com/@${fallbackUser}/video/${id}`,

        title:
            desc || "Vidéo TikTok",

        views:
            Number(playCount) || 0,

        likes:
            Number(diggCount) || 0,

        shares:
            Number(shareCount) || 0,

        createTime:
            Number(createTime) || null,

        thumbnail,

        channelTitle:
            fallbackUser
                ? "@" + fallbackUser
                : ""
    };
}

function extractJsonObjectsFromHtml(html) {
    const results = [];

    /*
    1. __UNIVERSAL_DATA_FOR_REHYDRATION__
    */

    const universalMatch =
        html.match(
            /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i
        );

    if (universalMatch) {
        try {
            results.push(
                JSON.parse(
                    universalMatch[1]
                )
            );
        } catch {}
    }

    /*
    2. SIGI_STATE
    */

    const sigiMatch =
        html.match(
            /<script[^>]*id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/i
        );

    if (sigiMatch) {
        try {
            results.push(
                JSON.parse(
                    sigiMatch[1]
                )
            );
        } catch {}
    }

    /*
    3. JSON-LD
    */

    const jsonLdMatches =
        html.matchAll(
            /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
        );

    for (const match of jsonLdMatches) {
        try {
            results.push(
                JSON.parse(match[1])
            );
        } catch {}
    }

    return results;
}

function recursivelyFindVideoObjects(
    obj,
    output = [],
    depth = 0
) {
    if (
        !obj ||
        depth > 12
    ) {
        return output;
    }

    if (Array.isArray(obj)) {
        for (const item of obj) {
            recursivelyFindVideoObjects(
                item,
                output,
                depth + 1
            );
        }

        return output;
    }

    if (
        typeof obj !== "object"
    ) {
        return output;
    }

    /*
    Objet vidéo TikTok classique.
    */

    if (
        obj.id &&
        (
            obj.stats ||
            obj.statistics ||
            obj.video
        )
    ) {
        output.push(obj);
    }

    /*
    Structure itemModule de SIGI_STATE.
    */

    if (
        obj.itemModule &&
        typeof obj.itemModule === "object"
    ) {
        for (
            const value
            of Object.values(obj.itemModule)
        ) {
            if (value) {
                output.push(value);
            }
        }
    }

    for (
        const value
        of Object.values(obj)
    ) {
        recursivelyFindVideoObjects(
            value,
            output,
            depth + 1
        );
    }

    return output;
}

async function fetchTikTokProfile(handle) {
    const username =
        handle.replace(/^@/, "");

    const url =
        `https://www.tiktok.com/@${encodeURIComponent(username)}`;

    const response = await fetch(
        url,
        {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36",

                "Accept":
                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",

                "Accept-Language":
                    "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",

                "Cache-Control":
                    "no-cache",

                "Pragma":
                    "no-cache"
            }
        }
    );

    if (!response.ok) {
        throw new Error(
            `TikTok a répondu ${response.status}.`
        );
    }

    return await response.text();
}

async function searchTikTokProfile(input) {
    const handle =
        extractTikTokHandle(input);

    if (!handle) {
        return formatError(
            "Pseudo TikTok invalide. Utilise @pseudo ou https://www.tiktok.com/@pseudo"
        );
    }

    const cacheKey =
        "tt_profile_" +
        handle.toLowerCase();

    const cached =
        getCache(cacheKey);

    if (cached) return cached;

    try {
        const html =
            await fetchTikTokProfile(handle);

        const jsonObjects =
            extractJsonObjectsFromHtml(html);

        const rawVideos = [];

        for (
            const object
            of jsonObjects
        ) {
            recursivelyFindVideoObjects(
                object,
                rawVideos
            );
        }

        const unique =
            new Map();

        for (
            const raw
            of rawVideos
        ) {
            const video =
                normalizeTikTokVideo(
                    raw,
                    handle
                );

            if (
                video &&
                !unique.has(video.id)
            ) {
                unique.set(
                    video.id,
                    video
                );
            }
        }

        const videos =
            Array.from(
                unique.values()
            ).slice(0, 30);

        /*
        Si TikTok a encore modifié sa structure,
        on retourne une erreur explicite.
        */

        if (!videos.length) {
            return formatError(
                "Aucune vidéo publique trouvée sur ce profil TikTok. TikTok peut avoir modifié la structure de son profil ou le compte peut être privé."
            );
        }

        const data = {
            error: false,

            platform: "tiktok",

            type: "profile",

            profile: {
                handle: "@" + handle,

                name: "@" + handle,

                thumbnail: ""
            },

            videos
        };

        setCache(
            cacheKey,
            data,
            PROFILE_CACHE_TIME
        );

        return data;

    } catch (error) {
        console.error(
            "Erreur recherche TikTok:",
            error.message
        );

        return formatError(
            "Impossible de récupérer ce profil TikTok : " +
            error.message
        );
    }
}

/*
=========================================================
TIKTOK : VIDÉO
=========================================================
*/

async function getTikTokStats(url) {
    const cacheKey =
        "tt_stats_" + url;

    const cached =
        getCache(cacheKey);

    if (cached) return cached;

    try {
        const response =
            await fetch(
                url,
                {
                    headers: {
                        "User-Agent":
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",

                        "Accept-Language":
                            "fr-FR,fr;q=0.9"
                    }
                }
            );

        const html =
            await response.text();

        /*
        Plusieurs formats possibles.
        */

        const play =
            html.match(
                /"playCount"\s*:\s*(\d+)/
            );

        const likes =
            html.match(
                /"diggCount"\s*:\s*(\d+)/
            );

        const shares =
            html.match(
                /"shareCount"\s*:\s*(\d+)/
            );

        const create =
            html.match(
                /"createTime"\s*:\s*(\d+)/
            );

        const desc =
            html.match(
                /"desc"\s*:\s*"((?:\\.|[^"])*)"/
            );

        const idMatch =
            url.match(
                /\/video\/(\d+)/
            );

        if (!play && !likes && !shares) {
            return formatError(
                "TikTok n'a pas fourni les statistiques publiques de cette vidéo."
            );
        }

        const data = {
            error: false,

            platform: "tiktok",

            type: "video",

            id:
                idMatch
                    ? idMatch[1]
                    : null,

            url,

            views:
                play
                    ? Number(play[1])
                    : 0,

            likes:
                likes
                    ? Number(likes[1])
                    : 0,

            shares:
                shares
                    ? Number(shares[1])
                    : 0,

            title:
                desc
                    ? decodeURIComponent(
                        desc[1]
                            .replace(/\\"/g, '"')
                    )
                    : "Vidéo TikTok",

            createTime:
                create
                    ? Number(create[1])
                    : null
        };

        setCache(
            cacheKey,
            data
        );

        return data;

    } catch (error) {
        console.error(
            "Erreur TikTok:",
            error.message
        );

        return formatError(
            error.message
        );
    }
}

/*
=========================================================
RECHERCHE PAR PROFIL
=========================================================
*/

app.get(
    "/search",
    async (req, res) => {
        const platform =
            String(
                req.query.platform || ""
            ).toLowerCase();

        const query =
            cleanUrl(
                req.query.q
            );

        if (!query) {
            return res.json(
                formatError(
                    "Recherche vide."
                )
            );
        }

        try {
            if (platform === "youtube") {
                return res.json(
                    await searchYouTubeProfile(
                        query
                    )
                );
            }

            if (platform === "tiktok") {
                return res.json(
                    await searchTikTokProfile(
                        query
                    )
                );
            }

            return res.json(
                formatError(
                    "Plateforme inconnue."
                )
            );

        } catch (error) {
            console.error(
                "Erreur /search:",
                error
            );

            return res.json(
                formatError(
                    error.message
                )
            );
        }
    }
);

/*
=========================================================
STATS
=========================================================
*/

app.get(
    "/stats",
    async (req, res) => {
        const url =
            cleanUrl(
                req.query.url
            );

        if (!url) {
            return res.json(
                formatError(
                    "Lien manquant."
                )
            );
        }

        const platform =
            detectPlatform(url);

        if (platform === "youtube") {
            return res.json(
                await getYouTubeStats(
                    url
                )
            );
        }

        if (platform === "tiktok") {
            return res.json(
                await getTikTokStats(
                    url
                )
            );
        }

        return res.json(
            formatError(
                "Plateforme non reconnue."
            )
        );
    }
);

/*
=========================================================
COMPARE
=========================================================
*/

app.get(
    "/compare",
    async (req, res) => {
        const urlA =
            cleanUrl(
                req.query.urlA
            );

        const urlB =
            cleanUrl(
                req.query.urlB
            );

        if (!urlA || !urlB) {
            return res.json(
                formatError(
                    "Les deux liens sont requis."
                )
            );
        }

        try {
            const [a, b] =
                await Promise.all([
                    getStatsFromAnyUrl(
                        urlA
                    ),
                    getStatsFromAnyUrl(
                        urlB
                    )
                ]);

            return res.json({
                error: false,
                a,
                b
            });

        } catch (error) {
            return res.json(
                formatError(
                    error.message
                )
            );
        }
    }
);

async function getStatsFromAnyUrl(url) {
    const platform =
        detectPlatform(url);

    if (platform === "youtube") {
        return getYouTubeStats(url);
    }

    if (platform === "tiktok") {
        return getTikTokStats(url);
    }

    return formatError(
        "URL TikTok ou YouTube invalide."
    );
}

/*
=========================================================
NETTOYAGE CACHE
=========================================================
*/

setInterval(() => {
    const now =
        Date.now();

    for (
        const [key, item]
        of cache.entries()
    ) {
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

app.listen(
    PORT,
    () => {
        console.log(
            `Serveur lancé sur le port ${PORT}`
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
    }
);
