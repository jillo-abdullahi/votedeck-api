# VoteDeck Server

Real-time planning poker backend built with Fastify and Socket.IO.

## Setup

```bash
npm install
```

## Development

```bash
npm run dev
```

Server runs on `http://localhost:3001`

## Environment Variables

Create a `.env` file (optional):

```
PORT=3001
HOST=0.0.0.0
FRONTEND_URL=http://localhost:5173
```

## API Endpoints

### HTTP

- `POST /rooms` - Create a new room
- `GET /rooms/:id` - Get room metadata

### WebSocket Events

**Client → Server:**
- `JOIN_ROOM` - Join a room
- `CAST_VOTE` - Cast a vote
- `REVEAL` - Reveal all votes
- `RESET` - Reset votes
- `LEAVE_ROOM` - Leave room

**Server → Client:**
- `ROOM_STATE` - Room state updates
- `ERROR` - Error messages
