# gpzone

React/Vite frontend with a Socket.IO realtime server for multiplayer.

## Local Run

Prerequisites:
- Node.js 20+

Install:

```bash
npm install
```

Run the production-style app on one port:

```bash
npm run build
npm run start
```

Open:

```text
http://127.0.0.1:3000
```

Split frontend/server during development:

```bash
npm run dev:server
npm run dev:client
```

In local development, the frontend auto-connects to `http://127.0.0.1:3000` for realtime features.

## Deployment Model

This project cannot run multiplayer from a static frontend alone.

- Vercel hosts the frontend
- Render hosts the Socket.IO server
- Vercel connects to Render through `VITE_SOCKET_URL`

## Render Deployment

This repo includes [`render.yaml`](/Users/gp/gpzone/render.yaml) for a basic Render web service.

Render settings:

- Runtime: `Node`
- Build Command: `npm install`
- Start Command: `npm run start`
- Health Check Path: `/health`

After deploy, Render will give you a URL like:

```text
https://gpzone-server.onrender.com
```

## Vercel Deployment

Set this environment variable in Vercel:

```text
VITE_SOCKET_URL=https://gpzone-server.onrender.com
```

Then redeploy Vercel.

Without `VITE_SOCKET_URL`, the deployed site will show a realtime connection error and multiplayer will not work.

## Notes

- Render free instances can sleep when idle, so the first multiplayer connection may be slow.
- Single-player works on the frontend without the realtime server.
