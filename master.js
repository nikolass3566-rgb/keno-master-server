const http = require("http"); // OBAVEZNO DODAJ OVU LINIJU
const admin = require("firebase-admin");

let serviceAccount;

// 1. Prvo gledamo da li postoji Render varijabla (za produkciju)
if (process.env.FIREBASE_CONFIG_JSON) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG_JSON);
        // Popravka za private_key format
        if (serviceAccount.private_key) {
            serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        }
        console.log("✅ Firebase učitan preko Environment Varijable.");
    } catch (err) {
        console.error("❌ Greška pri parsiranju FIREBASE_CONFIG_JSON:", err.message);
    }
} 
// 2. Ako nema varijable, tek tada pokušavamo lokalni fajl (za tvoj kompjuter)
else {
    try {
        serviceAccount = require("./serviceAccountKey.json");
        console.log("✅ Firebase učitan preko lokalnog fajla.");
    } catch (err) {
        console.log("⚠️ Nije pronađen ni fajl ni varijabla. Proveri podešavanja!");
    }
}
// Pre inicijalizacije uradi ovo:
if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://keno-demo-31bf2-default-rtdb.europe-west1.firebasedatabase.app"
});
// 3. Inicijalizacija samo ako smo našli ključ
if (serviceAccount) {
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://keno-demo-31bf2-default-rtdb.europe-west1.firebasedatabase.app"
        });
    }
} else {
    console.error("❌ Kritična greška: Firebase Admin nije mogao biti inicijalizovan!");
}
// 4. INICIJALIZACIJA FIREBASE-A
if (serviceAccount) {
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://keno-demo-31bf2-default-rtdb.europe-west1.firebasedatabase.app"
        });
    }
}

const db = admin.database();
const roundRef = db.ref("currentRound");

// 5. KONSTANTE I PAYTABLE
const KENO_PAYTABLE = {
    1: { 1: 3.4 }, 2: { 2: 12.5 }, 3: { 2: 2, 3: 40 },
    4: { 2: 1, 3: 8, 4: 180 }, 5: { 3: 3, 4: 15, 5: 450 },
    6: { 3: 2, 4: 10, 5: 45, 6: 1800 }, 7: { 4: 4, 5: 15, 6: 120, 7: 4000 },
    8: { 4: 2, 5: 10, 6: 40, 7: 400, 8: 8000 }, 9: { 5: 5, 6: 20, 7: 120, 8: 1200, 9: 20000 },
    10: { 4: 2, 5: 5, 6: 10, 7: 40, 8: 400, 9: 4000, 10: 100000 }
};

const WAIT_TIME = 90000;
const DRAW_INTERVAL = 3500;

// 6. POMOĆNE FUNKCIJE
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function serverLog(message) {
    const time = new Date().toLocaleTimeString();
    const fullMessage = `[MASTER ${time}]: ${message}`;
    console.log(fullMessage);
    try {
        await db.ref("serverLogs").set({
            message: fullMessage,
            timestamp: Date.now()
        });
    } catch (e) { }
}

// 7. LOGIKA IGRE
async function startMaster() {
    await serverLog("Sistem pokrenut i spreman.");

    while (true) {
        try {
            const snap = await roundRef.get();
            const round = snap.val();

            if (!round) {
                await createNewRound(1001);
                continue;
            }

            const sada = Date.now();

            // RESET ZAGLAVLJENOG KOLA
            const predugoTraje = round.lastBallTime && (sada - round.lastBallTime > 180000);
            if (round.status === "running" && predugoTraje) {
                await serverLog("⚠️ Detektovano zaglavljeno kolo. Resetujem...");
                await finishRound(round);
                continue;
            }

            // RECOVERY: Nastavak izvlačenja
            if (round.status === "running") {
                const izvuceno = round.drawnAnimated ? Object.values(round.drawnAnimated).length : 0;
                if (izvuceno < 20) {
                    await serverLog(`Nastavljam prekinuto kolo ${round.roundId}`);
                    await resumeDrawing(round);
                } else {
                    await finishRound(round);
                }
                continue;
            }

            // WAITING FAZA
            if (round.status === "waiting") {
                const preostalo = round.endTime - sada;
                if (preostalo < -10000) { 
                    await serverLog("🔄 Produžavam tajmer zbog prekida.");
                    await roundRef.update({ endTime: sada + 30000 });
                    continue;
                }
                if (preostalo <= 0) {
                    await startNewDrawing(round);
                }
            } 
            else if (round.status === "finished") {
                await sleep(15000);
                await createNewRound(round.roundId + 1);
            }

        } catch (error) {
            console.error("❌ Greška u glavnoj petlji:", error.message);
            await sleep(5000);
        }
        await sleep(2000);
    }
}

