const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://keno-demo-31bf2-default-rtdb.europe-west1.firebasedatabase.app"
});

const db = admin.database();
const roundRef = db.ref("currentRound");

const KENO_PAYTABLE = {
    1: { 1: 3.4 }, 2: { 2: 12.5 }, 3: { 2: 2, 3: 40 },
    4: { 2: 1, 3: 8, 4: 180 }, 5: { 3: 3, 4: 15, 5: 450 },
    6: { 3: 2, 4: 10, 5: 45, 6: 1800 }, 7: { 4: 4, 5: 15, 6: 120, 7: 4000 },
    8: { 4: 2, 5: 10, 6: 40, 7: 400, 8: 8000 }, 9: { 5: 5, 6: 20, 7: 120, 8: 1200, 9: 20000 },
    10: { 4: 2, 5: 5, 6: 10, 7: 40, 8: 400, 9: 4000, 10: 100000 }
};

const WAIT_TIME = 90000;
const DRAW_INTERVAL = 3500;

async function startMaster() {
    console.log("🚀 MASTER AKTIVAN I PROVERAVA STANJE...");

    while (true) {
        try {
            const snap = await roundRef.get();
            const round = snap.val();

            if (!round) {
                await createNewRound(1001);
                continue;
            }

            // --- RECOVERY LOGIKA: Ako je status RUNNING, a nismo završili ---
            if (round.status === "running") {
                const izvucenoDoSada = round.drawnAnimated ? round.drawnAnimated.length : 0;
                if (izvucenoDoSada < 20) {
                    console.log(`⚠️ Detektovan prekid! Nastavljam kolo ${round.roundId} od ${izvucenoDoSada + 1}. loptice.`);
                    await resumeDrawing(round);
                    continue;
                } else {
                    // Ako su sve loptice tu ali status nije promenjen u finished
                    await finishRound(round);
                    continue;
                }
            }

            // --- STANDARDNA LOGIKA ---
            if (round.status === "waiting") {
                const preostalo = round.endTime - Date.now();
                if (preostalo <= 0) {
                    await startNewDrawing(round);
                }
            } else if (round.status === "finished") {
                await sleep(15000);
                await createNewRound(round.roundId + 1);
            }

        } catch (error) {
            console.error("❌ Greška u konekciji (Internet?):", error.message);
            console.log("Pokušavam ponovo za 5 sekundi...");
            await sleep(5000); // Čekaj internet
        }
        await sleep(1000);
    }
}

// Funkcija za novo izvlačenje (ispravljena da prvo zapiše SVE brojeve)
async function startNewDrawing(round) {
    console.log(`\n🎰 NOVO IZVLAČENJE: Kolo ${round.roundId}`);
    const finalNumbers = await generisiOptimalneBrojeve(round.roundId);
    
    // Odmah zapiši svih 20 brojeva u 'drawnNumbers' ali 'drawnAnimated' ostavi prazno
    await roundRef.update({
        status: "running",
        drawnNumbers: finalNumbers,
        drawnAnimated: []
    });

    await resumeDrawing({ ...round, status: "running", drawnNumbers: finalNumbers, drawnAnimated: [] });
}

// Funkcija koja NASTAVLJA tamo gde je stalo
async function resumeDrawing(round) {
    const finalNumbers = round.drawnNumbers;
    let drawnAnimated = round.drawnAnimated || [];

    for (let i = drawnAnimated.length; i < 20; i++) {
        const nextBall = finalNumbers[i];
        drawnAnimated.push(nextBall);
        
        try {
            await roundRef.update({ drawnAnimated: drawnAnimated });
            console.log(`Loptica [${i + 1}/20]: ${nextBall}`);
            await sleep(DRAW_INTERVAL);
        } catch (e) {
            console.error("Greška pri slanju loptice, pokušavam ponovo...");
            i--; // Ponovi istu lopticu ako internet pukne
            await sleep(2000);
        }
    }

    await finishRound(round);
}

async function finishRound(round) {
    console.log("Obračun tiketa...");
    try {
        await processTickets(round.roundId, round.drawnNumbers);
        await roundRef.update({ status: "finished", lastBallTime: Date.now() });
        
        // Arhiviranje
        await db.ref(`roundsHistory/${round.roundId}`).set({
            roundId: round.roundId,
            drawnNumbers: round.drawnNumbers,
            timestamp: Date.now()
        });
        console.log(`✅ Kolo ${round.roundId} USPJEŠNO ZAVRŠENO.`);
    } catch (e) {
        console.error("Greška pri završavanju kola:", e.message);
    }
}

// --- LOGIKA ZA PROFIT (Ostaje ista ali ubačen Try/Catch) ---
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

        // Ciljamo isplatu od maksimalno 70% uplate (30% profit)
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
        // Ako baza pukne, vrati bar neke nasumične brojeve da se igra ne blokira
        return Array.from({ length: 80 }, (_, i) => i + 1).sort(() => Math.random() - 0.5).slice(0, 20);
    }
}

// --- LOGIKA ZA ISPLATU ---
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

startMaster();
const http = require('http');
const port = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Keno Master is running...');
});

server.listen(port, () => {
  console.log(`Keep-alive server running on port ${port}`);
});