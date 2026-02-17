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
async function processTickets(roundId, finalNumbers) {
    console.log(`[OBRAČUN] Kolo: ${roundId}`);
    try {
        const snapshot = await db.ref("tickets").orderByChild("roundId").equalTo(roundId).once("value");
        if (!snapshot.exists()) {
            console.log(`[OBRAČUN] Nema tiketa za kolo ${roundId}`);
            return;
        }

        const tickets = snapshot.val();
        const updates = {}; // Koristimo multi-update za veću brzinu

        for (const id in tickets) {
            const t = tickets[id];

            // 1. Broj odigranih i broj pogođenih brojeva
            const totalPlayed = t.numbers.length;
            const hitsArray = t.numbers.filter(n => finalNumbers.includes(n));
            const hitCount = hitsArray.length;

            // 2. NOVA LOGIKA KVOTE: KENO_PAYTABLE[koliko_je_igrao][koliko_je_pogodio]
            let quota = 0;
            if (KENO_PAYTABLE[totalPlayed] && KENO_PAYTABLE[totalPlayed][hitCount] !== undefined) {
                quota = KENO_PAYTABLE[totalPlayed][hitCount];
            }

            // 3. Računanje uz Number() konverziju da izbegnemo NaN
            const stake = Number(t.amount) || 0;
            const winAmount = Math.floor(stake * quota);

            // Sigurnosni check pre upisa u bazu
            if (isNaN(winAmount)) {
                console.error(`[CRITICAL] NaN detektovan za tiket ${id}! Iznos: ${t.amount}, Kvota: ${quota}`);
                continue; // Preskoči ovaj tiket da ne srušiš ceo obračun
            }

            const status = winAmount > 0 ? "win" : "lose";

            // 4. Update tiketa
            await db.ref(`tickets/${id}`).update({
                status: status,
                winAmount: winAmount,
                hits: hitsArray
            });

            // 5. Isplata korisniku
            if (winAmount > 0) {
                console.log(`[ISPLATA] Korisnik ${t.userId} dobio ${winAmount} RSD na kolu ${roundId}`);
                await db.ref(`users/${t.userId}/balance`).transaction(currentBalance => {
                    return (Number(currentBalance) || 0) + winAmount;
                });
            }
        }
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
        // Generišemo brojeve pre nego što ih klijenti vide
        console.log(`[RTP] Analiza uplata za kolo ${currentRoundId}...`);
        const finalNumbers = await generateSmartNumbers(); // Ova funkcija bira najboljih 20 za profit

        // --- FAZA IZVLAČENJA (RUNNING) ---
        currentRoundStatus = "running";
        io.emit("roundUpdate", { status: "running", roundId: currentRoundId });

        // Prikazujemo lopticu jednu po jednu (animacija za klijente)
        for (let i = 0; i < 20; i++) {
            const n = finalNumbers[i];
            drawnNumbers.push(n);
            io.emit("ballDrawn", { number: n, allDrawn: drawnNumbers });
            await sleep(3000); // Pauza između loptica
        }

        // --- FAZA OBRAČUNA (CALCULATING) ---
        currentRoundStatus = "calculating";

        // 1. Sačuvaj u lokalnu istoriju (za brzi AJAX/Socket pristup)
        roundHistory[currentRoundId] = [...drawnNumbers];
        let keys = Object.keys(roundHistory);
        if (keys.length > 20) delete roundHistory[keys[0]];

        // 2. Sačuvaj u Firebase (trajna arhiva rezultata)
        await db.ref(`rounds/${currentRoundId}`).set({
            numbers: drawnNumbers,
            timestamp: Date.now()
        });

        // 3. Pokreni obračun tiketa (ona sređena funkcija sa Number() zaštitom)
        // Ovo rešava problem sa NaN i Pending statusom
        await processTickets(currentRoundId, drawnNumbers);

        // 4. Javi klijentima da je gotovo
        io.emit("roundFinished", {
            roundId: currentRoundId,
            allNumbers: drawnNumbers
        });

        await sleep(10000); // Pauza od 10s za gledanje rezultata

        // --- PRIPREMA ZA NOVO KOLO ---
        currentRoundId++;
        // Čuvamo ID u bazu da bi se restart servera nastavio odavde
        await db.ref("lastRoundId").set(currentRoundId);
    }
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
io.on("connection", (socket) => {
    // SINHRONIZACIJA: Šaljemo podatke zavisno od toga šta se trenutno dešava
    socket.emit("initialState", {
        roundId: currentRoundId,
        status: currentRoundStatus,
        timeLeft: countdown,
        history: roundHistory, // Ovo je ključno!
        // Ako je pauza, pošalji prošle brojeve, ako je izvlačenje, pošalji trenutne
        drawnNumbers: currentRoundStatus === "waiting" ? lastRoundNumbers : drawnNumbers
    });
    // master.js - Unutar io.on("connection", (socket) => { ... })

    socket.on("placeTicket", async (data) => {
        const { userId, numbers, amount, roundId } = data;
        const ticketAmount = Number(amount);

        // Osnovna provera podataka da izbegnemo NaN u bazi
        if (isNaN(ticketAmount) || ticketAmount <= 0) {
            return socket.emit("ticketError", "Nevalidan iznos uplate!");
        }

        try {
            const userRef = db.ref(`users/${userId}/balance`);

            // Korišćenje transakcije za sigurno skidanje novca
            const result = await userRef.transaction((currentBalance) => {
                if (currentBalance === null) return 0; // Ako korisnik ne postoji
                if (currentBalance < ticketAmount) {
                    return; // Prekida transakciju ako nema dovoljno para
                }
                return currentBalance - ticketAmount;
            });

            // Provera da li je transakcija uspela (committed)
            if (!result.committed) {
                return socket.emit("ticketError", "Nemaš dovoljno novca ili je greška u nalogu!");
            }

            const finalBalance = result.snapshot.val();

            // Upiši tiket
            const newTicketRef = db.ref(`tickets`).push();
            await newTicketRef.set({
                userId: userId,
                numbers: numbers,
                amount: ticketAmount,
                roundId: roundId,
                status: "pending",
                createdAt: Date.now()
            });

            // OBAVEZNO: Javi klijentu novo stanje balansa odmah
            socket.emit("balanceUpdate", finalBalance);

            console.log(`[UPLATA SUCCESS] Korisnik ${userId}: -${ticketAmount} RSD. Novo stanje: ${finalBalance}`);

        } catch (err) {
            console.error("Kritična greška pri uplati:", err);
            socket.emit("ticketError", "Greška na serveru. Novac nije skinut.");
        }
        // Dodaj u Jackpot i Bonus fond (iz prethodne logike)
        await db.ref("gameData/jackpot").transaction(j => (j || 0) + (ticketAmount * 0.01));
        await db.ref("gameData/bonusPot").transaction(b => (b || 0) + (ticketAmount * 0.01));
    });


    // 2. DODAJ OVO: Slušalac za promenu taba (Visibility API sinhronizacija)
    socket.on("requestSync", () => {
        console.log(`[SYNC] Korisnik osvežava tab za kolo ${currentRoundId}`);
        socket.emit("initialState", {
            roundId: currentRoundId,
            status: currentRoundStatus,
            timeLeft: countdown,
            history: roundHistory,
            drawnNumbers: currentRoundStatus === "waiting" ? lastRoundNumbers : drawnNumbers
        });
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