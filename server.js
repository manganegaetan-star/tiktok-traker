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

// Ta clé YouTube
const YOUTUBE_API_KEY =
  process.env.YOUTUBE_API_KEY ||
  "AIzaSyDQNrpnW3W6Ezu34Ngcv7_mFYoefhNYa2A";

const PORT = process.env.PORT || 3000;

let cache = {};

/*
=========================================================
UTILITAIRES
=========================================================
*/

function cacheGet(key) {
  if (
    cache[key] &&
    Date.now() - cache[key].time < 30000
  ) {
    return cache[key].data;
  }

  return null;
}

function cacheSet(key, data, duration = 30000) {
  cache[key] = {
    data,
    time: Date.now(),
    duration
  };
}

function cleanUsername(username) {
  return String(username || "")
    .trim()
    .replace(/^@/, "")
    .replace(/\s+/g, "");
}

function detectPlatform(url) {
  if (/tiktok\.com/i.test(url)) return "tiktok";
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  return null;
}

/*
=========================================================
YOUTUBE
=========================================================
*/

function extractYouTubeId(url) {
  const patterns = [
    /(?:v=|\/embed\/|\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);

    if (match) {
      return match[1];
    }
  }

  return null;
}

async function getYouTubeStats(url) {
  const cached = cacheGet("stats:" + url);

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
      error: "ID vidéo introuvable dans l'URL"
    };
  }

  try {
    const apiUrl =
      "https://www.googleapis.com/youtube/v3/videos" +
      "?part=snippet,statistics" +
      "&id=" +
      encodeURIComponent(videoId) +
      "&key=" +
      encodeURIComponent(YOUTUBE_API_KEY);

    const response = await fetch(apiUrl);
    const json = await response.json();

    if (!response.ok) {
      return {
        platform: "youtube",
        views: 0,
        likes: 0,
        shares: 0,
        title: "Erreur YouTube",
        error:
          json?.error?.message ||
          "Erreur API YouTube"
      };
    }

    if (!json.items || json.items.length === 0) {
      return {
        platform: "youtube",
        views: 0,
        likes: 0,
        shares: 0,
        title: "Vidéo introuvable",
        error: "Aucun résultat"
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
      title: snippet.title || "Titre introuvable",
      createTime: snippet.publishedAt
        ? Math.floor(
            new Date(snippet.publishedAt).getTime() /
              1000
          )
        : null,
      url
    };

    cacheSet("stats:" + url, data, 30000);

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
      title: "Erreur YouTube",
      error: error.message
    };
  }
}

/*
=========================================================
RECHERCHE YOUTUBE PAR CHAÎNE / NOM D'UTILISATEUR
=========================================================
*/

