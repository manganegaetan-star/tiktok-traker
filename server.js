const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

/*
===========================================================
CONFIGURATION
===========================================================
*/

const YOUTUBE_API_KEY =
  process.env.YOUTUBE_API_KEY ||
  "AIzaSyDQNrpnW3W6Ezu34Ngcv7_mFYoefhNYa2A";

const PORT = process.env.PORT || 3000;

const cache = new Map();

const CACHE_TIME = 20 * 1000;

/*
===========================================================
UTILITAIRES
===========================================================
*/

function setCache(key, data, ttl = CACHE_TIME) {
  cache.set(key, {
    data,
    time: Date.now(),
    ttl
  });
}

function getCache(key) {
  const entry = cache.get(key);

  if (!entry) return null;

  if (Date.now() - entry.time > entry.ttl) {
    cache.delete(key);
    return null;
  }

  return entry.data;
}

function cleanText(value) {
  if (!value) return "";

  return String(value)
    .replace(/\\u002F/g, "/")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, " ")
    .replace(/\\"/g, '"')
    .trim();
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .replace(/^https?:\/\/(www\.)?tiktok\.com\/@/i, "")
    .replace(/\/.*$/, "")
    .trim();
}

function formatTikTokUrl(username) {
  return `https://www.tiktok.com/@${normalizeUsername(username)}`;
}

/*
===========================================================
DETECTION PLATEFORME
===========================================================
*/

function detectPlatform(value) {
  if (!value) return null;

  const text = String(value).trim();

  if (/tiktok\.com/i.test(text)) {
    return "tiktok";
  }

  if (/youtube\.com|youtu\.be/i.test(text)) {
    return "youtube";
  }

  return null;
}

/*
===========================================================
YOUTUBE
===========================================================
*/

