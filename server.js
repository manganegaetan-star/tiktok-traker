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
*/

const YOUTUBE_API_KEY =
  process.env.YOUTUBE_API_KEY ||
  "AIzaSyDQNrpnW3W6Ezu34Ngcv7_mFYoefhNYa2A";

const PORT = process.env.PORT || 3000;

const CACHE_TTL = 15000;

const cache = new Map();

/*
|--------------------------------------------------------------------------
| OUTILS
|--------------------------------------------------------------------------
*/

function setCache(key, data) {
  cache.set(key, {
    data,
    time: Date.now()
  });
}

function getCache(key) {
  const item = cache.get(key);

  if (!item) return null;

  if (Date.now() - item.time > CACHE_TTL) {
    cache.delete(key);
    return null;
  }

  return item.data;
}

function cleanText(value) {
  if (!value) return "";

  return String(value)
    .replace(/\\u0026/g, "&")
    .replace(/\\u003C/g, "<")
    .replace(/\\u003E/g, ">")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .trim();
}

/*
|--------------------------------------------------------------------------
| PLATEFORME
|--------------------------------------------------------------------------
*/

function detectPlatform(input) {
  if (!input) return null;

  const value = String(input).trim();

  if (/tiktok\.com/i.test(value)) {
    return "tiktok";
  }

  if (/youtube\.com|youtu\.be/i.test(value)) {
    return "youtube";
  }

  return null;
}

/*
|--------------------------------------------------------------------------
| YOUTUBE
|--------------------------------------------------------------------------
*/

function extractYouTubeId(input) {
  if (!input) return null;

  const value = input.trim();

  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);

    if (match) {
      return match[1];
    }
  }

  return null;
}

