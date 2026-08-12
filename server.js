const express = require("express");
const cors = require("cors");
const app = express();

app.use(cors());
app.use(express.static(__dirname));

// ⚠️ Ta clé YouTube API
const YOUTUBE_API_KEY =
  process.env.YOUTUBE_API_KEY ||
  "AIzaSyDQNrpnW3W6Ezu34Ngcv7_mFYoefhNYa2A";

let cache = {};

// ---------- TikTok (scraping HTML, inchangé) ----------
async function getTikTokStats(url) {
  if (
    cache[url] &&
    Date.now() - cache[url].time < 3000
  ) {
    return cache[url].data;
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept-Language":
          "fr-FR,fr;q=0.9"
      }
    });

    const html = await response.text();

    const views = html.match(/"playCount":(\d+)/);
    const likes = html.match(/"diggCount":(\d+)/);
    const shares = html.match(/"shareCount":(\d+)/);
    const title = html.match(/"desc":"(.*?)"/);

    const data = {
      platform: "tiktok",
      views: views ? Number(views[1]) : 0,
      likes: likes ? Number(likes[1]) : 0,
      shares: shares ? Number(shares[1]) : 0,
      title: title
        ? title[1].replace(/\n/g, " ")
        : "Titre introuvable"
    };

    cache[url] = {
      data: data,
      time: Date.now()
    };

    console.log("Stats TikTok récupérées:", data);

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

// ---------- YouTube ----------
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
  if (
    cache[url] &&
    Date.now() - cache[url].time < 3000
  ) {
    return cache[url].data;
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
      `https://www.googleapis.com/youtube/v3/videos` +
      `?part=snippet,statistics` +
      `&id=${videoId}` +
      `&key=${YOUTUBE_API_KEY}`;

    const response = await fetch(apiUrl);
    const json = await response.json();

    if (!json.items || json.items.length === 0) {
      return {
        platform: "youtube",
        views: 0,
        likes: 0,
        shares: 0,
        title: "Vidéo introuvable",
        error: json.error
          ? json.error.message
          : "Aucun résultat"
      };
    }

    const item = json.items[0];
    const stats = item.statistics;
    const snippet = item.snippet;

    const data = {
      platform: "youtube",
      views: Number(stats.viewCount) || 0,
      likes: Number(stats.likeCount) || 0,
      shares: 0,
      title:
        snippet.title || "Titre introuvable",
      createTime: Math.floor(
        new Date(
          snippet.publishedAt
        ).getTime() / 1000
      )
    };

    cache[url] = {
      data: data,
      time: Date.now()
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
      title: "Erreur YouTube",
      error: error.message
    };
  }
}