function extractYouTubeId(url) {
  if (!url) return null;

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

function extractYouTubeChannelId(url) {
  if (!url) return null;

  const match = String(url).match(
    /youtube\.com\/channel\/([a-zA-Z0-9_-]+)/
  );

  return match ? match[1] : null;
}

function extractYouTubeHandle(url) {
  if (!url) return null;

  const match = String(url).match(
    /youtube\.com\/@([^/?#]+)/
  );

  return match ? match[1] : null;
}

async function youtubeRequest(endpoint, params) {
  const query = new URLSearchParams({
    ...params,
    key: YOUTUBE_API_KEY
  });

  const response = await fetch(
    `https://www.googleapis.com/youtube/v3/${endpoint}?${query}`
  );

  const json = await response.json();

  if (!response.ok || json.error) {
    throw new Error(
      json?.error?.message ||
      `YouTube API HTTP ${response.status}`
    );
  }

  return json;
}

/*
-----------------------------------------------------------
YouTube : vidéo
-----------------------------------------------------------
*/

async function getYouTubeStats(url) {
  const cacheKey = `youtube-video:${url}`;

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
      error: "ID vidéo introuvable dans l'URL"
    };
  }

  try {
    const json = await youtubeRequest("videos", {
      part: "snippet,statistics",
      id: videoId
    });

    if (!json.items || json.items.length === 0) {
      return {
        platform: "youtube",
        views: 0,
        likes: 0,
        shares: 0,
        title: "Vidéo YouTube introuvable",
        error: "Aucun résultat"
      };
    }

    const item = json.items[0];

    const stats = item.statistics || {};
    const snippet = item.snippet || {};

    const data = {
      platform: "youtube",

      id: videoId,

      views: Number(stats.viewCount) || 0,
      likes: Number(stats.likeCount) || 0,

      // L'API YouTube ne donne pas publiquement le nombre
      // de partages d'une vidéo.
      shares: 0,

      title: snippet.title || "Vidéo YouTube",

      createTime: snippet.publishedAt
        ? Math.floor(
            new Date(snippet.publishedAt).getTime() / 1000
          )
        : null,

      channelTitle: snippet.channelTitle || "",

      thumbnail:
        snippet.thumbnails?.medium?.url ||
        snippet.thumbnails?.default?.url ||
        "",

      url: `https://www.youtube.com/watch?v=${videoId}`
    };

    setCache(cacheKey, data);

    console.log("YouTube vidéo:", data);

    return data;
  } catch (error) {
    console.error(
      "Erreur YouTube vidéo:",
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
-----------------------------------------------------------
YouTube : résolution d'une chaîne
-----------------------------------------------------------
*/

async function resolveYouTubeChannel(input) {
  const value = String(input || "").trim();

  const directChannelId = extractYouTubeChannelId(value);

  if (directChannelId) {
    return directChannelId;
  }

  const handle = extractYouTubeHandle(value);

  try {
    if (handle) {
      const json = await youtubeRequest("channels", {
        part: "snippet,contentDetails",
        forHandle: handle
      });

      if (json.items?.length) {
        return json.items[0].id;
      }
    }
  } catch (error) {
    console.log(
      "Résolution handle YouTube:",
      error.message
    );
  }

  /*
   * Si l'utilisateur met simplement :
   *
   * MrBeast
   *
   * ou :
   *
   * @MrBeast
   *
   * on utilise la recherche YouTube.
   */

  const query = value
    .replace(/^@/, "")
    .trim();

  const search = await youtubeRequest("search", {
    part: "snippet",
    q: query,
    type: "channel",
    maxResults: 5
  });

  if (!search.items?.length) {
    return null;
  }

  /*
   * On essaie d'abord de trouver le nom le plus proche.
   */

  const lower = query.toLowerCase();

  const exact = search.items.find(item => {
    const title =
      item.snippet?.channelTitle?.toLowerCase() || "";

    return title === lower;
  });

  return (
    exact?.snippet?.channelId ||
    search.items[0]?.snippet?.channelId ||
    search.items[0]?.id?.channelId ||
    null
  );
}

/*
-----------------------------------------------------------
YouTube : vidéos d'une chaîne
-----------------------------------------------------------
*/

async function getYouTubeProfileVideos(input) {
  const cacheKey = `youtube-profile:${input}`;

  const cached = getCache(cacheKey);

  if (cached) {
    return cached;
  }

  try {
    const channelId =
      await resolveYouTubeChannel(input);

    if (!channelId) {
      return {
        platform: "youtube",
        profile: null,
        videos: [],
        error: "Chaîne YouTube introuvable"
      };
    }

    const channelJson =
      await youtubeRequest("channels", {
        part: "snippet,contentDetails",
        id: channelId
      });

    if (!channelJson.items?.length) {
      return {
        platform: "youtube",
        profile: null,
        videos: [],
        error: "Chaîne YouTube introuvable"
      };
    }

    const channel = channelJson.items[0];

    const uploadsPlaylist =
      channel.contentDetails?.relatedPlaylists?.uploads;

    if (!uploadsPlaylist) {
      return {
        platform: "youtube",
        profile: {
          id: channelId,
          title: channel.snippet?.title || "",
          description:
            channel.snippet?.description || "",
          thumbnail:
            channel.snippet?.thumbnails?.medium?.url ||
            ""
        },
        videos: [],
        error: "Playlist des vidéos introuvable"
      };
    }

    const playlistJson =
      await youtubeRequest("playlistItems", {
        part: "snippet,contentDetails",
        playlistId: uploadsPlaylist,
        maxResults: 20
      });

    const ids = (playlistJson.items || [])
      .map(item => item.contentDetails?.videoId)
      .filter(Boolean);

    let statistics = [];

    if (ids.length) {
      const statsJson =
        await youtubeRequest("videos", {
          part: "snippet,statistics",
          id: ids.join(",")
        });

      statistics = statsJson.items || [];
    }

    const videos = statistics.map(item => {
      const stats = item.statistics || {};
      const snippet = item.snippet || {};

      return {
        platform: "youtube",

        id: item.id,

        title:
          snippet.title ||
          "Vidéo YouTube",

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
          snippet.thumbnails?.medium?.url ||
          snippet.thumbnails?.high?.url ||
          snippet.thumbnails?.default?.url ||
          "",

        url:
          `https://www.youtube.com/watch?v=${item.id}`
      };
    });

    const data = {
      platform: "youtube",

      profile: {
        id: channelId,

        title:
          channel.snippet?.title || "",

        description:
          channel.snippet?.description || "",

        thumbnail:
          channel.snippet?.thumbnails?.medium?.url ||
          ""
      },

      videos
    };

    setCache(cacheKey, data, 60 * 1000);

    return data;
  } catch (error) {
    console.error(
      "Erreur recherche YouTube:",
      error.message
    );

    return {
      platform: "youtube",
      profile: null,
      videos: [],
      error: error.message
    };
  }
}

/*
===========================================================
TIKTOK
===========================================================
*/

/*
 * TikTok change régulièrement la structure de ses pages.
 *
 * On cherche donc plusieurs sources :
 *
 * 1. SIGI_STATE
 * 2. __UNIVERSAL_DATA_FOR_REHYDRATION__
 * 3. autres scripts JSON
 * 4. recherche récursive de structures ItemModule / itemList
 */

function extractScriptJson(html, scriptId) {
  const regex = new RegExp(
    `<script[^>]+id=["']${scriptId}["'][^>]*>([\\s\\S]*?)<\\/script>`,
    "i"
  );

  const match = html.match(regex);

  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractAllJsonScripts(html) {
  const results = [];

  const regex =
    /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let match;

  while ((match = regex.exec(html)) !== null) {
    try {
      results.push(
        JSON.parse(match[1])
      );
    } catch {
      // JSON invalide : on continue
    }
  }

  return results;
}

function walkObject(obj, callback, depth = 0) {
  if (!obj || depth > 25) return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      walkObject(item, callback, depth + 1);
    }

    return;
  }

  if (typeof obj !== "object") return;

  callback(obj);

  for (const value of Object.values(obj)) {
    if (
      value &&
      typeof value === "object"
    ) {
      walkObject(
        value,
        callback,
        depth + 1
      );
    }
  }
}

function normalizeTikTokItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  /*
   * Formats possibles :
   *
   * item.id
   * item.aweme_id
   * item.itemId
   */

  const id =
    item.id ||
    item.aweme_id ||
    item.awemeId ||
    item.itemId;

  if (!id) return null;

  /*
   * Plusieurs structures utilisent :
   *
   * stats.playCount
   * statistics.playCount
   * playCount
   */

  const stats =
    item.stats ||
    item.statistics ||
    {};

  const views =
    Number(
      stats.playCount ??
      stats.play_count ??
      item.playCount ??
      item.play_count ??
      0
    ) || 0;

  const likes =
    Number(
      stats.diggCount ??
      stats.digg_count ??
      item.diggCount ??
      item.digg_count ??
      0
    ) || 0;

  const comments =
    Number(
      stats.commentCount ??
      stats.comment_count ??
      item.commentCount ??
      0
    ) || 0;

  const shares =
    Number(
      stats.shareCount ??
      stats.share_count ??
      item.shareCount ??
      item.share_count ??
      0
    ) || 0;

  const desc =
    item.desc ||
    item.description ||
    item.title ||
    "";

  const createTime =
    Number(
      item.createTime ??
      item.create_time ??
      0
    ) || null;

  let cover = "";

  if (typeof item.video === "object") {
    cover =
      item.video.cover ||
      item.video.coverUrl ||
      item.video.originCover ||
      item.video.dynamicCover ||
      "";
  }

  cover =
    cover ||
    item.cover ||
    item.coverUrl ||
    "";

  let username = "";

  if (item.author) {
    if (typeof item.author === "object") {
      username =
        item.author.uniqueId ||
        item.author.unique_id ||
        item.author.nickname ||
        "";
    } else {
      username = String(item.author);
    }
  }

  return {
    platform: "tiktok",

    id: String(id),

    title:
      cleanText(desc) ||
      "Vidéo TikTok",

    views,

    likes,

    shares,

    comments,

    createTime,

    thumbnail: cover,

    username,

    url:
      `https://www.tiktok.com/@${username || "user"}/video/${id}`
  };
}

function collectTikTokVideosFromObject(root) {
  const found = new Map();

  if (!root) {
    return [];
  }

  /*
   * Recherche des structures connues.
   */

  walkObject(root, obj => {
    /*
     * ItemModule :
     *
     * {
     *   ItemModule: {
     *      "123": {...}
     *   }
     * }
     */

    if (
      obj.ItemModule &&
      typeof obj.ItemModule === "object"
    ) {
      for (const item of Object.values(
        obj.ItemModule
      )) {
        const normalized =
          normalizeTikTokItem(item);

        if (normalized) {
          found.set(
            normalized.id,
            normalized
          );
        }
      }
    }

    /*
     * itemList
     */

    if (Array.isArray(obj.itemList)) {
      for (const item of obj.itemList) {
        const normalized =
          normalizeTikTokItem(item);

        if (normalized) {
          found.set(
            normalized.id,
            normalized
          );
        }
      }
    }

    /*
     * item_list
     */

    if (Array.isArray(obj.item_list)) {
      for (const item of obj.item_list) {
        const normalized =
          normalizeTikTokItem(item);

        if (normalized) {
          found.set(
            normalized.id,
            normalized
          );
        }
      }
    }

    /*
     * posts / videos / items
     */

    for (
      const key of [
        "posts",
        "videos",
        "items"
      ]
    ) {
      if (Array.isArray(obj[key])) {
        for (const item of obj[key]) {
          const normalized =
            normalizeTikTokItem(item);

          if (normalized) {
            found.set(
              normalized.id,
              normalized
            );
          }
        }
      }
    }
  });

  return Array.from(found.values());
}

function extractTikTokVideosFromHtml(html) {
  const sources = [];

  const universal =
    extractScriptJson(
      html,
      "__UNIVERSAL_DATA_FOR_REHYDRATION__"
    );

  if (universal) {
    sources.push(universal);
  }

  const sigi =
    extractScriptJson(
      html,
      "SIGI_STATE"
    );

  if (sigi) {
    sources.push(sigi);
  }

  sources.push(
    ...extractAllJsonScripts(html)
  );

  const all = new Map();

  for (const source of sources) {
    const videos =
      collectTikTokVideosFromObject(
        source
      );

    for (const video of videos) {
      all.set(video.id, video);
    }
  }

  /*
   * Fallback regex pour certaines anciennes
   * pages TikTok.
   */

  const regex =
    /"(?:(?:aweme_id)|(?:id))":"?(\d{10,25})"?[\s\S]{0,2500}?"(?:playCount|play_count)":(\d+)/g;

  let match;

  while ((match = regex.exec(html)) !== null) {
    const id = match[1];
    const views = Number(match[2]) || 0;

    if (!all.has(id)) {
      all.set(id, {
        platform: "tiktok",
        id,

        title: "Vidéo TikTok",

        views,

        likes: 0,
        shares: 0,
        comments: 0,

        createTime: null,

        thumbnail: "",

        username: "",

        url:
          `https://www.tiktok.com/video/${id}`
      });
    }
  }

  return Array.from(all.values());
}

/*
-----------------------------------------------------------
TikTok : fetch page
-----------------------------------------------------------
*/

async function fetchTikTokPage(url) {
  const response = await fetch(url, {
    redirect: "follow",

    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",

      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",

      "Accept-Language":
        "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",

      "Cache-Control":
        "no-cache",

      "Pragma":
        "no-cache"
    }
  });

  const html =
    await response.text();

  return {
    response,
    html
  };
}

/*
-----------------------------------------------------------
TikTok : vidéo
-----------------------------------------------------------
*/

async function getTikTokStats(url) {
  const cacheKey =
    `tiktok-video:${url}`;

  const cached =
    getCache(cacheKey);

  if (cached) {
    return cached;
  }

  try {
    const { response, html } =
      await fetchTikTokPage(url);

    if (!response.ok) {
      throw new Error(
        `TikTok HTTP ${response.status}`
      );
    }

    const videos =
      extractTikTokVideosFromHtml(html);

    const videoId =
      extractTikTokVideoId(url);

    let data = null;

    if (videoId) {
      data =
        videos.find(
          video =>
            String(video.id) ===
            String(videoId)
        ) || null;
    }

    /*
     * Si l'ID n'a pas été trouvé, on prend
     * la première vidéo si la page est bien
     * une page vidéo.
     */

    if (!data && videos.length === 1) {
      data = videos[0];
    }

    if (!data) {
      /*
       * Fallback direct avec les anciennes
       * expressions utilisées par TikTok.
       */

      const play =
        html.match(
          /"playCount":(\d+)/
        );

      const digg =
        html.match(
          /"diggCount":(\d+)/
        );

      const share =
        html.match(
          /"shareCount":(\d+)/
        );

      const desc =
        html.match(
          /"desc":"([\s\S]*?)"/
        );

      if (play) {
        data = {
          platform: "tiktok",

          id:
            videoId || "",

          views:
            Number(play[1]) || 0,

          likes:
            digg
              ? Number(digg[1])
              : 0,

          shares:
            share
              ? Number(share[1])
              : 0,

          title:
            desc
              ? cleanText(desc[1])
              : "Vidéo TikTok",

          comments: 0,

          createTime: null,

          thumbnail: "",

          username: "",

          url
        };
      }
    }

    if (!data) {
      return {
        platform: "tiktok",

        views: 0,
        likes: 0,
        shares: 0,

        title:
          "Données TikTok introuvables",

        error:
          "TikTok n'a pas fourni les statistiques publiques dans cette réponse."
      };
    }

    data.url = url;

    setCache(
      cacheKey,
      data
    );

    console.log(
      "TikTok vidéo:",
      data
    );

    return data;
  } catch (error) {
    console.error(
      "Erreur TikTok vidéo:",
      error.message
    );

    return {
      platform: "tiktok",

      views: 0,
      likes: 0,
      shares: 0,

      title:
        "Erreur TikTok",

      error:
        error.message
    };
  }
}

/*
-----------------------------------------------------------
TikTok : ID vidéo
-----------------------------------------------------------
*/

function extractTikTokVideoId(url) {
  if (!url) return null;

  const match =
    String(url).match(
      /\/video\/(\d+)/
    );

  return match
    ? match[1]
    : null;
}

/*
-----------------------------------------------------------
TikTok : profil
-----------------------------------------------------------
*/

async function getTikTokProfileVideos(input) {
  const username =
    normalizeUsername(input);

  if (!username) {
    return {
      platform: "tiktok",
      profile: null,
      videos: [],
      error: "Pseudo TikTok invalide"
    };
  }

  const cacheKey =
    `tiktok-profile:${username.toLowerCase()}`;

  const cached =
    getCache(cacheKey);

  if (cached) {
    return cached;
  }

  const profileUrl =
    formatTikTokUrl(username);

  try {
    const { response, html } =
      await fetchTikTokPage(
        profileUrl
      );

    if (!response.ok) {
      throw new Error(
        `TikTok HTTP ${response.status}`
      );
    }

    /*
     * Extraire les vidéos.
     */

    const videos =
      extractTikTokVideosFromHtml(html);

    /*
     * Essayer de récupérer les infos
     * utilisateur.
     */

    let nickname = username;
    let avatar = "";

    const universal =
      extractScriptJson(
        html,
        "__UNIVERSAL_DATA_FOR_REHYDRATION__"
      );

    const sigi =
      extractScriptJson(
        html,
        "SIGI_STATE"
      );

    const profileSources =
      [universal, sigi]
        .filter(Boolean);

    for (
      const source of profileSources
    ) {
      walkObject(source, obj => {
        if (
          obj.userInfo?.user
        ) {
          const user =
            obj.userInfo.user;

          nickname =
            user.nickname ||
            user.uniqueId ||
            nickname;

          avatar =
            user.avatarLarger ||
            user.avatarMedium ||
            user.avatarThumb ||
            avatar;
        }

        if (
          obj.UserModule?.users
        ) {
          const users =
            obj.UserModule.users;

          const first =
            Object.values(users)[0];

          if (first) {
            nickname =
              first.nickname ||
              first.uniqueId ||
              nickname;

            avatar =
              first.avatarLarger ||
              first.avatarMedium ||
              first.avatarThumb ||
              avatar;
          }
        }

        if (
          obj.author
        ) {
          if (
            typeof obj.author ===
            "object"
          ) {
            nickname =
              obj.author.nickname ||
              obj.author.uniqueId ||
              nickname;

            avatar =
              obj.author.avatarLarger ||
              obj.author.avatarMedium ||
              obj.author.avatarThumb ||
              avatar;
          }
        }
      });
    }

    /*
     * Nettoyage et dédoublonnage.
     */

    const uniqueVideos =
      Array.from(
        new Map(
          videos.map(video => [
            video.id,
            {
              ...video,

              username:
                video.username ||
                username,

              url:
                video.url &&
                !video.url.includes(
                  "/@user/"
                )
                  ? video.url
                  : `https://www.tiktok.com/@${username}/video/${video.id}`
            }
          ])
        ).values()
      );

    /*
     * Trier par date quand elle existe.
     */

    uniqueVideos.sort(
      (a, b) =>
        Number(b.createTime || 0) -
        Number(a.createTime || 0)
    );

    const data = {
      platform: "tiktok",

      profile: {
        username,

        title:
          nickname ||
          `@${username}`,

        thumbnail:
          avatar,

        url: profileUrl
      },

      videos:
        uniqueVideos.slice(0, 30)
    };

    if (!data.videos.length) {
      data.error =
        "Aucune vidéo publique trouvée. TikTok peut avoir bloqué la requête ou modifié la structure de son profil.";
    }

    setCache(
      cacheKey,
      data,
      45 * 1000
    );

    console.log(
      `TikTok profil @${username}: ${data.videos.length} vidéos`
    );

    return data;
  } catch (error) {
    console.error(
      `Erreur profil TikTok @${username}:`,
      error.message
    );

    return {
      platform: "tiktok",

      profile: {
        username,
        title: `@${username}`,

        thumbnail: "",

        url: profileUrl
      },

      videos: [],

      error:
        `Impossible de récupérer le profil TikTok : ${error.message}`
    };
  }
}

/*
===========================================================
RECHERCHE UNIFIÉE
===========================================================
*/

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(
    String(value || "").trim()
  );
}

