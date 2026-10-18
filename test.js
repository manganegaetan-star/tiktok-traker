const video = "https://www.tiktok.com/@fruitstoryanime/video/7697545039135788310";

async function test() {
    const url = "https://www.tikwm.com/api/?url=" +
        encodeURIComponent(video);

    try {
        const response = await fetch(url);

        console.log("HTTP :", response.status);
        console.log("URL :", response.url);
        console.log("Headers :", Object.fromEntries(response.headers));

        const body = await response.text();

        console.log("Réponse :", body.slice(0, 1500));
    } catch (error) {
        console.error("Erreur réseau :", error.message);
    }
}

test();
