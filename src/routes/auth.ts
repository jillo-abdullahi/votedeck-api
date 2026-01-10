import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { generateAccessToken, getCookieOptions } from '../utils/auth.js';
import { prisma } from '../db/prisma.js';

export async function authRoutes(fastify: FastifyInstance) {
    /**
     * POST /auth/anonymous
     * Create an anonymous user and return tokens
     */
    fastify.post('/auth/anonymous', {
        schema: {
            tags: ['Auth'],
            summary: 'Create anonymous session',
            description: 'Creates a new anonymous user and sets the access token cookie.',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        userId: { type: 'string' },
                        recoveryCode: { type: 'string' }
                    }
                },
                '4xx': {
                    type: 'object',
                    properties: {
                        error: { type: 'string' },
                        message: { type: 'string' }
                    }
                }
            }
        }
    }, async (request, reply) => {
        const userId = nanoid();
        const recoveryCode = nanoid(12);

        // Persist user with recovery code
        await prisma.user.create({
            data: {
                id: userId,
                name: "Anonymous User",
                recoveryCode
            }
        });

        // Generate tokens
        const accessToken = generateAccessToken({
            sub: userId,
            role: 'participant'
        });
        // Set access token in cookie
        reply.setCookie('accessToken', accessToken, getCookieOptions());

        return {
            userId,
            recoveryCode
        };
    });

    /**
     * POST /auth/restore
     * Restore session via recovery code
     */
    fastify.post('/auth/restore', {
        schema: {
            tags: ['Auth'],
            summary: 'Restore session',
            description: 'Restores a user session using a recovery code.',
            body: {
                type: 'object',
                required: ['recoveryCode'],
                properties: {
                    recoveryCode: { type: 'string' }
                }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        userId: { type: 'string' },
                        name: { type: 'string' },
                        recoveryCode: { type: 'string' }
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
    }, async (request, reply) => {
        const { recoveryCode } = request.body as { recoveryCode: string };

        if (!recoveryCode) {
            return reply.code(400).send({ error: 'Recovery code required' });
        }

        // Check for new format: [id].[secret]
        const parts = recoveryCode.split('.');
        let user;

        if (parts.length === 2) {
            const [recoveryId, recoverySecret] = parts;
            const bcrypt = await import('bcryptjs');

            user = await prisma.user.findUnique({
                where: { recoveryCode: recoveryId }
            });

            if (user && user.recoveryHash) {
                const isValid = await bcrypt.compare(recoverySecret, user.recoveryHash);
                if (!isValid) user = null;
            } else {
                // Not found or no hash (legacy shouldn't have dot, but just in case)
                user = null;
            }
        } else {
            // Legacy fallback (plain text)
            // Only allow if user does NOT have a hash (so they can't bypass hash with old code)
            user = await prisma.user.findUnique({
                where: { recoveryCode }
            });

            if (user && user.recoveryHash) {
                // If user has a hash, they MUST use the new format.
                user = null;
            }
        }

        if (!user) {
            return reply.code(404).send({ error: 'Invalid recovery code' });
        }

        // Generate new tokens
        const accessToken = generateAccessToken({
            sub: user.id,
            role: 'participant'
        });
        reply.setCookie('accessToken', accessToken, getCookieOptions());

        return {
            userId: user.id,
            name: user.name,
            recoveryCode
        };
    });



    /**
     * POST /auth/logout
     * Clear tokens
     */
    fastify.post('/auth/logout', {
        schema: {
            tags: ['Auth'],
            summary: 'Logout',
            description: 'Clears the access token cookie.',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' }
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
    }, async (request, reply) => {
        reply.clearCookie('accessToken', getCookieOptions(0));
        return { success: true };
    });



    /**
     * GET /auth/me
     * Get current user info
     */
    fastify.get('/auth/me', {
        schema: {
            tags: ['Auth'],
            summary: 'Get current user',
            description: 'Returns the currently authenticated user based on the access token cookie.',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        name: { type: 'string' }
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
    }, async (request, reply) => {
        try {
            const decoded = await request.jwtVerify() as { sub: string };
            const userId = decoded.sub;

            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: { id: true, name: true }
            });

            if (!user) {
                return reply.code(404).send({ error: 'User not found' });
            }

            return user;
        } catch (err) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }
    });
}