async function searchYouTubeProfile(username) {
  username = cleanUsername(username);

  if (!username) {
    return {
      platform: "youtube",
      username,
      videos: [],
      error: "Nom d'utilisateur manquant"
    };
  }

  const cacheKey = "youtube-search:" + username;

  const cached = cacheGet(cacheKey);

  if (cached) {
    return cached;
  }

  try {
    /*
     * On tente d'abord une recherche par handle.
     * Exemple :
     * @MrBeast
     */

    let channelId = null;

    const handleUrl =
      "https://www.googleapis.com/youtube/v3/channels" +
      "?part=id,snippet,contentDetails" +
      "&forHandle=" +
      encodeURIComponent(username) +
      "&key=" +
      encodeURIComponent(YOUTUBE_API_KEY);

    let response = await fetch(handleUrl);
    let json = await response.json();

    if (json.items && json.items.length > 0) {
      channelId = json.items[0].id;
    }

    /*
     * Si le handle n'a pas fonctionné,
     * on utilise search.list.
     */

    if (!channelId) {
      const searchUrl =
        "https://www.googleapis.com/youtube/v3/search" +
        "?part=snippet" +
        "&type=channel" +
        "&maxResults=5" +
        "&q=" +
        encodeURIComponent(username) +
        "&key=" +
        encodeURIComponent(YOUTUBE_API_KEY);

      response = await fetch(searchUrl);
      json = await response.json();

      if (
        json.items &&
        json.items.length > 0
      ) {
        channelId =
          json.items[0].snippet.channelId;
      }
    }

    if (!channelId) {
      return {
        platform: "youtube",
        username,
        videos: [],
        error: "Chaîne YouTube introuvable"
      };
    }

    /*
     * Récupération des informations de la chaîne
     */

    const channelUrl =
      "https://www.googleapis.com/youtube/v3/channels" +
      "?part=snippet,contentDetails" +
      "&id=" +
      encodeURIComponent(channelId) +
      "&key=" +
      encodeURIComponent(YOUTUBE_API_KEY);

    const channelResponse =
      await fetch(channelUrl);

    const channelJson =
      await channelResponse.json();

    if (
      !channelJson.items ||
      channelJson.items.length === 0
    ) {
      return {
        platform: "youtube",
        username,
        videos: [],
        error: "Chaîne YouTube introuvable"
      };
    }

    const channel = channelJson.items[0];

    const uploadsPlaylistId =
      channel.contentDetails
        ?.relatedPlaylists
        ?.uploads;

    if (!uploadsPlaylistId) {
      return {
        platform: "youtube",
        username,
        channelId,
        channelTitle:
          channel.snippet?.title || username,
        videos: []
      };
    }

    /*
     * Récupération des dernières vidéos
     */

    const playlistUrl =
      "https://www.googleapis.com/youtube/v3/playlistItems" +
      "?part=snippet,contentDetails" +
      "&playlistId=" +
      encodeURIComponent(uploadsPlaylistId) +
      "&maxResults=20" +
      "&key=" +
      encodeURIComponent(YOUTUBE_API_KEY);

    const playlistResponse =
      await fetch(playlistUrl);

    const playlistJson =
      await playlistResponse.json();

    if (
      !playlistJson.items ||
      playlistJson.items.length === 0
    ) {
      return {
        platform: "youtube",
        username,
        channelId,
        channelTitle:
          channel.snippet?.title || username,
        videos: []
      };
    }

    const videoIds =
      playlistJson.items
        .map(
          item =>
            item.contentDetails?.videoId
        )
        .filter(Boolean);

    /*
     * On récupère les statistiques des vidéos
     */

    let statistics = {};

    if (videoIds.length > 0) {
      const statsUrl =
        "https://www.googleapis.com/youtube/v3/videos" +
        "?part=statistics,snippet" +
        "&id=" +
        videoIds.join(",") +
        "&key=" +
        encodeURIComponent(YOUTUBE_API_KEY);

      const statsResponse =
        await fetch(statsUrl);

      const statsJson =
        await statsResponse.json();

      for (const item of
        statsJson.items || []) {
        statistics[item.id] = item;
      }
    }

    const videos =
      playlistJson.items.map(item => {
        const videoId =
          item.contentDetails?.videoId;

        const info = statistics[videoId];

        return {
          platform: "youtube",
          id: videoId,
          url:
            "https://www.youtube.com/watch?v=" +
            videoId,
          title:
            item.snippet?.title ||
            "Vidéo YouTube",
          thumbnail:
            item.snippet?.thumbnails?.medium
              ?.url ||
            item.snippet?.thumbnails?.default
              ?.url ||
            "",
          views:
            Number(
              info?.statistics?.viewCount
            ) || 0,
          likes:
            Number(
              info?.statistics?.likeCount
            ) || 0,
          shares: 0,
          createTime:
            item.snippet?.publishedAt
              ? Math.floor(
                  new Date(
                    item.snippet.publishedAt
                  ).getTime() / 1000
                )
              : null
        };
      });

    const result = {
      platform: "youtube",
      username,
      channelId,
      channelTitle:
        channel.snippet?.title ||
        username,
      channelUrl:
        "https://www.youtube.com/channel/" +
        channelId,
      videos
    };

    cacheSet(cacheKey, result, 60000);

    return result;
  } catch (error) {
    console.log(
      "Erreur recherche YouTube:",
      error.message
    );

    return {
      platform: "youtube",
      username,
      videos: [],
      error: error.message
    };
  }
}

/*
=========================================================
TIKTOK
=========================================================
*/

