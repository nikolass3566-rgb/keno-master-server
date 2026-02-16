const http = require("http");
const admin = require("firebase-admin");
const express = require("express");
const { Server } = require("socket.io");

// ================= GLOBALNE VARIJABLE & SETUP =================
let currentRoundId = 0;
let currentRoundStatus = "waiting";
let drawnNumbers = [];
let roundHistory = {}; 
let isDrawing = false;

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// ================= FIREBASE SETUP =================
let serviceAccount;
if (process.env.FIREBASE_CONFIG_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG_JSON);
    if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
} else {
    try { serviceAccount = require("./serviceAccountKey.json"); } catch (e) {}
}

if (serviceAccount && !admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://keno-demo-31bf2-default-rtdb.europe-west1.firebasedatabase.app"
    });
}
const db = admin.database();

// ================= KONSTANTE & ISPLATE =================
const WAIT_TIME_SECONDS = 90;
const DRAW_INTERVAL = 3000; // 3 sekunde između loptica
const RTP_TARGET = 0.70; // 70% Return to Player

const KENO_PAYTABLE = {
    10: 10000, 9: 2000, 8: 500, 7: 100, 6: 25, 5: 5, 4: 2, 3: 0, 2: 0, 1: 0, 0: 0
};

// ================= POMOĆNE FUNKCIJE =================
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function getNextRoundId() {
    const snap = await db.ref("lastRoundId").get();
    let nextId = (snap.val() || 1000) + 1;
    await db.ref("lastRoundId").set(nextId);
    return nextId;
}

// ================= RTP LOGIKA (PROVERA PROFITA) =================
async function getTargetBall(currentDrawn, roundId) {
    // 1. Uzmi sve tikete za ovo kolo
    const snapshot = await db.ref("tickets").orderByChild("roundId").equalTo(roundId).once("value");
    const tickets = snapshot.val() || {};
    
    let totalBet = 0;
    Object.values(tickets).forEach(t => totalBet += (t.amount || 0));

    // Ako nema uloga, vrati bilo koji nasumičan broj
    if (totalBet === 0) {
        let n;
        do { n = Math.floor(Math.random() * 80) + 1; } while (currentDrawn.includes(n));
        return n;
    }

    // 2. Simulacija: Nađi broj koji najmanje isplaćuje
    let bestBall = -1;
    let minPayout = Infinity;
    let possibleBalls = [];

    for (let i = 1; i <= 80; i++) {
        if (currentDrawn.includes(i)) continue;
        possibleBalls.push(i);

        let simulatedPayout = 0;
        const tempDrawn = [...currentDrawn, i];

        Object.values(tickets).forEach(t => {
            const hits = t.numbers.filter(num => tempDrawn.includes(num)).length;
            const win = t.amount * (KENO_PAYTABLE[hits] || 0);
            simulatedPayout += win;
        });

        // Tražimo lopticu koja drži isplatu ispod 70% ukupnog uloga
        if (simulatedPayout < minPayout) {
            minPayout = simulatedPayout;
            bestBall = i;
        }
    }

    // Sigurnosni filter: Ako i najbolja loptica isplaćuje previše, uzmi onu sa najmanjim rizikom
    return bestBall !== -1 ? bestBall : possibleBalls[Math.floor(Math.random() * possibleBalls.length)];
}

// ================= OBRAČUN TIKETA =================
async function processTickets(roundId, finalNumbers) {
    console.log(`[OBRAČUN] Kolo: ${roundId}`);
    try {
        const snapshot = await db.ref("tickets").orderByChild("roundId").equalTo(roundId).once("value");
        if (!snapshot.exists()) return;

        const tickets = snapshot.val();
        const updates = {};

        for (const ticketId in tickets) {
            const ticket = tickets[ticketId];
            if (ticket.status !== "pending") continue;

            const hits = ticket.numbers.filter(num => finalNumbers.includes(num)).length;
            const winAmount = Math.floor(ticket.amount * (KENO_PAYTABLE[hits] || 0));
            const finalStatus = winAmount > 0 ? "won" : "lost";
            
            updates[`/tickets/${ticketId}/status`] = finalStatus;
            updates[`/tickets/${ticketId}/winAmount`] = winAmount;
            updates[`/tickets/${ticketId}/hitsCount`] = hits;

            if (winAmount > 0) {
                await db.ref(`users/${ticket.userId}/balance`).transaction(b => (b || 0) + winAmount);
            }
        }
        await db.ref().update(updates);
    } catch (error) {
        console.error("Greška u isplati:", error);
    }
}

