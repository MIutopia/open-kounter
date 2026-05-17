const RES_CODE = { SUCCESS: 0, FAIL: 1000 }

export async function onRequest(context) {
  const { request, env } = context

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request)
    })
  }

  if (typeof OPEN_KOUNTER === 'undefined') {
    return new Response(JSON.stringify({ code: RES_CODE.FAIL, message: 'OPEN_KOUNTER not bound' }), {
      headers: getCorsHeaders(request),
      status: 200
    })
  }

  try {
    if (request.method !== 'POST') {
      throw new Error('Method not allowed')
    }

    const body = await request.json()
    const { action = 'status', token } = body

    if (action === 'status') {
      const storedToken = await OPEN_KOUNTER.get('system:token')
      return new Response(JSON.stringify({
        code: RES_CODE.SUCCESS,
        data: {
          initialized: !!(storedToken || env.ADMIN_TOKEN),
          hasAdminToken: !!env.ADMIN_TOKEN
        }
      }), {
        headers: getCorsHeaders(request),
        status: 200
      })
    }

    if (action !== 'export_all') {
      throw new Error('Unknown action')
    }

    await checkAuth(token, env)

    const [allowedDomainsData, storedToken, counters, users, credentials, challenges, managementTokens] = await Promise.all([
      OPEN_KOUNTER.get('system:allowed_domains'),
      OPEN_KOUNTER.get('system:token'),
      exportCounters(),
      exportPrefixMap('passkey:user:'),
      exportPrefixMap('passkey:credential:'),
      exportPrefixMap('passkey:challenge:'),
      exportPrefixMap('passkey:mgmt_token:')
    ])

    return new Response(JSON.stringify({
      code: RES_CODE.SUCCESS,
      data: {
        system: {
          token: storedToken || env.ADMIN_TOKEN || null,
          allowedDomains: allowedDomainsData ? JSON.parse(allowedDomainsData) : []
        },
        counters,
        passkey: {
          users,
          credentials,
          challenges,
          managementTokens
        },
        timestamp: Date.now(),
        version: 'kv-legacy-1'
      }
    }), {
      headers: getCorsHeaders(request),
      status: 200
    })
  } catch (error) {
    return new Response(JSON.stringify({ code: RES_CODE.FAIL, message: error.message }), {
      headers: getCorsHeaders(request),
      status: 200
    })
  }
}

async function checkAuth(token, env) {
  if (!token) {
    throw new Error('Unauthorized')
  }

  if (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN) {
    return
  }

  const storedToken = await OPEN_KOUNTER.get('system:token')
  if (!storedToken) {
    throw new Error('System not initialized or Unauthorized')
  }

  if (storedToken !== token) {
    throw new Error('Unauthorized')
  }
}

async function exportCounters() {
  const counterKeys = await listAllKeys('counter:')
  const pairs = await Promise.all(counterKeys.map(async (key) => {
    const rawValue = await OPEN_KOUNTER.get(key)
    const target = key.slice('counter:'.length)
    return [target, normalizeCounterValue(rawValue)]
  }))
  return Object.fromEntries(pairs)
}

async function exportPrefixMap(prefix) {
  const keys = await listAllKeys(prefix)
  const entries = await Promise.all(keys.map(async (key) => {
    const rawValue = await OPEN_KOUNTER.get(key)
    return [key.slice(prefix.length), safeParseJson(rawValue)]
  }))
  return Object.fromEntries(entries.filter(([, value]) => value !== null))
}

async function listAllKeys(prefix) {
  const keys = []
  let cursor
  let result

  do {
    const options = { prefix, limit: 256 }
    if (typeof cursor === 'string' && cursor) {
      options.cursor = cursor
    }
    result = await OPEN_KOUNTER.list(options)
    const pageKeys = extractKeyNames(result)
    for (const key of pageKeys) {
      keys.push(key)
    }

    const nextCursor = typeof result?.cursor === 'string' ? result.cursor : ''
    const isComplete = typeof result?.complete === 'boolean'
      ? result.complete
      : !nextCursor || pageKeys.length === 0

    if (isComplete) {
      break
    }

    if (nextCursor === cursor) {
      break
    }

    cursor = nextCursor
  } while (true)

  return keys
}

function extractKeyNames(result) {
  const candidates = [
    result?.keys,
    result?.items,
    result?.list,
    result?.blobs,
    Array.isArray(result) ? result : null
  ]

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue
    }

    return candidate
      .map((item) => {
        if (typeof item === 'string') {
          return item
        }

        if (item && typeof item === 'object') {
          return item.name || item.key || null
        }

        return null
      })
      .filter(Boolean)
  }

  return []
}

function normalizeCounterValue(rawValue) {
  if (!rawValue) {
    return { time: 0, created_at: 0, updated_at: 0 }
  }

  const parsed = safeParseJson(rawValue)
  if (parsed && typeof parsed === 'object' && 'time' in parsed) {
    return {
      time: Number.parseInt(parsed.time, 10) || 0,
      created_at: Number(parsed.created_at) || 0,
      updated_at: Number(parsed.updated_at) || 0
    }
  }

  return {
    time: Number.parseInt(rawValue, 10) || 0,
    created_at: 0,
    updated_at: 0
  }
}

function safeParseJson(rawValue) {
  if (!rawValue) {
    return null
  }

  try {
    return JSON.parse(rawValue)
  } catch {
    return rawValue
  }
}

function getCorsHeaders(request) {
  const origin = request.headers.get('origin') || '*'
  return {
    'Content-Type': 'application/json; charset=UTF-8',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600'
  }
}

export default { onRequest }