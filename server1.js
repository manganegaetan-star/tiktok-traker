
const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

let browser = null;

async function getBrowser() {
    if (!browser || !browser.isConnected()) {
        browser = await chromium.launch({
            headless: true,
            args: [
                "--no-sandbox",
                "--disable-dev-shm-usage"
            ]
        });
    }

    return browser;
}

app.get("/test", async (req, res) => {
    const url = req.query.url;

    if (typeof url !== "string") {
        return res.status(400).json({
            error: "URL TikTok manquante"
        });
    }

    const match = url.match(
        /^https:\/\/(?:www\.)?tiktok\.com\/@[^/]+\/video\/(\d+)/
    );

    if (!match) {
        return res.status(400).json({
            error: "Lien TikTok invalide"
        });
    }

    let page;

    try {
        const activeBrowser = await getBrowser();

        page = await activeBrowser.newPage();

        const apiUrl =
            "https://www.tikwm.com/api/?url=" +
            encodeURIComponent(url);

        console.log("Test TikWM avec Chromium...");

        const response = await page.goto(apiUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30000
        });

        const httpStatus = response?.status() || 0;

        console.log("TikWM HTTP :", httpStatus);

        if (httpStatus !== 200) {
            return res.status(502).json({
                error: `TikWM HTTP ${httpStatus}`,
                httpStatus
            });
        }

        const content = await page.locator("body").innerText();

        let json;

        try {
            json = JSON.parse(content);
        } catch {
            throw new Error(
                "TikWM n'a pas retourné de JSON valide"
            );
        }

        if (json.code !== 0 || !json.data) {
            throw new Error(
                json.msg || "Données TikWM indisponibles"
            );
        }

        const video = json.data;

        if (
            video.id != null &&
            String(video.id) !== match[1]
        ) {
            throw new Error(
                "Les données reçues concernent une autre vidéo"
            );
        }

        if (video.play_count == null) {
            throw new Error(
                "TikWM ne fournit pas le nombre de vues"
            );
        }

        res.json({
            platform: "tiktok",
            source: "TikWM + Chromium",
            httpStatus,
            views: Number(video.play_count),
            likes: Number(video.digg_count ?? 0),
            shares: Number(video.share_count ?? 0),
            comments: Number(video.comment_count ?? 0),
            title: video.title || "Sans titre"
        });

    } catch (error) {
        console.error("Erreur :", error.message);

        res.status(500).json({
            error: error.message
        });

    } finally {
        if (page) {
            await page.close().catch(() => {});
        }
    }
});

app.listen(PORT, () => {
    console.log(`Serveur lancé sur le port ${PORT}`);
});
