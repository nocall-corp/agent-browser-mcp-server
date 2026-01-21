import type { VercelRequest, VercelResponse } from '@vercel/node'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from '@modelcontextprotocol/sdk/types.js'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { kv } from '@vercel/kv'
import chromium from '@sparticuz/chromium'
import { chromium as playwright, Browser, Page, BrowserContext } from 'playwright-core'

const authTokens = [process.env.MCP_AUTH_TOKEN, process.env.AUTH_TOKEN].filter(
  (t): t is string => typeof t === 'string' && t.length > 0
)
const requireAuth =
  process.env.REQUIRE_AUTH === 'true' ||
  (process.env.REQUIRE_AUTH !== 'false' && process.env.VERCEL_ENV === 'production')

// Session data interface
interface BrowserSession {
  id: string
  url: string
  cookies: Array<{
    name: string
    value: string
    domain: string
    path: string
    expires?: number
    httpOnly?: boolean
    secure?: boolean
    sameSite?: 'Strict' | 'Lax' | 'None'
  }>
  localStorage: Record<string, string>
  lastSnapshot?: string
  refs?: Record<string, { role: string; name: string; selector: string }>
  createdAt: number
  updatedAt: number
}

const SESSION_TTL = 15 * 60 // 15 minutes

// Session management functions
async function getSession(sessionId: string): Promise<BrowserSession | null> {
  try {
    const session = await kv.get<BrowserSession>(`browser_session:${sessionId}`)
    return session
  } catch (error) {
    console.error('Failed to get session:', error)
    return null
  }
}

async function saveSession(session: BrowserSession): Promise<void> {
  try {
    await kv.set(`browser_session:${session.id}`, session, { ex: SESSION_TTL })
  } catch (error) {
    console.error('Failed to save session:', error)
  }
}

async function deleteSession(sessionId: string): Promise<void> {
  try {
    await kv.del(`browser_session:${sessionId}`)
  } catch (error) {
    console.error('Failed to delete session:', error)
  }
}

// Browser management
async function launchBrowser(): Promise<Browser> {
  const executablePath = await chromium.executablePath()
  
  const browser = await playwright.launch({
    args: chromium.args,
    executablePath,
    headless: true,
  })
  
  return browser
}

async function setupPage(browser: Browser, session: BrowserSession | null): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })
  
  // Restore cookies if session exists
  if (session?.cookies && session.cookies.length > 0) {
    await context.addCookies(session.cookies)
  }
  
  const page = await context.newPage()
  
  // Restore localStorage if session exists and has a URL
  if (session?.localStorage && session.url && Object.keys(session.localStorage).length > 0) {
    await page.goto(session.url, { waitUntil: 'domcontentloaded' })
    await page.evaluate((storage) => {
      for (const [key, value] of Object.entries(storage)) {
        localStorage.setItem(key, value)
      }
    }, session.localStorage)
  }
  
  return { context, page }
}

async function extractSessionData(context: BrowserContext, page: Page, sessionId: string, refs?: Record<string, { role: string; name: string; selector: string }>): Promise<BrowserSession> {
  const cookies = await context.cookies()
  const url = page.url()
  
  let localStorage: Record<string, string> = {}
  try {
    localStorage = await page.evaluate(() => {
      const storage: Record<string, string> = {}
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i)
        if (key) {
          storage[key] = window.localStorage.getItem(key) || ''
        }
      }
      return storage
    })
  } catch {
    // localStorage might not be available on some pages
  }
  
  return {
    id: sessionId,
    url,
    cookies: cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite as 'Strict' | 'Lax' | 'None' | undefined,
    })),
    localStorage,
    refs,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

// Accessibility snapshot helper
async function getAccessibilitySnapshot(page: Page): Promise<{ snapshot: string; refs: Record<string, { role: string; name: string; selector: string }> }> {
  const snapshot = await page.accessibility.snapshot({ interestingOnly: true })
  const refs: Record<string, { role: string; name: string; selector: string }> = {}
  let refCounter = 1
  
  function processNode(node: any, path: string[] = []): string {
    if (!node) return ''
    
    const lines: string[] = []
    const indent = '  '.repeat(path.length)
    const role = node.role || 'unknown'
    const name = node.name || ''
    
    // Generate ref for interactive elements
    let refStr = ''
    if (['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem', 'tab'].includes(role)) {
      const refId = `e${refCounter++}`
      refs[refId] = {
        role,
        name,
        selector: generateSelector(role, name),
      }
      refStr = ` [ref=${refId}]`
    }
    
    let line = `${indent}- ${role}`
    if (name) line += ` "${name}"`
    line += refStr
    lines.push(line)
    
    if (node.children) {
      for (const child of node.children) {
        const childOutput = processNode(child, [...path, role])
        if (childOutput) lines.push(childOutput)
      }
    }
    
    return lines.join('\n')
  }
  
  function generateSelector(role: string, name: string): string {
    if (name) {
      return `role=${role}[name="${name.replace(/"/g, '\\"')}"]`
    }
    return `role=${role}`
  }
  
  const snapshotText = processNode(snapshot)
  return { snapshot: snapshotText, refs }
}

