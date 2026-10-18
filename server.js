
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "10kb" }));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

const VIDEO_CACHE_MS = 4000;
const PROFILE_CACHE_MS = 30000;
const PROFILE_ERROR_CACHE_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 35000;
const REQUEST_TIMEOUT_MS = 12000;

const videoCache = new Map();
const profileCache = new Map();
const profileErrors = new Map();
const pending = new Map();
const sessions = new Map();

// =====================================================
// OUTILS
// =====================================================

function numberOrNull(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function safeImageUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === "https:" ? url.href : null;
    } catch {
        return null;
    }
}

function getCached(map, key, duration) {
    const item = map.get(key);

    if (!item) return null;

    if (Date.now() - item.time >= duration) {
        map.delete(key);
        return null;
    }

    return item.data;
}

function putCached(map, key, data) {
    if (map.size >= 1000) {
        map.delete(map.keys().next().value);
    }

    map.set(key, {
        data,
        time: Date.now()
    });
}

async function once(key, callback) {
    if (pending.has(key)) {
        return pending.get(key);
    }

    const promise = Promise.resolve().then(callback);
    pending.set(key, promise);

    try {
        return await promise;
    } finally {
        pending.delete(key);
    }
}

function errorResult(message) {
    return {
        platform: "tiktok",
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

function validUsername(value) {
    if (typeof value !== "string") return null;

    const clean = value.replace(/^@/, "").trim();

    return /^[a-zA-Z0-9._]{1,30}$/.test(clean)
        ? clean
        : null;
}

// =====================================================
// LIENS TIKTOK
// =====================================================

function isTikTokHost(hostname) {
    const host = hostname.toLowerCase();

    return (
        host === "tiktok.com" ||
        host.endsWith(".tiktok.com")
    );
}

function parseTikTokUrl(value) {
    try {
        const url = new URL(value);

        if (!["http:", "https:"].includes(url.protocol)) {
            return null;
        }

        if (
            !isTikTokHost(url.hostname) ||
            url.username ||
            url.password ||
            url.port
        ) {
            return null;
        }

        return url;
    } catch {
        return null;
    }
}

function extractSharedUrl(input) {
    if (
        typeof input !== "string" ||
        input.length > 5000
    ) {
        return null;
    }

    const candidates = input.match(
        /https?:\/\/[^\s<>"'`]+/gi
    ) || [];

    for (const candidate of candidates) {
        const clean = candidate.replace(
            /[),.;!?\]}]+$/g,
            ""
        );

        const parsed = parseTikTokUrl(clean);

        if (parsed) return parsed;
    }

    return parseTikTokUrl(input.trim());
}

function extractVideoId(url) {
    return (
        url.pathname.match(
            /\/(?:@[^/]+\/)?video\/(\d+)/
        )?.[1] ||

        url.pathname.match(
            /\/v\/(\d+)/
        )?.[1] ||

        null
    );
}

function extractUsername(url) {
    return url.pathname.match(
        /^\/@([a-zA-Z0-9._]+)\/video\//
    )?.[1] || null;
}

// =====================================================
// RÉSOLUTION DES LIENS COURTS
// =====================================================

async function resolveTikTokLink(input) {
    let url = extractSharedUrl(input);

    if (!url) {
        throw new Error("Lien TikTok invalide");
    }

    if (extractVideoId(url)) {
        return url;
    }

    for (let hop = 0; hop < 6; hop++) {
        let response;

        try {
            response = await fetch(url.href, {
                method: "GET",
                redirect: "manual",
                headers: {
                    "User-Agent": "Mozilla/5.0",
                    Accept: "text/html"
                },
                signal: AbortSignal.timeout(
                    REQUEST_TIMEOUT_MS
                )
            });
        } catch (error) {
            console.warn(
                "[LINK] Résolution impossible :",
                error.message
            );

            // TikWM peut parfois résoudre
            // directement un lien court.
            return url;
        }

        const location = response.headers.get("location");

        if (
            !location ||
            response.status < 300 ||
            response.status >= 400
        ) {
            return url;
        }

        const next = new URL(location, url);

        if (!parseTikTokUrl(next.href)) {
            throw new Error(
                "Redirection hors de TikTok refusée"
            );
        }

        url = next;

        if (extractVideoId(url)) {
            return url;
        }
    }

    return url;
}

