import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.status(200).end()
    return
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const hasMcpAuthToken = !!process.env.MCP_AUTH_TOKEN
  const hasLegacyAuthToken = !!process.env.AUTH_TOKEN
  const hasKvUrl = !!process.env.KV_REST_API_URL
  const hasKvToken = !!process.env.KV_REST_API_TOKEN
  const hasBrowserlessUrl = !!process.env.BROWSERLESS_URL
  const hasBrowserlessToken = !!process.env.BROWSERLESS_TOKEN
  const browserConfigured = hasBrowserlessUrl || hasBrowserlessToken
  const requireAuth =
    process.env.REQUIRE_AUTH === 'true' ||
    (process.env.REQUIRE_AUTH !== 'false' && process.env.VERCEL_ENV === 'production')

  res.status(200).json({
    status: browserConfigured ? 'ok' : 'warning',
    server: 'agent-browser-mcp-server',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    config: {
      mcp_auth_token_configured: hasMcpAuthToken,
      auth_token_configured: hasMcpAuthToken || hasLegacyAuthToken,
      legacy_auth_token_configured: hasLegacyAuthToken,
      kv_configured: hasKvUrl && hasKvToken,
      browserless_configured: browserConfigured,
      require_auth: requireAuth,
      vercel_env: process.env.VERCEL_ENV ?? null,
    },
    message: !browserConfigured ? 'BROWSERLESS_URL or BROWSERLESS_TOKEN is required for browser automation. Get a free API key at https://browserless.io' : undefined,
  })
}
