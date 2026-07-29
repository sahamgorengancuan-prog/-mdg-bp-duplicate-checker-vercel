// Vercel Function adapter for GET /api (service info).
// vercel.json rewrites the bare "/api" path here, mirroring the Cloudflare
// Pages Functions directory-index behavior of functions/api/index.js.
import { json } from '../_lib/duplicate.js';

export default {
  async fetch(request) {
    if (request.method === 'GET') {
      return json({ ok: true, service: 'MDG BP Duplicate Checker API', endpoints: ['/api/health', '/api/check'] });
    }
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }
};