// ---------- Recherche utilisateur YouTube ----------
async function searchYouTubeUser(username) {
  let handle = String(username || "").trim();

  if (handle.startsWith("@")) {
    handle = handle.substring(1);
  }

  handle = handle.replace(
    /^https?:\/\/(www\.)?youtube\.com\/@?/i,
    ""
  );

  handle = handle.split("/")[0];
  handle = handle.split("?")[0];

  if (!handle) {
    throw new Error(
      "Nom d'utilisateur YouTube manquant."
    );
  }

  // Trouver la chaîne via son handle
  const channelUrl =
    `https://www.googleapis.com/youtube/v3/channels` +
    `?part=snippet,contentDetails` +
    `&forHandle=@${encodeURIComponent(handle)}` +
    `&key=${YOUTUBE_API_KEY}`;

  const channelResponse =
    await fetch(channelUrl);

  const channelJson =
    await channelResponse.json();

  if (
    !channelResponse.ok ||
    !channelJson.items ||
    channelJson.items.length === 0
  ) {
    throw new Error(
      channelJson.error?.message ||
      `Chaîne YouTube introuvable pour @${handle}`
    );
  }

  const channel = channelJson.items[0];

  const channelId = channel.id;

  const uploadsPlaylistId =
    channel.contentDetails.relatedPlaylists.uploads;

  const channelTitle =
    channel.snippet?.title ||
    handle;

  const channelThumbnail =
    channel.snippet?.thumbnails?.high?.url ||
    channel.snippet?.thumbnails?.medium?.url ||
    channel.snippet?.thumbnails?.default?.url ||
    null;

  // Les 5 dernières vidéos
  const playlistUrl =
    `https://www.googleapis.com/youtube/v3/playlistItems` +
    `?part=snippet,contentDetails` +
    `&playlistId=${uploadsPlaylistId}` +
    `&maxResults=5` +
    `&key=${YOUTUBE_API_KEY}`;

  const playlistResponse =
    await fetch(playlistUrl);

  const playlistJson =
    await playlistResponse.json();

  if (
    !playlistResponse.ok ||
    !playlistJson.items
  ) {
    throw new Error(
      playlistJson.error?.message ||
      "Impossible de récupérer les vidéos."
    );
  }

  const videoIds =
    playlistJson.items
      .map(item =>
        item.contentDetails?.videoId
      )
      .filter(Boolean);

  if (videoIds.length === 0) {
    return {
      platform: "youtube",
      username: `@${handle}`,
      channelId: channelId,
      channelTitle: channelTitle,
      channelThumbnail: channelThumbnail,
      videos: []
    };
  }

  // Statistiques des 5 vidéos en une seule requête
  const videosUrl =
    `https://www.googleapis.com/youtube/v3/videos` +
    `?part=snippet,statistics` +
    `&id=${videoIds.join(",")}` +
    `&key=${YOUTUBE_API_KEY}`;

  const videosResponse =
    await fetch(videosUrl);

  const videosJson =
    await videosResponse.json();

  if (
    !videosResponse.ok ||
    !videosJson.items
  ) {
    throw new Error(
      videosJson.error?.message ||
      "Impossible de récupérer les statistiques."
    );
  }

  const videoMap = new Map(
    videosJson.items.map(video => [
      video.id,
      video
    ])
  );

  const videos =
    videoIds
      .map(videoId =>
        videoMap.get(videoId)
      )
      .filter(Boolean)
      .map(video => {
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
            "Titre introuvable",

          thumbnail:
            snippet.thumbnails?.high?.url ||
            snippet.thumbnails?.medium?.url ||
            snippet.thumbnails?.default?.url ||
            null,

          views:
            Number(stats.viewCount) || 0,

          likes:
            Number(stats.likeCount) || 0,

          shares: 0,

          publishedAt:
            snippet.publishedAt || null,

          createTime:
            snippet.publishedAt
              ? Math.floor(
                  new Date(
                    snippet.publishedAt
                  ).getTime() / 1000
                )
              : null
        };
      });

  return {
    platform: "youtube",
    username: `@${handle}`,
    channelId: channelId,
    channelTitle: channelTitle,
    channelThumbnail: channelThumbnail,
    videos: videos
  };
}

// ---------- Détection automatique de la plateforme ----------
function detectPlatform(url) {
  if (/tiktok\.com/i.test(url)) {
    return "tiktok";
  }

  if (/youtube\.com|youtu\.be/i.test(url)) {
    return "youtube";
  }

  return null;
}

// ---------- Route /stats ----------
app.get("/stats", async (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.json({
      error: "Lien manquant"
    });
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
    return res.json({
      error:
        "Plateforme non reconnue (TikTok ou YouTube uniquement)"
    });
  }

  res.json(result);
});

// ---------- Route /search ----------
app.get("/search", async (req, res) => {
  const platform =
    String(
      req.query.platform || ""
    ).toLowerCase();

  const username =
    String(
      req.query.username || ""
    ).trim();

  if (!platform) {
    return res.status(400).json({
      error: "Plateforme manquante"
    });
  }

  if (!username) {
    return res.status(400).json({
      error: "Nom d'utilisateur manquant"
    });
  }

  try {
    if (platform === "youtube") {
      const result =
        await searchYouTubeUser(username);

      return res.json(result);
    }

    return res.status(501).json({
      platform: platform,
      error:
        "La recherche par utilisateur n'est disponible que pour YouTube pour le moment."
    });
  } catch (error) {
    console.error(
      "Erreur recherche utilisateur:",
      error.message
    );

    return res.status(500).json({
      error: error.message
    });
  }
});

// ---------- Route /compare ----------
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
      title: "Plateforme non reconnue",
      error: "URL invalide"
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

// ---------- Nettoyage cache ----------
setInterval(() => {
  const now = Date.now();

  for (const key in cache) {
    if (
      now - cache[key].time > 60000
    ) {
      delete cache[key];
    }
  }
}, 60000);

// ---------- Serveur ----------
const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `Serveur lancé sur le port ${PORT}`
  );

  if (
    YOUTUBE_API_KEY ===
    "TA_CLE_API_YOUTUBE_ICI"
  ) {
    console.log(
      "⚠️ Pense à définir YOUTUBE_API_KEY."
    );
  }
});
