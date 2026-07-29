// Vercel Function adapter for POST /api/check.
// This file only routes the request; ALL duplicate-check logic lives in ../_lib/duplicate.js,
// unchanged from the Cloudflare Pages Functions version. Vercel env vars are read via
// process.env (Node.js runtime), passed through as context.env so the shared engine below
// stays 100% platform-agnostic.
import { handleCheck, handleOptions, json } from '../_lib/duplicate.js';

export default {
  async fetch(request) {
    const method = request.method;

    if (method === 'OPTIONS') return handleOptions();
    if (method === 'POST') return handleCheck({ request, env: process.env });
    if (method === 'GET') return json({ ok: true, endpoint: '/api/check', method: 'POST' });

    return json({ ok: false, error: 'Method not allowed' }, 405);
  }
};