function cleanYouTubeUsername(value) {
  if (!value) return "";

  let username = value.trim();

  username = username
    .replace(/^https?:\/\/(www\.)?youtube\.com\//i, "")
    .replace(/^@/, "");

  username = username
    .replace(/^channel\//i, "")
    .replace(/^c\//i, "")
    .replace(/^user\//i, "");

  username = username.split(/[/?#]/)[0];

  return username.trim();
}

async function getYouTubeStats(input) {
  const cacheKey = `youtube:stats:${input}`;

  const cached = getCache(cacheKey);

  if (cached) return cached;

  const videoId = extractYouTubeId(input);

  if (!videoId) {
    return {
      platform: "youtube",
      views: 0,
      likes: 0,
      shares: 0,
      title: "Lien YouTube invalide",
      error: "ID vidéo YouTube introuvable."
    };
  }

  try {
    const apiUrl =
      "https://www.googleapis.com/youtube/v3/videos" +
      `?part=snippet,statistics&id=${encodeURIComponent(videoId)}` +
      `&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;

    const response = await fetch(apiUrl);

    const json = await response.json();

    if (!response.ok || json.error) {
      return {
        platform: "youtube",
        views: 0,
        likes: 0,
        shares: 0,
        title: "Erreur YouTube",
        error:
          json?.error?.message ||
          `YouTube API HTTP ${response.status}`
      };
    }

    if (!json.items || !json.items.length) {
      return {
        platform: "youtube",
        views: 0,
        likes: 0,
        shares: 0,
        title: "Vidéo YouTube introuvable",
        error: "Cette vidéo n'existe pas ou n'est pas accessible."
      };
    }

    const item = json.items[0];

    const stats = item.statistics || {};
    const snippet = item.snippet || {};

    const data = {
      platform: "youtube",
      views: Number(stats.viewCount) || 0,
      likes: Number(stats.likeCount) || 0,
      shares: 0,
      title: snippet.title || "Vidéo YouTube",
      createTime: snippet.publishedAt
        ? Math.floor(new Date(snippet.publishedAt).getTime() / 1000)
        : null,
      url: `https://www.youtube.com/watch?v=${videoId}`
    };

    setCache(cacheKey, data);

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

/*
|--------------------------------------------------------------------------
| YOUTUBE : RECHERCHE PAR PSEUDO
|--------------------------------------------------------------------------
|
| YouTube permet de résoudre un handle @pseudo via l'API.
|
*/

async function resolveYouTubeChannel(username) {
  const clean = cleanYouTubeUsername(username);

  if (!clean) {
    return null;
  }

  const cacheKey = `youtube:channel:${clean.toLowerCase()}`;

  const cached = getCache(cacheKey);

  if (cached) return cached;

  try {
    const handle = clean.startsWith("@")
      ? clean
      : `@${clean}`;

    const apiUrl =
      "https://www.googleapis.com/youtube/v3/channels" +
      `?part=id,snippet&forHandle=${encodeURIComponent(handle)}` +
      `&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;

    const response = await fetch(apiUrl);

    const json = await response.json();

    if (!response.ok || !json.items?.length) {
      return null;
    }

    const channel = json.items[0];

    const result = {
      id: channel.id,
      title: channel.snippet?.title || clean,
      handle
    };

    setCache(cacheKey, result);

    return result;
  } catch {
    return null;
  }
}

async function searchYouTubeVideosByUsername(username) {
  const channel = await resolveYouTubeChannel(username);

  if (!channel) {
    return {
      platform: "youtube",
      username,
      videos: [],
      error:
        "Chaîne YouTube introuvable. Utilise un @handle YouTube valide."
    };
  }

  try {
    const apiUrl =
      "https://www.googleapis.com/youtube/v3/search" +
      `?part=snippet&channelId=${encodeURIComponent(channel.id)}` +
      "&type=video" +
      "&order=date" +
      "&maxResults=20" +
      `&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;

    const response = await fetch(apiUrl);

    const json = await response.json();

    if (!response.ok || json.error) {
      return {
        platform: "youtube",
        username,
        videos: [],
        error:
          json?.error?.message ||
          `YouTube API HTTP ${response.status}`
      };
    }

    const videos = (json.items || [])
      .filter(item => item.id?.videoId)
      .map(item => ({
        platform: "youtube",
        id: item.id.videoId,
        title: item.snippet?.title || "Vidéo YouTube",
        thumbnail:
          item.snippet?.thumbnails?.medium?.url ||
          item.snippet?.thumbnails?.default?.url ||
          "",
        publishedAt: item.snippet?.publishedAt || null,
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`
      }));

    return {
      platform: "youtube",
      username: channel.title,
      channelId: channel.id,
      videos
    };
  } catch (error) {
    return {
      platform: "youtube",
      username,
      videos: [],
      error: error.message
    };
  }
}

/*
|--------------------------------------------------------------------------
| TIKTOK
|--------------------------------------------------------------------------
*/

/*
 * IMPORTANT :
 *
 * TikTok n'offre pas une API publique simple permettant de récupérer
 * toutes les vidéos publiques d'un profil sans authentification /
 * accès spécifique.
 *
 * On tente donc de récupérer les données JSON présentes dans la page
 * publique du profil.
 */

function extractJsonObjects(html) {
  const results = [];

  const patterns = [
    /<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i,
    /<script[^>]+id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (!match) continue;

    try {
      results.push(JSON.parse(match[1]));
    } catch {
      // TikTok peut échapper le JSON différemment.
    }
  }

  return results;
}

function recursiveFindVideoObjects(object, output = []) {
  if (!object || typeof object !== "object") {
    return output;
  }

  if (Array.isArray(object)) {
    for (const item of object) {
      recursiveFindVideoObjects(item, output);
    }

    return output;
  }

  const hasVideoId =
    object.id ||
    object.aweme_id ||
    object.awemeId ||
    object.videoId;

  const hasVideoData =
    object.video ||
    object.stats ||
    object.statistics ||
    object.desc ||
    object.description;

  if (hasVideoId && hasVideoData) {
    output.push(object);
  }

  for (const key of Object.keys(object)) {
    const value = object[key];

    if (value && typeof value === "object") {
      recursiveFindVideoObjects(value, output);
    }
  }

  return output;
}

function normalizeTikTokVideo(video) {
  if (!video) return null;

  const id =
    video.id ||
    video.aweme_id ||
    video.awemeId ||
    video.videoId;

  if (!id) return null;

  const stats =
    video.stats ||
    video.statistics ||
    {};

  const videoObject =
    video.video ||
    {};

  const title =
    video.desc ||
    video.description ||
    video.title ||
    "";

  const views =
    stats.playCount ??
    stats.play_count ??
    stats.viewCount ??
    video.playCount ??
    video.play_count ??
    0;

  const likes =
    stats.diggCount ??
    stats.digg_count ??
    stats.likeCount ??
    video.diggCount ??
    video.likeCount ??
    0;

  const shares =
    stats.shareCount ??
    stats.share_count ??
    video.shareCount ??
    video.share_count ??
    0;

  const createTime =
    video.createTime ??
    video.create_time ??
    null;

  let thumbnail = "";

  if (videoObject.cover) {
    thumbnail =
      videoObject.cover.urlList?.[0] ||
      videoObject.cover.url_list?.[0] ||
      "";
  }

  if (!thumbnail) {
    thumbnail =
      video.coverUrl ||
      video.cover_url ||
      "";
  }

  return {
    platform: "tiktok",
    id: String(id),
    title: cleanText(title) || "Vidéo TikTok",
    views: Number(views) || 0,
    likes: Number(likes) || 0,
    shares: Number(shares) || 0,
    createTime: createTime ? Number(createTime) : null,
    thumbnail,
    url: `https://www.tiktok.com/@unknown/video/${id}`
  };
}

async function fetchTikTokProfile(username) {
  const cleanUsername = username
    .replace(/^@/, "")
    .replace(/^https?:\/\/(www\.)?tiktok\.com\/@/i, "")
    .split(/[/?#]/)[0]
    .trim();

  if (!cleanUsername) {
    return {
      username,
      videos: [],
      error: "Pseudo TikTok invalide."
    };
  }

  const profileUrl =
    `https://www.tiktok.com/@${encodeURIComponent(cleanUsername)}`;

  try {
    const response = await fetch(profileUrl, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/131.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language":
          "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
        Referer: "https://www.tiktok.com/"
      }
    });

    if (!response.ok) {
      return {
        username: cleanUsername,
        videos: [],
        error:
          `TikTok a répondu avec HTTP ${response.status}.`
      };
    }

    const html = await response.text();

    const jsonObjects = extractJsonObjects(html);

    let rawVideos = [];

    for (const json of jsonObjects) {
      rawVideos.push(
        ...recursiveFindVideoObjects(json)
      );
    }

    /*
     * Fallback : recherche directe de données de vidéos dans le HTML.
     */

    if (!rawVideos.length) {
      const idMatches = [
        ...html.matchAll(
          /"id":"(\d{15,25})"/g
        )
      ];

      const uniqueIds = [
        ...new Set(
          idMatches.map(match => match[1])
        )
      ];

      rawVideos = uniqueIds.map(id => ({
        id
      }));
    }

    const videos = [];

    const seen = new Set();

    for (const raw of rawVideos) {
      const video = normalizeTikTokVideo(raw);

      if (!video) continue;

      if (seen.has(video.id)) continue;

      seen.add(video.id);

      videos.push(video);
    }

    /*
     * On garde les 20 premières vidéos détectées.
     */

    return {
      username: cleanUsername,
      videos: videos.slice(0, 20)
    };
  } catch (error) {
    return {
      username: cleanUsername,
      videos: [],
      error: error.message
    };
  }
}

async function getTikTokStats(url) {
  const cacheKey = `tiktok:stats:${url}`;

  const cached = getCache(cacheKey);

  if (cached) return cached;

  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/131.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language":
          "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7"
      }
    });

    if (!response.ok) {
      return {
        platform: "tiktok",
        views: 0,
        likes: 0,
        shares: 0,
        title: "Erreur TikTok",
        error: `TikTok HTTP ${response.status}`
      };
    }

    const html = await response.text();

    const jsonObjects = extractJsonObjects(html);

    let videos = [];

    for (const json of jsonObjects) {
      videos.push(
        ...recursiveFindVideoObjects(json)
      );
    }

    /*
     * Fallback regex.
     */

    const playMatch = html.match(
      /"playCount"\s*:\s*(\d+)/i
    );

    const likeMatch = html.match(
      /"diggCount"\s*:\s*(\d+)/i
    );

    const shareMatch = html.match(
      /"shareCount"\s*:\s*(\d+)/i
    );

    const titleMatch = html.match(
      /"desc"\s*:\s*"([^"]*)"/i
    );

    if (videos.length) {
      const normalized = normalizeTikTokVideo(videos[0]);

      if (normalized) {
        setCache(cacheKey, normalized);
        return normalized;
      }
    }

    const data = {
      platform: "tiktok",
      views: playMatch
        ? Number(playMatch[1])
        : 0,
      likes: likeMatch
        ? Number(likeMatch[1])
        : 0,
      shares: shareMatch
        ? Number(shareMatch[1])
        : 0,
      title: titleMatch
        ? cleanText(titleMatch[1])
        : "Vidéo TikTok",
      createTime: null
    };

    if (
      data.views === 0 &&
      data.likes === 0 &&
      data.shares === 0
    ) {
      data.error =
        "TikTok ne fournit pas les statistiques publiques de cette vidéo dans la page récupérée.";
    }

    setCache(cacheKey, data);

    return data;
  } catch (error) {
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
|--------------------------------------------------------------------------
| EXTRACTION D'UN PSEUDO
|--------------------------------------------------------------------------
*/

function extractUsername(input, platform) {
  if (!input) return "";

  let value = input.trim();

  if (platform === "youtube") {
    return cleanYouTubeUsername(value);
  }

  if (platform === "tiktok") {
    value = value
      .replace(/^https?:\/\/(www\.)?tiktok\.com\/@/i, "")
      .replace(/^@/, "");

    return value.split(/[/?#]/)[0].trim();
  }

  return value.replace(/^@/, "");
}

/*
|--------------------------------------------------------------------------
| RECHERCHE PAR PSEUDO
|--------------------------------------------------------------------------
*/

async function searchByUsername(platform, username) {
  if (platform === "youtube") {
    return searchYouTubeVideosByUsername(username);
  }

  if (platform === "tiktok") {
    return fetchTikTokProfile(username);
  }

  return {
    platform: null,
    username,
    videos: [],
    error: "Plateforme inconnue."
  };
}

/*
|--------------------------------------------------------------------------
| ROUTE /STATS
|--------------------------------------------------------------------------
*/

app.get("/stats", async (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({
      error: "Lien manquant."
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

  return res.status(400).json({
    error:
      "Plateforme non reconnue. Utilise TikTok ou YouTube."
  });
});

/*
|--------------------------------------------------------------------------
| ROUTE /SEARCH
|--------------------------------------------------------------------------
*/

app.get("/search", async (req, res) => {
  const platform = String(
    req.query.platform || ""
  ).toLowerCase();

  const username = String(
    req.query.username || ""
  ).trim();

  if (!username) {
    return res.status(400).json({
      error: "Pseudo manquant."
    });
  }

  if (!["tiktok", "youtube"].includes(platform)) {
    return res.status(400).json({
      error: "Plateforme invalide."
    });
  }

  const result = await searchByUsername(
    platform,
    username
  );

  return res.json(result);
});

/*
|--------------------------------------------------------------------------
| ROUTE /COMPARE
|--------------------------------------------------------------------------
*/

app.get("/compare", async (req, res) => {
  const urlA = req.query.urlA;
  const urlB = req.query.urlB;

  if (!urlA || !urlB) {
    return res.status(400).json({
      error:
        "Les deux liens urlA et urlB sont requis."
    });
  }

  const [a, b] = await Promise.all([
    detectPlatform(urlA) === "youtube"
      ? getYouTubeStats(urlA)
      : detectPlatform(urlA) === "tiktok"
      ? getTikTokStats(urlA)
      : {
          platform: null,
          views: 0,
          likes: 0,
          shares: 0,
          title: "URL A invalide",
          error: "Plateforme non reconnue."
        },

    detectPlatform(urlB) === "youtube"
      ? getYouTubeStats(urlB)
      : detectPlatform(urlB) === "tiktok"
      ? getTikTokStats(urlB)
      : {
          platform: null,
          views: 0,
          likes: 0,
          shares: 0,
          title: "URL B invalide",
          error: "Plateforme non reconnue."
        }
  ]);

  return res.json({
    a,
    b
  });
});

/*
|--------------------------------------------------------------------------
| NETTOYAGE CACHE
|--------------------------------------------------------------------------
*/

setInterval(() => {
  const now = Date.now();

  for (const [key, item] of cache.entries()) {
    if (now - item.time > 60000) {
      cache.delete(key);
    }
  }
}, 60000);

/*
|--------------------------------------------------------------------------
| SERVEUR
|--------------------------------------------------------------------------
*/

app.listen(PORT, () => {
  console.log(
    `🚀 TikTok Pulse lancé sur http://localhost:${PORT}`
  );
});
