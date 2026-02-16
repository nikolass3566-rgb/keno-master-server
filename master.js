const http = require("http");
const express = require("express");
const admin = require("firebase-admin");
const { Server } = require("socket.io");

// ==========================================================================
// 1. GLOBALNE VARIJABLE I KONFIGURACIJA
// ==========================================================================
let currentRoundId = 0;
let currentRoundStatus = "waiting"; // "waiting", "running", "calculating"
let drawnNumbers = [];
let roundHistory = {}; // Čuva rezultate poslednjih kola za klijentski prikaz
let isDrawing = false;
let countdown = 90; // Sekunde između kola

const app = express();
const server = http.createServer(app);

// CORS podešavanja za stabilnu vezu sa lokalnim i remote klijentima
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// ==========================================================================
// 2. FIREBASE ADMIN SETUP
// ==========================================================================
let serviceAccount;
try {
    if (process.env.FIREBASE_CONFIG_JSON) {
        serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG_JSON);
    } else {
        serviceAccount = require("./serviceAccountKey.json");
    }

    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://keno-demo-31bf2-default-rtdb.europe-west1.firebasedatabase.app"
        });
    }
} catch (error) {
    console.error("KRITIČNA GREŠKA: Firebase nije inicijalizovan!", error);
}

const db = admin.database();

// ==========================================================================
// 3. ISPLATNA TABELA (PAYTABLE) I RTP PARAMETRI
// ==========================================================================
const RTP_TARGET = 0.70; // Ciljani povrat igračima je 70%

const KENO_PAYTABLE = {
    10: 10000, 9: 2000, 8: 500, 7: 100, 
    6: 25, 5: 5, 4: 2, 3: 0, 2: 0, 1: 0, 0: 0
};

// ==========================================================================
// 4. RTP LOGIKA - KONTROLA IZVLAČENJA
// ==========================================================================

/**
 * Simulira isplatu za potencijalni broj i vraća procenat rizika.
 * Pomaže serveru da odluči da li da izvuče određenu lopticu.
 */
async function calculatePotentialPayout(proposedBall, currentBalls, roundId) {
    const snapshot = await db.ref("tickets").orderByChild("roundId").equalTo(roundId).once("value");
    if (!snapshot.exists()) return 0;

    const tickets = snapshot.val();
    let totalPotentialPayout = 0;
    let totalBets = 0;

    const testDrawn = [...currentBalls, proposedBall];

    for (const id in tickets) {
        const t = tickets[id];
        totalBets += t.amount;
        const hits = t.numbers.filter(n => testDrawn.includes(n)).length;
        const win = t.amount * (KENO_PAYTABLE[hits] || 0);
        totalPotentialPayout += win;
    }

    return { payout: totalPotentialPayout, bets: totalBets };
}

/**
 * Bira "najbolju" lopticu koja održava RTP unutar granica.
 */
async function getSmartBall(currentDrawn, roundId) {
    let bestBall = null;
    let safestBall = null;
    let minPayout = Infinity;

    // Pokušavamo da nađemo lopticu u 10 nasumičnih pokušaja radi performansi
    for (let i = 0; i < 15; i++) {
        let candidate = Math.floor(Math.random() * 80) + 1;
        if (currentDrawn.includes(candidate)) continue;

        const { payout, bets } = await calculatePotentialPayout(candidate, currentDrawn, roundId);
        
        // Ako je isplata manja od 70% uloga, to je savršena loptica
        if (bets > 0 && (payout / bets) <= RTP_TARGET) {
            return candidate; 
        }

        // Pratimo koja loptica bar najmanje isplaćuje ako su sve "skupe"
        if (payout < minPayout) {
            minPayout = payout;
            safestBall = candidate;
        }
    }
    
    return safestBall || Math.floor(Math.random() * 80) + 1;
}

// ==========================================================================
// 5. PROCESUIRANJE TIKETA I ISPLATA
// ==========================================================================

