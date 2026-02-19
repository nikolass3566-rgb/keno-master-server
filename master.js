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
    1: { 0: 0, 1: 3 },               // 1 pogodak: kvota 3
    2: { 0: 0, 1: 1, 2: 8 },         // 2 pogotka: kvota 8
    3: { 0: 0, 1: 0, 2: 2, 3: 40 }, 
    4: { 0: 0, 1: 0, 2: 1, 3: 8, 4: 80 },
    5: { 0: 0, 2: 0, 3: 3, 4: 20, 5: 350 },
    6: { 0: 0, 3: 1, 4: 10, 5: 70, 6: 1500 },
    7: { 0: 0, 3: 1, 4: 4, 5: 30, 6: 300, 7: 5000 },
    8: { 0: 0, 4: 2, 5: 15, 6: 100, 7: 1000, 8: 15000 },
    9: { 0: 0, 4: 5, 5: 20, 6: 100, 7: 1000, 8: 4000, 9: 20000 },
    10: { 0: 0, 4: 4, 5: 10, 6: 20 , 7: 80, 8: 1000, 9: 10000, 10: 50000 }
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
                timeLeft: s,
                lastNumbers: lastRoundNumbers
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
        lastRoundNumbers = [...drawnNumbers];
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


function generateRandom20() {
    let arr = [];
    while (arr.length < 20) {
        let n = Math.floor(Math.random() * 80) + 1;
        if (!arr.includes(n)) arr.push(n);
    }
    return arr;
}
// master.js

