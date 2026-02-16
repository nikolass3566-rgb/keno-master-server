const http = require("http");
const admin = require("firebase-admin");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Socket.io setup - Optimizovano za real-time tajmer i animacije
const io = new Server(server, {
    cors: {
        origin: "*", // Dozvoljava svim originima, rešava CORS probleme sa kosom crtom
        methods: ["GET", "POST"]
    }
});

let serviceAccount;

// 1. FIREBASE ADMIN SETUP
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

// 2. KONSTANTE
const WAIT_TIME_SECONDS = 90; // 90 sekundi
const WAIT_TIME_MS = WAIT_TIME_SECONDS * 1000;
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

    // Čim se poveže, šaljemo mu trenutno stanje direktno iz memorije/baze
    roundRef.once("value").then(snap => {
        socket.emit("initialState", snap.val());
    });
});

// 4. POMOĆNE FUNKCIJE
async function getNextRoundId() {
    const snap = await db.ref("lastRoundId").get();
    let nextId = (snap.val() || 1000) + 1;
    await db.ref("lastRoundId").set(nextId);
    return nextId;
}

// U master.js dodaj ovu funkciju za proveru svih "pending" tiketa
async function processTickets(roundId, drawnNumbers) {
    console.log(`Započinjem obračun za kolo: ${roundId}`);

    const ticketsRef = db.ref("tickets");
    // Uzmi sve tikete koji čekaju (pending) i pripadaju ovom kolu
    const snapshot = await ticketsRef.orderByChild("roundId").equalTo(roundId).once("value");

    if (!snapshot.exists()) {
        console.log("Nema tiketa za obračun u ovom kolu.");
        return;
    }

    const tickets = snapshot.val();
    const updates = {};

    for (const key in tickets) {
        const ticket = tickets[key];
        if (ticket.status !== "pending") continue;

        // Izbroj pogotke
        const hits = ticket.numbers.filter(num => drawnNumbers.includes(num)).length;

        // IZRAČUNAJ DOBITAK (Ovo je tvoja logika kvota)
        // Primer: kvota je (broj pogodaka * 2) - prilagodi svojim pravilima
        let winAmount = 0;
        if (hits >= 1) {
            // Primer proste logike: fiksne kvote ili množioci
            const odds = [0, 2, 5, 10, 20, 50, 100, 500, 1000, 5000, 10000]; // Kvote za 0 do 10 pogodaka
            winAmount = ticket.amount * (odds[hits] || 0);
        }

        const status = winAmount > 0 ? "won" : "lost";

        // Pripremi update za tiket
        updates[`/tickets/${key}/status`] = status;
        updates[`/tickets/${key}/winAmount`] = winAmount;

        // Ako je dobitan, dodaj novac korisniku odmah
        if (winAmount > 0) {
            const userBalanceRef = db.ref(`users/${ticket.userId}/balance`);
            await userBalanceRef.transaction((currentBalance) => {
                return (currentBalance || 0) + winAmount;
            });
            console.log(`Korisnik ${ticket.userId} dobio ${winAmount} RSD`);
        }
    }

    // Izvrši sve promene na tiketima odjednom
    await db.ref().update(updates);
    console.log("Obračun završen.");
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// 5. GLAVNA LOGIKA IGRE
async function runGame() {
    console.log("🚀 Keno Master Start...");

    while (true) {
        let roundId = await getNextRoundId();
        let endTime = Date.now() + WAIT_TIME_MS;

        // --- KORAK 1: WAITING FAZA ---
        let roundData = {
            roundId: roundId,
            status: "waiting",
            endTime: endTime,
            drawnNumbers: [],
            drawnAnimated: []
        };
        await roundRef.set(roundData);

        console.log(`🔹 Kolo ${roundId}: Počela uplata.`);

        // TAJMER PETLJA: Emituje svake sekunde preko Socketa
        for (let s = WAIT_TIME_SECONDS; s >= 0; s--) {
            io.emit("roundUpdate", {
                roundId: roundId,
                status: "waiting",
                timeLeft: s,
                totalTime: WAIT_TIME_SECONDS
            });
            await sleep(1000);
        }

        // --- KORAK 2: RUNNING FAZA (IZVLAČENJE) ---
        await roundRef.update({ status: "running" });
        io.emit("roundUpdate", { status: "running", roundId: roundId });
        console.log(`🔴 Kolo ${roundId}: Izvlačenje!`);

        let drawn = [];
        for (let i = 0; i < 20; i++) {
            let n;
            do { n = Math.floor(Math.random() * 80) + 1; } while (drawn.includes(n));
            drawn.push(n);

            // Ažuriraj bazu (za one koji tek uđu na sajt)
            await roundRef.update({ drawnAnimated: drawn });

            // SOCKET EMIT: Šalje lopticu klijentu ZA ANIMACIJU
            io.emit("ballDrawn", {
                number: n,
                allDrawn: drawn,
                index: i // Šaljemo index 0-19 da klijent zna kad da očisti grid
            });

            console.log(`Loptica ${i + 1}: ${n}`);
            await sleep(DRAW_INTERVAL);
        }

        // --- KORAK 3: OBRAČUN ---
        await roundRef.update({ status: "calculating", drawnNumbers: drawn });
        io.emit("roundUpdate", { status: "calculating", roundId: roundId });

        await processTickets(roundId, drawn);

        // Arhiviranje
        await db.ref(`roundsHistory/${roundId}`).set({
            roundId,
            drawnNumbers: drawn,
            createdAt: Date.now()
        });

        io.emit("roundFinished", { roundId: roundId });
        console.log(`✅ Kolo ${roundId} završeno.`);
        await sleep(10000); // 10s pauze pre novog kola

        // U master.js (na kraju runde)
        io.emit("roundFinished", {
            roundId: currentRoundId,
            allNumbers: finalDrawnNumbers
        });

        // Pozovi funkciju za Firebase obračun
        processTickets(currentRoundId, finalDrawnNumbers);
    }
}

// 6. SERVER START
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n⭐ MASTER SERVER AKTIVAN NA PORTU ${PORT}`);
    runGame().catch(err => console.error("KRITIČNA GREŠKA:", err));
});