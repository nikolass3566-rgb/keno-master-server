const http = require("http");
const admin = require("firebase-admin");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// FIREBASE KONFIGURACIJA (Preuzima iz env ili fajla)
let serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG_JSON);
if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://keno-demo-31bf2-default-rtdb.europe-west1.firebasedatabase.app"
});
const db = admin.database();

// GLOBALNE VARIJABLE
let currentRoundId = 0;
let currentRoundStatus = "waiting";
let drawnNumbers = [];
let lastRoundNumbers = []; // Za korisnike koji uđu u pauzi
let countdown = 90;

const KENO_PAYTABLE = { 10:10000, 9:2000, 8:500, 7:100, 6:25, 5:5, 4:2, 3:0, 2:0, 1:0, 0:0 };
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// OBRAČUN DOBITAKA
async function processTickets(roundId, finalNumbers) {
    console.log(`[OBRAČUN] Kolo: ${roundId}`);
    try {
        const snapshot = await db.ref("tickets").orderByChild("roundId").equalTo(roundId).once("value");
        if (!snapshot.exists()) return;

        const tickets = snapshot.val();
        for (const id in tickets) {
            const t = tickets[id];
            const hits = t.numbers.filter(n => finalNumbers.includes(n));
            const winAmount = Math.floor(t.amount * (KENO_PAYTABLE[hits.length] || 0));
            
            const status = winAmount > 0 ? "win" : "lose";

            // Update tiketa u bazi
            await db.ref(`tickets/${id}`).update({
                status: status,
                winAmount: winAmount,
                hits: hits // Da bi klijent mogao da ih pozlati
            });

            // Isplata korisniku
            if (winAmount > 0) {
                await db.ref(`users/${t.userId}/balance`).transaction(b => (b || 0) + winAmount);
            }
        }
    } catch (e) { console.error("Greška u obračunu:", e); }
}

async function runGame() {
    // Inicijalni Round ID
    const snap = await db.ref("lastRoundId").get();
    currentRoundId = snap.val() || 1000;

    while (true) {
        currentRoundId++;
        await db.ref("lastRoundId").set(currentRoundId);
        drawnNumbers = [];
        currentRoundStatus = "waiting";

        // 1. COUNTDOWN FAZA
        for (let s = 90; s >= 0; s--) {
            countdown = s;
            io.emit("roundUpdate", { roundId: currentRoundId, status: "waiting", timeLeft: s });
            await sleep(1000);
        }

        // 2. IZVLAČENJE FAZA
        currentRoundStatus = "running";
        io.emit("roundUpdate", { status: "running", roundId: currentRoundId });

        for (let i = 0; i < 20; i++) {
            let n;
            do { n = Math.floor(Math.random() * 80) + 1; } while (drawnNumbers.includes(n));
            drawnNumbers.push(n);
            io.emit("ballDrawn", { number: n, allDrawn: drawnNumbers });
            await sleep(3000);
        }

        // 3. KRAJ I OBRAČUN
        currentRoundStatus = "calculating";
        lastRoundNumbers = [...drawnNumbers]; // Čuvamo za "pauza" prikaz
        await processTickets(currentRoundId, drawnNumbers);
        
        io.emit("roundFinished", { roundId: currentRoundId, allNumbers: drawnNumbers });
        await sleep(10000); // 10 sekundi prikaza rezultata pre nove runde
    }
}

io.on("connection", (socket) => {
    // SINHRONIZACIJA: Šaljemo podatke zavisno od toga šta se trenutno dešava
    socket.emit("initialState", {
        roundId: currentRoundId,
        status: currentRoundStatus,
        timeLeft: countdown,
        // Ako je pauza, pošalji prošle brojeve, ako je izvlačenje, pošalji trenutne
        drawnNumbers: currentRoundStatus === "waiting" ? lastRoundNumbers : drawnNumbers
    });
    // master.js - Unutar io.on("connection", (socket) => { ... })

socket.on("placeTicket", async (data) => {
    const { userId, numbers, amount, roundId } = data;

    try {
        // 1. Provera balansa u Firebase-u
        const userRef = db.ref(`users/${userId}`);
        const userSnap = await userRef.once("value");
        const userData = userSnap.val();

        if (!userData || (userData.balance < amount)) {
            return socket.emit("ticketError", "Nemaš dovoljno novca na računu!");
        }

        // 2. Oduzmi novac (Ovo je sigurno jer server kontroliše)
        const newBalance = userData.balance - amount;
        await userRef.update({ balance: newBalance });

        // 3. UPIŠI TIKET U GLOBALNU LISTU (Ovo aktivira loadUserTickets kod klijenta)
        const newTicketRef = db.ref(`tickets`).push();
        await newTicketRef.set({
            userId: userId,
            numbers: numbers,
            amount: amount,
            roundId: roundId,
            status: "pending",
            createdAt: Date.now()
        });

        console.log(`[UPLATA] Korisnik ${userId} uplatio ${amount} RSD za kolo ${roundId}`);

    } catch (err) {
        console.error("Greška pri uplati:", err);
        socket.emit("ticketError", "Serverska greška pri obradi tiketa.");
    }
});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server aktivan na portu ${PORT}`);
    runGame();
});