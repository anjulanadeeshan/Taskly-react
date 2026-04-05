import { useCallback, useEffect, useRef, useState } from 'react'
import { Routes, Route, NavLink } from 'react-router-dom'
import { GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { auth } from './firebase'
import { createCalendarEvent, getCalendarEvents, type CalendarEvent, type NewCalendarEventInput } from './calendar'
import './App.css'

// ─── Google Calendar token persistence ──────────────────────────────────────
const GCAL_TOKEN_KEY = 'taskly-gcal-token'
const GCAL_EXPIRY_KEY = 'taskly-gcal-expiry'
const TODO_STORAGE_KEY = 'taskly-todos'

type TodoItem = {
  id: string
  title: string
  deadline: string
  isDaily: boolean
  isPinned: boolean
  completed: boolean
  createdAt: string
}

type NewTodoInput = {
  title: string
  deadline: string
  isDaily: boolean
  isPinned: boolean
}

const DEFAULT_TODOS: TodoItem[] = [
  {
    id: 'todo-1',
    title: 'Finish assignment report',
    deadline: '2026-04-05',
    isDaily: false,
    isPinned: true,
    completed: false,
    createdAt: '2026-04-01T08:30:00.000Z',
  },
  {
    id: 'todo-2',
    title: 'Review lecture notes',
    deadline: '2026-04-05',
    isDaily: true,
    isPinned: false,
    completed: false,
    createdAt: '2026-04-01T10:00:00.000Z',
  },
  {
    id: 'todo-3',
    title: 'Plan group meeting',
    deadline: '2026-04-06',
    isDaily: false,
    isPinned: false,
    completed: false,
    createdAt: '2026-04-02T13:15:00.000Z',
  },
]

function loadTodos(): TodoItem[] {
  try {
    const raw = localStorage.getItem(TODO_STORAGE_KEY)
    if (!raw) return DEFAULT_TODOS
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return DEFAULT_TODOS

    const todos = parsed.filter((item): item is TodoItem => {
      if (typeof item !== 'object' || item === null) return false
      const value = item as Partial<TodoItem>
      return (
        typeof value.id === 'string' &&
        typeof value.title === 'string' &&
        typeof value.deadline === 'string' &&
        typeof value.isDaily === 'boolean' &&
        typeof value.isPinned === 'boolean' &&
        typeof value.completed === 'boolean' &&
        typeof value.createdAt === 'string'
      )
    })

    return todos.length > 0 ? todos : DEFAULT_TODOS
  } catch {
    return DEFAULT_TODOS
  }
}

function saveCalToken(token: string): void {
  localStorage.setItem(GCAL_TOKEN_KEY, token)
  // Access tokens last ~3600 s; save with 55 min buffer
  localStorage.setItem(GCAL_EXPIRY_KEY, String(Date.now() + 55 * 60 * 1000))
}

function loadCalToken(): string | null {
  const token = localStorage.getItem(GCAL_TOKEN_KEY)
  const expiry = localStorage.getItem(GCAL_EXPIRY_KEY)
  if (!token || !expiry || Date.now() > Number(expiry)) {
    localStorage.removeItem(GCAL_TOKEN_KEY)
    localStorage.removeItem(GCAL_EXPIRY_KEY)
    return null
  }
  return token
}

function clearCalToken(): void {
  localStorage.removeItem(GCAL_TOKEN_KEY)
  localStorage.removeItem(GCAL_EXPIRY_KEY)
}
// ────────────────────────────────────────────────────────────────────────────

function getTimeOfDayGreeting(date = new Date()): string {
  const hour = date.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function formatDisplayTitle(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

function projectStatusClass(status: string): string {
  if (status === 'Active') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
  if (status === 'In progress') return 'bg-sky-500/15 text-sky-300 border-sky-500/30'
  return 'bg-slate-500/15 text-slate-300 border-slate-500/30'
}

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(() => loadCalToken())
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([])
  const [todos, setTodos] = useState<TodoItem[]>(() => loadTodos())
  const [calendarLoading, setCalendarLoading] = useState(false)
  const [calendarError, setCalendarError] = useState<string | null>(null)
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const hasSeenInitialAuthEvent = useRef(false)
  const profileMenuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    localStorage.setItem(TODO_STORAGE_KEY, JSON.stringify(todos))
  }, [todos])

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((currentUser) => {
      setUser(currentUser)
      // Ignore the very first auth event so refresh-time session restoration
      // cannot wipe a valid saved calendar token.
      if (hasSeenInitialAuthEvent.current && !currentUser) {
        setGoogleAccessToken(null)
        setCalendarEvents([])
        clearCalToken()
      }
      hasSeenInitialAuthEvent.current = true
    })
    return () => unsubscribe()
  }, [])

  const getAuthErrorCode = (err: unknown): string | undefined => {
    if (typeof err === 'object' && err !== null && 'code' in err) {
      const code = (err as { code?: unknown }).code
      return typeof code === 'string' ? code : undefined
    }
    return undefined
  }

  const isInsufficientScopeError = (message: string): boolean => {
    const value = message.toLowerCase()
    return value.includes('insufficientpermissions') || value.includes('insufficient authentication scopes')
  }

  // Sign in + request Calendar scope together — no separate "Connect" step needed
  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider()
      provider.addScope('https://www.googleapis.com/auth/calendar.events')
      const result = await signInWithPopup(auth, provider)
      const credential = GoogleAuthProvider.credentialFromResult(result)
      const token = credential?.accessToken ?? null
      setGoogleAccessToken(token)
      if (token) saveCalToken(token)
    } catch (error) {
      const code = getAuthErrorCode(error)
      if (code === 'auth/popup-closed-by-user') return
      if (code === 'auth/popup-blocked') {
        setCalendarError('Popup blocked. Allow popups for this site and try again.')
        return
      }
      console.error('Error signing in with Google', error)
    }
  }

  const handleConnectCalendar = async (): Promise<string | null> => {
    try {
      const calendarProvider = new GoogleAuthProvider()
      calendarProvider.addScope('https://www.googleapis.com/auth/calendar.events')
      calendarProvider.setCustomParameters({ prompt: 'consent' })

      const result = await signInWithPopup(auth, calendarProvider)
      const credential = GoogleAuthProvider.credentialFromResult(result)
      const token = credential?.accessToken ?? null
      setGoogleAccessToken(token)
      if (token) saveCalToken(token)
      setCalendarError(null)
      return token
    } catch (error) {
      const code = getAuthErrorCode(error)
      if (code === 'auth/popup-closed-by-user') {
        setCalendarError('Popup closed. Please try again to connect Calendar.')
        return null
      }
      if (code === 'auth/popup-blocked') {
        setCalendarError('Popup blocked. Allow popups for this site and try again.')
        return null
      }
      console.error('Error connecting Google Calendar', error)
      setCalendarError('Calendar permission was not granted.')
      return null
    }
  }

  const refreshCalendarEvents = useCallback(async (tokenOverride?: string) => {
    const token = tokenOverride ?? googleAccessToken
    if (!user || !token) return

    try {
      setCalendarError(null)
      setCalendarLoading(true)
      const items = await getCalendarEvents(token)
      setCalendarEvents(items)
    } catch (err) {
      console.error('Failed to load calendar events', err)
      const msg = err instanceof Error ? err.message : ''
      if (msg.includes('401') || msg.includes('403')) {
        clearCalToken()
        setGoogleAccessToken(null)
        setCalendarError('Calendar session expired. Click "Reconnect" to refresh.')
      } else {
        setCalendarError('Could not load Google Calendar events.')
      }
    } finally {
      setCalendarLoading(false)
    }
  }, [user, googleAccessToken])

  const handleCreateCalendarEvent = async (input: NewCalendarEventInput) => {
    if (!user || !googleAccessToken) {
      throw new Error('Connect Google Calendar before creating an event.')
    }

    try {
      await createCalendarEvent(googleAccessToken, input)
      await refreshCalendarEvents(googleAccessToken)
      setCalendarError(null)
    } catch (error) {
      console.error('Error creating Google Calendar event', error)
      const message = error instanceof Error ? error.message : 'Could not create event.'

      // Users may still have an old read-only token in storage; request consent
      // for calendar write scope and retry once with the upgraded token.
      if (isInsufficientScopeError(message)) {
        const upgradedToken = await handleConnectCalendar()
        if (!upgradedToken) {
          throw new Error('Please reconnect Google Calendar to grant event-create permissions.')
        }

        await createCalendarEvent(upgradedToken, input)
        await refreshCalendarEvents(upgradedToken)
        setCalendarError(null)
        return
      }

      throw new Error(message)
    }
  }

  const handleLogout = async () => {
    try {
      await signOut(auth)
      setGoogleAccessToken(null)
      setCalendarEvents([])
      clearCalToken()
    } catch (error) {
      console.error('Error signing out', error)
    }
  }

  const handleAddTodo = (input: NewTodoInput) => {
    const title = input.title.trim()
    if (!title) return

    const newTodo: TodoItem = {
      id: `todo-${Date.now()}`,
      title,
      deadline: input.deadline,
      isDaily: input.isDaily,
      isPinned: input.isPinned,
      completed: false,
      createdAt: new Date().toISOString(),
    }

    setTodos((prev) => [newTodo, ...prev])
  }

  const handleToggleTodoCompleted = (id: string) => {
    setTodos((prev) =>
      prev.map((todo) => (todo.id === id ? { ...todo, completed: !todo.completed } : todo))
    )
  }

  const handleToggleTodoPinned = (id: string) => {
    setTodos((prev) =>
      prev.map((todo) => (todo.id === id ? { ...todo, isPinned: !todo.isPinned } : todo))
    )
  }

  const handleDeleteTodo = (id: string) => {
    setTodos((prev) => prev.filter((todo) => todo.id !== id))
  }

  useEffect(() => {
    void refreshCalendarEvents()
  }, [refreshCalendarEvents])

  useEffect(() => {
    document.documentElement.classList.add('dark')
  }, [])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!profileMenuOpen) return
      const target = event.target as Node | null
      if (target && profileMenuRef.current && !profileMenuRef.current.contains(target)) {
        setProfileMenuOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [profileMenuOpen])

  return (
    <div className="dark h-full bg-slate-950 text-slate-100 transition-colors">
      <div className="min-h-screen flex flex-col lg:flex-row">
        <aside className="hidden lg:block w-full lg:w-64 border-b lg:border-b-0 lg:border-r backdrop-blur transition-colors bg-slate-800 border-slate-700 text-slate-100">
          <div className="flex items-center justify-between px-4 py-4 border-b transition-colors border-slate-800/60 text-slate-100">
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-slate-100">Taskly</h1>
              <p className="text-xs text-slate-400">Plan. Focus. Execute.</p>
            </div>
          </div>

          <nav className="px-3 py-3 flex flex-col gap-1 text-sm">
            <SidebarLink to="/" label="Dashboard" />
            <SidebarLink to="/schedule" label="Daily Schedule" />
            <SidebarLink to="/tasks" label="To-Do List" />
            <SidebarLink to="/mind-dump" label="Mind Dump" />
            <SidebarLink to="/projects" label="Projects" />
          </nav>
        </aside>

        <main className="flex-1 pb-20 lg:pb-0 transition-colors bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
          <header className="grid gap-2 sm:gap-3 px-3 sm:px-4 lg:px-8 py-3 sm:py-4 border-b transition-colors border-slate-800 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-center">
            <div>
              <h2 className="text-base sm:text-lg font-semibold tracking-tight text-slate-950 dark:text-slate-100">
                {user
                  ? `${getTimeOfDayGreeting()}, ${user.displayName ?? 'friend'} 👋`
                  : 'Welcome to Taskly 👋'}
              </h2>
              <p className="text-[11px] sm:text-xs text-slate-800 dark:text-slate-400">
                Your daily hub for tasks, schedule, and projects.
              </p>
            </div>

            <div className="hidden lg:flex items-center justify-center">
              <div className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1.5 text-[11px] text-slate-300 shadow-sm">
                {/* <span className="font-semibold text-slate-100">Dashboard</span> */}
                {/* <span className="text-slate-500">/</span> */}
                <span>{new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
              </div>
            </div>

            <div className="relative flex items-center justify-end gap-2" ref={profileMenuRef}>
              {user && (
                <>
                  <button
                    type="button"
                    onClick={() => setProfileMenuOpen((value) => !value)}
                    className="inline-flex items-center gap-1 rounded-full border border-slate-300/70 dark:border-slate-700 bg-white/80 dark:bg-slate-900/70 px-1.5 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:bg-white/95 dark:hover:bg-slate-800/90 transition-colors"
                    aria-haspopup="menu"
                    aria-expanded={profileMenuOpen}
                  >
                    <UserAvatar user={user} />
                    <span className="pr-0.5 text-[10px] leading-none text-slate-500 dark:text-slate-400">
                      ▾
                    </span>
                  </button>
                </>
              )}
              {!user ? (
                <button
                  onClick={handleLogin}
                  className="inline-flex items-center rounded-full bg-primary-500 text-white text-xs px-3 py-1.5 shadow-md hover:bg-primary-600"
                >
                  Sign in with Google
                </button>
              ) : null}
              {user && profileMenuOpen ? (
                <>
                  <button
                    type="button"
                    onClick={() => setProfileMenuOpen(false)}
                    className="sm:hidden fixed inset-0 z-40 bg-black/35"
                    aria-label="Close profile menu"
                  />
                  <div className="absolute right-0 top-full mt-2 w-56 overflow-hidden rounded-2xl border border-slate-700 bg-slate-950/95 shadow-2xl backdrop-blur z-50 max-sm:fixed max-sm:left-3 max-sm:right-3 max-sm:top-20 max-sm:mt-0 max-sm:w-auto">
                  <div className="border-b border-slate-800 px-4 py-3">
                    <div className="flex items-center gap-3">
                      <UserAvatar user={user} />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-100">{user.displayName ?? 'Google user'}</p>
                        <p className="truncate text-xs text-slate-400">{user.email}</p>
                      </div>
                    </div>
                  </div>

                  <div className="p-2">
                    <button
                      type="button"
                      onClick={() => {
                        setProfileMenuOpen(false)
                        window.open('https://myaccount.google.com/', '_blank', 'noreferrer')
                      }}
                      className="flex w-full items-center rounded-xl px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-800 transition-colors"
                    >
                      Profile Settings
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setProfileMenuOpen(false)
                        void handleLogout()
                      }}
                      className="flex w-full items-center rounded-xl px-3 py-2 text-left text-xs text-rose-300 hover:bg-rose-500/10 transition-colors"
                    >
                      Logout
                    </button>
                  </div>
                  </div>
                </>
              ) : null}
            </div>
          </header>

          <section className="px-3 sm:px-4 lg:px-8 py-3 sm:py-4 lg:py-6">
            <Routes>
              <Route
                path="/"
                element={
                  <DashboardPage
                    isSignedIn={Boolean(user)}
                    hasCalendarToken={Boolean(googleAccessToken)}
                    onConnectCalendar={handleConnectCalendar}
                    onCreateEvent={handleCreateCalendarEvent}
                    calendarEvents={calendarEvents}
                    calendarLoading={calendarLoading}
                    calendarError={calendarError}
                    todos={todos}
                  />
                }
              />
              <Route path="/schedule" element={<SchedulePage />} />
              <Route
                path="/tasks"
                element={
                  <TasksPage
                    todos={todos}
                    onAddTodo={handleAddTodo}
                    onToggleTodoCompleted={handleToggleTodoCompleted}
                    onToggleTodoPinned={handleToggleTodoPinned}
                    onDeleteTodo={handleDeleteTodo}
                  />
                }
              />
              <Route path="/mind-dump" element={<MindDumpPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
            </Routes>
          </section>
        </main>

        <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-slate-800 bg-slate-950/95 backdrop-blur px-2 py-2">
          <div className="grid grid-cols-5 gap-1 text-[10px]">
            <MobileNavLink to="/" label="Home" />
            <MobileNavLink to="/schedule" label="Schedule" />
            <MobileNavLink to="/tasks" label="Tasks" />
            <MobileNavLink to="/mind-dump" label="Ideas" />
            <MobileNavLink to="/projects" label="Projects" />
          </div>
        </nav>
      </div>
    </div>
  )
}

