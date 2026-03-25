import express from 'express';
import { createServer as createViteServer } from 'vite';
import { Server } from 'socket.io';
import http from 'http';
import path from 'path';
import { GameEngine } from './src/server/GameEngine';

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: '*' }
  });
  const PORT = 3000;

  const game = new GameEngine(io);

  io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    game.addPlayer(socket.id);

    socket.on('input', (input) => {
      game.handleInput(socket.id, input);
    });

    socket.on('disconnect', () => {
      console.log('Player disconnected:', socket.id);
      game.removePlayer(socket.id);
    });
  });

  // Game loop
  setInterval(() => {
    game.update();
  }, 1000 / 30); // 30 FPS

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