function looksLikeTikTokProfile(value) {
  return (
    /tiktok\.com\/@/i.test(value) ||
    /^@?[a-zA-Z0-9._-]{2,32}$/.test(
      String(value || "").trim()
    )
  );
}

function looksLikeYouTubeChannel(value) {
  return (
    /youtube\.com\/(@|channel\/|c\/|user\/)/i.test(
      value
    ) ||
    /^@?[a-zA-Z0-9._-]{2,100}$/.test(
      String(value || "").trim()
    )
  );
}

async function unifiedSearch(input, forcedPlatform = null) {
  const value =
    String(input || "").trim();

  if (!value) {
    return {
      error: "Recherche vide"
    };
  }

  const platform =
    forcedPlatform ||
    detectPlatform(value);

  /*
   * URL vidéo
   */

  if (platform === "tiktok") {
    if (
      /\/video\/\d+/i.test(value)
    ) {
      return {
        type: "video",
        platform: "tiktok",
        videos: [
          await getTikTokStats(value)
        ]
      };
    }

    return getTikTokProfileVideos(
      value
    );
  }

  if (platform === "youtube") {
    if (extractYouTubeId(value)) {
      return {
        type: "video",
        platform: "youtube",
        videos: [
          await getYouTubeStats(value)
        ]
      };
    }

    return getYouTubeProfileVideos(
      value
    );
  }

  /*
   * Pas de plateforme détectée.
   *
   * Pour un pseudo pur, on cherche sur les
   * deux plateformes en parallèle.
   */

  if (
    !looksLikeUrl(value)
  ) {
    const [tiktok, youtube] =
      await Promise.all([
        getTikTokProfileVideos(value),
        getYouTubeProfileVideos(value)
      ]);

    return {
      type: "profile-search",
      query: value,

      results: {
        tiktok,
        youtube
      }
    };
  }

  return {
    error:
      "Plateforme non reconnue. Utilise un lien TikTok/YouTube ou un pseudo."
  };
}

