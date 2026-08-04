const express = require("express");
const cors = require("cors");


const app = express();


app.use(cors());

app.use(express.static(__dirname));


let cache = {};




// Récupération TikTok avec fetch
async function getTikTokStats(url){


    if(
        cache[url] &&
        Date.now() - cache[url].time < 3000
    ){

        return cache[url].data;

    }



    try{


        const response = await fetch(url,{

            headers:{

                "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",

                "Accept-Language":
                "fr-FR,fr;q=0.9"

            }


        });



        const html = await response.text();





        const views =
        html.match(
            /"playCount":(\d+)/
        );



        const likes =
        html.match(
            /"diggCount":(\d+)/
        );



        const shares =
        html.match(
            /"shareCount":(\d+)/
        );



        const title =
        html.match(
            /"desc":"(.*?)"/
        );






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



        console.log("Stats récupérées:", data);



        return data;



    }
    catch(error){


        console.log(
            "Erreur fetch TikTok:",
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


}







app.get("/stats", async(req,res)=>{


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


});