type SidebarLinkProps = {
  to: string
  label: string
}

function SidebarLink({ to, label }: SidebarLinkProps) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center justify-between rounded-md px-3 py-2 text-xs font-medium transition-all ${
          isActive
            ? 'bg-blue-600 dark:bg-slate-100/10 text-white dark:text-white shadow-sm border border-blue-700 dark:border-slate-700'
            : 'text-slate-800 dark:text-slate-300 hover:bg-sky-50 dark:hover:bg-slate-800/80 hover:text-slate-950 dark:hover:text-white'
        }`
      }
      end={to === '/'}
    >
      <span>{label}</span>
    </NavLink>
  )
}

function getUserInitials(user: User): string {
  const name = user.displayName?.trim()
  if (!name) return 'U'

  const parts = name.split(/\s+/).filter(Boolean)
  const initials = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '')
  return initials.join('') || 'U'
}

type UserAvatarProps = {
  user: User
}

function UserAvatar({ user }: UserAvatarProps) {
  const initials = getUserInitials(user)

  return (
    <div className="h-9 w-9 rounded-full overflow-hidden bg-slate-100 dark:bg-slate-800 shrink-0 flex items-center justify-center">
      {user.photoURL ? (
        <img
          src={user.photoURL}
          alt={user.displayName ? `${user.displayName} profile picture` : 'Google account profile picture'}
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
        />
      ) : (
        <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
          {initials}
        </span>
      )}
    </div>
  )
}

function MobileNavLink({ to, label }: SidebarLinkProps) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center justify-center rounded-lg px-1.5 py-2 font-medium transition-colors ${
          isActive
            ? 'bg-blue-600 text-white'
            : 'text-slate-300 bg-slate-900 hover:bg-slate-800'
        }`
      }
      end={to === '/'}
    >
      {label}
    </NavLink>
  )
}

type DashboardPageProps = {
  isSignedIn: boolean
  hasCalendarToken: boolean
  onConnectCalendar: () => void
  onCreateEvent: (input: NewCalendarEventInput) => Promise<void>
  calendarEvents: CalendarEvent[]
  calendarLoading: boolean
  calendarError: string | null
  todos: TodoItem[]
}

type CalendarDayCell = {
  date: Date
  inMonth: boolean
  key: string
}

type SpecialDayKind = 'new-year' | 'poya' | 'holiday'

type SpecialDay = {
  title: string
  kind: SpecialDayKind
}

const TASKLY_EVENT_MARKER = 'Created by Taskly'

const SPECIAL_DAYS_BY_DATE: Record<string, SpecialDay[]> = {
  '2026-01-01': [{ title: "New Year's Day", kind: 'new-year' }],
  '2026-01-03': [{ title: 'Duruthu Full Moon Poya Day', kind: 'poya' }],
  '2026-02-01': [{ title: 'Navam Full Moon Poya Day', kind: 'poya' }],
  '2026-03-03': [{ title: 'Medin Full Moon Poya Day', kind: 'poya' }],
  '2026-04-01': [{ title: 'Bak Full Moon Poya Day', kind: 'poya' }],
  '2026-04-03': [{ title: 'Good Friday', kind: 'holiday' }],
  '2026-04-05': [{ title: 'Easter Sunday', kind: 'holiday' }],
  '2026-04-13': [{ title: "Sinhala and Tamil New Year's Eve", kind: 'new-year' }],
  '2026-04-14': [{ title: "Sinhala and Tamil New Year's Day", kind: 'new-year' }],
  '2026-05-01': [
    { title: 'May Day', kind: 'holiday' },
    { title: 'Vesak Full Moon Poya Day', kind: 'poya' },
  ],
  '2026-05-31': [{ title: 'Poson Full Moon Poya Day', kind: 'poya' }],
  '2026-06-29': [{ title: 'Esala Full Moon Poya Day', kind: 'poya' }],
  '2026-07-29': [{ title: 'Nikini Full Moon Poya Day', kind: 'poya' }],
  '2026-08-27': [{ title: 'Binara Full Moon Poya Day', kind: 'poya' }],
  '2026-09-25': [{ title: 'Vap Full Moon Poya Day', kind: 'poya' }],
  '2026-10-24': [{ title: 'Il Full Moon Poya Day', kind: 'poya' }],
  '2026-11-23': [{ title: 'Unduvap Full Moon Poya Day', kind: 'poya' }],
  '2026-12-22': [{ title: 'December Full Moon Poya Day', kind: 'poya' }],
  '2026-12-25': [{ title: 'Christmas Day', kind: 'holiday' }],
}

function specialDayChipClass(kind: SpecialDayKind): string {
  if (kind === 'poya') return 'border-l-4 border-l-violet-400 bg-violet-500/10 text-violet-100'
  if (kind === 'new-year') return 'border-l-4 border-l-amber-400 bg-amber-500/10 text-amber-100'
  return 'border-l-4 border-l-rose-400 bg-rose-500/10 text-rose-100'
}

function specialDayBadgeClass(kind: SpecialDayKind): string {
  if (kind === 'poya') return 'bg-violet-500/20 text-violet-200 border border-violet-500/40'
  if (kind === 'new-year') return 'bg-amber-500/20 text-amber-200 border border-amber-400/40'
  return 'bg-rose-500/20 text-rose-200 border border-rose-500/40'
}

function isTasklyCreatedEvent(event: CalendarEvent): boolean {
  return typeof event.description === 'string' && event.description.includes(TASKLY_EVENT_MARKER)
}

function toLocalDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function hashString(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

function eventChipClass(ev: CalendarEvent): string {
  const palettes = [
    'border-l-4 border-l-emerald-400 bg-emerald-500/10 text-emerald-50 hover:bg-emerald-500/15',
    'border-l-4 border-l-sky-400 bg-sky-500/10 text-sky-50 hover:bg-sky-500/15',
    'border-l-4 border-l-teal-400 bg-teal-500/10 text-teal-50 hover:bg-teal-500/15',
    'border-l-4 border-l-cyan-400 bg-cyan-500/10 text-cyan-50 hover:bg-cyan-500/15',
  ]
  const key = ev.id || ev.summary || 'event'
  return palettes[hashString(key) % palettes.length]
}

// Sunday-first calendar grid trimmed to the current month end.
function buildMonthGrid(monthStart: Date): CalendarDayCell[] {
  const first = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1)
  const sundayFirstIndex = first.getDay()
  const gridStart = addDays(first, -sundayFirstIndex)
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1)

  const cells: CalendarDayCell[] = []
  for (let date = new Date(gridStart); date < monthEnd; date = addDays(date, 1)) {
    cells.push({
      date,
      inMonth: date.getMonth() === monthStart.getMonth(),
      key: toLocalDateKey(date),
    })
  }
  return cells
}

function formatEventLabel(ev: CalendarEvent): string {
  const title = ev.summary ?? '(No title)'
  if (ev.start?.date) return `All day · ${title}`
  const raw = ev.start?.dateTime
  if (!raw) return title

  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return title
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return `${time} · ${title}`
}