/*
===========================================================
ROUTES
===========================================================
*/

/*
 * Route stats rétrocompatible.
 */

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

    if (platform === "youtube") {
      result =
        await getYouTubeStats(url);
    } else if (platform === "tiktok") {
      result =
        await getTikTokStats(url);
    } else {
      return res.json({
        error:
          "Plateforme non reconnue"
      });
    }

    res.json(result);
  }
);

/*
 * Nouvelle recherche.
 *
 * /search?q=@MrBeast
 * /search?q=https://...
 */

app.get(
  "/search",
  async (req, res) => {
    const q =
      req.query.q;

    const platform =
      req.query.platform || null;

    if (!q) {
      return res.json({
        error:
          "Paramètre q manquant"
      });
    }

    try {
      const result =
        await unifiedSearch(
          q,
          platform
        );

      res.json(result);
    } catch (error) {
      console.error(
        "Erreur /search:",
        error
      );

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/*
 * Comparaison rétrocompatible.
 *
 * A et B peuvent maintenant être
 * TikTok OU YouTube.
 */

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
          "Les deux liens urlA et urlB sont requis"
      });
    }

    try {
      const fetchOne =
        async url => {
          const platform =
            detectPlatform(url);

          if (
            platform === "youtube"
          ) {
            return getYouTubeStats(
              url
            );
          }

          if (
            platform === "tiktok"
          ) {
            return getTikTokStats(
              url
            );
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
        };

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
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/*
===========================================================
NETTOYAGE CACHE
===========================================================
*/

setInterval(() => {
  const now =
    Date.now();

  for (
    const [
      key,
      entry
    ] of cache.entries()
  ) {
    if (
      now - entry.time >
      entry.ttl
    ) {
      cache.delete(key);
    }
  }
}, 60 * 1000);

/*
===========================================================
SERVEUR
===========================================================
*/

app.listen(
  PORT,
  () => {
    console.log(
      `Serveur lancé sur le port ${PORT}`
    );

    console.log(
      "TikTok + YouTube activés."
    );
  }
);
