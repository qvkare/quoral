import { tick, status, type Env } from "./tick";

export default {
  /** Cron trigger: one quote, settle or pause flag per minute. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      tick(env).then(
        (r) => console.log(JSON.stringify(r)),
        (e) => console.error(JSON.stringify({ action: "error", detail: e instanceof Error ? e.message.slice(0, 400) : String(e) })),
      ),
    );
  },

  /** Read-only health check: GET / returns the agreement state and the operator's gas balance (503 when behind). */
  async fetch(req: Request, env: Env): Promise<Response> {
    if (new URL(req.url).pathname !== "/") return new Response("not found", { status: 404 });
    try {
      const s = await status(env);
      return Response.json(s, { status: s.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message.slice(0, 300) : String(e) }, { status: 502 });
    }
  },
};
