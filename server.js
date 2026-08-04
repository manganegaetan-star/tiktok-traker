const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");


const app = express();


app.use(cors());


// Sert index.html
app.use(express.static(__dirname));



let browser;
let page;

let cache = {};

let isLoading = false;



// Initialisation navigateur
async function init(){


    browser = await chromium.launch({

        headless:true,

        args:[
            "--no-sandbox",
            "--disable-setuid-sandbox"
        ]

    });



    page = await browser.newPage({

        userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"

    });



    // Bloque les ressources inutiles
    await page.route("**/*", route=>{


        const type =
        route.request().resourceType();



        if(
            type === "image" ||
            type === "font" ||
            type === "stylesheet" ||
            type === "media"
        ){

            route.abort();

        }
        else{

            route.continue();

        }


    });



    console.log("Navigateur prêt");


}






async function getTikTokStats(url){



    // Cache court
    if(
        cache[url] &&
        Date.now() - cache[url].time < 3000
    ){

        return cache[url].data;

    }




    // évite deux chargements simultanés
    while(isLoading){

        await new Promise(r=>setTimeout(r,100));

    }


    isLoading=true;




    try{


        console.log("Chargement TikTok...");



        await page.goto(url,{

            waitUntil:"domcontentloaded",

            timeout:15000

        });




        const html =
        await page.content();





        const views =
        html.match(/"playCount":(\d+)/);



        const likes =
        html.match(/"diggCount":(\d+)/);



        const shares =
        html.match(/"shareCount":(\d+)/);



        const title =
        html.match(/"desc":"(.*?)"/);






        const data={


            views:
            views ? Number(views[1]) : 0,



            likes:
            likes ? Number(likes[1]) : 0,



            shares:
            shares ? Number(shares[1]) : 0,



            title:
            title
            ? title[1].replace(/\\n/g," ")
            : "Titre introuvable"


        };





        cache[url]={

            data:data,

            time:Date.now()

        };



        return data;



    }
    catch(error){


        console.log(
            "Erreur TikTok:",
            error.message
        );


        return {

            views:0,

            likes:0,

            shares:0,

            title:"Erreur TikTok",

            error:error.message

        };


    }
    finally{


        isLoading=false;


    }



}









// API stats
app.get("/stats",async(req,res)=>{


    const url=req.query.url;



    if(!url){

        return res.json({

            error:"Lien manquant"

        });

    }



    const result =
    await getTikTokStats(url);



    res.json(result);



});








// Nettoyage cache
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









// Start
init()
.then(()=>{


    const PORT =
    process.env.PORT || 3000;



    app.listen(PORT,()=>{


        console.log(
            `Serveur lancé sur le port ${PORT}`
        );


    });



})
.catch(err=>{


    console.error(
        "Erreur serveur:",
        err
    );


});
