import { Hono } from 'hono'
import { api } from './api'
import { ensureSchema, seedAdmin } from './db'
import type { Bindings } from './types'

const app = new Hono<{ Bindings: Bindings }>()

/** One schema+seed bootstrap per isolate. Both steps are idempotent. */
let bootstrap: Promise<void> | null = null
function ready(db: D1Database): Promise<void> {
  if (!bootstrap) {
    bootstrap = (async () => {
      await ensureSchema(db)
      await seedAdmin(db)
    })().catch((err) => {
      bootstrap = null
      throw err
    })
  }
  return bootstrap
}

// Every API call gets a guaranteed schema + permanent admin.
app.use('/api/*', async (c, next) => {
  try {
    await ready(c.env.DB)
  } catch (err) {
    console.error('bootstrap failed', err)
    return c.json({ error: 'The database is warming up. Please retry in a moment.' }, 503)
  }
  await next()
})

app.route('/', api)

// Static assets (index.html, style.css, script.js) are served by the ASSETS binding.
app.all('*', async (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw)
  return c.text('Not found', 404)
})

app.onError((err, c) => {
  console.error('worker error', err)
  return c.json({ error: 'Unexpected server error.' }, 500)
})

export default app