// =====================================================
// REQUÊTES API TIKWM
// =====================================================

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
        method: "GET",
        headers: {
            Accept: "application/json, text/plain, */*",
            "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
            "User-Agent": "TikTokPulse/1.0"
        },
        signal: AbortSignal.timeout(
            REQUEST_TIMEOUT_MS
        )
    });

    if (!response.ok) {
        const error = new Error(
            `TikWM HTTP ${response.status}`
        );

        error.status = response.status;
        throw error;
    }

    const json = await response.json();

    if (Number(json.code) !== 0 || !json.data) {
        throw new Error(
            json.msg ||
            "Données TikWM indisponibles"
        );
    }

    return json.data;
}

// =====================================================
// EXTRACTION DU PROFIL
// =====================================================

function parseProfile(data, fallback) {
    const root = data?.userInfo || data || {};
    const user = root.user || data?.user || root;

    const stats =
        root.stats ||
        data?.stats ||
        root.statistics ||
        data?.statistics ||
        {};

    const profile = {
        username: validUsername(
            user.uniqueId ||
            user.unique_id ||
            user.username ||
            fallback
        ),

        nickname:
            user.nickname ||
            user.nickName ||
            null,

        avatar: safeImageUrl(
            user.avatarLarger ||
            user.avatarMedium ||
            user.avatarThumb ||
            user.avatar ||
            user.avatar_thumb
        ),

        bio:
            user.signature ||
            user.bio ||
            null,

        verified:
            typeof user.verified === "boolean"
                ? user.verified
                : null,

        followers: numberOrNull(
            stats.followerCount ??
            stats.follower_count ??
            stats.followers
        ),

        following: numberOrNull(
            stats.followingCount ??
            stats.following_count ??
            stats.following
        ),

        likes: numberOrNull(
            stats.heartCount ??
            stats.heart_count ??
            stats.heart ??
            stats.likes
        ),

        videos: numberOrNull(
            stats.videoCount ??
            stats.video_count ??
            stats.videos
        )
    };

    const hasStats = [
        profile.followers,
        profile.following,
        profile.likes,
        profile.videos
    ].some(value => value !== null);

    return hasStats ? profile : null;
}

// =====================================================
// STATISTIQUES CRÉATEUR
// =====================================================

async function getProfile(username) {
    username = validUsername(username);

    if (!username) return null;

    const key = username.toLowerCase();

    // Conserver les dernières données connues,
    // même lorsque leur cache a expiré.
    const previousProfile =
        profileCache.get(key)?.data || null;

    const cached = getCached(
        profileCache,
        key,
        PROFILE_CACHE_MS
    );

    if (cached) return cached;

    // Si TikWM a récemment refusé la requête,
    // éviter de recommencer immédiatement.
    const blockedUntil = profileErrors.get(key);

    if (blockedUntil && Date.now() < blockedUntil) {
        return previousProfile;
    }

    return once("profile:" + key, async () => {
        try {
            const data = await fetchTikWM(
                "/api/user/info",
                {
                    unique_id: username
                }
            );

            const profile = parseProfile(
                data,
                username
            );

            if (!profile) {
                console.warn(
                    "[PROFILE] Données absentes :",
                    username
                );

                profileErrors.set(
                    key,
                    Date.now() + 60000
                );

                return previousProfile;
            }

            putCached(
                profileCache,
                key,
                profile
            );

            profileErrors.delete(key);

            console.log(
                "[PROFILE] Actualisé :",
                username,
                {
                    followers: profile.followers,
                    following: profile.following,
                    likes: profile.likes,
                    videos: profile.videos
                }
            );

            return profile;

        } catch (error) {
            console.warn(
                "[PROFILE] Erreur :",
                username,
                error.message
            );

            if (error.status === 403) {
                console.warn(
                    "[PROFILE] Accès refusé par TikWM depuis Cloud Run"
                );
            }

            profileErrors.set(
                key,
                Date.now() + PROFILE_ERROR_CACHE_MS
            );

            return previousProfile;
        }
    });
}

// =====================================================
// STATISTIQUES VIDÉO
// =====================================================

