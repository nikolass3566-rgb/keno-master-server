const http = require("http");
const admin = require("firebase-admin");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
// Dodaj ovo pre nego što pokreneš server (server.listen)
app.get("/", (req, res) => {
    res.status(200).send("Server je aktivan i vrti runde!");
});
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
let roundHistory = {}; // OVO MORA BITI OVDE DEFINISANO

const KENO_PAYTABLE = {
    1: { 0: 0, 1: 2 },
    2: { 0: 0, 1: 1, 2: 5 },
    3: { 0: 0, 1: 0, 2: 2, 3: 10 },
    4: { 0: 0, 1: 0, 2: 1, 3: 5, 4: 15 },
    5: { 0: 0, 1: 0, 2: 0, 3: 2, 4: 10, 5: 50 },
    6: { 0: 0, 1: 0, 2: 0, 3: 1, 4: 6, 5: 25, 6: 120 },
    7: { 0: 0, 1: 0, 2: 0, 3: 1, 4: 5, 5: 25, 6: 100, 7: 400 },
    8: { 0: 0, 1: 0, 2: 0, 3: 1, 4: 0, 5: 2, 6: 75, 7: 250, 8: 800 },
    9: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 2, 5: 4, 6: 80, 7: 300, 8: 1200, 9: 4000 },
    10: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 4, 5: 8, 6: 100, 7: 400, 8: 2000, 9: 5000, 10: 10000 }
};
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// OBRAČUN DOBITAKA
// master.js - ISPRAVLJEN OBRAČUN TIKETA
async function processTickets(roundId, finalNumbers) {
    let roundIn = 0;
    let roundOut = 0;
    console.log(`[OBRAČUN] Kolo: ${roundId}`);

    try {
        const snapshot = await db.ref("tickets").orderByChild("roundId").equalTo(roundId).once("value");
        if (!snapshot.exists()) {
            console.log(`[OBRAČUN] Nema tiketa za kolo ${roundId}`);
            return;
        }

        const tickets = snapshot.val();

        for (const id in tickets) {
            const t = tickets[id];
            const stake = Number(t.amount) || 0;
            roundIn += stake; // Dodajemo uplaćen novac u statistiku

            const hitsArray = t.numbers.filter(n => finalNumbers.includes(n));
            const hitCount = hitsArray.length;
            const quota = KENO_PAYTABLE[t.numbers.length]?.[hitCount] || 0;
            const winAmount = Math.floor(stake * quota);

            if (winAmount > 0) {
                roundOut += winAmount; // Dodajemo isplaćen novac
                console.log(`[ISPLATA] Korisnik ${t.userId} dobio ${winAmount} RSD`);
                await db.ref(`users/${t.userId}/balance`).transaction(bal => (Number(bal) || 0) + winAmount);
            }

            // Ažuriramo tiket u bazi
            await db.ref(`tickets/${id}`).update({
                status: winAmount > 0 ? "win" : "lose",
                winAmount: winAmount,
                hits: hitsArray
            });
        }

        // Ažuriramo globalni RTP jednom na kraju kola
        await updateGlobalStats(roundIn, roundOut);

    } catch (e) {
        console.error("Kritična greška u obračunu:", e);
    }
}

async function runGame() {
    // 1. Inicijalizacija pri startu servera
    const snap = await db.ref("lastRoundId").get();
    currentRoundId = snap.val() || 1000;
    console.log(`[START] Igra pokrenuta od kola: ${currentRoundId}`);

    while (true) {
        // --- FAZA ČEKANJA (WAITING) ---
        drawnNumbers = [];
        currentRoundStatus = "waiting";

        for (let s = 90; s >= 0; s--) {
            countdown = s;
            io.emit("roundUpdate", {
                roundId: currentRoundId,
                status: "waiting",
                timeLeft: s
            });
            await sleep(1000);
        }

        // --- FAZA PAMETNOG GENERISANJA (RTP KONTROLA) ---
        console.log(`[RTP] Analiza uplata za kolo ${currentRoundId}...`);
        const finalNumbers = await generateSmartNumbers();

        // --- FAZA IZVLAČENJA (RUNNING) ---
        currentRoundStatus = "running";
        io.emit("roundUpdate", { status: "running", roundId: currentRoundId });

        for (let i = 0; i < 20; i++) {
            const n = finalNumbers[i];
            drawnNumbers.push(n);
            io.emit("ballDrawn", { number: n, allDrawn: drawnNumbers });
            await sleep(3000);
        }

        // --- FAZA OBRAČUNA (CALCULATING) ---
        currentRoundStatus = "calculating";

        // 1. Sačuvaj u lokalnu istoriju
        roundHistory[currentRoundId] = [...drawnNumbers];
        let keys = Object.keys(roundHistory);
        if (keys.length > 20) delete roundHistory[keys[0]];

        // 2. Sačuvaj u Firebase
        await db.ref(`rounds/${currentRoundId}`).set({
            numbers: drawnNumbers,
            timestamp: Date.now()
        });

        // 3. Pokreni obračun tiketa 
        await processTickets(currentRoundId, drawnNumbers);

        // 4. Javi klijentima da je gotovo
        io.emit("roundFinished", {
            roundId: currentRoundId,
            allNumbers: drawnNumbers
        });

        // 5. BONUS/JACKPOT PROVERA
        await checkSpecialPrizes(); 

        await sleep(10000); // Pauza od 10s za gledanje rezultata

        // --- PRIPREMA ZA NOVO KOLO ---
        currentRoundId++;
        await db.ref("lastRoundId").set(currentRoundId);
    } // <-- JEDINI KRAJ WHILE PETLJE
}