function groupEventsByDay(
  events: CalendarEvent[],
  monthStart: Date,
  monthEnd: Date
): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>()

  for (const ev of events) {
    const startRaw = ev.start?.dateTime ?? ev.start?.date
    if (!startRaw) continue

    const isAllDay = Boolean(ev.start?.date)

    const startDate = isAllDay
      ? new Date(`${ev.start?.date}T00:00:00`)
      : new Date(startRaw)

    const endRaw = ev.end?.dateTime ?? ev.end?.date
    const endDate = endRaw
      ? isAllDay
        ? new Date(`${ev.end?.date}T00:00:00`)
        : new Date(endRaw)
      : addDays(startDate, 1)

    if (Number.isNaN(startDate.getTime())) continue

    const startDay = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate())
    let endDay = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate())

    // Timed events on the same day still need 1 iteration.
    if (!isAllDay && isSameLocalDay(startDay, endDay)) {
      endDay = addDays(endDay, 1)
    }

    // For all-day events, Google provides end.date as exclusive. We keep that behavior.
    for (let d = new Date(startDay); d < endDay; d = addDays(d, 1)) {
      if (d < monthStart || d >= monthEnd) continue
      const key = toLocalDateKey(d)
      const list = map.get(key)
      if (list) list.push(ev)
      else map.set(key, [ev])
    }
  }

  // Sort events per day by start time (best-effort)
  for (const [key, list] of map.entries()) {
    list.sort((a, b) => {
      const ar = a.start?.dateTime ?? a.start?.date ?? ''
      const br = b.start?.dateTime ?? b.start?.date ?? ''
      return ar.localeCompare(br)
    })
    map.set(key, list)
  }

  return map
}

type DateDetailModalProps = {
  date: Date
  events: CalendarEvent[]
  specialDays: SpecialDay[]
  canCreateEvent: boolean
  onCreateEvent: (input: NewCalendarEventInput) => Promise<void>
  onClose: () => void
}

