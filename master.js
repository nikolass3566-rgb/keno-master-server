const http = require("http");
const admin = require("firebase-admin");
const express = require("express");
const { Server } = require("socket.io");
// ================= NA SAMOM VRHU FAJLA (iza require-a) =================
let currentRoundId = Date.now(); // Inicijalizacija odmah
let currentRoundStatus = "waiting";
let drawnNumbers = [];
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

const db = admin.database(); // OVO MORA BITI DEFINISANO DA BI 'db' RADILO
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
/**
 * Glavna funkcija za proveru tiketa i isplatu novca
 * Poziva se odmah nakon izvlačenja 20. loptice
 */
async function processTickets(roundId, drawnNumbers) {
    console.log(`\n[OBRAČUN] Pokretanje za kolo: ${roundId}`);
    
    try {
        // 1. Pristup tabeli sa tiketima
        const ticketsRef = db.ref("tickets");
        
        // 2. Uzmi samo tikete koji su uplaćeni za ovo specifično kolo
        const snapshot = await ticketsRef
            .orderByChild("roundId")
            .equalTo(roundId)
            .once("value");

        if (!snapshot.exists()) {
            console.log(`[OBRAČUN] Nema uplaćenih tiketa za kolo ${roundId}.`);
            return;
        }

        const tickets = snapshot.val();
        const updates = {};

        // 3. Prolazak kroz svaki tiket u bazi
        for (const ticketId in tickets) {
            const ticket = tickets[ticketId];

            // Obrađujemo samo tikete koji još čekaju (status: pending)
            if (ticket.status !== "pending") continue;

            // 4. Izračunaj broj pogodaka
            const hits = ticket.numbers.filter(num => drawnNumbers.includes(num)).length;
            
            // 5. DEFINICIJA KVOTA (Primer: keno 10/20)
            // hits: kvota (npr. 5 pogodaka množi ulog sa 5)
            const paytable = {
                10: 10000, 9: 2000, 8: 500, 7: 100, 
                6: 25, 5: 5, 4: 2, 3: 0, 2: 0, 1: 0, 0: 0
            };

            const multiplier = paytable[hits] || 0;
            const winAmount = Math.floor(ticket.amount * multiplier);

            // 6. Pripremi podatke za masovni update u bazi
            const finalStatus = winAmount > 0 ? "won" : "lost";
            
            updates[`/tickets/${ticketId}/status`] = finalStatus;
            updates[`/tickets/${ticketId}/winAmount`] = winAmount;
            updates[`/tickets/${ticketId}/hitsCount`] = hits;

            // 7. ISPLATA NA BALANS (Ako je tiket dobitan)
            if (winAmount > 0) {
                const userBalanceRef = db.ref(`users/${ticket.userId}/balance`);
                
                // Koristimo transaction da osiguramo preciznost balansa
                await userBalanceRef.transaction((currentBalance) => {
                    return (currentBalance || 0) + winAmount;
                });
                
                console.log(`[ISPLATA] Korisnik ${ticket.userId}: +${winAmount} RSD (Pogodaka: ${hits})`);
            }
        }

        // 8. Jednim potezom ažuriraj sve statuse tiketa u Firebase-u
        await db.ref().update(updates);
        console.log(`[OBRAČUN] Kolo ${roundId} je uspešno procesuirano.\n`);

    } catch (error) {
        console.error("[GREŠKA] Problem tokom obračuna tiketa:", error);
    }
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
// Negde u tvojoj keno logici...
console.log("Izvlačenje završeno!");

// Prvo pošalji klijentima da je gotovo
io.emit("roundFinished", { roundId: currentRoundId, allNumbers: drawnNumbers });



// Nakon toga pripremi sve za novo kolo
// currentRoundId = Date.now(); ... itd.
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
// Na vrhu master.js
let roundHistory = {}; // Objekat koji čuva rezultate: { roundId: [brojevi] }

// U funkciji gde završavaš kolo
async function finishRound(roundId, finalNumbers) {
    // Sačuvaj u memoriju servera
    roundHistory[roundId] = finalNumbers;

    // Opciono: Drži samo poslednjih 20 kola u memoriji da ne trošiš RAM
    const historyKeys = Object.keys(roundHistory);
    if (historyKeys.length > 20) {
        delete roundHistory[historyKeys[0]];
    }

    // Emituj svima rezultate i istoriju
    io.emit("roundFinished", { 
        roundId: roundId, 
        allNumbers: finalNumbers,
        history: roundHistory // Šaljemo celu istoriju klijentima
    });

    // Pokreni proces isplate u bazi (ovo ostaje u bazi jer su pare u pitanju)
    await processTickets(roundId, finalNumbers);
}

// U io.on("connection"), pošalji istoriju novom igraču
io.on("connection", (socket) => {
    socket.emit("initialState", {
        roundId: currentRoundId,
        status: currentRoundStatus,
        history: roundHistory, // Igrač odmah dobija rezultate prošlih kola
        // ... ostali podaci
    });
});
async function finalizeRound() {
    // 1. Sačuvaj trenutne rezultate u istoriju pre nego što krene novo kolo
    roundHistory[currentRoundId] = [...drawnNumbers];

    // Ograniči istoriju na poslednjih 15 kola (da ne preopteretiš RAM)
    const keys = Object.keys(roundHistory);
    if (keys.length > 15) {
        delete roundHistory[keys[0]];
    }

    // 2. Emituj kraj runde sa istorijom
    io.emit("roundFinished", { 
        roundId: currentRoundId, 
        allNumbers: drawnNumbers,
        history: roundHistory 
    });

    // 3. Obračunaj tikete u Firebase-u (isplata para)
    await processTickets(currentRoundId, drawnNumbers);

    // 4. Tek sada kreiraj NOVI ID za sledeće kolo
    currentRoundId = Date.now();
    currentRoundStatus = "waiting";
    drawnNumbers = [];
}