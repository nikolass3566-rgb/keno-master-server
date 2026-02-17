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
  1:  {0:0, 1:2},
  2:  {0:0, 1:1, 2:5},
  3:  {0:0, 1:0, 2:2, 3:10},
  4:  {0:0, 1:0, 2:1, 3:5, 4:15},
  5:  {0:0, 1:0, 2:0, 3:2, 4:10, 5:50},
  6:  {0:0, 1:0, 2:0, 3:1, 4:6, 5:25, 6:120},
  7:  {0:0, 1:0, 2:0, 3:1, 4:5, 5:25, 6:100, 7:400},
  8:  {0:0, 1:0, 2:0, 3:1, 4:0, 5:2, 6:75, 7:250, 8:800},
  9:  {0:0, 1:0, 2:0, 3:0, 4:2, 5:4, 6:80, 7:300, 8:1200, 9:4000},
  10: {0:0, 1:0, 2:0, 3:0, 4:4, 5:8, 6:100, 7:400, 8:2000, 9:5000, 10:10000}
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
    // 1. Inicijalizacija - Uzmi poslednji ID iz baze samo JEDNOM pri startu servera
    const snap = await db.ref("lastRoundId").get();
    currentRoundId = snap.val() || 1000;

    console.log(`[START] Igra pokrenuta od kola: ${currentRoundId}`);

    while (true) {
        // --- FAZA ČEKANJA (WAITING) ---
        // Na početku petlje, currentRoundId je onaj koji je upravo postavljen
        drawnNumbers = [];
        currentRoundStatus = "waiting";

        for (let s = 90; s >= 0; s--) {
            countdown = s;
            // Šaljemo SVIMA informaciju o tekućem kolu za koje mogu da uplaćuju
            io.emit("roundUpdate", { 
                roundId: currentRoundId, 
                status: "waiting", 
                timeLeft: s 
            });
            await sleep(1000);
        }

        // --- FAZA IZVLAČENJA (RUNNING) ---
        currentRoundStatus = "running";
        io.emit("roundUpdate", { status: "running", roundId: currentRoundId });

        for (let i = 0; i < 20; i++) {
            let n;
            do { n = Math.floor(Math.random() * 80) + 1; } while (drawnNumbers.includes(n));
            drawnNumbers.push(n);
            io.emit("ballDrawn", { number: n, allDrawn: drawnNumbers });
            await sleep(3000);
        }
            // 1. SAČUVAJ BROJEVE U ISTORIJU PRE NEGO ŠTO POVEĆAŠ ID
roundHistory[currentRoundId] = [...drawnNumbers]; 

// 2. Opciono: Čuvaj samo zadnjih 20 kola da ne preopteretiš memoriju
let keys = Object.keys(roundHistory);
if (keys.length > 20) {
    delete roundHistory[keys[0]];
}


       // ... (kraj izvlačenja)
        currentRoundStatus = "calculating";
        lastRoundNumbers = [...drawnNumbers]; 
        await processTickets(currentRoundId, drawnNumbers);
        
        // Šaljemo finalne brojeve i obaveštenje da je KRAJ
        io.emit("roundFinished", { 
            roundId: currentRoundId, 
            allNumbers: drawnNumbers 
        });

        await sleep(10000); // 10 sekundi pauze da ljudi vide rezultate

        // KLJUČNA IZMENA: Povećavamo ID i ODMAH javljamo klijentima novo stanje
        currentRoundId++;
        await db.ref("lastRoundId").set(currentRoundId);
        
        // Resetujemo parametre za novo kolo
        drawnNumbers = [];
        currentRoundStatus = "waiting";
        
        // Obaveštavamo klijente da je počelo novo čekanje sa NOVIM ID-om
        io.emit("roundUpdate", { 
            roundId: currentRoundId, 
            status: "waiting", 
            timeLeft: 90 
        });
    }
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
// master.js
db.ref("tickets").on("child_added", async (snapshot) => {
    const ticket = snapshot.val();
    if (!ticket.roundId) {
        // Server mu dodeljuje ID kola koje je TRENUTNO aktivno na serveru
        await snapshot.ref.update({ roundId: currentRoundId });
    }
});