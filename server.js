const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.static(__dirname));


// ============================================================
// CONFIGURATION
// ============================================================

// Mets ici ta clé YouTube Data API v3.
// Tu peux conserver ta restriction par IP côté Google Cloud.
const YOUTUBE_API_KEY = "AIzaSyDQNrpnW3W6Ezu34Ngcv7_mFYoefhNYa2A";


// ============================================================
// CACHE
// ============================================================

let cache = {};

const CACHE_DURATION = 3000; // 3 secondes


// ============================================================
// OUTILS
// ============================================================

function cleanHandle(value) {
    return String(value || "")
        .trim()
        .replace(/^@/, "")
        .replace(/^https?:\/\/(www\.)?(youtube\.com\/@|tiktok\.com\/@)/i, "")
        .split(/[/?#]/)[0]
        .trim();
}


function formatError(message) {
    return {
        error: message
    };
}


// ============================================================
// TIKTOK — STATISTIQUES D'UNE VIDÉO
// ============================================================

async function getTikTokStats(url) {

    if (
        cache[url] &&
        Date.now() - cache[url].time < CACHE_DURATION
    ) {
        return cache[url].data;
    }

    try {

        const response = await fetch(url, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",

                "Accept-Language":
                    "fr-FR,fr;q=0.9,en;q=0.8",

                "Accept":
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            }
        });

        if (!response.ok) {
            throw new Error(
                `TikTok a répondu avec le statut ${response.status}`
            );
        }

        const html = await response.text();


        const views =
            html.match(/"playCount":(\d+)/) ||
            html.match(/"playCount":"(\d+)"/);

        const likes =
            html.match(/"diggCount":(\d+)/) ||
            html.match(/"diggCount":"(\d+)"/);

        const shares =
            html.match(/"shareCount":(\d+)/) ||
            html.match(/"shareCount":"(\d+)"/);

        const title =
            html.match(/"desc":"(.*?)"/);


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

            title: title
                ? decodeTikTokText(title[1])
                : "Titre introuvable",

            createTime: null
        };


        cache[url] = {
            data,
            time: Date.now()
        };


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

            title: "Erreur TikTok",

            error: error.message
        };
    }
}


// ============================================================
// TIKTOK — DÉCODAGE TEXTE
// ============================================================