function DateDetailModal({ date, events, specialDays, canCreateEvent, onCreateEvent, onClose }: DateDetailModalProps) {
  const [title, setTitle] = useState('')
  const [allDay, setAllDay] = useState(true)
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('10:00')
  const [submitting, setSubmitting] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const dateStr = date.toLocaleString(undefined, { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  })

  const handleCreate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!canCreateEvent) return

    const summary = title.trim()
    if (!summary) {
      setCreateError('Event title is required.')
      return
    }

    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)
    const parseTime = (value: string) => {
      const [h, m] = value.split(':').map(Number)
      return new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m, 0, 0)
    }

    const start = allDay ? dayStart : parseTime(startTime)
    const end = allDay ? addDays(dayStart, 1) : parseTime(endTime)

    if (!allDay && end <= start) {
      setCreateError('End time must be after start time.')
      return
    }

    try {
      setSubmitting(true)
      setCreateError(null)
      await onCreateEvent({
        summary,
        allDay,
        start,
        end,
      })
      setTitle('')
      setStartTime('09:00')
      setEndTime('10:00')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not create event.'
      setCreateError(message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 dark:bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-sky-200 dark:border-slate-800 max-w-md w-full max-h-[80vh] overflow-y-auto">
        <div className="sticky top-0 bg-gradient-to-r from-sky-50 via-white to-cyan-50 dark:from-slate-900 dark:to-slate-800 border-b border-sky-200 dark:border-slate-800 px-6 py-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{dateStr}</h2>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
              {events.length} event{events.length !== 1 ? 's' : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-full w-8 h-8 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="p-6 space-y-4">
          {specialDays.length > 0 ? (
            <div className="rounded-xl border border-slate-700 p-3 bg-slate-900/50">
              <h3 className="text-xs font-semibold text-slate-200 mb-2">Special days</h3>
              <ul className="space-y-1.5">
                {specialDays.map((special, index) => (
                  <li key={`${special.title}-${index}`} className="text-[11px]">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-semibold ${specialDayBadgeClass(special.kind)}`}>
                      {special.title}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <form onSubmit={handleCreate} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-2 bg-slate-50/70 dark:bg-slate-900/40">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-200">Add event</h3>
              <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={allDay}
                  onChange={(e) => setAllDay(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                All day
              </label>
            </div>

            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Event title"
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2 text-xs text-slate-900 dark:text-slate-100"
              disabled={!canCreateEvent || submitting}
            />

            {!allDay ? (
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[11px] text-slate-700 dark:text-slate-300">
                  Start
                  <input
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs"
                    disabled={!canCreateEvent || submitting}
                  />
                </label>
                <label className="text-[11px] text-slate-700 dark:text-slate-300">
                  End
                  <input
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs"
                    disabled={!canCreateEvent || submitting}
                  />
                </label>
              </div>
            ) : null}

            {createError ? (
              <p className="text-[11px] text-rose-700 dark:text-rose-200">{createError}</p>
            ) : null}

            {!canCreateEvent ? (
              <p className="text-[11px] text-slate-600 dark:text-slate-400">
                Connect Google Calendar to create events.
              </p>
            ) : null}

            <button
              type="submit"
              disabled={!canCreateEvent || submitting}
              className="inline-flex items-center rounded-full bg-blue-600 text-white text-[11px] px-3 py-1.5 shadow-sm hover:bg-blue-700 disabled:opacity-60"
            >
              {submitting ? 'Saving...' : 'Add to Google Calendar'}
            </button>
          </form>

          {events.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-slate-500 dark:text-slate-400">No events on this day</p>
            </div>
          ) : (
            events.map((ev) => (
              <div
                key={ev.id}
                className={`rounded-xl border p-4 transition-colors ${eventChipClass(ev)}`}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <h3 className="font-semibold text-sm line-clamp-2">{ev.summary ?? '(No title)'}</h3>
                  {ev.htmlLink && (
                    <a
                      href={ev.htmlLink}
                      target="_blank"
                      rel="noreferrer"
                      className="flex-shrink-0 text-xs opacity-70 hover:opacity-100 transition-opacity underline"
                    >
                      View
                    </a>
                  )}
                </div>
                <p className="text-xs opacity-80">
                  {formatEventLabel(ev)}
                </p>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function DashboardPage({
  isSignedIn,
  hasCalendarToken,
  onConnectCalendar,
  onCreateEvent,
  calendarEvents,
  calendarLoading,
  calendarError,
  todos,
}: DashboardPageProps) {
  const [currentMonth, setCurrentMonth] = useState(new Date())
  const [selectedDate, setSelectedDate] = useState<Date | null>(null)
  const [showSpecialHolidays, setShowSpecialHolidays] = useState(true)
  const [showMyTasks, setShowMyTasks] = useState(true)

  const monthStart = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1)
  const monthEnd = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1)

  const cells = buildMonthGrid(monthStart)
  const eventsByDay = groupEventsByDay(calendarEvents, monthStart, monthEnd)
  const visibleEventsByDay = new Map<string, CalendarEvent[]>()

  for (const [key, list] of eventsByDay.entries()) {
    const filtered = list.filter((event) => showMyTasks || !isTasklyCreatedEvent(event))
    if (filtered.length > 0) visibleEventsByDay.set(key, filtered)
  }

  const handlePrevMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1))
  }

  const handleNextMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1))
  }

  const handleDateClick = (date: Date) => {
    setSelectedDate(date)
  }

  const handleCloseDateDetail = () => {
    setSelectedDate(null)
  }

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const upcomingEvents = calendarEvents
    .map((event) => {
      const raw = event.start?.dateTime ?? event.start?.date
      if (!raw) return null

      const start = event.start?.date
        ? new Date(`${event.start.date}T00:00:00`)
        : new Date(raw)

      if (Number.isNaN(start.getTime())) return null
      return { event, start }
    })
    .filter((item): item is { event: CalendarEvent; start: Date } => item !== null)
    .filter(({ start }) => start >= todayStart)
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, 8)

  const todayKey = toLocalDateKey(new Date())
  const openTodos = todos.filter((todo) => !todo.completed)
  const pinnedOrDailyTodos = openTodos
    .filter((todo) => todo.isPinned || todo.isDaily)
    .sort((a, b) => {
      const deadlineCmp = a.deadline.localeCompare(b.deadline)
      if (deadlineCmp !== 0) return deadlineCmp
      return a.createdAt.localeCompare(b.createdAt)
    })
    .slice(0, 8)
  const dueTodayCount = openTodos.filter((todo) => todo.deadline === todayKey).length
  const mobileMonthEvents = upcomingEvents
    .filter(({ start }) =>
      start.getFullYear() === currentMonth.getFullYear() &&
      start.getMonth() === currentMonth.getMonth()
    )
    .slice(0, 6)

  const projectDetails = [
    {
      name: 'Uni group software project',
      status: 'Active',
      progress: 65,
      note: 'Next checkpoint: UI review and testing.',
    },
    {
      name: 'Taskly dashboard',
      status: 'In progress',
      progress: 82,
      note: 'Calendar sync and layout cleanup.',
    },
    {
      name: 'Semester planning',
      status: 'Pending',
      progress: 28,
      note: 'Add study milestones and deadlines.',
    },
  ]

  const todayWeekIndex = new Date().getDay()
  const todayDayName = todayWeekIndex === 0 ? 'Sun' : DAYS_OF_WEEK[todayWeekIndex - 1]
  const todaysSchedule = (() => {
    try {
      const raw = localStorage.getItem(SCHEDULE_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<WeekSchedule>
        const fromStorage = parsed[todayDayName]
        if (Array.isArray(fromStorage)) {
          return [...fromStorage].sort((a, b) => a.startTime.localeCompare(b.startTime))
        }
      }
    } catch {
      // fall back to default schedule below
    }

    return [...(DEFAULT_WEEK_SCHEDULE[todayDayName] ?? [])].sort((a, b) =>
      a.startTime.localeCompare(b.startTime)
    )
  })()

  const filterSpecialDays = (days: SpecialDay[]): SpecialDay[] => {
    return showSpecialHolidays ? days : []
  }

  return (
    <div className="space-y-4">
      <div className="sm:hidden -mx-1 overflow-x-auto px-1">
        <div className="flex min-w-max gap-2">
          <MobileStatPill title="Today’s Tasks" value={String(dueTodayCount)} subtitle="Due today" />
          <MobileStatPill title="Projects" value="4" subtitle="2 active" />
          <MobileStatPill title="Quick Ideas" value="12" subtitle="Mind dump" />
          <MobileStatPill title="Open Todos" value={String(openTodos.length)} subtitle="Total pending" />
        </div>
      </div>

      <div className="hidden sm:grid gap-4 grid-cols-2 md:grid-cols-4">
        <DashboardStat title="Today’s Tasks" value={String(dueTodayCount)} subtitle="Due today" />
        <DashboardStat title="Projects" value="4" subtitle="2 active" />
        <DashboardStat title="Quick Ideas" value="12" subtitle="Mind dump" />
        <DashboardStat title="Open Todos" value={String(openTodos.length)} subtitle="Total pending" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)] 2xl:grid-cols-[820px_minmax(0,1fr)]">
        <div className="rounded-3xl border border-slate-300 p-3 lg:p-4 shadow-sm bg-slate-100/80 dark:bg-slate-900/60">
          <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3 mb-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 px-2.5 sm:px-3 py-2">
            <div className="flex items-center gap-1.5 sm:gap-2">
              <button
                onClick={() => setCurrentMonth(new Date())}
                className="inline-flex items-center rounded-full border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 sm:px-3 py-1 text-[11px] sm:text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                Today
              </button>
              <button
                onClick={handlePrevMonth}
                className="inline-flex items-center justify-center rounded-full border border-transparent hover:border-slate-300 dark:hover:border-slate-700 text-slate-700 dark:text-slate-300 h-7 w-7 sm:h-8 sm:w-8 text-base font-semibold transition-colors"
              >
                ‹
              </button>
              <button
                onClick={handleNextMonth}
                className="inline-flex items-center justify-center rounded-full border border-transparent hover:border-slate-300 dark:hover:border-slate-700 text-slate-700 dark:text-slate-300 h-7 w-7 sm:h-8 sm:w-8 text-base font-semibold transition-colors"
              >
                ›
              </button>
              <div className="text-base sm:text-lg font-medium text-slate-900 dark:text-slate-100 ml-0.5 sm:ml-1">
                {monthStart.toLocaleString(undefined, { month: 'long', year: 'numeric' })}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
              {hasCalendarToken && !calendarLoading && !calendarError ? (
                <div className="text-[11px] sm:text-xs text-slate-600 dark:text-slate-400 mr-0 sm:mr-1">
                  {calendarEvents.length} events
                </div>
              ) : null}
              <span className="hidden sm:inline text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400 mr-1">
                Map filters
              </span>
              <button
                onClick={() => setShowSpecialHolidays((value) => !value)}
                className={`inline-flex items-center rounded-full px-2.5 sm:px-3 py-1 text-[10px] sm:text-[11px] font-medium border transition-colors ${
                  showSpecialHolidays
                    ? 'bg-violet-500/20 text-violet-200 border-violet-500/40'
                    : 'bg-slate-900 text-slate-400 border-slate-700 hover:bg-slate-800'
                }`}
              >
                Special days
              </button>
              <button
                onClick={() => setShowMyTasks((value) => !value)}
                className={`inline-flex items-center rounded-full px-2.5 sm:px-3 py-1 text-[10px] sm:text-[11px] font-medium border transition-colors ${
                  showMyTasks
                    ? 'bg-blue-500/20 text-blue-200 border-blue-500/40'
                    : 'bg-slate-900 text-slate-400 border-slate-700 hover:bg-slate-800'
                }`}
              >
                My tasks
              </button>
            </div>
          </div>

          {!isSignedIn ? (
            <div className="mt-3 rounded-xl border border-slate-300 dark:border-slate-800 bg-white dark:bg-slate-950/30 p-3">
              <p className="text-[11px] text-slate-800 dark:text-slate-400">
                Sign in with Google to load your Calendar events.
              </p>
            </div>
          ) : !hasCalendarToken ? (
            <div className="mt-3 rounded-xl border border-slate-300 dark:border-slate-800 bg-white dark:bg-slate-950/30 p-3 flex items-center justify-between gap-2">
              <p className="text-[11px] text-slate-800 dark:text-slate-400">
                Connect Google Calendar to show events.
              </p>
              <button
                onClick={onConnectCalendar}
                className="inline-flex items-center rounded-full bg-primary-500 text-white text-[11px] px-3 py-1.5 shadow-md hover:bg-primary-600"
              >
                Connect
              </button>
            </div>
          ) : calendarLoading ? (
            <div className="mt-3 rounded-xl border border-slate-300 dark:border-slate-800 bg-white dark:bg-slate-950/30 p-3">
              <p className="text-[11px] text-slate-800 dark:text-slate-400">Loading events…</p>
            </div>
          ) : calendarError ? (
            <div className="mt-3 rounded-xl border border-rose-200/70 dark:border-rose-700/50 bg-rose-50/60 dark:bg-rose-950/30 p-3">
              <p className="text-[11px] text-rose-700 dark:text-rose-200">{calendarError}</p>
            </div>
          ) : (
            <>
              <div className="mt-2 sm:hidden rounded-2xl border border-slate-300 dark:border-[#1e293b] bg-white dark:bg-slate-900/50 p-2.5">
                <div className="grid grid-cols-7 text-[9px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">
                  {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => (
                    <div key={d} className="text-center py-1">{d}</div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {cells.map((cell) => {
                    const dayKey = toLocalDateKey(cell.date)
                    const dayEvents = visibleEventsByDay.get(dayKey) ?? []
                    const specialDays = filterSpecialDays(SPECIAL_DAYS_BY_DATE[dayKey] ?? [])
                    const isToday = isSameLocalDay(cell.date, new Date())
                    const hasMarker = dayEvents.length > 0 || specialDays.length > 0

                    return (
                      <button
                        key={`mobile-${cell.key}`}
                        onClick={() => handleDateClick(cell.date)}
                        className={`relative h-10 rounded-md border text-[10px] transition-colors ${
                          cell.inMonth
                            ? 'border-slate-300 dark:border-[#1e293b] bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200'
                            : 'border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-slate-900/70 text-slate-400 dark:text-slate-500'
                        }`}
                      >
                        <span
                          className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 ${
                            isToday ? 'bg-blue-600 text-white font-semibold' : ''
                          }`}
                        >
                          {cell.date.getDate()}
                        </span>
                        {hasMarker ? (
                          <span className="absolute bottom-1 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-emerald-400" />
                        ) : null}
                      </button>
                    )
                  })}
                </div>

                <div className="mt-2 border-t border-slate-200 dark:border-slate-800 pt-2">
                  <p className="text-[10px] font-semibold text-slate-600 dark:text-slate-400 mb-1">Upcoming</p>
                  {mobileMonthEvents.length === 0 ? (
                    <p className="text-[10px] text-slate-600 dark:text-slate-400">No upcoming events this month.</p>
                  ) : (
                    <ul className="space-y-1 max-h-[88px] overflow-y-auto pr-1">
                      {mobileMonthEvents.slice(0, 3).map(({ event, start }) => (
                        <li key={`mobile-list-${event.id}`} className="text-[10px] text-slate-700 dark:text-slate-300 truncate">
                          {start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {event.summary ?? '(No title)'}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div className="hidden sm:block mt-2 overflow-x-auto -mx-1 px-1 sm:mx-0 sm:px-0">
              <div className="min-w-[640px] sm:min-w-[720px]">
                <div className="grid grid-cols-7 text-[10px] text-slate-500 dark:text-slate-400 font-semibold tracking-wide uppercase">
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                  <div
                    key={d}
                    className="px-2 py-2 text-center"
                  >
                    {d}
                  </div>
                ))}
                </div>

                <div className="grid grid-cols-7 border-t border-l border-slate-300 dark:border-[#1e293b] rounded-b-2xl overflow-hidden bg-white dark:bg-slate-900">
                  {cells.map((cell) => {
                    const dayKey = toLocalDateKey(cell.date)
                    const dayEvents = visibleEventsByDay.get(dayKey) ?? []
                    const specialDays = filterSpecialDays(SPECIAL_DAYS_BY_DATE[dayKey] ?? [])
                    const isToday = isSameLocalDay(cell.date, new Date())
                    const specialDaySlots = Math.min(2, specialDays.length)
                    const eventSlots = Math.max(0, 4 - specialDaySlots)

                    return (
                      <button
                        key={cell.key}
                        onClick={() => handleDateClick(cell.date)}
                        className={`h-[96px] sm:h-[118px] border-r border-b border-slate-300 dark:border-[#1e293b] p-1.5 sm:p-2 overflow-hidden text-left transition-colors cursor-pointer ${
                          cell.inMonth
                            ? 'bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800/70'
                            : 'bg-slate-50 dark:bg-slate-900/80 text-slate-500 dark:text-slate-500'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span
                            className={`text-[11px] ${
                              isToday
                                ? 'inline-flex items-center justify-center h-5 min-w-5 px-1 rounded-full bg-blue-600 text-white font-semibold'
                                : cell.inMonth
                                  ? 'text-slate-700 dark:text-slate-300 font-medium'
                                  : 'text-slate-400 dark:text-slate-500'
                            }`}
                          >
                            {cell.date.getDate()}
                          </span>
                        </div>

                        <div className="space-y-1 max-h-[62px] sm:max-h-[84px] overflow-auto pr-0.5">
                          {specialDays.slice(0, 2).map((special, index) => (
                            <span
                              key={`${special.title}-${index}`}
                              title={special.title}
                              className={`block truncate rounded-md px-2 py-0.5 text-[10px] leading-5 font-semibold ${specialDayChipClass(special.kind)}`}
                            >
                              {special.title}
                            </span>
                          ))}
                          {dayEvents.slice(0, eventSlots).map((ev) => (
                            <a
                              key={ev.id}
                              href={ev.htmlLink}
                              target="_blank"
                              rel="noreferrer"
                              title={ev.summary ?? '(No title)'}
                              className={`block truncate rounded-md px-2 py-0.5 text-[10px] leading-5 font-semibold transition-opacity hover:opacity-90 ${eventChipClass(ev)}`}
                            >
                              {ev.summary ?? '(No title)'}
                            </a>
                          ))}
                          {dayEvents.length > eventSlots && (
                            <span className="block text-[10px] text-slate-600 dark:text-slate-400 px-1">
                              +{dayEvents.length - eventSlots} more
                            </span>
                          )}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
              </div>
            </>
          )}

          {selectedDate && (
            <DateDetailModal
              date={selectedDate}
              events={(eventsByDay.get(toLocalDateKey(selectedDate)) ?? []).filter((event) => showMyTasks || !isTasklyCreatedEvent(event))}
              specialDays={filterSpecialDays(SPECIAL_DAYS_BY_DATE[toLocalDateKey(selectedDate)] ?? [])}
              canCreateEvent={isSignedIn && hasCalendarToken}
              onCreateEvent={onCreateEvent}
              onClose={handleCloseDateDetail}
            />
          )}
        </div>

        <aside className="grid gap-4 sm:grid-cols-2 auto-rows-[minmax(220px,auto)] sm:auto-rows-[320px]">
          <section className="h-auto sm:h-[320px] min-h-[220px] rounded-3xl border border-slate-300 bg-white dark:bg-slate-900/80 p-3 sm:p-4 shadow-sm flex flex-col">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">Pinned & Daily Todos</h3>
            <p className="text-[11px] text-slate-600 dark:text-slate-400 mb-3">
              Highlighted tasks from your todo list.
            </p>

            <div className="flex-1 overflow-y-auto pr-1">
              {pinnedOrDailyTodos.length === 0 ? (
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  No pinned or daily todos yet. Add them from the To-Do page.
                </p>
              ) : (
                <ul className="space-y-2">
                  {pinnedOrDailyTodos.map((todo) => (
                    <li key={todo.id} className="rounded-xl border border-slate-200 dark:border-slate-800 p-2.5 bg-slate-50/70 dark:bg-slate-900/40">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-[11px] font-semibold text-slate-900 dark:text-slate-100 line-clamp-2">
                          {formatDisplayTitle(todo.title)}
                        </p>
                        <div className="flex items-center gap-1 shrink-0">
                          {todo.isDaily ? (
                            <span className="inline-flex rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">
                              Daily
                            </span>
                          ) : null}
                          {todo.isPinned ? (
                            <span className="inline-flex rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-300">
                              Pinned
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <p className="text-[10px] text-slate-500 dark:text-slate-500 mt-1">
                        Deadline: {new Date(`${todo.deadline}T00:00:00`).toLocaleDateString()}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="h-auto sm:h-[320px] min-h-[220px] rounded-3xl border border-slate-300 bg-white dark:bg-slate-900/80 p-3 sm:p-4 shadow-sm flex flex-col">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">Upcoming Events</h3>
            <p className="text-[11px] text-slate-600 dark:text-slate-400 mb-3">
              Your next events from Google Calendar.
            </p>

            <div className="flex-1 overflow-y-auto pr-1">
              {!isSignedIn ? (
                <p className="text-xs text-slate-600 dark:text-slate-400">Sign in to see upcoming events.</p>
              ) : !hasCalendarToken ? (
                <p className="text-xs text-slate-600 dark:text-slate-400">Connect Calendar to see upcoming events.</p>
              ) : calendarLoading ? (
                <p className="text-xs text-slate-600 dark:text-slate-400">Loading upcoming events…</p>
              ) : calendarError ? (
                <p className="text-xs text-rose-700 dark:text-rose-200">{calendarError}</p>
              ) : upcomingEvents.length === 0 ? (
                <p className="text-xs text-slate-600 dark:text-slate-400">No upcoming events for now.</p>
              ) : (
                <ul className="space-y-2">
                  {upcomingEvents.map(({ event, start }) => (
                    <li key={event.id} className="rounded-xl border border-slate-200 dark:border-slate-800 p-2.5 bg-slate-50/70 dark:bg-slate-900/40">
                      <p className="text-[11px] font-semibold text-slate-900 dark:text-slate-100 truncate">
                        {event.summary ?? '(No title)'}
                      </p>
                      <p className="text-[10px] text-slate-600 dark:text-slate-400 mt-0.5">
                        {start.toLocaleString(undefined, {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="h-auto sm:h-[320px] min-h-[220px] rounded-3xl border border-slate-300 bg-white dark:bg-slate-900/80 p-3 sm:p-4 shadow-sm flex flex-col">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">Today&apos;s Schedule</h3>
            <p className="text-[11px] text-slate-600 dark:text-slate-400 mb-3">
              Planned timeline for {todayDayName}.
            </p>

            <div className="flex-1 overflow-y-auto pr-1">
              {todaysSchedule.length === 0 ? (
                <p className="text-xs text-slate-600 dark:text-slate-400">No schedule entries for today.</p>
              ) : (
                <ul className="space-y-2">
                  {todaysSchedule.map((entry) => (
                    <li key={entry.id} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 bg-slate-50/70 dark:bg-slate-900/40">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-[11px] font-semibold text-slate-900 dark:text-slate-100 line-clamp-2">
                          {entry.activity}
                        </p>
                        <span className="inline-flex rounded-full border border-slate-300 dark:border-slate-700 px-2 py-0.5 text-[10px] text-slate-700 dark:text-slate-300 bg-white/70 dark:bg-slate-900/60 uppercase">
                          {entry.category}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-600 dark:text-slate-400 mt-1">
                        {entry.startTime} - {entry.endTime}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="h-auto sm:h-[320px] min-h-[220px] rounded-3xl border border-slate-300 bg-white dark:bg-slate-900/80 p-3 sm:p-4 shadow-sm flex flex-col">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">Project Details</h3>
            <p className="text-[11px] text-slate-600 dark:text-slate-400 mb-3">
              Active work and planning items.
            </p>

            <div className="flex-1 overflow-y-auto pr-1">
              <ul className="space-y-2">
                {projectDetails.map((project) => (
                  <li key={project.name} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 bg-slate-50/70 dark:bg-slate-900/40">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold text-slate-900 dark:text-slate-100 truncate">
                          {project.name}
                        </p>
                        <p className="text-[10px] text-slate-600 dark:text-slate-400 mt-0.5">
                          {project.note}
                        </p>
                      </div>
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] shrink-0 ${projectStatusClass(project.status)}`}>
                        {project.status}
                      </span>
                    </div>

                    <div className="mt-2 flex items-center gap-2">
                      <div className="h-2 flex-1 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                        <div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-400" style={{ width: `${project.progress}%` }} />
                      </div>
                      <span className="text-[10px] text-slate-500 dark:text-slate-500 w-8 text-right">
                        {project.progress}%
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}

type DashboardStatProps = {
  title: string
  value: string
  subtitle: string
}

function MobileStatPill({ title, value, subtitle }: DashboardStatProps) {
  return (
    <div className="min-w-[130px] rounded-2xl bg-white/95 dark:bg-slate-900/85 border border-slate-300 dark:border-slate-800 px-3 py-2.5 shadow-sm">
      <p className="text-[10px] uppercase tracking-wide text-slate-700 dark:text-slate-500 mb-1">
        {title}
      </p>
      <p className="text-lg font-semibold text-slate-950 dark:text-slate-50 leading-none">{value}</p>
      <p className="text-[10px] text-slate-700 dark:text-slate-400 mt-1">{subtitle}</p>
    </div>
  )
}

function DashboardStat({ title, value, subtitle }: DashboardStatProps) {
  return (
    <div className="rounded-2xl bg-white dark:bg-slate-900/80 border border-slate-300 dark:border-slate-800 p-3 shadow-sm flex flex-col justify-between">
      <p className="text-[11px] uppercase tracking-wide text-slate-700 dark:text-slate-500 mb-1">
        {title}
      </p>
      <p className="text-xl font-semibold text-slate-950 dark:text-slate-50">{value}</p>
      <p className="text-[11px] text-slate-800 dark:text-slate-400">{subtitle}</p>
    </div>
  )
}

// ─── Schedule Types ───────────────────────────────────────────────────────────
type ScheduleEntry = {
  id: string
  startTime: string
  endTime: string
  activity: string
  category: 'morning' | 'university' | 'evening' | 'night' | 'other'
  priority?: 'high' | 'medium' | 'low'
  mode?: 'fixed' | 'flex'
  durationMinutes?: number
  completed?: boolean
}

type WeekSchedule = Record<string, ScheduleEntry[]>

const SCHEDULE_STORAGE_KEY = 'taskly-week-schedule'
const DAYS_OF_WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const DEFAULT_WEEK_SCHEDULE: WeekSchedule = {
  Mon: [
    { id: 'mon-1', startTime: '06:00', endTime: '06:30', activity: 'Wake up & freshen', category: 'morning' },
    { id: 'mon-2', startTime: '06:30', endTime: '07:00', activity: 'Breakfast', category: 'morning' },
    { id: 'mon-3', startTime: '07:00', endTime: '07:30', activity: 'Review notes / plan day', category: 'morning' },
    { id: 'mon-4', startTime: '07:30', endTime: '08:00', activity: 'Travel to university', category: 'morning' },
    { id: 'mon-5', startTime: '08:00', endTime: '17:00', activity: 'Lectures (with breaks)', category: 'university' },
    { id: 'mon-6', startTime: '17:00', endTime: '18:00', activity: 'Travel back + rest', category: 'evening' },
    { id: 'mon-7', startTime: '18:00', endTime: '19:00', activity: 'Relax / shower / snack', category: 'evening' },
    { id: 'mon-8', startTime: '19:00', endTime: '21:00', activity: 'Focused study', category: 'evening' },
    { id: 'mon-9', startTime: '21:00', endTime: '21:30', activity: 'Dinner', category: 'evening' },
    { id: 'mon-10', startTime: '21:30', endTime: '22:30', activity: 'Light activities', category: 'evening' },
    { id: 'mon-11', startTime: '22:30', endTime: '06:00', activity: 'Sleep', category: 'night' },
  ],
  Tue: [
    { id: 'tue-1', startTime: '06:00', endTime: '06:30', activity: 'Wake up & freshen', category: 'morning' },
    { id: 'tue-2', startTime: '06:30', endTime: '07:00', activity: 'Breakfast', category: 'morning' },
    { id: 'tue-3', startTime: '07:30', endTime: '08:00', activity: 'Travel to university', category: 'morning' },
    { id: 'tue-4', startTime: '08:00', endTime: '17:00', activity: 'Lectures (with breaks)', category: 'university' },
    { id: 'tue-5', startTime: '17:00', endTime: '18:00', activity: 'Travel back + rest', category: 'evening' },
    { id: 'tue-6', startTime: '18:00', endTime: '19:00', activity: 'Gym / exercise', category: 'evening' },
    { id: 'tue-7', startTime: '19:00', endTime: '21:00', activity: 'Focused study', category: 'evening' },
    { id: 'tue-8', startTime: '21:00', endTime: '22:30', activity: 'Dinner + relax', category: 'evening' },
    { id: 'tue-9', startTime: '22:30', endTime: '06:00', activity: 'Sleep', category: 'night' },
  ],
  Wed: [
    { id: 'wed-1', startTime: '06:00', endTime: '07:00', activity: 'Morning routine', category: 'morning' },
    { id: 'wed-2', startTime: '07:30', endTime: '08:00', activity: 'Travel to university', category: 'morning' },
    { id: 'wed-3', startTime: '08:00', endTime: '17:00', activity: 'Lectures (with breaks)', category: 'university' },
    { id: 'wed-4', startTime: '17:00', endTime: '18:00', activity: 'Travel back + rest', category: 'evening' },
    { id: 'wed-5', startTime: '18:00', endTime: '20:00', activity: 'Group project work', category: 'evening' },
    { id: 'wed-6', startTime: '20:00', endTime: '21:30', activity: 'Personal study', category: 'evening' },
    { id: 'wed-7', startTime: '22:00', endTime: '06:00', activity: 'Sleep', category: 'night' },
  ],
  Thu: [
    { id: 'thu-1', startTime: '06:00', endTime: '07:00', activity: 'Morning routine', category: 'morning' },
    { id: 'thu-2', startTime: '07:30', endTime: '08:00', activity: 'Travel to university', category: 'morning' },
    { id: 'thu-3', startTime: '08:00', endTime: '17:00', activity: 'Lectures (with breaks)', category: 'university' },
    { id: 'thu-4', startTime: '17:00', endTime: '18:00', activity: 'Travel back + rest', category: 'evening' },
    { id: 'thu-5', startTime: '18:00', endTime: '20:00', activity: 'Focused study', category: 'evening' },
    { id: 'thu-6', startTime: '20:00', endTime: '22:00', activity: 'Dinner + leisure', category: 'evening' },
    { id: 'thu-7', startTime: '22:00', endTime: '06:00', activity: 'Sleep', category: 'night' },
  ],
  Fri: [
    { id: 'fri-1', startTime: '06:00', endTime: '07:00', activity: 'Morning routine', category: 'morning' },
    { id: 'fri-2', startTime: '07:30', endTime: '08:00', activity: 'Travel to university', category: 'morning' },
    { id: 'fri-3', startTime: '08:00', endTime: '14:00', activity: 'Lectures (with breaks)', category: 'university' },
    { id: 'fri-4', startTime: '14:00', endTime: '15:00', activity: 'Travel back', category: 'evening' },
    { id: 'fri-5', startTime: '15:00', endTime: '17:00', activity: 'Relax / free time', category: 'evening' },
    { id: 'fri-6', startTime: '17:00', endTime: '19:00', activity: 'Social / errands', category: 'evening' },
    { id: 'fri-7', startTime: '19:00', endTime: '22:00', activity: 'Family time / movies', category: 'evening' },
    { id: 'fri-8', startTime: '22:30', endTime: '06:00', activity: 'Sleep', category: 'night' },
  ],
  Sat: [
    { id: 'sat-1', startTime: '07:00', endTime: '08:00', activity: 'Wake up & breakfast', category: 'morning' },
    { id: 'sat-2', startTime: '08:00', endTime: '10:00', activity: 'Exercise / sports', category: 'morning' },
    { id: 'sat-3', startTime: '10:00', endTime: '13:00', activity: 'Study / projects', category: 'university' },
    { id: 'sat-4', startTime: '13:00', endTime: '14:00', activity: 'Lunch + rest', category: 'evening' },
    { id: 'sat-5', startTime: '14:00', endTime: '17:00', activity: 'Personal projects', category: 'evening' },
    { id: 'sat-6', startTime: '17:00', endTime: '20:00', activity: 'Social time / outing', category: 'evening' },
    { id: 'sat-7', startTime: '20:00', endTime: '23:00', activity: 'Leisure / entertainment', category: 'evening' },
    { id: 'sat-8', startTime: '23:00', endTime: '07:00', activity: 'Sleep', category: 'night' },
  ],
  Sun: [
    { id: 'sun-1', startTime: '07:30', endTime: '09:00', activity: 'Slow morning', category: 'morning' },
    { id: 'sun-2', startTime: '09:00', endTime: '11:00', activity: 'Weekly review & planning', category: 'morning' },
    { id: 'sun-3', startTime: '11:00', endTime: '13:00', activity: 'Chores / errands', category: 'evening' },
    { id: 'sun-4', startTime: '13:00', endTime: '14:00', activity: 'Lunch', category: 'evening' },
    { id: 'sun-5', startTime: '14:00', endTime: '17:00', activity: 'Rest / leisure', category: 'evening' },
    { id: 'sun-6', startTime: '17:00', endTime: '20:00', activity: 'Study catch-up', category: 'evening' },
    { id: 'sun-7', startTime: '20:00', endTime: '22:00', activity: 'Prepare for week', category: 'evening' },
    { id: 'sun-8', startTime: '22:30', endTime: '07:30', activity: 'Sleep', category: 'night' },
  ],
}

function getCategoryStyle(category: ScheduleEntry['category']): { dot: string; badge: string; text: string } {
  switch (category) {
    case 'morning':
      return { dot: 'bg-amber-400', badge: 'bg-amber-500/15 border-amber-500/30 text-amber-300', text: 'text-amber-400' }
    case 'university':
      return { dot: 'bg-blue-500', badge: 'bg-blue-500/15 border-blue-500/30 text-blue-300', text: 'text-blue-400' }
    case 'evening':
      return { dot: 'bg-emerald-500', badge: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300', text: 'text-emerald-400' }
    case 'night':
      return { dot: 'bg-indigo-400', badge: 'bg-indigo-400/15 border-indigo-400/30 text-indigo-300', text: 'text-indigo-300' }
    default:
      return { dot: 'bg-slate-400', badge: 'bg-slate-400/15 border-slate-400/30 text-slate-400', text: 'text-slate-400' }
  }
}

function normalizePriority(entry: ScheduleEntry): 'high' | 'medium' | 'low' {
  return entry.priority ?? 'medium'
}

function normalizeMode(entry: ScheduleEntry): 'fixed' | 'flex' {
  if (entry.mode) return entry.mode
  return entry.category === 'university' ? 'fixed' : 'flex'
}

function normalizeCompleted(entry: ScheduleEntry): boolean {
  return Boolean(entry.completed)
}

function priorityBadgeStyle(priority: 'high' | 'medium' | 'low'): string {
  if (priority === 'high') return 'bg-rose-500/15 border-rose-500/30 text-rose-300'
  if (priority === 'low') return 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
  return 'bg-amber-500/15 border-amber-500/30 text-amber-300'
}

type EntryModalProps = {
  day: string
  entry?: ScheduleEntry
  onSave: (entry: Omit<ScheduleEntry, 'id'>) => void
  onClose: () => void
}

function EntryModal({ day, entry, onSave, onClose }: EntryModalProps) {
  const [startTime, setStartTime] = useState(entry?.startTime ?? '08:00')
  const [endTime, setEndTime] = useState(entry?.endTime ?? '09:00')
  const [activity, setActivity] = useState(entry?.activity ?? '')
  const [category, setCategory] = useState<ScheduleEntry['category']>(entry?.category ?? 'other')
  const [priority, setPriority] = useState<'high' | 'medium' | 'low'>(entry?.priority ?? 'medium')
  const [mode, setMode] = useState<'fixed' | 'flex'>(entry?.mode ?? (entry?.category === 'university' ? 'fixed' : 'flex'))
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!activity.trim()) { setError('Activity description is required.'); return }
    onSave({ startTime, endTime, activity: activity.trim(), category, priority, mode })
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-100">
            {entry ? 'Edit entry' : 'Add entry'} — <span className="text-blue-400">{day}</span>
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100 transition-colors text-lg leading-none">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Start</span>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/40"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">End</span>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/40"
              />
            </label>
          </div>

          <label className="block space-y-1">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Activity</span>
            <input
              type="text"
              value={activity}
              onChange={(e) => { setActivity(e.target.value); setError(null) }}
              placeholder="What are you doing?"
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 placeholder-slate-500 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/40"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Category</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as ScheduleEntry['category'])}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/40"
            >
              <option value="morning">🌅 Morning</option>
              <option value="university">🎓 University</option>
              <option value="evening">🌆 Evening</option>
              <option value="night">🌙 Night</option>
              <option value="other">⚡ Other</option>
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Type</span>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as 'fixed' | 'flex')}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/40"
              >
                <option value="fixed">Fixed event</option>
                <option value="flex">Flexible task</option>
              </select>
            </label>

            <label className="block space-y-1">
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Priority</span>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as 'high' | 'medium' | 'low')}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/40"
              >
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
          </div>

          {error && <p className="text-[11px] text-rose-400">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-700 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 rounded-lg bg-blue-600 px-3 py-2 text-xs text-white font-semibold hover:bg-blue-500 transition-colors"
            >
              {entry ? 'Save changes' : 'Add entry'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function SchedulePage() {
  const todayIndex = new Date().getDay() // 0=Sun,1=Mon,...
  const todayDayName = todayIndex === 0 ? 'Sun' : DAYS_OF_WEEK[todayIndex - 1]

  const [schedule, setSchedule] = useState<WeekSchedule>(() => {
    try {
      const saved = localStorage.getItem(SCHEDULE_STORAGE_KEY)
      if (saved) return JSON.parse(saved) as WeekSchedule
    } catch { /* ignore */ }
    return DEFAULT_WEEK_SCHEDULE
  })
  const [modalState, setModalState] = useState<{ open: boolean; entry?: ScheduleEntry; day: string }>({
    open: false,
    day: todayDayName,
  })
  const [viewMode, setViewMode] = useState<'daily' | 'weekly'>('daily')
  const [focusDay, setFocusDay] = useState(todayDayName)

  const saveSchedule = (updated: WeekSchedule) => {
    setSchedule(updated)
    localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(updated))
  }

  const handleAddEntry = (day: string) => {
    setModalState({ open: true, day, entry: undefined })
  }

  const handleEditEntry = (day: string, entry: ScheduleEntry) => {
    setModalState({ open: true, day, entry })
  }

  const handleDeleteEntry = (day: string, id: string) => {
    const updated = {
      ...schedule,
      [day]: (schedule[day] ?? []).filter((e) => e.id !== id),
    }
    saveSchedule(updated)
  }

  const handleToggleCompleted = (day: string, id: string) => {
    const updated = {
      ...schedule,
      [day]: (schedule[day] ?? []).map((entry) =>
        entry.id === id ? { ...entry, completed: !normalizeCompleted(entry) } : entry
      ),
    }
    saveSchedule(updated)
  }

  const handleSaveEntry = (data: Omit<ScheduleEntry, 'id'>) => {
    const day = modalState.day
    const existing = modalState.entry
    const dayEntries = schedule[day] ?? []
    let updatedEntries: ScheduleEntry[]
    if (existing) {
      updatedEntries = dayEntries.map((e) => e.id === existing.id ? { ...e, ...data } : e)
    } else {
      const newEntry: ScheduleEntry = {
        id: `${day.toLowerCase()}-${Date.now()}`,
        ...data,
      }
      updatedEntries = [...dayEntries, newEntry]
    }
    // Sort by start time
    updatedEntries.sort((a, b) => a.startTime.localeCompare(b.startTime))
    saveSchedule({ ...schedule, [day]: updatedEntries })
  }

  const handleResetAll = () => {
    saveSchedule(DEFAULT_WEEK_SCHEDULE)
  }

  const buildTemplate = (template: 'heavy' | 'free' | 'exam', day: string): ScheduleEntry[] => {
    if (template === 'heavy') {
      return [
        { id: `${day}-tpl-1-${Date.now()}`, startTime: '08:00', endTime: '16:00', activity: 'Lectures and labs', category: 'university', mode: 'fixed', priority: 'high' },
        { id: `${day}-tpl-2-${Date.now()}`, startTime: '17:00', endTime: '18:00', activity: 'Review lecture notes', category: 'evening', mode: 'flex', priority: 'high' },
        { id: `${day}-tpl-3-${Date.now()}`, startTime: '19:00', endTime: '20:30', activity: 'Assignment progress', category: 'evening', mode: 'flex', priority: 'medium' },
      ]
    }
    if (template === 'exam') {
      return [
        { id: `${day}-tpl-1-${Date.now()}`, startTime: '07:00', endTime: '09:00', activity: 'High-focus revision block', category: 'morning', mode: 'flex', priority: 'high' },
        { id: `${day}-tpl-2-${Date.now()}`, startTime: '10:00', endTime: '12:00', activity: 'Past paper practice', category: 'university', mode: 'flex', priority: 'high' },
        { id: `${day}-tpl-3-${Date.now()}`, startTime: '16:00', endTime: '17:30', activity: 'Weak areas recap', category: 'evening', mode: 'flex', priority: 'medium' },
      ]
    }
    return [
      { id: `${day}-tpl-1-${Date.now()}`, startTime: '08:00', endTime: '09:00', activity: 'Light planning and admin', category: 'morning', mode: 'flex', priority: 'low' },
      { id: `${day}-tpl-2-${Date.now()}`, startTime: '10:00', endTime: '12:00', activity: 'Deep work session', category: 'university', mode: 'flex', priority: 'medium' },
      { id: `${day}-tpl-3-${Date.now()}`, startTime: '15:00', endTime: '16:30', activity: 'Project progress sprint', category: 'evening', mode: 'flex', priority: 'medium' },
    ]
  }

  const applyTemplateToFocusDay = (template: 'heavy' | 'free' | 'exam') => {
    const entries = buildTemplate(template, focusDay)
    entries.sort((a, b) => a.startTime.localeCompare(b.startTime))
    saveSchedule({
      ...schedule,
      [focusDay]: entries,
    })
  }

  const getNextDay = (day: string): string => {
    const idx = DAYS_OF_WEEK.indexOf(day)
    if (idx < 0) return DAYS_OF_WEEK[0]
    return DAYS_OF_WEEK[(idx + 1) % DAYS_OF_WEEK.length]
  }

  const handleSmartReschedule = () => {
    const dayEntries = schedule[focusDay] ?? []
    const carryOver = dayEntries.filter(
      (entry) => normalizeMode(entry) === 'flex' && !normalizeCompleted(entry)
    )
    if (carryOver.length === 0) return

    const nextDay = getNextDay(focusDay)
    const nextDayEntries = schedule[nextDay] ?? []

    const moved = carryOver.map((entry, index) => {
      const startHour = 18 + index
      const endHour = Math.min(startHour + 1, 23)
      const startTime = `${String(startHour).padStart(2, '0')}:00`
      const endTime = `${String(endHour).padStart(2, '0')}:00`

      return {
        ...entry,
        id: `${nextDay.toLowerCase()}-rescheduled-${Date.now()}-${index}`,
        startTime,
        endTime,
        completed: false,
      }
    })

    const updatedCurrent = dayEntries.map((entry) =>
      carryOver.some((c) => c.id === entry.id)
        ? { ...entry, completed: true }
        : entry
    )

    const updatedNext = [...nextDayEntries, ...moved].sort((a, b) =>
      a.startTime.localeCompare(b.startTime)
    )

    saveSchedule({
      ...schedule,
      [focusDay]: updatedCurrent,
      [nextDay]: updatedNext,
    })
  }

  // Collect all unique start times across all days, sorted
  const allTimeSlots = Array.from(
    new Set(
      DAYS_OF_WEEK.flatMap((day) =>
        (schedule[day] ?? []).map((e) => e.startTime)
      )
    )
  ).sort()

  const focusEntries = [...(schedule[focusDay] ?? [])].sort((a, b) =>
    a.startTime.localeCompare(b.startTime)
  )
  const completedToday = focusEntries.filter((entry) => normalizeCompleted(entry)).length
  const totalToday = focusEntries.length
  const completionPct = totalToday === 0 ? 0 : Math.round((completedToday / totalToday) * 100)
  const topPriorities = focusEntries
    .filter((entry) => !normalizeCompleted(entry))
    .sort((a, b) => {
      const rank = { high: 0, medium: 1, low: 2 }
      const pa = rank[normalizePriority(a)]
      const pb = rank[normalizePriority(b)]
      if (pa !== pb) return pa - pb
      return a.startTime.localeCompare(b.startTime)
    })
    .slice(0, 3)
  const fixedCount = focusEntries.filter((entry) => normalizeMode(entry) === 'fixed').length
  const flexCount = focusEntries.filter((entry) => normalizeMode(entry) === 'flex').length

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-100 tracking-tight">Smart Daily Scheduler</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Hybrid planning: fixed events + flexible tasks with daily focus.
          </p>
        </div>
        <div className="flex w-full sm:w-auto flex-wrap items-center gap-2">
          <div className="inline-flex w-full sm:w-auto rounded-xl border border-slate-700 overflow-hidden">
            <button
              onClick={() => setViewMode('daily')}
              className={`flex-1 sm:flex-none px-3 py-2 text-xs font-medium transition-colors ${
                viewMode === 'daily' ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              Daily Focus
            </button>
            <button
              onClick={() => setViewMode('weekly')}
              className={`flex-1 sm:flex-none px-3 py-2 text-xs font-medium transition-colors ${
                viewMode === 'weekly' ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              Weekly Board
            </button>
          </div>
          <button
            onClick={handleResetAll}
            className="inline-flex items-center rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium px-3 py-2 transition-colors"
          >
            Reset all
          </button>
          <button
            onClick={() => handleAddEntry(todayDayName)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold px-4 py-2 shadow-md transition-all hover:shadow-blue-500/20 hover:shadow-lg"
          >
            <span className="text-base leading-none">+</span>
            Add entry
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[11px]">
        {(['morning', 'university', 'evening', 'night', 'other'] as ScheduleEntry['category'][]).map((cat) => {
          const s = getCategoryStyle(cat)
          return (
            <span key={cat} className="flex items-center gap-1.5 text-slate-400">
              <span className={`h-2 w-2 rounded-full ${s.dot}`} />
              <span className="capitalize">{cat}</span>
            </span>
          )
        })}
        {(['high', 'medium', 'low'] as const).map((priority) => (
          <span key={priority} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] uppercase ${priorityBadgeStyle(priority)}`}>
            {priority}
          </span>
        ))}
      </div>

      {viewMode === 'daily' ? (
        <>
          <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
            <div className="rounded-2xl border border-slate-700 bg-slate-900/70 p-3">
              <p className="text-[10px] uppercase tracking-wide text-slate-400">Focus Day</p>
              <select
                value={focusDay}
                onChange={(e) => setFocusDay(e.target.value)}
                className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-2 text-xs text-slate-100"
              >
                {DAYS_OF_WEEK.map((day) => (
                  <option key={day} value={day}>{day}</option>
                ))}
              </select>
            </div>
            <div className="rounded-2xl border border-slate-700 bg-slate-900/70 p-3">
              <p className="text-[10px] uppercase tracking-wide text-slate-400">Completion</p>
              <p className="mt-2 text-lg font-semibold text-slate-100">{completionPct}%</p>
              <p className="text-[11px] text-slate-400">{completedToday}/{totalToday} done</p>
            </div>
            <div className="rounded-2xl border border-slate-700 bg-slate-900/70 p-3">
              <p className="text-[10px] uppercase tracking-wide text-slate-400">Hybrid Mix</p>
              <p className="mt-2 text-lg font-semibold text-slate-100">{fixedCount} fixed / {flexCount} flex</p>
              <p className="text-[11px] text-slate-400">Balance classes and tasks</p>
            </div>
            <div className="rounded-2xl border border-slate-700 bg-slate-900/70 p-3 flex items-end">
              <button
                onClick={handleSmartReschedule}
                className="w-full rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
              >
                Auto Reschedule Incomplete Flex Tasks
              </button>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
            <section className="rounded-2xl border border-slate-700 bg-slate-900/70 p-4 space-y-3">
              <h4 className="text-sm font-semibold text-slate-100">Top 3 Priorities</h4>
              {topPriorities.length === 0 ? (
                <p className="text-xs text-slate-400">No pending priorities for {focusDay}.</p>
              ) : (
                <ul className="space-y-2">
                  {topPriorities.map((entry) => (
                    <li key={entry.id} className="rounded-lg border border-slate-700 bg-slate-800/60 p-2.5">
                      <p className="text-xs font-semibold text-slate-100 line-clamp-2">{entry.activity}</p>
                      <div className="mt-1 flex items-center gap-1.5">
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] uppercase ${priorityBadgeStyle(normalizePriority(entry))}`}>
                          {normalizePriority(entry)}
                        </span>
                        <span className="text-[10px] text-slate-400">{entry.startTime} - {entry.endTime}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="pt-1">
                <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Templates</p>
                <div className="grid grid-cols-1 gap-1.5">
                  <button onClick={() => applyTemplateToFocusDay('heavy')} className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-slate-200 hover:bg-slate-700">Heavy Lecture Day</button>
                  <button onClick={() => applyTemplateToFocusDay('free')} className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-slate-200 hover:bg-slate-700">Free Day</button>
                  <button onClick={() => applyTemplateToFocusDay('exam')} className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-slate-200 hover:bg-slate-700">Exam Prep Day</button>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold text-slate-100">{focusDay} Timeline</h4>
                <button
                  onClick={() => handleAddEntry(focusDay)}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500"
                >
                  Add block
                </button>
              </div>

              {focusEntries.length === 0 ? (
                <p className="text-xs text-slate-400">No entries planned for {focusDay}.</p>
              ) : (
                <ul className="space-y-2 max-h-[360px] sm:max-h-[420px] overflow-y-auto pr-1">
                  {focusEntries.map((entry) => {
                    const categoryStyle = getCategoryStyle(entry.category)
                    const mode = normalizeMode(entry)
                    const priority = normalizePriority(entry)
                    const completed = normalizeCompleted(entry)

                    return (
                      <li key={entry.id} className={`rounded-xl border p-3 ${completed ? 'border-slate-700 bg-slate-800/40 opacity-75' : 'border-slate-700 bg-slate-800/60'}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className={`text-xs font-semibold ${completed ? 'line-through text-slate-400' : 'text-slate-100'}`}>
                              {entry.activity}
                            </p>
                            <p className="text-[10px] text-slate-400 mt-0.5">{entry.startTime} - {entry.endTime}</p>
                          </div>
                          <div className="flex items-center gap-1">
                            <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] capitalize ${categoryStyle.badge}`}>
                              {entry.category}
                            </span>
                            <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] uppercase ${priorityBadgeStyle(priority)}`}>
                              {priority}
                            </span>
                            <span className="inline-flex rounded-full border border-slate-600 px-2 py-0.5 text-[10px] uppercase text-slate-300">
                              {mode}
                            </span>
                          </div>
                        </div>

                        <div className="mt-2 flex items-center gap-1.5">
                          <button
                            onClick={() => handleToggleCompleted(focusDay, entry.id)}
                            className="rounded-lg border border-emerald-600/40 bg-emerald-600/10 px-2 py-1 text-[10px] text-emerald-300 hover:bg-emerald-600/20"
                          >
                            {completed ? 'Undo' : 'Done'}
                          </button>
                          <button
                            onClick={() => handleEditEntry(focusDay, entry)}
                            className="rounded-lg border border-blue-600/40 bg-blue-600/10 px-2 py-1 text-[10px] text-blue-300 hover:bg-blue-600/20"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteEntry(focusDay, entry.id)}
                            className="rounded-lg border border-rose-600/40 bg-rose-600/10 px-2 py-1 text-[10px] text-rose-300 hover:bg-rose-600/20"
                          >
                            Delete
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          </div>
        </>
      ) : (
        <div className="rounded-2xl border border-slate-700/80 overflow-hidden shadow-xl bg-slate-900/80 backdrop-blur-sm">
          <div className="overflow-x-auto -mx-1 px-1 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[700px] border-collapse text-xs">
              <thead>
                <tr className="bg-slate-800/90 border-b border-slate-700">
                  <th className="sticky left-0 z-10 bg-slate-800 px-4 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-slate-500 w-[90px] border-r border-slate-700">
                    Time
                  </th>
                  {DAYS_OF_WEEK.map((day) => {
                    const isToday = day === todayDayName
                    return (
                      <th
                        key={day}
                        className={`px-3 py-3 text-center text-[11px] font-bold uppercase tracking-wide border-r border-slate-700/50 last:border-r-0 ${
                          isToday ? 'text-blue-300 bg-blue-600/10' : 'text-slate-300'
                        }`}
                      >
                        <div className="flex flex-col items-center gap-1">
                          <span>{day}</span>
                          {isToday && <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />}
                        </div>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {allTimeSlots.map((timeSlot, rowIdx) => (
                  <tr
                    key={timeSlot}
                    className={`group transition-colors hover:bg-slate-800/30 ${
                      rowIdx % 2 === 0 ? 'bg-slate-900/30' : 'bg-slate-900/10'
                    }`}
                  >
                    <td className="sticky left-0 z-10 bg-inherit px-4 py-2.5 border-r border-slate-700/60">
                      <span className="font-mono text-[11px] font-semibold text-slate-400">{timeSlot}</span>
                    </td>
                    {DAYS_OF_WEEK.map((day) => {
                      const isToday = day === todayDayName
                      const entry = (schedule[day] ?? []).find((e) => e.startTime === timeSlot)
                      const style = entry ? getCategoryStyle(entry.category) : null
                      const priority = entry ? normalizePriority(entry) : 'medium'
                      const mode = entry ? normalizeMode(entry) : 'flex'
                      return (
                        <td
                          key={day}
                          className={`px-2 py-1.5 border-r border-slate-700/30 last:border-r-0 align-top ${
                            isToday ? 'bg-blue-600/5' : ''
                          }`}
                        >
                          {entry ? (
                            <div className="group/cell relative flex flex-col gap-1 rounded-lg px-2 py-1.5 border border-slate-700/40 bg-slate-800/40 hover:bg-slate-700/50 transition-colors min-h-[48px]">
                              <div className="flex items-start gap-1.5">
                                <span className={`mt-0.5 h-1.5 w-1.5 rounded-full flex-shrink-0 ${style!.dot}`} />
                                <span className="text-[11px] text-slate-100 leading-tight pr-5 break-words">{entry.activity}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] uppercase ${priorityBadgeStyle(priority)}`}>{priority}</span>
                                <span className="inline-flex rounded-full border border-slate-600 px-2 py-0.5 text-[10px] uppercase text-slate-300">{mode}</span>
                              </div>
                              <span className="text-[10px] text-slate-500">until {entry.endTime}</span>
                              <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover/cell:opacity-100 transition-opacity">
                                <button
                                  onClick={() => handleEditEntry(day, entry)}
                                  title="Edit"
                                  className="rounded p-0.5 hover:bg-blue-500/20 transition-all leading-none"
                                >✏️</button>
                                <button
                                  onClick={() => handleDeleteEntry(day, entry.id)}
                                  title="Delete"
                                  className="rounded p-0.5 hover:bg-rose-500/20 transition-all leading-none"
                                >🗑️</button>
                              </div>
                            </div>
                          ) : (
                            <button
                              onClick={() => handleAddEntry(day)}
                              title={`Add to ${day} at ${timeSlot}`}
                              className="w-full min-h-[48px] rounded-lg border border-dashed border-transparent hover:border-slate-600 hover:bg-slate-800/30 text-slate-600 hover:text-slate-300 transition-all text-lg opacity-0 group-hover:opacity-100"
                            >+</button>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
                {allTimeSlots.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-16 text-center">
                      <div className="flex flex-col items-center gap-2 text-slate-500">
                        <span className="text-3xl">📅</span>
                        <p className="text-sm">No schedule entries yet.</p>
                        <button onClick={() => handleAddEntry(todayDayName)} className="text-xs text-blue-400 hover:text-blue-300 underline">Add your first entry</button>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-700 bg-slate-800/40">
                  <td className="sticky left-0 z-10 bg-slate-800/90 px-4 py-2.5 border-r border-slate-700/60 text-[10px] text-slate-500 font-semibold uppercase tracking-wide">Add</td>
                  {DAYS_OF_WEEK.map((day) => (
                    <td key={day} className="px-2 py-2 text-center border-r border-slate-700/30 last:border-r-0">
                      <button
                        onClick={() => handleAddEntry(day)}
                        title={`Add entry to ${day}`}
                        className="inline-flex items-center justify-center w-7 h-7 rounded-lg border border-slate-600 text-slate-400 hover:text-white hover:bg-blue-600 hover:border-blue-500 transition-all text-base font-bold"
                      >+</button>
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {modalState.open && (
        <EntryModal
          day={modalState.day}
          entry={modalState.entry}
          onSave={handleSaveEntry}
          onClose={() => setModalState((s) => ({ ...s, open: false }))}
        />
      )}
    </div>
  )
}

type TasksPageProps = {
  todos: TodoItem[]
  onAddTodo: (input: NewTodoInput) => void
  onToggleTodoCompleted: (id: string) => void
  onToggleTodoPinned: (id: string) => void
  onDeleteTodo: (id: string) => void
}

function TasksPage({
  todos,
  onAddTodo,
  onToggleTodoCompleted,
  onToggleTodoPinned,
  onDeleteTodo,
}: TasksPageProps) {
  const todayDate = toLocalDateKey(new Date())
  const [title, setTitle] = useState('')
  const [deadline, setDeadline] = useState(todayDate)
  const [isDaily, setIsDaily] = useState(false)
  const [isPinned, setIsPinned] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const sortedTodos = [...todos].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1
    const deadlineCmp = a.deadline.localeCompare(b.deadline)
    if (deadlineCmp !== 0) return deadlineCmp
    return b.createdAt.localeCompare(a.createdAt)
  })

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) {
      setFormError('Todo title is required.')
      return
    }
    if (!deadline) {
      setFormError('Deadline is required.')
      return
    }

    onAddTodo({
      title: trimmed,
      deadline,
      isDaily,
      isPinned,
    })

    setTitle('')
    setDeadline(todayDate)
    setIsDaily(false)
    setIsPinned(false)
    setFormError(null)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-950 dark:text-slate-100">To-Do list</h3>
          <p className="text-xs text-slate-700 dark:text-slate-400">
            Tasks ordered by completion and priority.
          </p>
        </div>
      </div>

      <form
        onSubmit={handleSubmit}
        className="rounded-2xl bg-white/90 dark:bg-slate-900/80 border border-slate-300 dark:border-slate-800 p-4 shadow-sm space-y-3"
      >
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
          <label className="space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-400">
              Todo
            </span>
            <input
              type="text"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value)
                setFormError(null)
              }}
              placeholder="Add a new todo"
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/50"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-400">
              Deadline
            </span>
            <input
              type="date"
              value={deadline}
              onChange={(e) => {
                setDeadline(e.target.value)
                setFormError(null)
              }}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/50"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-4">
            <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={isDaily}
                onChange={(e) => setIsDaily(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 accent-emerald-500"
              />
              Daily todo
            </label>
            <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={isPinned}
                onChange={(e) => setIsPinned(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 accent-amber-500"
              />
              Pin on dashboard
            </label>
          </div>

          <button
            type="submit"
            className="inline-flex items-center rounded-full bg-primary-500 text-white text-xs px-3 py-1.5 shadow-md hover:bg-primary-600"
          >
            Add todo
          </button>
        </div>

        {formError ? (
          <p className="text-[11px] text-rose-700 dark:text-rose-300">{formError}</p>
        ) : null}
      </form>

      <div className="rounded-2xl bg-sky-50/80 dark:bg-slate-900/80 border border-sky-200 dark:border-slate-800 divide-y divide-sky-100/80 dark:divide-slate-800/80 shadow-sm">
        {sortedTodos.map((todo) => (
          <div key={todo.id} className="flex items-center gap-3 px-4 py-3 text-xs">
            <input
              type="checkbox"
              checked={todo.completed}
              onChange={() => onToggleTodoCompleted(todo.id)}
              className="h-4 w-4 rounded border-slate-300 accent-sky-500"
            />
            <div className="flex-1 min-w-0">
              <p className={`font-medium truncate ${todo.completed ? 'text-slate-500 line-through' : 'text-slate-950 dark:text-slate-50'}`}>
                {formatDisplayTitle(todo.title)}
              </p>
              <p className="text-[10px] text-slate-500 dark:text-slate-500">
                Deadline: {new Date(`${todo.deadline}T00:00:00`).toLocaleDateString()}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {todo.isDaily ? (
                <span className="inline-flex items-center rounded-full border border-emerald-400/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-800 dark:text-emerald-300 bg-emerald-500/15">
                  Daily
                </span>
              ) : null}
              {todo.isPinned ? (
                <span className="inline-flex items-center rounded-full border border-amber-400/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-800 dark:text-amber-300 bg-amber-500/15">
                  Pinned
                </span>
              ) : null}
              <button
                onClick={() => onToggleTodoPinned(todo.id)}
                className="inline-flex items-center rounded-full border border-slate-300 dark:border-slate-700 px-2 py-0.5 text-[10px] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                {todo.isPinned ? 'Unpin' : 'Pin'}
              </button>
              <button
                onClick={() => onDeleteTodo(todo.id)}
                className="inline-flex items-center rounded-full border border-rose-300/60 dark:border-rose-700 px-2 py-0.5 text-[10px] text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
        {sortedTodos.length === 0 ? (
          <p className="px-4 py-4 text-xs text-slate-600 dark:text-slate-400">
            No todos yet. Add one above.
          </p>
        ) : null}
      </div>
    </div>
  )
}

function MindDumpPage() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-950 dark:text-slate-100">Mind dump</h3>
          <p className="text-xs text-slate-700 dark:text-slate-400">
            Capture raw thoughts, then promote key ideas.
          </p>
        </div>
        <span className="text-[11px] text-slate-600 dark:text-slate-400">Pinned vs regular notes</span>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="md:col-span-2 rounded-2xl bg-cyan-50/70 dark:bg-slate-900/80 border border-cyan-200 dark:border-slate-800 p-4 shadow-sm">
          <textarea
            className="w-full rounded-xl border border-cyan-200 dark:border-slate-700 bg-white/95 dark:bg-slate-950/50 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none focus:ring-2 focus:ring-primary-500/60 focus:border-primary-500/60 min-h-[120px]"
            placeholder="Dump everything on your mind..."
          />
          <div className="flex justify-end mt-2">
            <button className="inline-flex items-center rounded-full bg-primary-500 text-white text-xs px-3 py-1.5 shadow-md hover:bg-primary-600">
              Save note
            </button>
          </div>
        </div>

        <div className="space-y-3 text-xs">
          <div className="rounded-2xl bg-amber-100/85 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700/70 p-3">
            <p className="text-[11px] font-semibold text-amber-950 dark:text-amber-100 mb-1">
              Pinned
            </p>
            <p className="text-amber-950/90 dark:text-amber-50">
              Ideas or notes you pin will show up here for quick access.
            </p>
          </div>
          <div className="rounded-2xl bg-white/95 dark:bg-slate-900/80 border border-slate-300 dark:border-slate-800 p-3 shadow-sm">
            <p className="text-[11px] text-slate-600 dark:text-slate-400">
              Recent notes
            </p>
            <p className="mt-1 text-slate-950 dark:text-slate-100">
              “Plan sprint tasks for team project UI...”
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function ProjectsPage() {
  const projects = [
    { id: 1, name: 'Uni group software project', status: 'Active', progress: 65 },
    { id: 2, name: 'Portfolio website', status: 'On-Hold', progress: 30 },
    { id: 3, name: 'Research presentation', status: 'Completed', progress: 100 },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-950 dark:text-slate-100">Projects</h3>
          <p className="text-xs text-slate-700 dark:text-slate-400">
            Track team work in a simple kanban-style overview.
          </p>
        </div>
        <button className="inline-flex items-center rounded-full bg-primary-500 text-white text-xs px-3 py-1.5 shadow-md hover:bg-primary-600">
          New project
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-3 text-xs">
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-slate-700 dark:text-slate-400 uppercase tracking-wide">
            Active
          </p>
          {projects
            .filter((p) => p.status === 'Active')
            .map((p) => (
              <ProjectCard key={p.id} name={p.name} progress={p.progress} />
            ))}
        </div>
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-slate-700 dark:text-slate-400 uppercase tracking-wide">
            On-Hold
          </p>
          {projects
            .filter((p) => p.status === 'On-Hold')
            .map((p) => (
              <ProjectCard key={p.id} name={p.name} progress={p.progress} />
            ))}
        </div>
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-slate-700 dark:text-slate-400 uppercase tracking-wide">
            Completed
          </p>
          {projects
            .filter((p) => p.status === 'Completed')
            .map((p) => (
              <ProjectCard key={p.id} name={p.name} progress={p.progress} />
            ))}
        </div>
      </div>
    </div>
  )
}

type ProjectCardProps = {
  name: string
  progress: number
}

function ProjectCard({ name, progress }: ProjectCardProps) {
  return (
    <div className="rounded-2xl bg-sky-50/80 dark:bg-slate-900/80 border border-sky-200 dark:border-slate-800 p-3 shadow-sm flex flex-col gap-1">
      <p className="font-medium text-slate-950 dark:text-slate-50">{name}</p>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-2 rounded-full bg-sky-100 dark:bg-slate-800 overflow-hidden">
          <div
            className="h-full bg-primary-500"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-[11px] text-slate-700 dark:text-slate-400">{progress}%</span>
      </div>
      <div className="flex -space-x-2 mt-1">
        <div className="h-5 w-5 rounded-full bg-sky-200 dark:bg-slate-700 border border-slate-300 dark:border-slate-600" />
        <div className="h-5 w-5 rounded-full bg-cyan-200 dark:bg-slate-700 border border-slate-300 dark:border-slate-600" />
        <div className="h-5 w-5 rounded-full bg-amber-200 dark:bg-slate-700 border border-slate-300 dark:border-slate-600" />
      </div>
    </div>
  )
}

export default App
