import { state } from '../../lib/server/state.js';
export function GET() { return Response.json({ count: state.count }); }
