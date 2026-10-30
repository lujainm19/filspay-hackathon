# AI agent conventions — FilsPay

All coding agents (Claude, Cursor, Copilot, …) follow **CLAUDE.md**. It is
the single source of AI instructions for this repo; keep this file a pointer
so the two can never disagree again.

The previous AGENTS.md told agents not to touch tests or `packages/money`,
that Math.random was acceptable for OTPs, that money was in cents and that
INTEGER columns were safe. All of that was false; see the table at the end of
CLAUDE.md.
