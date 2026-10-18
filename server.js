const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.static(__dirname));

// ⚠️ Remplace par ta propre clé API YouTube Data v3
// (Console Google Cloud → APIs & Services → Identifiants → Créer une clé API,
// puis active "YouTube Data API v3" sur le projet)
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "AIzaSyDQNrpnW3W6Ezu34Ngcv7_mFYoefhNYa2A";

let cache = {};

// ---------- TikTok (scraping HTML, inchangé) ----------


async function getTikTokStats(url) {
    const videoId = url.match(/\/video\/(\d+)/)?.[1];

    if (!videoId) {
        return {
            platform: "tiktok",
            error: "ID vidéo introuvable"
        };
    }

    try {
        const apiUrl =
            "https://www.tikwm.com/api/?url=" +
            encodeURIComponent(url);

        const response = await fetch(apiUrl, {
            headers: {
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0"
            },
            signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
            throw new Error(`TikWM HTTP ${response.status}`);
        }

        const json = await response.json();

        if (json.code !== 0 || !json.data) {
            throw new Error(
                json.msg || "Statistiques TikWM introuvables"
            );
        }

        const video = json.data;

        // Vérifie que les données correspondent
        // bien à la vidéo demandée.
        if (String(video.id) !== videoId) {
            throw new Error(
                "Les statistiques ne correspondent pas à la vidéo demandée"
            );
        }

        if (video.play_count == null) {
            throw new Error("Nombre de vues indisponible");
        }

        const data = {
            platform: "tiktok",
            views: Number(video.play_count),
            likes: Number(video.digg_count ?? 0),
            shares: Number(video.share_count ?? 0),
            comments: Number(video.comment_count ?? 0),
            title: video.title || "Sans titre",
            createTime: Number(video.create_time) || null
        };

        console.log("TikTok stats (TikWM) :", data);

        return data;

    } catch (error) {
        console.error("Erreur TikWM :", error.message);

        return {
            platform: "tiktok",
            error: error.message
        };
    }
}



// ---------- YouTube (API Data v3) ----------
function extractYouTubeId(url){
    // Gère youtube.com/watch?v=, youtu.be/, youtube.com/shorts/, youtube.com/embed/
    const patterns = [
        /(?:v=|\/embed\/|\/shorts\/)([a-zA-Z0-9_-]{11})/,
        /youtu\.be\/([a-zA-Z0-9_-]{11})/
    ];
    for(const pattern of patterns){
        const match = url.match(pattern);
        if(match) return match[1];
    }
    return null;
}

async function getYouTubeStats(url){
    if(
        cache[url] &&
        Date.now() - cache[url].time < 3000
    ){
        return cache[url].data;
    }

    const videoId = extractYouTubeId(url);
    if(!videoId){
        return {
            platform:"youtube",
            views:0,
            likes:0,
            shares:0,
            title:"Lien YouTube invalide",
            error:"ID vidéo introuvable dans l'URL"
        };
    }

    try{
        const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${videoId}&key=${YOUTUBE_API_KEY}`;
        const response = await fetch(apiUrl);
        const json = await response.json();

        if(!json.items || json.items.length === 0){
            return {
                platform:"youtube",
                views:0,
                likes:0,
                shares:0,
                title:"Vidéo introuvable",
                error: json.error ? json.error.message : "Aucun résultat"
            };
        }

        const item = json.items[0];
        const stats = item.statistics;
        const snippet = item.snippet;

        const data = {
            platform:"youtube",
            views: Number(stats.viewCount) || 0,
            likes: Number(stats.likeCount) || 0,
            shares: 0, // YouTube ne fournit pas ce chiffre publiquement via l'API
            title: snippet.title || "Titre introuvable",
            createTime: Math.floor(new Date(snippet.publishedAt).getTime() / 1000)
        };

        cache[url] = {
            data:data,
            time:Date.now()
        };
        console.log("Stats YouTube récupérées:", data);
        return data;
    }
    catch(error){
        console.log("Erreur fetch YouTube:", error.message);
        return {
            platform:"youtube",
            views:0,
            likes:0,
            shares:0,
            title:"Erreur YouTube",
            error:error.message
        };
    }
}

// ---------- Détection automatique de la plateforme ----------
function detectPlatform(url){
    if(/tiktok\.com/i.test(url)) return "tiktok";
    if(/youtube\.com|youtu\.be/i.test(url)) return "youtube";
    return null;
}

// Route existante (rétrocompatible) — détecte automatiquement TikTok ou YouTube
app.get("/stats", async(req,res)=>{
    const url=req.query.url;
    if(!url){
        return res.json({
            error:"Lien manquant"
        });
    }
    const platform = detectPlatform(url);
    let result;
    if(platform === "youtube"){
        result = await getYouTubeStats(url);
    }else if(platform === "tiktok"){
        result = await getTikTokStats(url);
    }else{
        return res.json({
            error:"Plateforme non reconnue (TikTok ou YouTube uniquement)"
        });
    }
    res.json(result);
});

// Nouvelle route pour la comparaison : deux liens en une seule requête
app.get("/compare", async(req,res)=>{
    const urlA = req.query.urlA;
    const urlB = req.query.urlB;
    if(!urlA || !urlB){
        return res.json({
            error:"Les deux liens (urlA et urlB) sont requis"
        });
    }

    async function fetchOne(url){
        const platform = detectPlatform(url);
        if(platform === "youtube") return getYouTubeStats(url);
        if(platform === "tiktok") return getTikTokStats(url);
        return { platform:null, views:0, likes:0, shares:0, title:"Plateforme non reconnue", error:"URL invalide" };
    }

    const [a, b] = await Promise.all([fetchOne(urlA), fetchOne(urlB)]);
    res.json({ a, b });
});

setInterval(()=>{
    const now=Date.now();
    for(let key in cache){
        if(
            now-cache[key].time > 60000
        ){
            delete cache[key];
        }
    }
},60000);

const PORT =
process.env.PORT || 3000;
app.listen(PORT,()=>{
    console.log(
        `Serveur lancé sur le port ${PORT}`
    );
    if(YOUTUBE_API_KEY === "TA_CLE_API_YOUTUBE_ICI"){
        console.log("⚠️  Pense à définir YOUTUBE_API_KEY (variable d'env ou dans le code) pour activer les stats YouTube.");
    }
});
