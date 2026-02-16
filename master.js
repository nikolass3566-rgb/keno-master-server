const http = require("http");
const admin = require("firebase-admin");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Socket.io setup - Srce sistema za 100k ljudi
const io = require("socket.io")(server, {
  cors: {
    origin: "https://keno-demo-31bf2.firebaseapp.com/", // U produkciji ovde stavi domen tvog sajta, npr: "https://tvoj-sajt.netlify.app"
    methods: ["GET", "POST"]
  }
});

let serviceAccount;

// 1. FIREBASE ADMIN SETUP (Tvoj originalni setup sa Render podrškom)
if (process.env.FIREBASE_CONFIG_JSON) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG_JSON);
        if (serviceAccount.private_key) {
            serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        }
        console.log("✅ Firebase učitan preko Environment Varijable.");
    } catch (err) {
        console.error("❌ Greška pri parsiranju FIREBASE_CONFIG_JSON:", err.message);
    }
} else {
    try {
        serviceAccount = require("./serviceAccountKey.json");
        console.log("✅ Firebase učitan preko lokalnog fajla.");
    } catch (err) {
        console.log("⚠️ Nije pronađen serviceAccountKey.json!");
    }
}

if (serviceAccount && !admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://keno-demo-31bf2-default-rtdb.europe-west1.firebasedatabase.app"
    });
}

const db = admin.database();
const roundRef = db.ref("currentRound");

// 2. KONSTANTE I PAYTABLE (Tvoji originalni podaci)
const WAIT_TIME = 90000; 
const DRAW_INTERVAL = 4000;
const KENO_PAYTABLE = {
    1: { 1: 3.5 },
    2: { 1: 1, 2: 14 },
    3: { 2: 2, 3: 65 },
    4: { 2: 1, 3: 10, 4: 275 },
    5: { 3: 3, 4: 45, 5: 1350 },
    6: { 3: 2, 4: 12, 5: 150, 6: 6500 },
    7: { 4: 5, 5: 45, 6: 800, 7: 25000 },
    8: { 4: 2, 5: 15, 6: 150, 7: 2500, 8: 100000 },
    9: { 5: 10, 6: 60, 7: 800, 8: 12000, 9: 250000 },
    10: { 5: 5, 6: 30, 7: 250, 8: 2500, 9: 35000, 10: 1000000 }
};

// 3. SOCKET UPRAVLJANJE KORISNICIMA
io.on("connection", (socket) => {
    console.log(`🔌 Igrač povezan: ${socket.id}`);
    
    // Čim uđe, daj mu trenutnu sliku runde iz baze
    roundRef.once("value").then(snap => {
        socket.emit("initialState", snap.val());
    });
});

// 4. POMOĆNE FUNKCIJE (Vraćene sve tvoje originalne funkcije)

async function getNextRoundId() {
    const snap = await db.ref("lastRoundId").get();
    let nextId = (snap.val() || 1000) + 1;
    await db.ref("lastRoundId").set(nextId);
    return nextId;
}

async function createNewRound(id) {
    const endTime = Date.now() + WAIT_TIME;
    const roundData = {
        roundId: id,
        status: "waiting",
        endTime: endTime,
        drawnNumbers: [],
        drawnAnimated: []
    };
    await roundRef.set(roundData);
    
    // Obavesti Socket klijente
    io.emit("roundUpdate", roundData);
}

async function processTickets(roundId, drawnNumbers) {
    console.log(`[Isplata] Provera tiketa za kolo ${roundId}...`);
    const ticketsSnap = await db.ref("tickets").get();
    if (!ticketsSnap.exists()) return;

    const tickets = ticketsSnap.val();
    const updates = {};
    
    for (const key in tickets) {
        const t = tickets[key];
        if (Number(t.roundId) === Number(roundId) && t.status === "pending") {
            const hits = t.numbers.filter(n => drawnNumbers.includes(n)).length;
            const mult = KENO_PAYTABLE[t.numbers.length]?.[hits] || 0;
            const win = Math.floor(t.amount * mult);
            
            updates[`tickets/${key}/hits`] = hits;
            updates[`tickets/${key}/winAmount`] = win;
            updates[`tickets/${key}/status`] = win > 0 ? "win" : "lose";

            if (win > 0) {
                const userRef = db.ref(`users/${t.userId}/balance`);
                const uSnap = await userRef.get();
                await userRef.set((uSnap.val() || 0) + win);
                console.log(`💰 Isplaćeno ${win} RSD korisniku ${t.userId}`);
            }
        }
    }
    if (Object.keys(updates).length > 0) await db.ref().update(updates);
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// 5. GLAVNA LOGIKA IGRE (Svi tvoji koraci su tu)

async function runGame() {
    console.log("🚀 Keno Master Start...");
    
    while (true) {
        let roundId = await getNextRoundId();
        
        // --- KORAK 1: ČEKANJE (WAITING) ---
        await createNewRound(roundId);
        console.log(`🔹 Kolo ${roundId}: Počela uplata.`);
        await sleep(WAIT_TIME);

        // --- KORAK 2: IZVLAČENJE (RUNNING) ---
        await roundRef.update({ status: "running" });
        io.emit("roundUpdate", { status: "running", roundId: roundId });
        console.log(`🔴 Kolo ${roundId}: Izvlačenje!`);

        let drawn = [];
        for (let i = 0; i < 20; i++) {
            let n;
            do { n = Math.floor(Math.random() * 80) + 1; } while (drawn.includes(n));
            drawn.push(n);

            // Ažuriraj bazu (da refresh stranice radi)
            await roundRef.update({ drawnAnimated: drawn });

            // NAJBITNIJE: Socket šalje broj SVIMA momentalno
            io.emit("newBall", { number: n, allDrawn: drawn, index: i + 1 });

            console.log(`Loptica ${i+1}: ${n}`);
            await sleep(DRAW_INTERVAL);
        }

        // --- KORAK 3: OBRAČUN (CALCULATING) ---
        await roundRef.update({ status: "calculating", drawnNumbers: drawn });
        io.emit("roundUpdate", { status: "calculating" });

        await processTickets(roundId, drawn);

        // Arhiviranje
        await db.ref(`roundsHistory/${roundId}`).set({
            roundId,
            drawnNumbers: drawn,
            createdAt: Date.now()
        });

        console.log(`✅ Kolo ${roundId} završeno.`);
        await sleep(10000); // Pauza od 10s između kola
    }
}

// 6. SERVER START
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n⭐ MASTER SERVER AKTIVAN NA PORTU ${PORT}`);
    runGame().catch(err => console.error("KRITIČNA GREŠKA:", err));
});