/**
 * Pomoćna funkcija za RTP kontrolu (55% - 77%)
 */
async function generateSmartNumbers() {
    let bestSet = [];
    let lowestPayout = Infinity;

    // Uzmi sve uplate za trenutno kolo
    const snapshot = await db.ref("tickets").orderByChild("roundId").equalTo(currentRoundId).once("value");
    const tickets = snapshot.exists() ? snapshot.val() : {};

    // Ako nema uplata, daj čisto nasumične brojeve
    if (Object.keys(tickets).length === 0) return generateRandom20();

    // Simuliraj 15 različitih izvlačenja i uzmi ono koje najmanje isplaćuje (RTP zaštita)
    for (let i = 0; i < 15; i++) {
        const candidate = generateRandom20();
        let totalWin = 0;

        for (const id in tickets) {
            const t = tickets[id];
            const hitCount = t.numbers.filter(n => candidate.includes(n)).length;
            const quota = KENO_PAYTABLE[t.numbers.length]?.[hitCount] || 0;
            totalWin += Math.floor((Number(t.amount) || 0) * quota);
        }

        if (totalWin < lowestPayout) {
            lowestPayout = totalWin;
            bestSet = candidate;
        }
    }
    return bestSet;
}

function generateRandom20() {
    let arr = [];
    while (arr.length < 20) {
        let n = Math.floor(Math.random() * 80) + 1;
        if (!arr.includes(n)) arr.push(n);
    }
    return arr;
}
// master.js

