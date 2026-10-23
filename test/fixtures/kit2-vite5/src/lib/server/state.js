import { randomUUID } from 'node:crypto';
// The instance id tells the runner whether HTTP and WebSocket share this module.
export const state = { count: 0, instance: randomUUID() };
