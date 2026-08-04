const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");


const app = express();

app.use(cors());


let browser;

let cache = {};




async function init(){

    browser = await chromium.launch({
        headless:true
    });

    console.log("Navigateur prêt");

}





async function getTikTokStats(url){


    if(
        cache[url] &&
        Date.now() - cache[url].time < 10000
    ){

        return cache[url].data;

    }





    const page =
    await browser.newPage();



    try{


        await page.goto(url,{

            waitUntil:"domcontentloaded",

            timeout:30000

        });





        const html =
        await page.content();





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






        let data = {


            views:
            views ? Number(views[1]) : 0,


            likes:
            likes ? Number(likes[1]) : 0,


            shares:
            shares ? Number(shares[1]) : 0,


            title:
            title 
            ? title[1]
            .replace(/\\n/g," ")
            : "Titre introuvable"


        };






        cache[url]={

            data:data,

            time:Date.now()

        };



        return data;



    }


    catch(error){


        return {

            error:error.message

        };


    }


    finally{


        await page.close();


    }



}








app.get("/stats",async(req,res)=>{


    const url =
    req.query.url;



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


    const now =
    Date.now();



    for(let key in cache){


        if(
            now-cache[key].time > 60000
        ){

            delete cache[key];

        }


    }



},60000);








init().then(()=>{


app.listen(3000,()=>{


console.log(
"Serveur lancé sur http://localhost:3000"
);


});


});