// Tool definitions
const tools: Tool[] = [
  {
    name: 'browser_open',
    description: 'URLを開いてブラウザセッションを開始します。セッションIDが返されるので、以降の操作で使用してください。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '開くURL' },
        session_id: { type: 'string', description: '既存のセッションID（任意）。指定すると前回のCookies/localStorageを復元します' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    description: 'ページのアクセシビリティスナップショットを取得します。要素にはref（@e1, @e2など）が付与され、クリックや入力操作で使用できます。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'セッションID' },
        url: { type: 'string', description: 'スナップショットを取得するURL（session_idがない場合に使用）' },
      },
    },
  },
  {
    name: 'browser_click',
    description: '要素をクリックします。ref（@e1など）またはCSSセレクタを指定できます。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'セッションID' },
        url: { type: 'string', description: '操作対象のURL（session_idがない場合に使用）' },
        ref: { type: 'string', description: 'スナップショットのref（例: @e1）' },
        selector: { type: 'string', description: 'CSSセレクタ（refがない場合に使用）' },
      },
    },
  },
  {
    name: 'browser_fill',
    description: 'フォームフィールドに値を入力します（既存の値を置き換え）。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'セッションID' },
        url: { type: 'string', description: '操作対象のURL（session_idがない場合に使用）' },
        ref: { type: 'string', description: 'スナップショットのref（例: @e1）' },
        selector: { type: 'string', description: 'CSSセレクタ（refがない場合に使用）' },
        value: { type: 'string', description: '入力する値' },
      },
      required: ['value'],
    },
  },
  {
    name: 'browser_type',
    description: 'テキストを1文字ずつ入力します（キーイベントをトリガーする場合に有効）。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'セッションID' },
        url: { type: 'string', description: '操作対象のURL（session_idがない場合に使用）' },
        ref: { type: 'string', description: 'スナップショットのref（例: @e1）' },
        selector: { type: 'string', description: 'CSSセレクタ（refがない場合に使用）' },
        text: { type: 'string', description: '入力するテキスト' },
        submit: { type: 'boolean', description: '入力後にEnterキーを押すか', default: false },
      },
      required: ['text'],
    },
  },
  {
    name: 'browser_get_text',
    description: '要素のテキストコンテンツを取得します。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'セッションID' },
        url: { type: 'string', description: '操作対象のURL（session_idがない場合に使用）' },
        ref: { type: 'string', description: 'スナップショットのref（例: @e1）' },
        selector: { type: 'string', description: 'CSSセレクタ（refがない場合に使用）' },
      },
    },
  },
  {
    name: 'browser_screenshot',
    description: 'ページのスクリーンショットを取得します（Base64形式）。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'セッションID' },
        url: { type: 'string', description: 'スクリーンショットを取得するURL（session_idがない場合に使用）' },
        full_page: { type: 'boolean', description: 'ページ全体のスクリーンショットを取得するか', default: false },
      },
    },
  },
  {
    name: 'browser_wait',
    description: '指定した条件を待機します。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'セッションID' },
        url: { type: 'string', description: '操作対象のURL（session_idがない場合に使用）' },
        time: { type: 'number', description: '待機する秒数' },
        text: { type: 'string', description: '出現を待機するテキスト' },
        selector: { type: 'string', description: '出現を待機する要素のセレクタ' },
      },
    },
  },
  {
    name: 'browser_press_key',
    description: 'キーボードのキーを押下します。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'セッションID' },
        url: { type: 'string', description: '操作対象のURL（session_idがない場合に使用）' },
        key: { type: 'string', description: 'キー名（例: Enter, Tab, ArrowDown, Escape）' },
      },
      required: ['key'],
    },
  },
  {
    name: 'browser_close',
    description: 'ブラウザセッションを終了し、セッションデータを削除します。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '終了するセッションID' },
      },
      required: ['session_id'],
    },
  },
]