// ================= GLAVNI CIKLUS IGRE =================
async function runGame() {
    while (true) {
        try {
            currentRoundId = await getNextRoundId();
            drawnNumbers = [];
            currentRoundStatus = "waiting";

            // 1. FAZA ČEKANJA (UPLATA)
            for (let s = WAIT_TIME_SECONDS; s >= 0; s--) {
                io.emit("roundUpdate", {
                    roundId: currentRoundId,
                    status: "waiting",
                    timeLeft: s,
                    totalTime: WAIT_TIME_SECONDS,
                    history: roundHistory // Šaljemo istoriju da bi klijent mogao da oboji stare tikete
                });
                await sleep(1000);
            }

            // 2. FAZA IZVLAČENJA (SA RTP KONTROLOM)
            currentRoundStatus = "running";
            io.emit("roundUpdate", { status: "running", roundId: currentRoundId });

            for (let i = 0; i < 20; i++) {
                // Prvih 15 loptica može biti random, zadnjih 5 ide kroz RTP kontrolu
                let n;
                if (i < 15) {
                    do { n = Math.floor(Math.random() * 80) + 1; } while (drawnNumbers.includes(n));
                } else {
                    n = await getTargetBall(drawnNumbers, currentRoundId);
                }

                drawnNumbers.push(n);
                io.emit("ballDrawn", { number: n, allDrawn: drawnNumbers, index: i });
                await sleep(DRAW_INTERVAL);
            }

            // 3. FAZA FINIŠIRANJA & ISTORIJA
            currentRoundStatus = "calculating";
            roundHistory[currentRoundId] = [...drawnNumbers];

            // Čuvamo samo poslednjih 20 kola
            const keys = Object.keys(roundHistory);
            if (keys.length > 20) delete roundHistory[keys[0]];

            io.emit("roundFinished", { 
                roundId: currentRoundId, 
                allNumbers: drawnNumbers,
                history: roundHistory 
            });

            await processTickets(currentRoundId, drawnNumbers);

            // Arhiviranje u Firebase
            await db.ref(`roundsHistory/${currentRoundId}`).set({
                roundId: currentRoundId,
                drawnNumbers: drawnNumbers,
                createdAt: Date.now()
            });

            await sleep(10000); // Pauza pre novog kola

        } catch (err) {
            console.error("KRITIČNA GREŠKA U CIKLUSU:", err);
            await sleep(5000);
        }
    }
}

// ================= SOCKET KONEKCIJA =================
// Unutar io.on("connection", (socket) => { ... })
socket.on("connection", (socket) => {
    console.log(`Klijent povezan: ${socket.id}`);

    // Šaljemo sve što klijentu treba za "hladni start"
    socket.emit("initialState", {
        roundId: currentRoundId,
        status: currentRoundStatus, // "waiting" ili "running"
        timeLeft: countdown,        // Sinhronizovan tajmer
        drawnNumbers: drawnNumbers, // Brojevi koji su VEĆ izašli u ovoj rundi
        history: roundHistory,      // Rezultati prethodnih kola za .hit klasu
        jackpot: currentJackpot,    // Pretpostavka da imaš ovu varijablu
        bonus: currentBonus         // Pretpostavka da imaš ovu varijablu
    });
});
// ================= START =================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`⭐ KENO MASTER AKTIVAN NA PORTU ${PORT} | RTP: ${RTP_TARGET * 100}%`);
    runGame();
});