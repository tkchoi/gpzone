import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

const PORT = 3000;

// Serve static files in production
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "dist")));
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "dist", "index.html"));
  });
}

const rooms: { [code: string]: { players: string[]; status: string } } = {};

io.on("connection", (socket) => {
  socket.on("create-room", () => {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    rooms[code] = { players: [socket.id], status: "lobby" };
    socket.join(code);
    socket.emit("room-created", code);
    io.to(code).emit("room-update", { players: rooms[code].players });
  });

  socket.on("join-room", (code) => {
    const upperCode = code.toUpperCase();
    if (rooms[upperCode]) {
      if (rooms[upperCode].status !== "lobby") {
        socket.emit("error-message", "Game already in progress");
        return;
      }
      rooms[upperCode].players.push(socket.id);
      socket.join(upperCode);
      socket.emit("room-joined", upperCode);
      io.to(upperCode).emit("room-update", { players: rooms[upperCode].players });
    } else {
      socket.emit("error-message", "Room not found");
    }
  });

  socket.on("start-game", (code) => {
    if (rooms[code] && rooms[code].players[0] === socket.id) {
      rooms[code].status = "playing";
      io.to(code).emit("game-started");
    }
  });

  socket.on("sync-state", (data) => {
    const { roomCode, state } = data;
    socket.to(roomCode).emit("remote-sync", { id: socket.id, state });
  });

  socket.on("leave-room", () => {
    for (const room of socket.rooms) {
      if (rooms[room]) {
        rooms[room].players = rooms[room].players.filter(id => id !== socket.id);
        socket.leave(room);
        if (rooms[room].players.length === 0) {
          delete rooms[room];
        } else {
          io.to(room).emit("room-update", { players: rooms[room].players });
        }
      }
    }
  });

  socket.on("disconnecting", () => {
    for (const room of socket.rooms) {
      if (rooms[room]) {
        rooms[room].players = rooms[room].players.filter(id => id !== socket.id);
        if (rooms[room].players.length === 0) {
          delete rooms[room];
        } else {
          io.to(room).emit("room-update", { players: rooms[room].players });
        }
      }
    }
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