function decodeTikTokText(value) {

    try {

        return JSON.parse(`"${value}"`)
            .replace(/\\n/g, " ")
            .trim();

    } catch {

        return String(value)
            .replace(/\\n/g, " ")
            .replace(/\\"/g, '"')
            .trim();
    }
}


// ============================================================
// TIKTOK — RECHERCHE PAR PSEUDO
// ============================================================

async function searchTikTokByHandle(handle) {

    const clean = cleanHandle(handle);

    if (!clean) {
        throw new Error("Pseudo TikTok manquant");
    }


    const profileUrl =
        `https://www.tiktok.com/@${encodeURIComponent(clean)}`;


    try {

        const response = await fetch(profileUrl, {

            headers: {

                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",

                "Accept-Language":
                    "fr-FR,fr;q=0.9,en;q=0.8",

                "Accept":
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            }
        });


        if (!response.ok) {

            throw new Error(
                `TikTok a répondu avec le statut ${response.status}`
            );
        }


        const html = await response.text();


        let videos = [];

        let username = clean;

        let nickname = `@${clean}`;


        // --------------------------------------------------------
        // Tentative avec __UNIVERSAL_DATA_FOR_REHYDRATION__
        // --------------------------------------------------------

        const universalMatch =
            html.match(
                /<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i
            );


        if (universalMatch) {

            try {

                const json =
                    JSON.parse(universalMatch[1]);


                const scope =
                    json?.__DEFAULT_SCOPE__;


                const userDetail =
                    scope?.["webapp.user-detail"];


                const userInfo =
                    userDetail?.userInfo;


                if (userInfo?.user?.uniqueId) {

                    username =
                        userInfo.user.uniqueId;
                }


                if (userInfo?.user?.nickname) {

                    nickname =
                        userInfo.user.nickname;
                }


                const itemList =
                    scope?.["webapp.video-detail"]?.itemList;


                if (Array.isArray(itemList)) {

                    videos =
                        itemList
                            .slice(0, 3)
                            .map(item => {

                                const videoId =
                                    item?.id;


                                return {

                                    id: videoId || "",

                                    url: videoId
                                        ? `https://www.tiktok.com/@${username}/video/${videoId}`
                                        : "",

                                    title:
                                        item?.desc ||
                                        "Vidéo TikTok",

                                    thumbnail:
                                        item?.video?.cover ||
                                        item?.video?.originCover ||
                                        item?.video?.dynamicCover ||
                                        "",

                                    views:
                                        Number(
                                            item?.stats?.playCount
                                        ) || 0,

                                    likes:
                                        Number(
                                            item?.stats?.diggCount
                                        ) || 0,

                                    shares:
                                        Number(
                                            item?.stats?.shareCount
                                        ) || 0,

                                    comments:
                                        Number(
                                            item?.stats?.commentCount
                                        ) || 0,

                                    createTime:
                                        Number(
                                            item?.createTime
                                        ) || null
                                };
                            });
                }

            } catch (error) {

                console.log(
                    "Parsing TikTok universal data:",
                    error.message
                );
            }
        }


        // --------------------------------------------------------
        // Deuxième méthode : SIGI_STATE
        // --------------------------------------------------------

        if (videos.length === 0) {

            const sigiMatch =
                html.match(
                    /<script[^>]+id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/i
                );


            if (sigiMatch) {

                try {

                    const json =
                        JSON.parse(sigiMatch[1]);


                    const itemModule =
                        json?.ItemModule || {};


                    const ids =
                        Object.keys(itemModule);


                    videos =
                        ids
                            .slice(0, 3)
                            .map(id => {

                                const item =
                                    itemModule[id];


                                return {

                                    id,

                                    url:
                                        `https://www.tiktok.com/@${clean}/video/${id}`,

                                    title:
                                        item?.desc ||
                                        "Vidéo TikTok",

                                    thumbnail:
                                        item?.video?.cover ||
                                        "",

                                    views:
                                        Number(
                                            item?.stats?.playCount
                                        ) || 0,

                                    likes:
                                        Number(
                                            item?.stats?.diggCount
                                        ) || 0,

                                    shares:
                                        Number(
                                            item?.stats?.shareCount
                                        ) || 0,

                                    comments:
                                        Number(
                                            item?.stats?.commentCount
                                        ) || 0,

                                    createTime:
                                        Number(
                                            item?.createTime
                                        ) || null
                                };
                            });

                } catch (error) {

                    console.log(
                        "Parsing TikTok SIGI_STATE:",
                        error.message
                    );
                }
            }
        }


        // --------------------------------------------------------
        // Fallback : récupérer les IDs présents dans le HTML
        // --------------------------------------------------------

        if (videos.length === 0) {

            const matches =
                [
                    ...html.matchAll(
                        /"id":"(\d{15,25})"/g
                    )
                ];


            const ids =
                matches
                    .map(match => match[1])
                    .filter(
                        (id, index, array) =>
                            array.indexOf(id) === index
                    )
                    .slice(0, 3);


            videos =
                ids.map(id => ({

                    id,

                    url:
                        `https://www.tiktok.com/@${clean}/video/${id}`,

                    title:
                        "Vidéo TikTok",

                    thumbnail:
                        "",

                    views:
                        0,

                    likes:
                        0,

                    shares:
                        0,

                    comments:
                        0,

                    createTime:
                        null
                }));
        }


        return {

            platform: "tiktok",

            handle: username,

            channelTitle: nickname,

            videos: videos.slice(0, 3)
        };


    } catch (error) {

        console.log(
            "Erreur recherche TikTok:",
            error.message
        );


        return {

            platform: "tiktok",

            handle: clean,

            channelTitle:
                `@${clean}`,

            videos: [],

            error: error.message
        };
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


    for (const pattern of patterns) {

        const match =
            url.match(pattern);

        if (match) {
            return match[1];
        }
    }


    return null;
}


// ============================================================
// YOUTUBE — STATISTIQUES D'UNE VIDÉO
// ============================================================

async function getYouTubeStats(url) {

    if (
        cache[url] &&
        Date.now() - cache[url].time < CACHE_DURATION
    ) {
        return cache[url].data;
    }


    const videoId =
        extractYouTubeId(url);


    if (!videoId) {

        return {

            platform: "youtube",

            views: 0,

            likes: 0,

            shares: 0,

            title:
                "Lien YouTube invalide",

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


        if (!response.ok) {

            throw new Error(
                json?.error?.message ||
                `Erreur YouTube HTTP ${response.status}`
            );
        }


        if (
            !json.items ||
            json.items.length === 0
        ) {

            return {

                platform: "youtube",

                views: 0,

                likes: 0,

                shares: 0,

                title:
                    "Vidéo introuvable",

                error:
                    "Aucun résultat"
            };
        }


        const item =
            json.items[0];


        const stats =
            item.statistics || {};


        const snippet =
            item.snippet || {};


        const data = {

            platform: "youtube",

            views:
                Number(stats.viewCount) || 0,

            likes:
                Number(stats.likeCount) || 0,

            shares:
                0,

            title:
                snippet.title ||
                "Titre introuvable",

            createTime:
                snippet.publishedAt
                    ? Math.floor(
                        new Date(
                            snippet.publishedAt
                        ).getTime() / 1000
                    )
                    : null
        };


        cache[url] = {

            data,

            time:
                Date.now()
        };


        console.log(
            "Stats YouTube récupérées:",
            data
        );


        return data;


    } catch (error) {

        console.log(
            "Erreur fetch YouTube:",
            error.message
        );


        return {

            platform: "youtube",

            views: 0,

            likes: 0,

            shares: 0,

            title:
                "Erreur YouTube",

            error:
                error.message
        };
    }
}


// ============================================================
// YOUTUBE — RECHERCHE PAR PSEUDO
// ============================================================

async function searchYouTubeByHandle(handle) {

    const clean =
        cleanHandle(handle);


    if (!clean) {

        throw new Error(
            "Pseudo YouTube manquant"
        );
    }


    if (
        !YOUTUBE_API_KEY ||
        YOUTUBE_API_KEY ===
        "COLLE_TA_CLE_YOUTUBE_ICI"
    ) {

        throw new Error(
            "La clé YOUTUBE_API_KEY n'est pas configurée"
        );
    }


    // --------------------------------------------------------
    // Recherche de la chaîne par handle
    // --------------------------------------------------------

    const channelUrl =
        `https://www.googleapis.com/youtube/v3/channels` +
        `?part=snippet,contentDetails` +
        `&forHandle=${encodeURIComponent(clean)}` +
        `&key=${YOUTUBE_API_KEY}`;


    const channelResponse =
        await fetch(channelUrl);


    const channelJson =
        await channelResponse.json();


    if (!channelResponse.ok) {

        throw new Error(
            channelJson?.error?.message ||
            "Erreur API YouTube"
        );
    }


    if (
        !channelJson.items ||
        channelJson.items.length === 0
    ) {

        return {

            platform: "youtube",

            handle: clean,

            channelTitle: "",

            videos: []
        };
    }


    const channel =
        channelJson.items[0];


    const channelId =
        channel.id;


    // --------------------------------------------------------
    // Récupération des 3 dernières vidéos
    // --------------------------------------------------------

    const searchUrl =
        `https://www.googleapis.com/youtube/v3/search` +
        `?part=snippet` +
        `&channelId=${encodeURIComponent(channelId)}` +
        `&type=video` +
        `&order=date` +
        `&maxResults=3` +
        `&key=${YOUTUBE_API_KEY}`;


    const searchResponse =
        await fetch(searchUrl);


    const searchJson =
        await searchResponse.json();


    if (!searchResponse.ok) {

        throw new Error(
            searchJson?.error?.message ||
            "Erreur recherche YouTube"
        );
    }


    const ids =
        (searchJson.items || [])
            .map(item => item.id?.videoId)
            .filter(Boolean);


    if (ids.length === 0) {

        return {

            platform: "youtube",

            handle: clean,

            channelTitle:
                channel.snippet?.title ||
                clean,

            videos: []
        };
    }


    // --------------------------------------------------------
    // Statistiques des 3 vidéos
    // --------------------------------------------------------

    const videosUrl =
        `https://www.googleapis.com/youtube/v3/videos` +
        `?part=snippet,statistics` +
        `&id=${ids.join(",")}` +
        `&key=${YOUTUBE_API_KEY}`;


    const videosResponse =
        await fetch(videosUrl);


    const videosJson =
        await videosResponse.json();


    if (!videosResponse.ok) {

        throw new Error(
            videosJson?.error?.message ||
            "Erreur statistiques YouTube"
        );
    }


    const videos =
        (videosJson.items || [])
            .map(item => ({

                id:
                    item.id,

                url:
                    `https://www.youtube.com/watch?v=${item.id}`,

                title:
                    item.snippet?.title ||
                    "Sans titre",

                thumbnail:
                    item.snippet?.thumbnails?.medium?.url ||
                    item.snippet?.thumbnails?.default?.url ||
                    "",

                views:
                    Number(
                        item.statistics?.viewCount
                    ) || 0,

                likes:
                    Number(
                        item.statistics?.likeCount
                    ) || 0,

                shares:
                    0,

                createTime:
                    item.snippet?.publishedAt
                        ? Math.floor(
                            new Date(
                                item.snippet.publishedAt
                            ).getTime() / 1000
                        )
                        : null
            }));


    return {

        platform: "youtube",

        handle: clean,

        channelTitle:
            channel.snippet?.title ||
            clean,

        videos
    };
}


// ============================================================
// DÉTECTION AUTOMATIQUE DE LA PLATEFORME
// ============================================================

function detectPlatform(url) {

    if (
        /tiktok\.com/i.test(url)
    ) {
        return "tiktok";
    }


    if (
        /youtube\.com|youtu\.be/i.test(url)
    ) {
        return "youtube";
    }


    return null;
}


// ============================================================
// ROUTE /stats
// ============================================================

app.get("/stats", async (req, res) => {

    const url =
        req.query.url;


    if (!url) {

        return res.json(
            formatError("Lien manquant")
        );
    }


    const platform =
        detectPlatform(url);


    let result;


    if (platform === "youtube") {

        result =
            await getYouTubeStats(url);

    } else if (platform === "tiktok") {

        result =
            await getTikTokStats(url);

    } else {

        return res.json(
            formatError(
                "Plateforme non reconnue (TikTok ou YouTube uniquement)"
            )
        );
    }


    res.json(result);
});


// ============================================================
// ROUTE /compare
// ============================================================

app.get("/compare", async (req, res) => {

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
});


// ============================================================
// ROUTE /search
// Recherche par pseudo
// ============================================================

app.get("/search", async (req, res) => {

    const query =
        String(
            req.query.query || ""
        ).trim();


    const platform =
        String(
            req.query.platform || ""
        ).toLowerCase()
        .trim();


    if (!query) {

        return res.status(400).json({

            error:
                "Pseudo manquant"
        });
    }


    if (
        platform !== "tiktok" &&
        platform !== "youtube"
    ) {

        return res.status(400).json({

            error:
                "Plateforme invalide"
        });
    }


    try {

        let result;


        if (platform === "youtube") {

            result =
                await searchYouTubeByHandle(query);

        } else {

            result =
                await searchTikTokByHandle(query);
        }


        res.json(result);


    } catch (error) {

        console.log(
            "Erreur recherche pseudo:",
            error.message
        );


        res.status(500).json({

            error:
                error.message
        });
    }
});


// ============================================================
// NETTOYAGE DU CACHE
// ============================================================

setInterval(() => {

    const now =
        Date.now();


    for (const key in cache) {

        if (
            now - cache[key].time >
            60000
        ) {

            delete cache[key];
        }
    }

}, 60000);


// ============================================================
// SERVEUR
// ============================================================

const PORT =
    process.env.PORT || 3000;


app.listen(PORT, () => {

    console.log(
        `Serveur lancé sur le port ${PORT}`
    );


    if (
        !YOUTUBE_API_KEY ||
        YOUTUBE_API_KEY ===
        "COLLE_TA_CLE_YOUTUBE_ICI"
    ) {

        console.log(
            "⚠️ Clé YouTube API non configurée."
        );

    } else {

        console.log(
            "✓ YouTube Data API configurée."
        );
    }
});
