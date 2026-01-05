import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import dotenv from 'dotenv';
import { Server as SocketIOServer } from 'socket.io';
import { roomRoutes } from './routes/rooms.js';
import { authRoutes } from './routes/auth.js';
import { setupSocketHandlers } from './socket/handlers.js';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function start() {
    // Create Fastify instance
    const fastify = Fastify({
        logger: true,
    });

    // Register CORS
    await fastify.register(cors, {
        origin: (origin, cb) => {
            const allowedOrigins = [
                process.env.FRONTEND_URL,
                'http://localhost:5173',
                'http://127.0.0.1:5173'
            ].filter(Boolean);

            // Allow requests with no origin (like mobile apps or curl requests)
            if (!origin) return cb(null, true);

            if (allowedOrigins.includes(origin)) {
                return cb(null, true);
            }

            // For now, in this hybrid dev/prod mode, let's log the failure to help debugging
            console.log(`Blocked by CORS: ${origin}`);
            return cb(new Error("Not allowed"), false);
        },
        credentials: true,
    });

    // Register JWT
    await fastify.register(fastifyJwt, {
        secret: process.env.JWT_SECRET || 'super-secret-key',
        cookie: {
            cookieName: 'refreshToken',
            signed: false,
        },
    });

    // Register Cookie
    await fastify.register(cookie);

    // Register HTTP routes
    await fastify.register(authRoutes);
    await fastify.register(roomRoutes);

    // Create Socket.IO server
    const io = new SocketIOServer(fastify.server, {
        cors: {
            origin: process.env.FRONTEND_URL || 'http://localhost:5173',
            credentials: true,
        },
    });

    // Make io accessible in routes
    fastify.decorate('io', io);

    // WebSocket Handshake Authentication
    io.use((socket, next) => {
        // In Socket.IO and React, we often send token in auth object
        const token = socket.handshake.auth.token || socket.handshake.headers['authorization']?.split(' ')[1];

        if (!token) {
            return next(new Error('Authentication error: Token missing'));
        }

        try {
            // We use fastify.jwt for verification
            const decoded = fastify.jwt.verify(token) as { sub: string; role: string };
            (socket as any).userId = decoded.sub;
            (socket as any).role = decoded.role;
            next();
        } catch (err) {
            next(new Error('Authentication error: Invalid token'));
        }
    });

    // Setup Socket.IO handlers
    setupSocketHandlers(io);

    // Start Fastify server
    await fastify.listen({ port: PORT, host: HOST });

    console.log(`🚀 Server running at http://${HOST}:${PORT}`);
    console.log(`🔌 Socket.IO ready for connections`);
}

start().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
