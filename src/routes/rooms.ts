import type { CreateRoomRequest, CreateRoomResponse } from '../types/index.js';
import { roomStore } from '../store/roomStore.js';
import { prisma } from '../db/prisma.js';
import type { FastifyInstance } from 'fastify';

export async function roomRoutes(fastify: FastifyInstance) {
    /**
     * POST /rooms
     * Create a new room
     * Requires Auth (Anonymous or Google) to identify the creator
     */
    fastify.post<{ Body: CreateRoomRequest; Reply: CreateRoomResponse }>(
        '/rooms',
        {
            preHandler: (fastify as any).verifyAuth,
            schema: {
                body: {
                    type: 'object',
                    required: ['name', 'votingSystem'],
                    properties: {
                        name: { type: 'string' },
                        votingSystem: {
                            type: 'string',
                            enum: ['fibonacci', 'modified_fibonacci', 'tshirts', 'powers_2'],
                        },
                        adminName: { type: 'string' },
                    },
                },
                response: {
                    201: {
                        type: 'object',
                        properties: {
                            roomId: { type: 'string' },
                            joinUrl: { type: 'string' }
                        }
                    },
                    '4xx': {
                        type: 'object',
                        properties: {
                            error: { type: 'string' }
                        }
                    }
                }
            },
        },
        async (request: any, reply) => {
            const { name, votingSystem, adminName } = request.body;
            const userId = request.user.uid; // From auth middleware

            // Update user name if provided and not set
            if (adminName) {
                await prisma.user.update({
                    where: { id: userId },
                    data: { name: adminName }
                });
            }

            // Check game limit (max 10)
            const existingRooms = await prisma.room.count({
                where: { adminId: userId }
            });

            if (existingRooms >= 10) {
                return reply.code(403).send({
                    error: 'You have reached the limit of 10 active games. Please delete some games to create a new one.'
                });
            }

            const room = await roomStore.createRoom(name, votingSystem, userId);

            // Add user to room state explicitly
            await roomStore.addUser(room.id, {
                id: userId,
                name: adminName || request.user.name || 'Host',
                socketId: '', // Will be updated on connect
            });

            const joinUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/room/${room.id}`;

            return reply.code(201).send({
                roomId: room.id,
                joinUrl
            });
        }
    );

    /**
     * GET /rooms/my
     * Get rooms for the authenticated user
     */
    fastify.get<{ Querystring: { limit?: number; offset?: number } }>(
        '/rooms/my',
        {
            preHandler: (fastify as any).verifyAuth,
            schema: {
                querystring: {
                    type: 'object',
                    properties: {
                        limit: { type: 'integer', default: 20 },
                        offset: { type: 'integer', default: 0 }
                    }
                },
                response: {
                    200: {
                        type: 'object',
                        properties: {
                            rooms: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        id: { type: 'string' },
                                        name: { type: 'string' },
                                        createdAt: { type: 'string' },
                                        adminId: { type: 'string' },
                                        activeUsers: { type: 'integer' }
                                    }
                                }
                            },
                            total: { type: 'integer' }
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
        },
        async (request: any, reply) => {
            const userId = request.user.uid;
            const { limit = 20, offset = 0 } = request.query;

            const result = await roomStore.getUserRooms(userId, limit, offset);

            return reply.send(result);
        }
    );

    /**
     * GET /rooms/:id
     * Get room metadata
     */
    fastify.get<{ Params: { id: string } }>(
        '/rooms/:id',
        {
            schema: {
                params: {
                    type: 'object',
                    required: ['id'],
                    properties: {
                        id: { type: 'string' }
                    }
                },
                response: {
                    200: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            name: { type: 'string' },
                            votingSystem: { type: 'string' },
                            createdAt: { type: 'string' }
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
        },
        async (request, reply) => {
            const { id } = request.params;

            const room = await roomStore.getRoom(id);

            if (!room) {
                return reply.code(404).send({
                    error: 'Room not found',
                });
            }

            return reply.send({
                id: room.id,
                name: room.name,
                votingSystem: room.votingSystem,
                createdAt: room.createdAt,
            });
        }
    );

    /**
     * DELETE /rooms/:id
     * Delete a room
     */
    fastify.delete<{ Params: { id: string } }>(
        '/rooms/:id',
        {
            preHandler: (fastify as any).verifyAuth,
            schema: {
                params: {
                    type: 'object',
                    required: ['id'],
                    properties: {
                        id: { type: 'string' }
                    }
                },
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
                    },
                    '5xx': {
                        type: 'object',
                        properties: {
                            error: { type: 'string' }
                        }
                    }
                }
            }
        },
        async (request: any, reply) => {
            try {
                const { id } = request.params;
                const userId = request.user.uid;

                const room = await roomStore.getRoom(id);

                if (!room) {
                    return reply.code(404).send({ error: 'Room not found' });
                }

                if (room.adminId !== userId) {
                    return reply.code(403).send({ error: 'Only the host can delete this room' });
                }

                // Broadcast room closed event
                const io = (fastify as any).io;
                if (io) {
                    io.to(id).emit('ROOM_CLOSED');
                    // Force disconnect all clients in this room
                    io.in(id).disconnectSockets(true);
                }

                await roomStore.deleteRoom(id);

                return reply.send({ success: true });
            } catch (err) {
                console.error('Delete room error:', err);
                return reply.code(500).send({ error: 'Failed to delete room' });
            }
        }
    );
}
