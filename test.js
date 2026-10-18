
const { chromium } = require("playwright");

const videoUrl =
    "https://www.tiktok.com/@fruitstoryanime/video/7697545039135788310";

async function test() {
    const browser = await chromium.launch({
        headless: true
    });

    try {
        const page = await browser.newPage();

        const apiUrl =
            "https://www.tikwm.com/api/?url=" +
            encodeURIComponent(videoUrl);

        console.log("Ouverture de TikWM avec Chromium...");

        const response = await page.goto(apiUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30000
        });

        console.log("HTTP :", response?.status());

        const content = await page.locator("body").innerText();

        try {
            const json = JSON.parse(content);

            console.log("Code TikWM :", json.code);
            console.log("Vues :", json.data?.play_count);
            console.log("Likes :", json.data?.digg_count);
            console.log("Partages :", json.data?.share_count);
            console.log("Commentaires :", json.data?.comment_count);

        } catch {
            console.log(
                "Réponse non JSON :",
                content.slice(0, 500)
            );
        }

    } catch (error) {
        console.error("Erreur Chromium :", error.message);
    } finally {
        await browser.close();
    }
}

test();