async function startNewDrawing(round) {
    await serverLog(`Započinjem izvlačenje za kolo ${round.roundId}`);
    const finalNumbers = await generisiOptimalneBrojeve(round.roundId);
    await roundRef.update({
        status: "running",
        drawnNumbers: finalNumbers,
        drawnAnimated: []
    });
    await resumeDrawing({ ...round, status: "running", drawnNumbers: finalNumbers, drawnAnimated: [] });
}

async function resumeDrawing(round) {
    const finalNumbers = round.drawnNumbers;
    const snap = await roundRef.child("drawnAnimated").get();
    let currentAnimated = snap.val() ? Object.values(snap.val()) : [];

    for (let i = currentAnimated.length; i < 20; i++) {
        const nextBall = finalNumbers[i];
        try {
            await roundRef.child("drawnAnimated").child(i.toString()).set(nextBall);
            await serverLog(`Loptica [${i + 1}/20]: ${nextBall}`);
            await sleep(DRAW_INTERVAL);
        } catch (e) {
            await serverLog("Greška u slanju, ponavljam...");
            i--;
            await sleep(3000);
        }
    }
    await finishRound(round);
}

async function finishRound(round) {
    await serverLog("Obračun tiketa u toku...");
    try {
        await processTickets(round.roundId, round.drawnNumbers);
        await roundRef.update({ status: "finished", lastBallTime: Date.now() });
        await db.ref(`roundsHistory/${round.roundId}`).set({
            roundId: round.roundId,
            drawnNumbers: round.drawnNumbers,
            timestamp: Date.now()
        });
        await serverLog(`✅ Kolo ${round.roundId} završeno.`);
    } catch (e) {
        console.error("Greška pri završavanju:", e.message);
    }
}

async function generisiOptimalneBrojeve(roundId) {
    try {
        const ticketsSnap = await db.ref("tickets").get();
        let activeTickets = [];
        let rundaUplata = 0;

        if (ticketsSnap.exists()) {
            ticketsSnap.forEach(child => {
                const t = child.val();
                if (Number(t.roundId) === Number(roundId) && t.status === "pending") {
                    activeTickets.push(t);
                    rundaUplata += t.amount;
                }
            });
        }

        let limitIsplate = rundaUplata * 0.70;
        let bestNumbers = [];
        let minPayout = Infinity;

        for (let i = 0; i < 100; i++) {
            let testNumbers = Array.from({ length: 80 }, (_, i) => i + 1)
                .sort(() => Math.random() - 0.5).slice(0, 20);

            let payout = 0;
            activeTickets.forEach(t => {
                const hits = t.numbers.filter(n => testNumbers.includes(n)).length;
                const mult = KENO_PAYTABLE[t.numbers.length]?.[hits] || 0;
                payout += (t.amount * mult);
            });

            if (payout <= limitIsplate) return testNumbers;
            if (payout < minPayout) { minPayout = payout; bestNumbers = testNumbers; }
        }
        return bestNumbers;
    } catch (e) {
        return Array.from({ length: 80 }, (_, i) => i + 1).sort(() => Math.random() - 0.5).slice(0, 20);
    }
}

async function processTickets(roundId, drawnNumbers) {
    const ticketsSnap = await db.ref("tickets").get();
    if (!ticketsSnap.exists()) return;
    const tickets = ticketsSnap.val();
    for (const key in tickets) {
        const t = tickets[key];
        if (Number(t.roundId) === Number(roundId) && t.status === "pending") {
            const hits = t.numbers.filter(n => drawnNumbers.includes(n)).length;
            const mult = KENO_PAYTABLE[t.numbers.length]?.[hits] || 0;
            const win = Math.floor(t.amount * mult);
            await db.ref(`tickets/${key}`).update({
                hits, winAmount: win, status: win > 0 ? "win" : "lose"
            });
            if (win > 0) {
                const userRef = db.ref(`users/${t.userId}/balance`);
                const uSnap = await userRef.get();
                await userRef.set((uSnap.val() || 0) + win);
            }
        }
    }
}

async function createNewRound(id) {
    await roundRef.set({
        roundId: id,
        status: "waiting",
        endTime: Date.now() + WAIT_TIME,
        drawnNumbers: [],
        drawnAnimated: []
    });
}

// 8. POKRETANJE I KEEP-ALIVE SERVER
const server = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Keno Master is running...');
});

server.listen(port, () => {
    console.log(`Keep-alive server running on port ${port}`);
});

// Glavni start
startMaster().catch(err => console.error("Kritična greška:", err));