// ==========================================
// 2. GLAVNI SOCKET DEO (Zameni svoj io.on deo ovim)
// ==========================================
io.on("connection", async (socket) => {
    console.log("Klijent povezan:", socket.id);

    // FUNKCIJA ZA SLANJE KOMPLETNOG STANJA (Gasi loader na klijentu)
    const sendGameState = async () => {
        try {
            const gameDataSnap = await db.ref("gameData").get();
            const gData = gameDataSnap.exists() ? gameDataSnap.val() : { jackpot: 0, bonusPot: 0 };

            socket.emit("gameUpdate", {
                roundId: currentRoundId,
                status: currentRoundStatus,
                countdown: countdown,
                drawnNumbers: drawnNumbers,
                lastNumbers: lastRoundNumbers,
                jackpot: gData.jackpot || 0,
                bonus: gData.bonusPot || 0
            });
        } catch (err) {
            console.error("Greška pri slanju početnog stanja:", err);
        }
    };

    // 1. Pošalji podatke ODMAH pri konekciji (Ovo gasi loader pri prvom ulasku)
    await sendGameState();

    // 2. Pošalji podatke kada klijent promeni tab i zatraži osvežavanje
    socket.on("requestSync", async () => {
        console.log(`[SYNC] Klijent ${socket.id} traži osvežavanje podataka.`);
        await sendGameState();
    });
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


            // 2. SPOREDNE STVARI (Statistika i Jackpot) - u posebnom try bloku
            try {
                await Promise.all([
                    //updateGlobalStats(ticketAmount, 0),
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

    // master.js - UNUTAR io.on("connection")


    // 1. Pošalji odmah pri konekciji
    sendGameState();

    // 2. Pošalji kada klijent zatraži (visibility change ili refresh)
    socket.on("requestSync", () => {
        console.log(`[SYNC] Klijent ${socket.id} traži osvežavanje podataka.`);
        sendGameState();
    });


 // Funkcija koja prikuplja SVE podatke i šalje ih (za sync i za admina)
   // master.js (Linija oko 230)

const sendFullSync = async () => {
    try {
        const [gameSnap, statsSnap] = await Promise.all([
            db.ref("gameData").get(),
            db.ref("admin/stats").get()
        ]);

        const gameData = gameSnap.val() || {};
        const stats = statsSnap.val() || { totalIn: 0, totalOut: 0, profit: 0 };

        socket.emit("gameUpdate", {
            roundId: currentRoundId,
            status: currentRoundStatus,
            countdown: countdown,
            jackpot: gameData.jackpot || 0,
            bonus: gameData.bonusPot || 0,
            // DODAJ OVE DVE LINIJE ISPOD:
            drawnNumbers: drawnNumbers,       // Trenutno izvučeni u rundi
            lastNumbers: lastRoundNumbers,    // Brojevi iz prošle runde
            stats: stats
        });
    } catch (err) {
        console.error("Greška pri sync-u:", err);
    }
};

    // Odmah pošalji podatke čim se admin/igrač poveže
    await sendFullSync();

    // Reaguj na ručni zahtev za osvežavanje (requestSync)
    socket.on("requestSync", async () => {
        await sendFullSync();
    });

    // Reset stats komanda sa Admin panela
    socket.on("adminResetStats", async () => {
        const freshStats = { totalIn: 0, totalOut: 0, profit: 0 };
        await db.ref("admin/stats").set(freshStats);
        io.emit("adminStatsUpdate", freshStats); // Javi svim adminima
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


// --- GLAVNA PAMETNA FUNKCIJA ---
async function generateSmartNumbers() {
    const statsSnap = await db.ref("admin/stats").get();
    const stats = statsSnap.val() || { totalIn: 0, totalOut: 0, profit: 0 };
    
    const snapshot = await db.ref("tickets").orderByChild("roundId").equalTo(currentRoundId).once("value");
    const tickets = snapshot.exists() ? snapshot.val() : {};
    
    let currentRoundIn = 0;
    for (const id in tickets) { currentRoundIn += (Number(tickets[id].amount) || 0); }

    const projectedTotalIn = (Number(stats.totalIn) || 0) + currentRoundIn;
    
    let bestCandidate = null;
    let closestRTPDiff = Infinity;
    const hasTickets = Object.keys(tickets).length > 0;

    // Simulacija (500 puta)
    for (let i = 0; i < 500; i++) {
        // Pola simulacija koristi "Near Miss", pola koristi čisti random
        const candidate = (i % 2 === 0 && hasTickets) 
            ? generateNearMissNumbers(tickets) 
            : generateRandom20();
            
        let potentialPayout = 0;
        
        for (const id in tickets) {
            const t = tickets[id];
            const hitCount = t.numbers.filter(n => candidate.includes(n)).length;
            const quota = KENO_PAYTABLE[t.numbers.length]?.[hitCount] || 0;
            potentialPayout += Math.floor((Number(t.amount) || 0) * quota);
        }

        const projectedTotalOut = (Number(stats.totalOut) || 0) + potentialPayout;
        const projectedRTP = projectedTotalIn > 0 ? (projectedTotalOut / projectedTotalIn) * 100 : 0;

        if (projectedRTP >= 70 && projectedRTP <= 85) {
            return candidate; // Našli smo savršen balans odmah
        }

        let diff = projectedRTP < 70 ? 70 - projectedRTP : projectedRTP - 85;
        if (diff < closestRTPDiff) {
            closestRTPDiff = diff;
            bestCandidate = candidate;
        }
    }
    return bestCandidate || generateRandom20();
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
// master.js - DODAJ OVU FUNKCIJU NA KRAJ FAJLA
async function updateGlobalStats(addIn, addOut) {
    try {
        const statsRef = db.ref("admin/stats");
        
        // Koristimo admin.database.ServerValue.increment
        // Ovo je "atomsko" - nema čitanja pa pisanja, samo direktno dodavanje
        await statsRef.update({
            totalIn: admin.database.ServerValue.increment(addIn),
            totalOut: admin.database.ServerValue.increment(addOut)
        });

        console.log(`[STATS] Uspešno ažurirano: +${addIn} ulaz, +${addOut} izlaz.`);
    } catch (e) {
        console.error("Greška u updateGlobalStats:", e);
    }
}
// master.js

// master.js

// Funkcija koja nalazi susedne brojeve (npr. za 15 to su 14, 16, 5, 25...)
function getAdjacentNumbers(num) {
    let adjacent = [];
    if (num > 1) adjacent.push(num - 1); // Broj levo
    if (num < 80) adjacent.push(num + 1); // Broj desno
    if (num > 10) adjacent.push(num - 10); // Broj iznad u gridu
    if (num < 71) adjacent.push(num + 10); // Broj ispod u gridu
    return adjacent;
}

// Modifikovana logika unutar generateSmartNumbers
function generateNearMissNumbers(playerTickets, targetProfit) {
    let finalNumbers = [];
    
    // ISPRAVKA: Pretvaramo objekat tiketa u niz da bi flatMap radio
    const ticketsArray = Object.values(playerTickets || {});
    let allPlayerNumbers = ticketsArray.flatMap(t => t.numbers || []);
    
    // Ukloni duplikate da ne vrtimo istu petlju više puta
    allPlayerNumbers = [...new Set(allPlayerNumbers)];

    // Prvo popunjavamo grid brojevima koji su "blizu" igračevih
    allPlayerNumbers.forEach(num => {
        // 50% šanse da dodamo susedni broj ako imamo mesta
        if (Math.random() > 0.5 && finalNumbers.length < 15) { 
            let adj = getAdjacentNumbers(num);
            let randomAdj = adj[Math.floor(Math.random() * adj.length)];
            
            // Dodajemo samo ako taj broj NIJE jedan od onih koje igrači igraju
            // i ako već nije u našem finalnom nizu
            if (!allPlayerNumbers.includes(randomAdj) && !finalNumbers.includes(randomAdj)) {
                finalNumbers.push(randomAdj);
            }
        }
    });

    // Ostatak do 20 brojeva popuni skroz nasumično, 
    // pazeći da ne pogodimo previše igračevih brojeva
    while (finalNumbers.length < 20) {
        let n = Math.floor(Math.random() * 80) + 1;
        if (!finalNumbers.includes(n)) {
            finalNumbers.push(n);
        }
    }
    
    return finalNumbers;
}