async function processTickets(roundId, finalNumbers) {
    console.log(`\n--- ZAPOČET OBRAČUN TIKETA ZA KOLO ${roundId} ---`);
    try {
        const ticketsRef = db.ref("tickets");
        const snapshot = await ticketsRef.orderByChild("roundId").equalTo(roundId).once("value");

        if (!snapshot.exists()) {
            console.log("Nema uplaćenih tiketa za ovo kolo.");
            return;
        }

        const tickets = snapshot.val();
        const updates = {};
        let totalPaidOut = 0;

        for (const ticketId in tickets) {
            const ticket = tickets[ticketId];
            if (ticket.status !== "pending") continue;

            const hits = ticket.numbers.filter(num => finalNumbers.includes(num)).length;
            const multiplier = KENO_PAYTABLE[hits] || 0;
            const winAmount = Math.floor(ticket.amount * multiplier);

            const finalStatus = winAmount > 0 ? "won" : "lost";

            updates[`/tickets/${ticketId}/status`] = finalStatus;
            updates[`/tickets/${ticketId}/winAmount`] = winAmount;
            updates[`/tickets/${ticketId}/hitsCount`] = hits;

            if (winAmount > 0) {
                const balanceRef = db.ref(`users/${ticket.userId}/balance`);
                await balanceRef.transaction(current => (current || 0) + winAmount);
                totalPaidOut += winAmount;
            }
        }

        await db.ref().update(updates);
        console.log(`Obračun završen. Ukupno isplaćeno: ${totalPaidOut} RSD`);

    } catch (error) {
        console.error("GREŠKA TOKOM PROCESUIRANJA TIKETA:", error);
    }
}

// ==========================================================================
// 6. GLAVNI CIKLUS IGRE (GAME LOOP)
// ==========================================================================

async function runGameCycle() {
    while (true) {
        // --- FAZA 1: ČEKANJE (ODBROJAVANJE) ---
        currentRoundId = Date.now();
        currentRoundStatus = "waiting";
        drawnNumbers = [];
        countdown = 90;

        console.log(`\nNovo kolo započeto: ${currentRoundId}`);

        while (countdown > 0) {
            io.emit("roundUpdate", {
                roundId: currentRoundId,
                status: "waiting",
                timeLeft: countdown,
                history: roundHistory // Šaljemo istoriju klijentu za zlatne brojeve
            });
            await new Promise(r => setTimeout(r, 1000));
            countdown--;
        }

        // --- FAZA 2: IZVLAČENJE LOPTICA ---
        currentRoundStatus = "running";
        io.emit("roundUpdate", { roundId: currentRoundId, status: "running", timeLeft: 0 });

        for (let i = 0; i < 20; i++) {
            let ball;
            // Prvih 10 loptica su totalno random, ostalih 10 server "pazi" na profit
            if (i < 10) {
                do {
                    ball = Math.floor(Math.random() * 80) + 1;
                } while (drawnNumbers.includes(ball));
            } else {
                ball = await getSmartBall(drawnNumbers, currentRoundId);
            }

            drawnNumbers.push(ball);
            io.emit("ballDrawn", { number: ball, allDrawn: drawnNumbers });
            console.log(`Loptica ${i + 1}: ${ball}`);
            await new Promise(r => setTimeout(r, 3000)); // Razmak između loptica
        }

        // --- FAZA 3: FINIŠIRANJE I ISTORIJA ---
        currentRoundStatus = "calculating";
        
        // Čuvamo rezultate u istoriju za klijentski prikaz
        roundHistory[currentRoundId] = [...drawnNumbers];
        
        // Limitiramo istoriju na 20 unosa radi memorije
        const hKeys = Object.keys(roundHistory);
        if (hKeys.length > 20) delete roundHistory[hKeys[0]];

        // Obaveštavamo klijente i šaljemo osveženu istoriju
        io.emit("roundFinished", {
            roundId: currentRoundId,
            allNumbers: drawnNumbers,
            history: roundHistory
        });

        // Isplata dobitaka
        await processTickets(currentRoundId, drawnNumbers);

        // Kratka pauza pre nego što sve krene ispočetka
        await new Promise(r => setTimeout(r, 10000));
    }
}

// ==========================================================================
// 7. SERVER LISTEN I SOCKET KONEKCIJA
// ==========================================================================

io.on("connection", (socket) => {
    console.log(`Klijent povezan: ${socket.id}`);
    
    // Slanje trenutnog stanja čim se klijent zakači
    socket.emit("initialState", {
        roundId: currentRoundId,
        status: currentRoundStatus,
        timeLeft: countdown,
        drawnNumbers: drawnNumbers,
        history: roundHistory
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚀 KENO MASTER SERVER POKRENUT`);
    console.log(`📍 Port: ${PORT}`);
    console.log(`💰 Ciljani RTP: ${RTP_TARGET * 100}%`);
    runGameCycle(); // Pokrećemo beskonačnu petlju igre
});