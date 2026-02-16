const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = 3000;

/************************************************
 * IN-MEMORY DATABASE (kasnije možemo SQLite)
 ************************************************/

let users = {};
let currentRound = {
  id: uuidv4(),
  status: "open",
  drawn: []
};

let tickets = {}; // roundId -> [tickets]

/************************************************
 * HELPER FUNCTIONS
 ************************************************/

function generateDraw() {
  const numbers = [];
  while (numbers.length < 20) {
    const n = Math.floor(Math.random() * 80) + 1;
    if (!numbers.includes(n)) numbers.push(n);
  }
  return numbers;
}

function calculateMultiplier(selected, hits) {
  const table = {
    1: [0, 2],
    2: [0, 1, 5],
    3: [0, 0, 2, 10],
    4: [0, 0, 1, 5, 20],
    5: [0, 0, 0, 3, 15, 50],
    6: [0, 0, 0, 2, 10, 30, 100],
    7: [0, 0, 0, 1, 5, 20, 50, 200],
    8: [0, 0, 0, 0, 5, 15, 40, 100, 500],
    9: [0, 0, 0, 0, 2, 10, 30, 80, 200, 1000],
    10: [0, 0, 0, 0, 1, 5, 20, 50, 150, 500, 2000]
  };
  if (!table[selected]) return 0;
  return table[selected][hits] || 0;
}

/************************************************
 * ROUND ENGINE
 ************************************************/

function startNewRound() {
  currentRound = {
    id: uuidv4(),
    status: "open",
    drawn: []
  };

  tickets[currentRound.id] = [];

  io.emit("roundStarted", currentRound);
}

function closeRound() {
  currentRound.status = "drawing";
  io.emit("roundClosed");

  currentRound.drawn = generateDraw();

  setTimeout(() => {
    resolveTickets();
  }, 3000);
}

function resolveTickets() {
  const roundTickets = tickets[currentRound.id];

  roundTickets.forEach(ticket => {
    const hits = ticket.numbers.filter(n =>
      currentRound.drawn.includes(n)
    ).length;

    const multiplier = calculateMultiplier(ticket.numbers.length, hits);
    const win = ticket.stake * multiplier;

    if (win > 0) {
      users[ticket.userId].balance += win;
    }

    ticket.status = "finished";
    ticket.hits = hits;
    ticket.win = win;

    io.to(ticket.socketId).emit("ticketResult", ticket);
  });

  io.emit("drawResult", currentRound.drawn);

  setTimeout(startNewRound, 8000);
}

/************************************************
 * SOCKET.IO
 ************************************************/

io.on("connection", socket => {

  console.log("User connected:", socket.id);

  socket.on("register", () => {
    const userId = uuidv4();

    users[userId] = {
      balance: 100
    };

    socket.emit("registered", {
      userId,
      balance: 100
    });
  });

  socket.on("getRound", () => {
    socket.emit("roundData", currentRound);
  });

  socket.on("playTicket", data => {

    const { userId, numbers, stake } = data;

    if (!users[userId]) return;
    if (currentRound.status !== "open") return;
    if (stake > users[userId].balance) return;

    users[userId].balance -= stake;

    const ticket = {
      id: uuidv4(),
      userId,
      socketId: socket.id,
      numbers,
      stake,
      status: "pending"
    };

    tickets[currentRound.id].push(ticket);

    socket.emit("ticketAccepted", {
      balance: users[userId].balance
    });
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
  });
});

/************************************************
 * AUTO ROUND TIMER
 ************************************************/

setInterval(() => {
  if (currentRound.status === "open") {
    closeRound();
  }
}, 30000);

startNewRound();

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});