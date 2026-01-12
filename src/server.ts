import Fastify from 'fastify';
import cors from '@fastify/cors';
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

    // Unified CORS origins
    const allowedOrigins = [
        process.env.FRONTEND_URL,
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        `http://${HOST}:${PORT}`, // Allow self (Swagger UI)
        `http://localhost:${PORT}`
    ].filter(Boolean) as string[];

    console.log('Allowed Origins:', allowedOrigins);

    // Shared CORS validator
    const checkOrigin = (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => {
        // Allow requests with no origin (like mobile apps or curl requests)
        // Note: Socket.IO requests usually have origin.
        if (!origin) {
            return cb(null, true);
        }

        if (allowedOrigins.includes(origin)) {
            return cb(null, true);
        }

        console.log(`[CORS] Blocked request from origin: ${origin}`);
        return cb(new Error("Not allowed by CORS"), false);
    };

    // Register CORS
    await fastify.register(cors, {
        origin: checkOrigin,
        credentials: true,
    });

    // Verify Auth Middleware (Custom)
    fastify.decorate('verifyAuth', async (request: any, reply: any) => {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return reply.code(401).send({ error: 'Unauthorized: Missing token' });
        }

        const token = authHeader.split(' ')[1];
        try {
            const { verifyAuthToken, syncUser } = await import('./utils/auth.js');
            const decoded = await verifyAuthToken(token);
            // Lazy sync: Ensure user exists in DB
            await syncUser(decoded);
            request.user = decoded;
        } catch (err) {
            return reply.code(401).send({ error: 'Unauthorized: Invalid token' });
        }
    });

    // Register HTTP routes
    await fastify.register(authRoutes);
    await fastify.register(roomRoutes);

    // Create Socket.IO server
    const io = new SocketIOServer(fastify.server, {
        cors: {
            origin: (origin, callback) => {
                checkOrigin(origin, (err, allow) => {
                    if (err) return callback(err, false);
                    return callback(null, allow);
                });
            },
            credentials: true,
        },
    });

    // Make io accessible in routes
    fastify.decorate('io', io);

    // WebSocket Handshake Authentication
    io.use(async (socket, next) => {
        const origin = socket.handshake.headers.origin;
        console.log(`[Socket] Handshake from origin: ${origin}`);

        // 1. Try "auth" object (client: socket = io({ auth: { token: '...' } }))
        let token = socket.handshake.auth?.token;

        // 2. Fallback to Authorization header
        if (!token && socket.handshake.headers.authorization) {
            const parts = socket.handshake.headers.authorization.split(' ');
            if (parts.length === 2) token = parts[1];
        }

        if (!token) {
            console.error(`[Socket] Auth failed: Token missing`);
            return next(new Error('Authentication error: Token missing'));
        }

        try {
            const { verifyAuthToken, syncUser } = await import('./utils/auth.js');
            const decoded = await verifyAuthToken(token);

            // Sync user to DB on connection
            await syncUser(decoded);

            (socket as any).userId = decoded.uid;
            console.log(`[Socket] Auth success for user: ${decoded.uid}`);
            next();
        } catch (err) {
            console.error(`[Socket] Auth failed: Invalid token`, err);
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
