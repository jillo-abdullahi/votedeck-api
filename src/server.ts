import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
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

    // Register JWT
    await fastify.register(fastifyJwt, {
        secret: process.env.JWT_SECRET || 'super-secret-key',
        cookie: {
            cookieName: 'accessToken',
            signed: false,
        },
    });

    // Register Cookie
    await fastify.register(cookie);

    // Register Swagger (OpenAPI)
    await fastify.register(fastifySwagger, {
        openapi: {
            info: {
                title: 'VoteDeck API',
                description: 'Real-time Planning Poker API',
                version: '1.0.0',
            },
            components: {
                securitySchemes: {
                    cookieAuth: {
                        type: 'apiKey',
                        in: 'cookie',
                        name: 'accessToken',
                    },
                },
            },
            security: [{ cookieAuth: [] }],
        },
    });

    await fastify.register(fastifySwaggerUi, {
        routePrefix: '/documentation',
        uiConfig: {
            docExpansion: 'list',
            deepLinking: false,
        },
        staticCSP: true,
    });

    // Register HTTP routes
    await fastify.register(authRoutes);
    await fastify.register(roomRoutes);

    // Create Socket.IO server
    const io = new SocketIOServer(fastify.server, {
        cors: {
            origin: (origin, callback) => {
                // Socket.IO CORS callback signature matches (err, success)
                // but types might effectively match checkOrigin structure
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
    io.use((socket, next) => {
        const origin = socket.handshake.headers.origin;
        console.log(`[Socket] Handshake from origin: ${origin}`);

        let token: string | undefined;

        if (socket.handshake.headers.cookie) {
            console.log(`[Socket] Cookies present`);
            const cookies = socket.handshake.headers.cookie.split(';');
            const accessTokenCookie = cookies.find(c => c.trim().startsWith('accessToken='));
            if (accessTokenCookie) {
                token = accessTokenCookie.split('=')[1];
            }
        } else {
            console.log(`[Socket] No cookies in handshake headers`);
        }

        if (!token) {
            console.error(`[Socket] Auth failed: Token missing`);
            return next(new Error('Authentication error: Token missing'));
        }

        try {
            // We use fastify.jwt for verification
            const decoded = fastify.jwt.verify(token) as { sub: string };
            (socket as any).userId = decoded.sub;
            console.log(`[Socket] Auth success for user: ${decoded.sub}`);
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