// Tool execution handler
async function executeTool(name: string, args: Record<string, unknown> | undefined): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }> {
  let browser: Browser | null = null
  
  try {
    switch (name) {
      case 'browser_open': {
        const url = args?.url as string
        if (!url) throw new Error('url is required')
        
        const existingSessionId = args?.session_id as string | undefined
        let session = existingSessionId ? await getSession(existingSessionId) : null
        
        browser = await launchBrowser()
        const { context, page } = await setupPage(browser, session)
        
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
        
        const sessionId = existingSessionId || randomUUID()
        const newSession = await extractSessionData(context, page, sessionId)
        await saveSession(newSession)
        
        await browser.close()
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              session_id: sessionId,
              url: page.url(),
              title: await page.title(),
              message: existingSessionId ? 'セッションを復元してページを開きました' : '新しいセッションでページを開きました',
            }, null, 2),
          }],
        }
      }
      
      case 'browser_snapshot': {
        const sessionId = args?.session_id as string | undefined
        const url = args?.url as string | undefined
        
        if (!sessionId && !url) throw new Error('session_id or url is required')
        
        let session = sessionId ? await getSession(sessionId) : null
        const targetUrl = url || session?.url
        if (!targetUrl) throw new Error('No URL available')
        
        browser = await launchBrowser()
        const { context, page } = await setupPage(browser, session)
        
        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 })
        
        const { snapshot, refs } = await getAccessibilitySnapshot(page)
        
        const newSessionId = sessionId || randomUUID()
        const newSession = await extractSessionData(context, page, newSessionId, refs)
        newSession.lastSnapshot = snapshot
        await saveSession(newSession)
        
        await browser.close()
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              session_id: newSessionId,
              url: page.url(),
              snapshot,
              refs: Object.fromEntries(
                Object.entries(refs).map(([k, v]) => [k, { role: v.role, name: v.name }])
              ),
            }, null, 2),
          }],
        }
      }
      
      case 'browser_click': {
        const sessionId = args?.session_id as string | undefined
        const url = args?.url as string | undefined
        const ref = args?.ref as string | undefined
        const selector = args?.selector as string | undefined
        
        if (!sessionId && !url) throw new Error('session_id or url is required')
        if (!ref && !selector) throw new Error('ref or selector is required')
        
        let session = sessionId ? await getSession(sessionId) : null
        const targetUrl = url || session?.url
        if (!targetUrl) throw new Error('No URL available')
        
        browser = await launchBrowser()
        const { context, page } = await setupPage(browser, session)
        
        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 })
        
        let targetSelector = selector
        if (ref && session?.refs) {
          const refKey = ref.startsWith('@') ? ref.slice(1) : ref
          const refData = session.refs[refKey]
          if (refData) {
            targetSelector = refData.selector
          }
        }
        
        if (!targetSelector) throw new Error('Could not resolve selector')
        
        await page.locator(targetSelector).click({ timeout: 10000 })
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
        
        const newSessionId = sessionId || randomUUID()
        const newSession = await extractSessionData(context, page, newSessionId)
        await saveSession(newSession)
        
        await browser.close()
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              session_id: newSessionId,
              url: page.url(),
              message: `クリックしました: ${ref || selector}`,
            }, null, 2),
          }],
        }
      }
      
      case 'browser_fill': {
        const sessionId = args?.session_id as string | undefined
        const url = args?.url as string | undefined
        const ref = args?.ref as string | undefined
        const selector = args?.selector as string | undefined
        const value = args?.value as string
        
        if (!value) throw new Error('value is required')
        if (!sessionId && !url) throw new Error('session_id or url is required')
        if (!ref && !selector) throw new Error('ref or selector is required')
        
        let session = sessionId ? await getSession(sessionId) : null
        const targetUrl = url || session?.url
        if (!targetUrl) throw new Error('No URL available')
        
        browser = await launchBrowser()
        const { context, page } = await setupPage(browser, session)
        
        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 })
        
        let targetSelector = selector
        if (ref && session?.refs) {
          const refKey = ref.startsWith('@') ? ref.slice(1) : ref
          const refData = session.refs[refKey]
          if (refData) {
            targetSelector = refData.selector
          }
        }
        
        if (!targetSelector) throw new Error('Could not resolve selector')
        
        await page.locator(targetSelector).fill(value, { timeout: 10000 })
        
        const newSessionId = sessionId || randomUUID()
        const newSession = await extractSessionData(context, page, newSessionId)
        await saveSession(newSession)
        
        await browser.close()
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              session_id: newSessionId,
              url: page.url(),
              message: `入力しました: ${ref || selector}`,
            }, null, 2),
          }],
        }
      }
      
      case 'browser_type': {
        const sessionId = args?.session_id as string | undefined
        const url = args?.url as string | undefined
        const ref = args?.ref as string | undefined
        const selector = args?.selector as string | undefined
        const text = args?.text as string
        const submit = args?.submit as boolean
        
        if (!text) throw new Error('text is required')
        if (!sessionId && !url) throw new Error('session_id or url is required')
        if (!ref && !selector) throw new Error('ref or selector is required')
        
        let session = sessionId ? await getSession(sessionId) : null
        const targetUrl = url || session?.url
        if (!targetUrl) throw new Error('No URL available')
        
        browser = await launchBrowser()
        const { context, page } = await setupPage(browser, session)
        
        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 })
        
        let targetSelector = selector
        if (ref && session?.refs) {
          const refKey = ref.startsWith('@') ? ref.slice(1) : ref
          const refData = session.refs[refKey]
          if (refData) {
            targetSelector = refData.selector
          }
        }
        
        if (!targetSelector) throw new Error('Could not resolve selector')
        
        await page.locator(targetSelector).click({ timeout: 10000 })
        await page.keyboard.type(text, { delay: 50 })
        
        if (submit) {
          await page.keyboard.press('Enter')
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
        }
        
        const newSessionId = sessionId || randomUUID()
        const newSession = await extractSessionData(context, page, newSessionId)
        await saveSession(newSession)
        
        await browser.close()
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              session_id: newSessionId,
              url: page.url(),
              message: `タイプしました: ${text}${submit ? ' (送信済み)' : ''}`,
            }, null, 2),
          }],
        }
      }
      
      case 'browser_get_text': {
        const sessionId = args?.session_id as string | undefined
        const url = args?.url as string | undefined
        const ref = args?.ref as string | undefined
        const selector = args?.selector as string | undefined
        
        if (!sessionId && !url) throw new Error('session_id or url is required')
        if (!ref && !selector) throw new Error('ref or selector is required')
        
        let session = sessionId ? await getSession(sessionId) : null
        const targetUrl = url || session?.url
        if (!targetUrl) throw new Error('No URL available')
        
        browser = await launchBrowser()
        const { context, page } = await setupPage(browser, session)
        
        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 })
        
        let targetSelector = selector
        if (ref && session?.refs) {
          const refKey = ref.startsWith('@') ? ref.slice(1) : ref
          const refData = session.refs[refKey]
          if (refData) {
            targetSelector = refData.selector
          }
        }
        
        if (!targetSelector) throw new Error('Could not resolve selector')
        
        const text = await page.locator(targetSelector).textContent({ timeout: 10000 })
        
        const newSessionId = sessionId || randomUUID()
        const newSession = await extractSessionData(context, page, newSessionId)
        await saveSession(newSession)
        
        await browser.close()
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              session_id: newSessionId,
              text: text || '',
            }, null, 2),
          }],
        }
      }
      
      case 'browser_screenshot': {
        const sessionId = args?.session_id as string | undefined
        const url = args?.url as string | undefined
        const fullPage = args?.full_page as boolean
        
        if (!sessionId && !url) throw new Error('session_id or url is required')
        
        let session = sessionId ? await getSession(sessionId) : null
        const targetUrl = url || session?.url
        if (!targetUrl) throw new Error('No URL available')
        
        browser = await launchBrowser()
        const { context, page } = await setupPage(browser, session)
        
        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 })
        
        const screenshot = await page.screenshot({
          fullPage: fullPage || false,
          type: 'jpeg',
          quality: 80,
        })
        
        const newSessionId = sessionId || randomUUID()
        const newSession = await extractSessionData(context, page, newSessionId)
        await saveSession(newSession)
        
        await browser.close()
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                session_id: newSessionId,
                url: page.url(),
              }, null, 2),
            },
            {
              type: 'image',
              data: screenshot.toString('base64'),
              mimeType: 'image/jpeg',
            },
          ],
        }
      }
      
      case 'browser_wait': {
        const sessionId = args?.session_id as string | undefined
        const url = args?.url as string | undefined
        const time = args?.time as number | undefined
        const text = args?.text as string | undefined
        const selector = args?.selector as string | undefined
        
        if (!sessionId && !url) throw new Error('session_id or url is required')
        if (!time && !text && !selector) throw new Error('time, text, or selector is required')
        
        let session = sessionId ? await getSession(sessionId) : null
        const targetUrl = url || session?.url
        if (!targetUrl) throw new Error('No URL available')
        
        browser = await launchBrowser()
        const { context, page } = await setupPage(browser, session)
        
        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 })
        
        let waitResult = ''
        if (time) {
          await page.waitForTimeout(time * 1000)
          waitResult = `${time}秒待機しました`
        } else if (text) {
          await page.waitForSelector(`text=${text}`, { timeout: 30000 })
          waitResult = `テキスト "${text}" が出現しました`
        } else if (selector) {
          await page.waitForSelector(selector, { timeout: 30000 })
          waitResult = `要素 "${selector}" が出現しました`
        }
        
        const newSessionId = sessionId || randomUUID()
        const newSession = await extractSessionData(context, page, newSessionId)
        await saveSession(newSession)
        
        await browser.close()
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              session_id: newSessionId,
              url: page.url(),
              message: waitResult,
            }, null, 2),
          }],
        }
      }
      
      case 'browser_press_key': {
        const sessionId = args?.session_id as string | undefined
        const url = args?.url as string | undefined
        const key = args?.key as string
        
        if (!key) throw new Error('key is required')
        if (!sessionId && !url) throw new Error('session_id or url is required')
        
        let session = sessionId ? await getSession(sessionId) : null
        const targetUrl = url || session?.url
        if (!targetUrl) throw new Error('No URL available')
        
        browser = await launchBrowser()
        const { context, page } = await setupPage(browser, session)
        
        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 })
        
        await page.keyboard.press(key)
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
        
        const newSessionId = sessionId || randomUUID()
        const newSession = await extractSessionData(context, page, newSessionId)
        await saveSession(newSession)
        
        await browser.close()
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              session_id: newSessionId,
              url: page.url(),
              message: `キー "${key}" を押しました`,
            }, null, 2),
          }],
        }
      }
      
      case 'browser_close': {
        const sessionId = args?.session_id as string
        if (!sessionId) throw new Error('session_id is required')
        
        await deleteSession(sessionId)
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `セッション ${sessionId} を終了しました`,
            }, null, 2),
          }],
        }
      }
      
      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: true, message: errorMessage }, null, 2) }],
      isError: true,
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {})
    }
  }
}

