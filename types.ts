export type Bindings = {
  DB: D1Database
  ASSETS: Fetcher
}

export type AppEnv = { Bindings: Bindings; Variables: { user: SessionUser } }

export type SessionUser = {
  id: number
  email: string
  name: string
  role: 'admin' | 'user'
  avatar: string
  theme: string
  created_at: string
}
