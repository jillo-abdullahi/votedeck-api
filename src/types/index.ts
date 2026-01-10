// Domain types for VoteDeck backend

export type VotingSystemId = 'fibonacci' | 'modified_fibonacci' | 'tshirts' | 'powers_2';
export type RevealPolicy = 'admin' | 'everyone';

export interface User {
    id: string;
    name: string;
    socketId: string;
}

export interface Room {
    id: string;
    name: string;
    adminId: string;
    votingSystem: VotingSystemId;
    revealPolicy: RevealPolicy;
    users: Map<string, User>;
    voteMap: Map<string, string | null>; // Client-side vote map (optional) or we can infer from votes
    votes: Map<string, string | null>;
    revealed: boolean;
    enableCountdown: boolean;
    createdAt: Date;
}

export interface RoomState {
    id: string;
    name: string;
    adminId: string;
    votingSystem: VotingSystemId;
    revealPolicy: RevealPolicy;
    users: Array<{
        id: string;
        name: string;
        hasVoted: boolean;
    }>;
    votes: Record<string, string | null>;
    revealed: boolean;
    enableCountdown: boolean;
}

// Socket.IO event payloads
export interface JoinRoomPayload {
    roomId: string;
    userId: string;
    name: string;
}

export interface CastVotePayload {
    value: string;
}

export interface UpdateNamePayload {
    name: string;
}

export interface UpdateSettingsPayload {
    name?: string;
    votingSystem?: VotingSystemId;
    revealPolicy?: RevealPolicy;
    enableCountdown?: boolean;
}

export interface CreateRoomRequest {
    name: string;
    votingSystem: VotingSystemId;
    adminId?: string;
    adminName?: string;
}

export interface CreateRoomResponse {
    roomId: string;
    joinUrl: string;
    accessToken?: string;
    userId: string;
    recoveryCode?: string;
}
