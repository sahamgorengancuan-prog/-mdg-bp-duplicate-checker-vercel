// Vercel Function adapter for GET /api/health.
// Same delegation pattern as check.js — no health-check logic lives in this file.
import { handleHealth, handleOptions, json } from '../_lib/duplicate.js';

export default {
  async fetch(request) {
    const method = request.method;

    if (method === 'OPTIONS') return handleOptions();
    if (method === 'GET') return handleHealth({ request, env: process.env });

    return json({ ok: false, error: 'Method not allowed' }, 405);
  }
};