async function fetchTikTokProfile(username) {
  username = cleanUsername(username);

  const profileUrl =
    "https://www.tiktok.com/@" +
    encodeURIComponent(username);

  const response = await fetch(profileUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "Accept-Language":
        "fr-FR,fr;q=0.9,en;q=0.8",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });

  const html = await response.text();

  return {
    html,
    profileUrl
  };
}

function decodeHtmlEntities(str) {
  return String(str || "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\\u002F/g, "/")
    .replace(/\\u0026/g, "&");
}

function extractTikTokVideosFromHtml(
  html,
  username
) {
  const videos = [];
  const seen = new Set();

  /*
   * Méthode 1 :
   * Recherche classique des URLs /video/ID
   */

  const regex =
    /https?:\\?\/\\?\/(?:www\.)?tiktok\.com\\?\/@[^"'\\\s]+\\?\/video\\?\/(\d+)/gi;

  let match;

  while (
    (match = regex.exec(html)) !== null
  ) {
    const id = match[1];

    if (seen.has(id)) continue;

    seen.add(id);

    videos.push({
      platform: "tiktok",
      id,
      url:
        "https://www.tiktok.com/@" +
        username +
        "/video/" +
        id,
      title: "Vidéo TikTok",
      thumbnail: "",
      views: 0,
      likes: 0,
      shares: 0,
      createTime: null
    });
  }

  /*
   * Méthode 2 :
   * URL relative /@user/video/ID
   */

  const relativeRegex =
    /\/@[^"'\\\s]+\/video\/(\d+)/gi;

  while (
    (match = relativeRegex.exec(html)) !== null
  ) {
    const id = match[1];

    if (seen.has(id)) continue;

    seen.add(id);

    videos.push({
      platform: "tiktok",
      id,
      url:
        "https://www.tiktok.com/@" +
        username +
        "/video/" +
        id,
      title: "Vidéo TikTok",
      thumbnail: "",
      views: 0,
      likes: 0,
      shares: 0,
      createTime: null
    });
  }

  /*
   * Extraction de données JSON publiques.
   */

  const playCounts =
    [
      ...(html.matchAll(
        /"playCount":\s*(\d+)/g
      ) || [])
    ].map(m => Number(m[1]));

  const diggCounts =
    [
      ...(html.matchAll(
        /"diggCount":\s*(\d+)/g
      ) || [])
    ].map(m => Number(m[1]));

  const shareCounts =
    [
      ...(html.matchAll(
        /"shareCount":\s*(\d+)/g
      ) || [])
    ].map(m => Number(m[1]));

  /*
   * On associe au mieux les statistiques aux vidéos.
   * TikTok ne garantit pas cette structure.
   */

  videos.forEach((video, index) => {
    video.views =
      playCounts[index] || 0;

    video.likes =
      diggCounts[index] || 0;

    video.shares =
      shareCounts[index] || 0;
  });

  /*
   * Recherche de titres / descriptions
   */

  const descRegex =
    /"desc":"((?:\\.|[^"\\])*)"/g;

  const descriptions = [];

  while (
    (match = descRegex.exec(html)) !== null
  ) {
    descriptions.push(
      decodeHtmlEntities(match[1])
    );
  }

  videos.forEach((video, index) => {
    if (descriptions[index]) {
      video.title =
        descriptions[index]
          .replace(/\\"/g, '"')
          .replace(/\\n/g, " ")
          .trim();
    }
  });

  return videos.slice(0, 20);
}

/*
=========================================================
RECHERCHE TIKTOK PAR NOM D'UTILISATEUR
=========================================================
*/

async function searchTikTokProfile(username) {
  username = cleanUsername(username);

  if (!username) {
    return {
      platform: "tiktok",
      username,
      videos: [],
      error: "Nom d'utilisateur manquant"
    };
  }

  const cacheKey =
    "tiktok-search:" + username;

  const cached = cacheGet(cacheKey);

  if (cached) {
    return cached;
  }

  try {
    const { html, profileUrl } =
      await fetchTikTokProfile(username);

    if (
      !html ||
      html.length < 500
    ) {
      return {
        platform: "tiktok",
        username,
        videos: [],
        error:
          "Le profil TikTok n'a pas pu être chargé"
      };
    }

    const videos =
      extractTikTokVideosFromHtml(
        html,
        username
      );

    const result = {
      platform: "tiktok",
      username,
      profileUrl,
      profileTitle:
        "@" + username,
      videos
    };

    if (videos.length === 0) {
      result.error =
        "Aucune vidéo publique trouvée. TikTok peut avoir modifié la structure de son profil ou le compte est privé.";
    }

    cacheSet(cacheKey, result, 60000);

    console.log(
      `TikTok @${username}: ${videos.length} vidéos trouvées`
    );

    return result;
  } catch (error) {
    console.log(
      "Erreur recherche TikTok:",
      error.message
    );

    return {
      platform: "tiktok",
      username,
      videos: [],
      error: error.message
    };
  }
}

/*
=========================================================
STATS TIKTOK D'UNE VIDÉO
=========================================================
*/

async function getTikTokStats(url) {
  const cached = cacheGet("stats:" + url);

  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept-Language":
          "fr-FR,fr;q=0.9,en;q=0.8"
      }
    });

    const html =
      await response.text();

    const viewsMatch =
      html.match(/"playCount":\s*(\d+)/);

    const likesMatch =
      html.match(/"diggCount":\s*(\d+)/);

    const sharesMatch =
      html.match(/"shareCount":\s*(\d+)/);

    const createTimeMatch =
      html.match(/"createTime":\s*(\d+)/);

    const titleMatch =
      html.match(
        /"desc":"((?:\\.|[^"\\])*)"/
      );

    const data = {
      platform: "tiktok",

      views: viewsMatch
        ? Number(viewsMatch[1])
        : 0,

      likes: likesMatch
        ? Number(likesMatch[1])
        : 0,

      shares: sharesMatch
        ? Number(sharesMatch[1])
        : 0,

      title: titleMatch
        ? decodeHtmlEntities(
            titleMatch[1]
          )
            .replace(/\\"/g, '"')
            .replace(/\\n/g, " ")
        : "Titre introuvable",

      createTime: createTimeMatch
        ? Number(createTimeMatch[1])
        : null,

      url
    };

    cacheSet(
      "stats:" + url,
      data,
      10000
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
      title: "Erreur TikTok",
      error: error.message
    };
  }
}

