/**
 * 极简页面计数器 - EdgeOne Pages Function
 */
import { getStore } from '@edgeone/pages-blob';

export async function onRequest({ request }) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const store = getStore('open-kounter');
    const url = new URL(request.url);
    const path = url.searchParams.get('path') || '/';

    if (request.method === 'GET') {
      const raw = await store.get(path);
      const count = raw ? parseInt(raw) : 0;
      return new Response(JSON.stringify({ path, count }), { headers: corsHeaders });
    }

    if (request.method === 'POST') {
      const body = await request.json();
      const action = body.action || 'inc';
      const target = body.target || path;

      if (action === 'inc') {
        const raw = await store.get(target);
        const current = raw ? parseInt(raw) : 0;
        const next = current + 1;
        await store.set(target, String(next));
        return new Response(JSON.stringify({ path: target, count: next }), { headers: corsHeaders });
      }

      return new Response(JSON.stringify({ path: target, count: 0 }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