// MCP Server class
class AgentBrowserMCPServer {
  private server: Server

  constructor() {
    this.server = new Server({ name: 'agent-browser-mcp-server', version: '1.0.0' }, { capabilities: { tools: {} } })
    this.setupHandlers()
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: params } = request.params
      return executeTool(name, params)
    })
  }

  async connect(transport: Transport) {
    await this.server.connect(transport)
  }
}

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {}

// Authentication helper
function authenticate(req: VercelRequest, res: VercelResponse): boolean {
  if (requireAuth && authTokens.length === 0) {
    res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32002, message: 'Server misconfigured: MCP_AUTH_TOKEN or AUTH_TOKEN is required' },
      id: null
    })
    return false
  }

  if (authTokens.length === 0) return true

  const authHeader = req.headers['authorization']
  const authHeaderStr = Array.isArray(authHeader) ? authHeader[0] : authHeader
  const bearerToken =
    authHeaderStr && typeof authHeaderStr === 'string' && authHeaderStr.toLowerCase().startsWith('bearer ')
      ? authHeaderStr.slice('bearer '.length).trim()
      : null

  const directTokenHeader = req.headers['x-auth-token']
  const directToken = Array.isArray(directTokenHeader) ? directTokenHeader[0] : directTokenHeader
  const token = bearerToken || (typeof directToken === 'string' ? directToken : null)
  
  if (!token || !authTokens.includes(token)) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null
    })
    return false
  }
  return true
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id')

  if (req.method === 'OPTIONS') {
    res.status(200).end()
    return
  }

  if (!authenticate(req, res)) return

  try {
    if (req.method === 'POST') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      let transport: StreamableHTTPServerTransport

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId]
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport
          }
        })

        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId]
          }
        }

        const mcpServer = new AgentBrowserMCPServer()
        await mcpServer.connect(transport)
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null
        })
        return
      }

      await transport.handleRequest(req as any, res as any, req.body)
    } else if (req.method === 'GET' || req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID')
        return
      }
      await transports[sessionId].handleRequest(req as any, res as any)
    } else {
      res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32601, message: 'Method not allowed' },
        id: null
      })
    }
  } catch (error) {
    console.error('MCP Error:', error)
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: `Internal error: ${error instanceof Error ? error.message : 'Unknown'}` },
        id: null
      })
    }
  }
}