io.on("connection", async (socket) => {
    console.log("Klijent povezan:", socket.id);

    // ODMAH pošalji trenutne vrijednosti Jackpot-a i Bonusa čim uđe na sajt
    try {
        const gameDataSnap = await db.ref("gameData").get();
        if (gameDataSnap.exists()) {
            socket.emit("liveUpdate", {
                jackpot: gameDataSnap.val().jackpot || 0,
                bonus: gameDataSnap.val().bonusPot || 0 // Šaljemo kao 'bonus' radi script.js
            });
        }
    } catch (e) { console.log("Greška pri početnom slanju:", e); }

    socket.on("placeTicket", async (data) => {
        const { userId, numbers, amount, roundId } = data;
        const ticketAmount = Number(amount);
        let moneyDeducted = false;

        try {
            const userRef = db.ref(`users/${userId}/balance`);
            const result = await userRef.transaction(current => {
                if (current === null) return 0;
                let bal = Number(current);
                if (bal < ticketAmount) return;
                return bal - ticketAmount;
            });

            if (!result.committed) return socket.emit("ticketError", "Nedovoljno novca!");

            moneyDeducted = true;
            const finalBalance = result.snapshot.val();

            // 1. UPIŠI TIKET (Glavni prioritet)
            const newTicketRef = db.ref(`tickets`).push();
            await newTicketRef.set({
                userId, numbers, amount: ticketAmount, roundId,
                status: "pending", createdAt: Date.now()
            });

            // JAVI USPEH ODMAH (Ne čekaj statistiku)
            socket.emit("balanceUpdate", finalBalance);
            socket.emit("ticketSuccess", { msg: "Tiket uplaćen!", balance: finalBalance });

            // 2. SPOREDNE STVARI (Statistika i Jackpot) - u posebnom try bloku
            try {
                await Promise.all([
                    updateGlobalStats(ticketAmount, 0),
                    db.ref("gameData/jackpot").transaction(j => (j || 0) + (ticketAmount * 0.01)),
                    db.ref("gameData/bonusPot").transaction(b => (b || 0) + (ticketAmount * 0.01))
                ]);

                // Pošalji svima novo stanje fondova
                const gData = await db.ref("gameData").get();
                io.emit("liveUpdate", {
                    jackpot: gData.val()?.jackpot || 0,
                    bonus: gData.val()?.bonusPot || 0
                });
            } catch (sideErr) { console.error("Stats error:", sideErr); }

        } catch (err) {
            console.error("Kritična greška:", err);
            if (!moneyDeducted) socket.emit("ticketError", "Greška na serveru.");
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server aktivan na portu ${PORT}`);
    runGame();
});
// master.js
db.ref("tickets").on("child_added", async (snapshot) => {
    const ticket = snapshot.val();
    if (!ticket.roundId) {
        // Server mu dodeljuje ID kola koje je TRENUTNO aktivno na serveru
        await snapshot.ref.update({ roundId: currentRoundId });
    }
});


async function generateSmartNumbers() {
    // 1. Povuci statistiku iz baze
    const statsSnap = await db.ref("admin/stats").get();
    const stats = statsSnap.val() || { totalIn: 0, totalOut: 0, profit: 0 };
    
    // Izračunaj trenutni RTP (isplaćeno / uplaćeno)
    const currentRTP = stats.totalIn > 0 ? (stats.totalOut / stats.totalIn) * 100 : 0;

    let bestSet = [];
    let lowestPayout = Infinity;

    // 2. Simuliraj izvlačenja
    for (let i = 0; i < 200; i++) { // Probaj 20 različitih kombinacija
        let candidate = generateRandom20();
        let potentialPayout = await calculateSimulatedPayout(candidate);

        // Ako je profit nizak (RTP > 77%), forsiraj kombinaciju sa najmanjom isplatom
        if (currentRTP > 77) {
            if (potentialPayout < lowestPayout) {
                lowestPayout = potentialPayout;
                bestSet = candidate;
            }
        } else {
            // Ako smo u dobrom profitu, daj bilo koju fer kombinaciju
            return candidate; 
        }
    }
    return bestSet;
}
// master.js

async function checkSpecialPrizes() {
    const statsSnap = await db.ref("admin/stats").get();
    const stats = statsSnap.val() || { profit: 0 };
    
    const gameDataSnap = await db.ref("gameData").get();
    const gameData = gameDataSnap.val() || { jackpot: 0, bonusPot: 0 };

    // 1. JACKPOT: Puca samo ako je profit preko 100,000 RSD i jackpot preko 5,000
    if (stats.profit > 100000 && gameData.jackpot > 5000) {
        if (Math.random() < 0.05) { // 5% šanse svako kolo kada su uslovi ispunjeni
            await triggerJackpotPayback(gameData.jackpot);
        }
    }

    // 2. BONUS: Puca ako je profit preko 20,000 RSD i bonusPot prešao limit
    if (stats.profit > 20000 && gameData.bonusPot > 10000) {
        await triggerBonusRound(gameData.bonusPot);
    }
}

// ================= NEDOSTAJUĆE FUNKCIJE =================

async function calculateSimulatedPayout(candidateNumbers) {
    try {
        const snapshot = await db.ref("tickets").orderByChild("roundId").equalTo(currentRoundId).once("value");
        if (!snapshot.exists()) return 0;

        let totalPotentialWin = 0;
        const tickets = snapshot.val();
        
        for (const id in tickets) {
            const t = tickets[id];
            const hitCount = t.numbers.filter(n => candidateNumbers.includes(n)).length;
            const quota = KENO_PAYTABLE[t.numbers.length]?.[hitCount] || 0;
            totalPotentialWin += Math.floor((Number(t.amount) || 0) * quota);
        }
        return totalPotentialWin;
    } catch (e) { return 999999; }
}

async function triggerJackpotPayback(amount) {
    console.log(`[JACKPOT PUKAO] Iznos: ${amount}`);
    // Resetuj u bazi
    await db.ref("gameData/jackpot").set(0);
    // Ovde možeš dodati logiku da izvučeš random korisnika i daš mu pare
}

async function triggerBonusRound(amount) {
    console.log(`[BONUS PUKAO] Iznos: ${amount}`);
    await db.ref("gameData/bonusPot").set(0);
}