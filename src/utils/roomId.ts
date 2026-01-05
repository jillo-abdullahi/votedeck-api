import { customAlphabet } from 'nanoid';

// Generate short, URL-friendly room IDs (e.g., "3Q18NP")
const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 6);

export function generateRoomId(): string {
    return nanoid();
}
