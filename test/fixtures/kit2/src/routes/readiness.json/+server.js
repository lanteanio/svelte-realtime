// Readiness identity for the compatibility runner. Loads no live module.
export function GET() { return Response.json({ token: process.env.KIT_COMPAT_SESSION, pid: process.pid }); }
