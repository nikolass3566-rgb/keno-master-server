const http = require("http");
const express = require("express");
const admin = require("firebase-admin");
const { Server } = require("socket.io");

// ======================================================
// GLOBAL STATE
// ======================================================

let currentRoundId = 0;
let currentRoundStatus = "waiting";
let drawnNumbers = [];
let roundHistory = {};
let countdown = 90;

const RTP_TARGET = 0.70;
const TOTAL_NUMBERS = 80;
const MAX_PICK = 10;
const MIN_BET = 20;

const KENO_PAYTABLE = {
    10: 10000, 9: 2000, 8: 500, 7: 100,
    6: 25, 5: 5, 4: 2, 3: 0, 2: 0, 1: 0, 0: 0
};

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// ======================================================
// FIREBASE INIT
// ======================================================

let serviceAccount;
if (process.env.FIREBASE_CONFIG_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG_JSON);
} else {
    serviceAccount = require("./serviceAccountKey.json");
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://keno-demo-31bf2-default-rtdb.europe-west1.firebasedatabase.app"
});

const db = admin.database();

// ======================================================
// RTP LOGIKA
// ======================================================

async function calculatePotentialPayout(ball, currentBalls, roundId) {
    const snap = await db.ref("tickets")
        .orderByChild("roundId")
        .equalTo(roundId)
        .once("value");

    if (!snap.exists()) return { payout: 0, bets: 0 };

    const tickets = snap.val();
    let totalPayout = 0;
    let totalBets = 0;

    const testDraw = [...currentBalls, ball];

    for (const id in tickets) {
        const t = tickets[id];
        totalBets += t.amount;
        const hits = t.numbers.filter(n => testDraw.includes(n)).length;
        totalPayout += t.amount * (KENO_PAYTABLE[hits] || 0);
    }

    return { payout: totalPayout, bets: totalBets };
}

async function getSmartBall(currentDrawn, roundId) {
    let safestBall = null;
    let minPayout = Infinity;

    for (let i = 0; i < 15; i++) {
        const candidate = Math.floor(Math.random() * 80) + 1;
        if (currentDrawn.includes(candidate)) continue;

        const { payout, bets } = await calculatePotentialPayout(candidate, currentDrawn, roundId);

        if (bets > 0 && (payout / bets) <= RTP_TARGET)
            return candidate;

        if (payout < minPayout) {
            minPayout = payout;
            safestBall = candidate;
        }
    }

    return safestBall || Math.floor(Math.random() * 80) + 1;
}

// ======================================================
// TICKET PROCESSING
// ======================================================

async function processTickets(roundId, finalNumbers) {
    const snap = await db.ref("tickets")
        .orderByChild("roundId")
        .equalTo(roundId)
        .once("value");

    if (!snap.exists()) return;

    const tickets = snap.val();
    const updates = {};

    for (const ticketId in tickets) {
        const t = tickets[ticketId];
        if (t.status !== "pending") continue;

        const hits = t.numbers.filter(n => finalNumbers.includes(n)).length;
        const multiplier = KENO_PAYTABLE[hits] || 0;
        const winAmount = Math.floor(t.amount * multiplier);

        updates[`tickets/${ticketId}/status`] = winAmount > 0 ? "won" : "lost";
        updates[`tickets/${ticketId}/winAmount`] = winAmount;
        updates[`tickets/${ticketId}/hitsCount`] = hits;

        if (winAmount > 0) {
            await db.ref(`users/${t.userId}/balance`)
                .transaction(b => (b || 0) + winAmount);
        }
    }

    await db.ref().update(updates);
}

// ======================================================
// SOCKET LOGIKA
// ======================================================

io.on("connection", (socket) => {

    console.log("Client connected:", socket.id);

    socket.emit("initialState", {
        roundId: currentRoundId,
        status: currentRoundStatus,
        timeLeft: countdown,
        drawnNumbers,
        history: roundHistory
    });

    // ==================================================
    // PLACE BET (SERVER AUTHORITY)
    // ==================================================

    socket.on("placeBet", async (data, callback) => {

        try {
            const { userId, numbers, amount } = data;

            if (currentRoundStatus !== "waiting")
                return callback({ success: false, message: "Kolo je u toku." });

            if (!userId || !Array.isArray(numbers))
                return callback({ success: false, message: "Neispravni podaci." });

            if (numbers.length === 0 || numbers.length > MAX_PICK)
                return callback({ success: false, message: "Neispravan broj brojeva." });

            if (amount < MIN_BET)
                return callback({ success: false, message: "Minimalna uplata je 20." });

            const uniqueNumbers = [...new Set(numbers)];
            if (uniqueNumbers.length !== numbers.length)
                return callback({ success: false, message: "Dupli brojevi." });

            if (numbers.some(n => n < 1 || n > TOTAL_NUMBERS))
                return callback({ success: false, message: "Brojevi van opsega." });

            const balanceRef = db.ref(`users/${userId}/balance`);

            let newBalance = 0;

            await balanceRef.transaction(balance => {
                if ((balance || 0) < amount) return;
                newBalance = balance - amount;
                return newBalance;
            });

            const ticketRef = db.ref("tickets").push();
            await ticketRef.set({
                userId,
                roundId: currentRoundId,
                numbers,
                amount,
                status: "pending",
                createdAt: Date.now()
            });

            callback({ success: true, balance: newBalance });

        } catch (err) {
            console.error("Bet error:", err);
            callback({ success: false, message: "Server greška." });
        }
    });
});

// ======================================================
// GAME LOOP
// ======================================================

async function runGameCycle() {
    while (true) {

        currentRoundId = Date.now();
        currentRoundStatus = "waiting";
        drawnNumbers = [];
        countdown = 90;

        while (countdown > 0) {
            io.emit("roundUpdate", {
                roundId: currentRoundId,
                status: "waiting",
                timeLeft: countdown
            });
            await new Promise(r => setTimeout(r, 1000));
            countdown--;
        }

        currentRoundStatus = "running";
        io.emit("roundUpdate", { roundId: currentRoundId, status: "running" });

        for (let i = 0; i < 20; i++) {
            let ball;

            if (i < 10) {
                do {
                    ball = Math.floor(Math.random() * 80) + 1;
                } while (drawnNumbers.includes(ball));
            } else {
                ball = await getSmartBall(drawnNumbers, currentRoundId);
            }

            drawnNumbers.push(ball);
            io.emit("ballDrawn", { number: ball });
            await new Promise(r => setTimeout(r, 3000));
        }

        currentRoundStatus = "calculating";

        roundHistory[currentRoundId] = [...drawnNumbers];
        if (Object.keys(roundHistory).length > 20)
            delete roundHistory[Object.keys(roundHistory)[0]];

        io.emit("roundFinished", {
            roundId: currentRoundId,
            allNumbers: drawnNumbers,
            history: roundHistory
        });

        await processTickets(currentRoundId, drawnNumbers);

        await new Promise(r => setTimeout(r, 10000));
    }
}

// ======================================================
// START SERVER
// ======================================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
    console.log("🚀 KENO MASTER SERVER POKRENUT");
    console.log("💰 RTP:", RTP_TARGET * 100, "%");
    runGameCycle();
});