/*
=========================================================
ROUTE STATS
=========================================================
*/

app.get("/stats", async (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.json({
      error: "Lien manquant"
    });
  }

  const platform = detectPlatform(url);

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
        "Plateforme non reconnue (TikTok ou YouTube uniquement)"
    });
  } catch (error) {
    return res.json({
      error: error.message
    });
  }
});

/*
=========================================================
ROUTE RECHERCHE PAR PROFIL
=========================================================

Exemples :

/search-profile?platform=tiktok&username=mrbeast

/search-profile?platform=youtube&username=MrBeast
*/

app.get(
  "/search-profile",
  async (req, res) => {
    const platform =
      String(req.query.platform || "")
        .toLowerCase();

    const username =
      cleanUsername(
        req.query.username
      );

    if (!username) {
      return res.json({
        error:
          "Nom d'utilisateur manquant"
      });
    }

    try {
      if (platform === "tiktok") {
        return res.json(
          await searchTikTokProfile(
            username
          )
        );
      }

      if (platform === "youtube") {
        return res.json(
          await searchYouTubeProfile(
            username
          )
        );
      }

      return res.json({
        error:
          "Plateforme invalide"
      });
    } catch (error) {
      return res.json({
        error: error.message
      });
    }
  }
);

/*
=========================================================
ROUTE COMPARAISON
=========================================================
*/

app.get("/compare", async (req, res) => {
  const urlA = req.query.urlA;
  const urlB = req.query.urlB;

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
      error: "URL invalide"
    };
  }

  try {
    const [a, b] =
      await Promise.all([
        fetchOne(urlA),
        fetchOne(urlB)
      ]);

    res.json({
      a,
      b
    });
  } catch (error) {
    res.json({
      error: error.message
    });
  }
});

/*
=========================================================
NETTOYAGE CACHE
=========================================================
*/

setInterval(() => {
  const now = Date.now();

  for (const key in cache) {
    const item = cache[key];

    if (
      now - item.time >
      (item.duration || 60000)
    ) {
      delete cache[key];
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
    `Serveur lancé sur le port ${PORT}`
  );
});
