import { createStore } from '../_api.js'
import { writeJson } from '../_blobStore.js'

const OIDC_STATE_PREFIX = 'oidc/states/'
const STATE_TTL_MS = 5 * 60 * 1000 // 5 分钟

/**
 * 发起 OIDC 授权流程
 * GET /api/oidc/login?mode=login|bind&token=xxx
 *   mode=bind 时需要携带 token 参数（管理员绑定 OIDC 身份）
 *   mode=login 时直接发起登录
 */
export async function onRequestGet(context) {
  const { request, env } = context

  // 检查 OIDC 配置
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET || !env.OIDC_REDIRECT_URI) {
    return new Response('OIDC not configured', { status: 500 })
  }

  const url = new URL(request.url)
  const mode = url.searchParams.get('mode') || 'login' // 'login' | 'bind'
  const token = url.searchParams.get('token') || ''

  // bind 模式必须携带 token
  if (mode === 'bind' && !token) {
    return new Response('Token required for bind mode', { status: 400 })
  }

  const store = createStore(context)

  // 生成 state 和 nonce
  const stateBytes = new Uint8Array(32)
  crypto.getRandomValues(stateBytes)
  const state = base64URLEncode(stateBytes)

  const nonceBytes = new Uint8Array(32)
  crypto.getRandomValues(nonceBytes)
  const nonce = base64URLEncode(nonceBytes)

  // 存储 state 到 Blob
  await writeJson(store, `${OIDC_STATE_PREFIX}${state}.json`, {
    state,
    nonce,
    mode,
    token: mode === 'bind' ? token : '',
    createdAt: Date.now(),
    expiresAt: Date.now() + STATE_TTL_MS
  })

  // 发现 OIDC 端点
  const endpoints = await discoverOIDCEndpoints(env.OIDC_ISSUER)

  // 构建授权 URL
  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: env.OIDC_CLIENT_ID,
    redirect_uri: env.OIDC_REDIRECT_URI,
    scope: 'openid email profile',
    state,
    nonce
  })

  const authUrl = `${endpoints.authorization_endpoint}?${authParams.toString()}`

  return Response.redirect(authUrl, 302)
}

/**
 * 发现 OIDC 端点配置
 */
async function discoverOIDCEndpoints(issuer) {
  const wellKnownUrl = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
  const res = await fetch(wellKnownUrl)
  if (!res.ok) {
    throw new Error(`Failed to fetch OIDC discovery document: ${res.status}`)
  }
  return await res.json()
}

function base64URLEncode(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export default { onRequestGet }
