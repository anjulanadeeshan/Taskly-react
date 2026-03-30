import { useEffect, useState } from 'react'
import { Routes, Route, NavLink } from 'react-router-dom'
import { GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { auth, googleProvider } from './firebase'
import { getCalendarEvents, type CalendarEvent } from './calendar'
import './App.css'

type Theme = 'light' | 'dark'

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>('light')

  useEffect(() => {
    const stored = window.localStorage.getItem('taskly-theme') as Theme | null
    if (stored === 'light' || stored === 'dark') {
      setTheme(stored)
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      setTheme('dark')
    }
  }, [])

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
    window.localStorage.setItem('taskly-theme', theme)
  }, [theme])

  return [theme, setTheme]
}

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [theme, setTheme] = useTheme()
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(null)
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([])
  const [calendarLoading, setCalendarLoading] = useState(false)
  const [calendarError, setCalendarError] = useState<string | null>(null)

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((currentUser) => {
      setUser(currentUser)
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

  const handleLogin = async () => {
    try {
      const result = await signInWithPopup(auth, googleProvider)
      const credential = GoogleAuthProvider.credentialFromResult(result)
      setGoogleAccessToken(credential?.accessToken ?? null)
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

  const handleConnectCalendar = async () => {
    try {
      const calendarProvider = new GoogleAuthProvider()
      calendarProvider.addScope('https://www.googleapis.com/auth/calendar.readonly')
      calendarProvider.setCustomParameters({ prompt: 'consent' })

      const result = await signInWithPopup(auth, calendarProvider)
      const credential = GoogleAuthProvider.credentialFromResult(result)
      setGoogleAccessToken(credential?.accessToken ?? null)
    } catch (error) {
      const code = getAuthErrorCode(error)
      if (code === 'auth/popup-closed-by-user') {
        setCalendarError('Popup closed. Please try again to connect Calendar.')
        return
      }
      if (code === 'auth/popup-blocked') {
        setCalendarError('Popup blocked. Allow popups for this site and try again.')
        return
      }
      console.error('Error connecting Google Calendar', error)
      setCalendarError('Calendar permission was not granted.')
    }
  }

  const handleLogout = async () => {
    try {
      await signOut(auth)
      setGoogleAccessToken(null)
      setCalendarEvents([])
    } catch (error) {
      console.error('Error signing out', error)
    }
  }

  useEffect(() => {
    const loadCalendar = async () => {
      if (!googleAccessToken) return
      try {
        setCalendarError(null)
        setCalendarLoading(true)
        const items = await getCalendarEvents(googleAccessToken)
        setCalendarEvents(items)
      } catch (err) {
        console.error('Failed to load calendar events', err)
        setCalendarError('Could not load Google Calendar events.')
      } finally {
        setCalendarLoading(false)
      }
    }
    void loadCalendar()
  }, [googleAccessToken])

  return (
    <div className={`h-full bg-slate-950 text-slate-100 transition-colors ${theme === 'light' ? 'bg-slate-100 text-slate-900' : ''}`}>
      <div className="min-h-screen flex flex-col lg:flex-row">
        <aside className="w-full lg:w-64 bg-slate-900/90 dark:bg-slate-950 border-b lg:border-b-0 lg:border-r border-slate-800/60 backdrop-blur text-slate-100">
          <div className="flex items-center justify-between px-4 py-4 border-b border-slate-800/60">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Taskly</h1>
              <p className="text-xs text-slate-400">Plan. Focus. Execute.</p>
            </div>
            <button
              onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-700 bg-slate-900/60 text-xs hover:bg-slate-800"
            >
              {theme === 'light' ? '🌙' : '☀️'}
            </button>
          </div>

          <nav className="px-3 py-3 flex flex-col gap-1 text-sm">
            <SidebarLink to="/" label="Dashboard" />
            <SidebarLink to="/schedule" label="Daily Schedule" />
            <SidebarLink to="/tasks" label="To-Do List" />
            <SidebarLink to="/mind-dump" label="Mind Dump" />
            <SidebarLink to="/projects" label="Projects" />
          </nav>
        </aside>

        <main className="flex-1 bg-gradient-to-br from-slate-50 via-slate-100 to-slate-200 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
          <header className="flex items-center justify-between px-4 lg:px-8 py-4 border-b border-slate-200/60 dark:border-slate-800">
            <div>
              <h2 className="text-lg font-medium tracking-tight text-slate-900 dark:text-slate-100">
                {user ? `Welcome back, ${user.displayName ?? 'friend'} 👋` : 'Welcome to Taskly 👋'}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Your daily hub for tasks, schedule, and projects.
              </p>
            </div>
            <div className="flex items-center gap-3">
              {user && (
                <div className="hidden sm:flex flex-col text-right text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-medium text-slate-900 dark:text-slate-100">{user.displayName}</span>
                  <span className="truncate max-w-[150px]">{user.email}</span>
                </div>
              )}
              {user ? (
                <button
                  onClick={handleLogout}
                  className="inline-flex items-center rounded-full bg-slate-900 text-slate-50 text-xs px-3 py-1.5 shadow-sm hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900"
                >
                  Logout
                </button>
              ) : (
                <button
                  onClick={handleLogin}
                  className="inline-flex items-center rounded-full bg-primary-500 text-white text-xs px-3 py-1.5 shadow-sm hover:bg-primary-600"
                >
                  Sign in with Google
                </button>
              )}
            </div>
          </header>

          <section className="px-4 lg:px-8 py-4 lg:py-6">
            <Routes>
              <Route
                path="/"
                element={
                  <DashboardPage
                    isSignedIn={Boolean(user)}
                    hasCalendarToken={Boolean(googleAccessToken)}
                    onConnectCalendar={handleConnectCalendar}
                    calendarEvents={calendarEvents}
                    calendarLoading={calendarLoading}
                    calendarError={calendarError}
                  />
                }
              />
              <Route path="/schedule" element={<SchedulePage />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/mind-dump" element={<MindDumpPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
            </Routes>
          </section>
        </main>
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
        `flex items-center justify-between rounded-md px-3 py-2 text-xs font-medium transition-colors ${
          isActive
            ? 'bg-slate-100/10 text-white shadow-sm border border-slate-700'
            : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
        }`
      }
      end={to === '/'}
    >
      <span>{label}</span>
    </NavLink>
  )
}

type DashboardPageProps = {
  isSignedIn: boolean
  hasCalendarToken: boolean
  onConnectCalendar: () => void
  calendarEvents: CalendarEvent[]
  calendarLoading: boolean
  calendarError: string | null
}

type CalendarDayCell = {
  date: Date
  inMonth: boolean
  key: string
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
    'bg-rose-500/15 text-rose-800 dark:text-rose-100 hover:bg-rose-500/25',
    'bg-amber-500/15 text-amber-900 dark:text-amber-100 hover:bg-amber-500/25',
    'bg-emerald-500/15 text-emerald-900 dark:text-emerald-100 hover:bg-emerald-500/25',
    'bg-sky-500/15 text-sky-900 dark:text-sky-100 hover:bg-sky-500/25',
    'bg-indigo-500/15 text-indigo-900 dark:text-indigo-100 hover:bg-indigo-500/25',
    'bg-fuchsia-500/15 text-fuchsia-900 dark:text-fuchsia-100 hover:bg-fuchsia-500/25',
  ]
  const key = ev.id || ev.summary || 'event'
  return palettes[hashString(key) % palettes.length]
}

// Monday-first calendar grid with 6 rows (42 days)
function buildMonthGrid(monthStart: Date): CalendarDayCell[] {
  const first = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1)
  const mondayFirstIndex = (first.getDay() + 6) % 7
  const gridStart = addDays(first, -mondayFirstIndex)

  const cells: CalendarDayCell[] = []
  for (let i = 0; i < 42; i++) {
    const date = addDays(gridStart, i)
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

function DashboardPage({
  isSignedIn,
  hasCalendarToken,
  onConnectCalendar,
  calendarEvents,
  calendarLoading,
  calendarError,
}: DashboardPageProps) {
  const month = new Date()
  const monthStart = new Date(month.getFullYear(), month.getMonth(), 1)
  const monthEnd = new Date(month.getFullYear(), month.getMonth() + 1, 1)

  const cells = buildMonthGrid(monthStart)
  const eventsByDay = groupEventsByDay(calendarEvents, monthStart, monthEnd)

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-4">
        <DashboardStat title="Today’s Tasks" value="8" subtitle="3 high priority" />
        <DashboardStat title="Projects" value="4" subtitle="2 active" />
        <DashboardStat title="Quick Ideas" value="12" subtitle="Mind dump" />
        <DashboardStat title="Notes" value="23" subtitle="Pinned & regular" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl bg-white/70 dark:bg-slate-900/70 border border-slate-200/70 dark:border-slate-800 p-4 shadow-sm">
          <h3 className="text-sm font-semibold mb-2">Today at a glance</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
            Stay on top of lectures, study time, and breaks.
          </p>
          <ul className="space-y-1 text-xs text-slate-700 dark:text-slate-300">
            <li>• 6:00 – Wake up & light exercise</li>
            <li>• 8:00 – 17:00 – Lectures & campus time</li>
            <li>• 19:00 – 21:00 – Focused study block</li>
          </ul>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200/70 dark:border-slate-800 p-4 shadow-sm bg-gradient-to-br from-white/80 via-white/60 to-indigo-50/50 dark:from-slate-950/40 dark:via-slate-900/60 dark:to-indigo-950/20">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Monthly schedule (Google Calendar)</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Full month view with your events.
            </p>
          </div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400">
            {monthStart.toLocaleString(undefined, { month: 'long', year: 'numeric' })}
            {hasCalendarToken && !calendarLoading && !calendarError ? ` · ${calendarEvents.length} events` : ''}
          </div>
        </div>

        {!isSignedIn ? (
          <div className="mt-3 rounded-xl border border-slate-200/70 dark:border-slate-800 bg-white/60 dark:bg-slate-950/30 p-3">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Sign in with Google to load your Calendar events.
            </p>
          </div>
        ) : !hasCalendarToken ? (
          <div className="mt-3 rounded-xl border border-slate-200/70 dark:border-slate-800 bg-white/60 dark:bg-slate-950/30 p-3 flex items-center justify-between gap-2">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Connect Google Calendar to show events.
            </p>
            <button
              onClick={onConnectCalendar}
              className="inline-flex items-center rounded-full bg-primary-500 text-white text-[11px] px-3 py-1.5 shadow-sm hover:bg-primary-600"
            >
              Connect
            </button>
          </div>
        ) : calendarLoading ? (
          <div className="mt-3 rounded-xl border border-slate-200/70 dark:border-slate-800 bg-white/60 dark:bg-slate-950/30 p-3">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">Loading events…</p>
          </div>
        ) : calendarError ? (
          <div className="mt-3 rounded-xl border border-rose-200/70 dark:border-rose-700/50 bg-rose-50/60 dark:bg-rose-950/30 p-3">
            <p className="text-[11px] text-rose-700 dark:text-rose-200">{calendarError}</p>
          </div>
        ) : (
          <div className="mt-3">
            <div className="grid grid-cols-7 gap-1.5 text-[11px] text-center text-slate-600 dark:text-slate-300">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                <div
                  key={d}
                  className={`py-1 rounded-lg font-semibold ${
                    d === 'Sat' || d === 'Sun'
                      ? 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-200'
                      : 'bg-slate-500/5'
                  }`}
                >
                  {d}
                </div>
              ))}
            </div>

            <div className="mt-2 grid grid-cols-7 gap-1.5">
              {cells.map((cell) => {
                const dayKey = toLocalDateKey(cell.date)
                const dayEvents = eventsByDay.get(dayKey) ?? []
                const isToday = isSameLocalDay(cell.date, new Date())
                const isWeekend = cell.date.getDay() === 0 || cell.date.getDay() === 6

                const baseBg = isWeekend
                  ? 'bg-indigo-50/50 dark:bg-indigo-950/15'
                  : 'bg-white/60 dark:bg-slate-950/25'

                return (
                  <div
                    key={cell.key}
                    className={`min-h-[104px] rounded-xl border p-2 overflow-hidden ${baseBg} ${
                      cell.inMonth
                        ? 'border-slate-200/70 dark:border-slate-800'
                        : 'border-slate-200/40 dark:border-slate-800/40 opacity-60'
                    } ${isToday ? 'ring-2 ring-primary-500/50' : ''}`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={`text-xs font-semibold ${
                          cell.inMonth
                            ? isWeekend
                              ? 'text-indigo-700 dark:text-indigo-200'
                              : 'text-slate-700 dark:text-slate-200'
                            : 'text-slate-400 dark:text-slate-500'
                        }`}
                      >
                        {cell.date.getDate()}
                      </span>
                      {dayEvents.length > 0 && (
                        <span className="text-[10px] text-slate-400 dark:text-slate-500">
                          {dayEvents.length}
                        </span>
                      )}
                    </div>

                    <div className="mt-1.5 space-y-1 max-h-[78px] overflow-auto pr-0.5">
                      {dayEvents.map((ev) => (
                        <a
                          key={ev.id}
                          href={ev.htmlLink}
                          target="_blank"
                          rel="noreferrer"
                          title={ev.summary ?? '(No title)'}
                          className={`block truncate rounded-lg px-2 py-1 text-[10px] border border-white/40 dark:border-white/5 ${eventChipClass(ev)}`}
                        >
                          {formatEventLabel(ev)}
                        </a>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

type DashboardStatProps = {
  title: string
  value: string
  subtitle: string
}

function DashboardStat({ title, value, subtitle }: DashboardStatProps) {
  return (
    <div className="rounded-2xl bg-white/80 dark:bg-slate-900/80 border border-slate-200/70 dark:border-slate-800 p-3 shadow-sm flex flex-col justify-between">
      <p className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-1">
        {title}
      </p>
      <p className="text-xl font-semibold text-slate-900 dark:text-slate-50">{value}</p>
      <p className="text-[11px] text-slate-500 dark:text-slate-400">{subtitle}</p>
    </div>
  )
}

function SchedulePage() {
  const defaultSchedule = [
    '6:00 – Wake up',
    '6:00–6:30 – Freshen up + light exercise',
    '6:30–7:00 – Breakfast',
    '7:00–7:30 – Review notes / plan the day',
    '7:30–8:00 – Travel to university',
    '8:00–17:00 – Lectures (with breaks)',
    '17:00–18:00 – Travel back + rest',
    '18:00–19:00 – Relax / shower / snack',
    '19:00–21:00 – Focused study',
    '21:00–21:30 – Dinner',
    '21:30–22:30 – Light activities',
    '22:30–6:00 – Sleep',
  ]

  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Daily schedule</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Default weekday plan, customizable per user.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        {days.map((day, index) => (
          <button
            key={`${day}-${index}`}
            className={`rounded-full border border-slate-300/70 dark:border-slate-700/70 px-3 py-1 bg-white/70 dark:bg-slate-900/70`}
          >
            {day}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr,2fr]">
        <div className="rounded-2xl bg-white/80 dark:bg-slate-900/80 border border-slate-200/70 dark:border-slate-800 p-4 text-xs space-y-1">
          {defaultSchedule.map((line) => (
            <p key={line}>• {line}</p>
          ))}
        </div>
        <div className="rounded-2xl bg-white/80 dark:bg-slate-900/80 border border-slate-200/70 dark:border-slate-800 p-4 text-xs">
          <p className="text-slate-500 dark:text-slate-400 mb-2">
            24-hour visual timeline (conceptual mockup).
          </p>
          <div className="space-y-2">
            {['Morning', 'Afternoon', 'Evening', 'Night'].map((block) => (
              <div key={block} className="flex items-center gap-2">
                <div className="w-16 text-[11px] text-slate-500 dark:text-slate-400">
                  {block}
                </div>
                <div className="flex-1 h-3 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div className="h-full w-1/2 bg-primary-500/70" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function TasksPage() {
  const [tasks] = useState([
    { id: 1, title: 'Finish assignment report', priority: 'High', due: 'Today' },
    { id: 2, title: 'Review lecture notes', priority: 'Medium', due: 'Today' },
    { id: 3, title: 'Plan group meeting', priority: 'Low', due: 'Tomorrow' },
  ])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">To-Do list</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Tasks ordered by completion and priority.
          </p>
        </div>
        <button className="inline-flex items-center rounded-full bg-primary-500 text-white text-xs px-3 py-1.5 shadow-sm hover:bg-primary-600">
          Add task
        </button>
      </div>

      <div className="rounded-2xl bg-white/80 dark:bg-slate-900/80 border border-slate-200/70 dark:border-slate-800 divide-y divide-slate-100/80 dark:divide-slate-800/80">
        {tasks.map((task) => (
          <div key={task.id} className="flex items-center gap-3 px-4 py-3 text-xs">
            <input type="checkbox" className="h-4 w-4 rounded border-slate-300" />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-slate-900 dark:text-slate-50 truncate">
                {task.title}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Due: {task.due}
              </p>
            </div>
            <span className="inline-flex items-center rounded-full border border-slate-200 dark:border-slate-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {task.priority}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function MindDumpPage() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Mind dump</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Capture raw thoughts, then promote key ideas.
          </p>
        </div>
        <span className="text-[11px] text-slate-400">Pinned vs regular notes</span>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="md:col-span-2 rounded-2xl bg-white/80 dark:bg-slate-900/80 border border-slate-200/70 dark:border-slate-800 p-4">
          <textarea
            className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-950/50 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-primary-500/60 focus:border-primary-500/60 min-h-[120px]"
            placeholder="Dump everything on your mind..."
          />
          <div className="flex justify-end mt-2">
            <button className="inline-flex items-center rounded-full bg-primary-500 text-white text-xs px-3 py-1.5 shadow-sm hover:bg-primary-600">
              Save note
            </button>
          </div>
        </div>

        <div className="space-y-3 text-xs">
          <div className="rounded-2xl bg-amber-50/90 dark:bg-amber-900/20 border border-amber-200/70 dark:border-amber-700/70 p-3">
            <p className="text-[11px] font-semibold text-amber-900 dark:text-amber-100 mb-1">
              Pinned
            </p>
            <p className="text-amber-900/90 dark:text-amber-50">
              Ideas or notes you pin will show up here for quick access.
            </p>
          </div>
          <div className="rounded-2xl bg-white/80 dark:bg-slate-900/80 border border-slate-200/70 dark:border-slate-800 p-3">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Recent notes
            </p>
            <p className="mt-1 text-slate-800 dark:text-slate-100">
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
          <h3 className="text-sm font-semibold">Projects</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Track team work in a simple kanban-style overview.
          </p>
        </div>
        <button className="inline-flex items-center rounded-full bg-primary-500 text-white text-xs px-3 py-1.5 shadow-sm hover:bg-primary-600">
          New project
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-3 text-xs">
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
            Active
          </p>
          {projects
            .filter((p) => p.status === 'Active')
            .map((p) => (
              <ProjectCard key={p.id} name={p.name} progress={p.progress} />
            ))}
        </div>
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
            On-Hold
          </p>
          {projects
            .filter((p) => p.status === 'On-Hold')
            .map((p) => (
              <ProjectCard key={p.id} name={p.name} progress={p.progress} />
            ))}
        </div>
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
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
    <div className="rounded-2xl bg-white/80 dark:bg-slate-900/80 border border-slate-200/70 dark:border-slate-800 p-3 shadow-sm flex flex-col gap-1">
      <p className="font-medium text-slate-900 dark:text-slate-50">{name}</p>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
          <div
            className="h-full bg-primary-500"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-[11px] text-slate-500 dark:text-slate-400">{progress}%</span>
      </div>
      <div className="flex -space-x-2 mt-1">
        <div className="h-5 w-5 rounded-full bg-slate-200 dark:bg-slate-700 border border-slate-300 dark:border-slate-600" />
        <div className="h-5 w-5 rounded-full bg-slate-200 dark:bg-slate-700 border border-slate-300 dark:border-slate-600" />
        <div className="h-5 w-5 rounded-full bg-slate-200 dark:bg-slate-700 border border-slate-300 dark:border-slate-600" />
      </div>
    </div>
  )
}

export default App