async function getVideo(input) {
    const resolved = await resolveTikTokLink(input);

    const expectedId = extractVideoId(resolved);

    const key = expectedId
        ? `video:${expectedId}`
        : `short:${resolved.href}`;

    const cached = getCached(
        videoCache,
        key,
        VIDEO_CACHE_MS
    );

    if (cached) return cached;

    return once(key, async () => {
        const video = await fetchTikWM(
            "/api/",
            {
                url: resolved.href
            }
        );

        if (
            !video.id ||
            video.play_count == null
        ) {
            throw new Error(
                "Statistiques vidéo indisponibles"
            );
        }

        if (
            expectedId &&
            String(video.id) !== expectedId
        ) {
            throw new Error(
                "Identifiant vidéo incohérent"
            );
        }

        const authorData = video.author || {};

        const username = validUsername(
            authorData.unique_id ||
            authorData.uniqueId ||
            extractUsername(resolved)
        );

        const data = {
            platform: "tiktok",

            id: String(video.id),

            views: numberOrNull(
                video.play_count
            ),

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

            author: {
                id: authorData.id || null,
                username,
                nickname:
                    authorData.nickname ||
                    username ||
                    null,
                avatar: safeImageUrl(
                    authorData.avatar ||
                    authorData.avatar_thumb
                )
            },

            source: "tikwm"
        };

        putCached(
            videoCache,
            key,
            data
        );

        return data;
    });
}

// =====================================================
// ROUTE /stats
// =====================================================

app.get("/stats", async (req, res) => {
    res.set("Cache-Control", "no-store");

    const input = req.query.url;

    if (
        typeof input !== "string" ||
        !input.trim()
    ) {
        return res.status(400).json(
            errorResult("Lien TikTok manquant")
        );
    }

    if (!extractSharedUrl(input)) {
        return res.status(400).json(
            errorResult("Lien TikTok invalide")
        );
    }

    try {
        const video = await getVideo(input);

        const profile = await getProfile(
            video.author?.username
        );

        return res.json({
            ...video,
            profile
        });

    } catch (error) {
        console.error(
            "[STATS]",
            error.message
        );

        return res.json(
            errorResult(error.message)
        );
    }
});

// =====================================================
// SESSIONS ACTIVES
// =====================================================

function cleanSessions() {
    const now = Date.now();

    for (const [id, lastSeen] of sessions) {
        if (now - lastSeen > SESSION_TTL_MS) {
            sessions.delete(id);
        }
    }
}

function online() {
    cleanSessions();
    return sessions.size;
}

app.post("/presence", (req, res) => {
    const {
        sessionId,
        active,
        action
    } = req.body || {};

    if (
        typeof sessionId !== "string" ||
        !/^[a-zA-Z0-9_-]{16,128}$/.test(sessionId)
    ) {
        return res.status(400).json({
            error: "Identifiant de session invalide"
        });
    }

    const isActive =
        typeof active === "boolean"
            ? active
            : action === "leave"
                ? false
                : ["heartbeat", "join"].includes(action)
                    ? true
                    : null;

    if (isActive === null) {
        return res.status(400).json({
            error: "Présence invalide"
        });
    }

    cleanSessions();

    if (isActive) {
        sessions.set(sessionId, Date.now());
    } else {
        sessions.delete(sessionId);
    }

    res.set("Cache-Control", "no-store");

    return res.json({
        success: true,
        online: online()
    });
});

app.get("/presence", (req, res) => {
    res.set("Cache-Control", "no-store");

    return res.json({
        online: online()
    });
});

// =====================================================
// TEST DU SERVEUR
// =====================================================

app.get("/test", (req, res) => {
    res.set("Cache-Control", "no-store");

    res.json({
        success: true,
        message: "TikTok Pulse fonctionne !",
        online: online(),
        timestamp: new Date().toISOString(),
        cache: {
            videoSeconds: VIDEO_CACHE_MS / 1000,
            profileSeconds: PROFILE_CACHE_MS / 1000
        }
    });
});

// =====================================================
// NETTOYAGE AUTOMATIQUE
// =====================================================

setInterval(() => {
    const now = Date.now();

    for (const [key, item] of videoCache) {
        if (now - item.time > VIDEO_CACHE_MS) {
            videoCache.delete(key);
        }
    }

    // On conserve les dernières statistiques
    // du profil pour pouvoir les afficher
    // lorsqu'une requête échoue.
    for (const [key, item] of profileCache) {
        if (now - item.time > 24 * 60 * 60 * 1000) {
            profileCache.delete(key);
        }
    }

    for (const [key, until] of profileErrors) {
        if (now >= until) {
            profileErrors.delete(key);
        }
    }

    cleanSessions();

}, 15000).unref();

// =====================================================
// DÉMARRAGE
// =====================================================

app.listen(PORT, "0.0.0.0", () => {
    console.log("================================");
    console.log("        TIKTOK PULSE");
    console.log("================================");
    console.log("Port :", PORT);
    console.log("TikTok uniquement");
    console.log("Liens de partage : activés");
    console.log("Cache vidéo : 4 secondes");
    console.log("Cache profil : 30 secondes");
    console.log("Protection erreur 403 : activée");
    console.log("Sessions actives : activées");
    console.log("================================");
});
