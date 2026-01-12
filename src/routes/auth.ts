import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/prisma.js';

export async function authRoutes(fastify: FastifyInstance) {
    /**
     * GET /auth/me
     * Get current user info from DB (synced from Firebase)
     */
    fastify.get('/auth/me', {
        preHandler: (fastify as any).verifyAuth, // Use our custom middleware
        schema: {
            response: {
                200: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                        email: { type: 'string' },
                        avatarUrl: { type: 'string' }
                    }
                },
                '4xx': {
                    type: 'object',
                    properties: {
                        error: { type: 'string' }
                    }
                }
            }
        }
    }, async (request: any, reply) => {
        const userId = request.user.uid;

        const user = await prisma.user.findUnique({
            where: { id: userId }
        });

        if (!user) {
            return reply.code(404).send({ error: 'User not found in database (Sync failed)' });
        }

        return user;
    });
}
