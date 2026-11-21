// =====================================================
// TIKTOK PULSE — serveur
// -----------------------------------------------------
// Site réservé aux créateurs connectés avec TikTok.
// Toutes les statistiques viennent de l'API officielle
// TikTok (Login Kit + Display API) : voir tiktok-auth.js.
// Plus aucune récupération sur la page publique ni tikwm.
// =====================================================

const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// Cloud Run est derrière un proxy HTTPS : nécessaire pour
// que les cookies de connexion soient « Secure » et que
// l'adresse de retour TikTok soit en https.
app.set("trust proxy", true);
app.use(express.json({ limit: "10kb" }));

// Connexion TikTok + API officielle. Monté EN PREMIER :
// il verrouille tout le site (sauf connexion et pages
// légales) pour les visiteurs non connectés.
require("./tiktok-auth")(app);

// Ne servir que les fichiers du site (jamais server.js,
// .env, package.json…). La page d'accueil est l'espace
// créateur.
const SITE_FILES = new Set([
    "/compte.html", "/analyse.html", "/connexion.html", "/premium.css", "/pulse-ui.js", "/relier.html", "/mon-compte.html",
    "/confidentialite.html", "/conditions.html"
]);

const serveStatic = express.static(__dirname, { index: false });

app.get("/", (req, res) => {
    res.sendFile("compte.html", { root: __dirname });
});

app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    // Fichiers de vérification TikTok (tiktokXXXX.txt)
    const isTikTokProof = /^\/tiktok[A-Za-z0-9]{10,64}\.txt$/.test(req.path);
    // Fichier de vérification Google Search Console (googleXXXX.html)
    const isGoogleProof = /^\/google[0-9a-f]{16}\.html$/.test(req.path);

    if (!SITE_FILES.has(req.path) && !isTikTokProof && !isGoogleProof) return next();
    serveStatic(req, res, next);
});

// Ancienne adresse de la page publique → espace créateur
app.get("/index.html", (req, res) => res.redirect("/"));

// Test de santé (public)
app.get("/test", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
        success: true,
        message: "TikTok Pulse fonctionne !",
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log("================================");
    console.log("        TIKTOK PULSE");
    console.log("================================");
    console.log("Port :", PORT);
    console.log("Accès : créateurs connectés uniquement");
    console.log("Données : API officielle TikTok");
    console.log("================================");
});
