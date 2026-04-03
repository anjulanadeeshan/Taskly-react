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

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(() => loadCalToken())
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([])
  const [calendarLoading, setCalendarLoading] = useState(false)
  const [calendarError, setCalendarError] = useState<string | null>(null)
  const hasSeenInitialAuthEvent = useRef(false)

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

  useEffect(() => {
    void refreshCalendarEvents()
  }, [refreshCalendarEvents])

  useEffect(() => {
    document.documentElement.classList.add('dark')
  }, [])

  return (
    <div className="dark h-full bg-slate-950 text-slate-100 transition-colors">
      <div className="min-h-screen flex flex-col lg:flex-row">
        <aside className="w-full lg:w-64 border-b lg:border-b-0 lg:border-r backdrop-blur transition-colors bg-slate-800 border-slate-700 text-slate-100">
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

        <main className="flex-1 transition-colors bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
          <header className="flex items-center justify-between px-4 lg:px-8 py-4 border-b transition-colors border-slate-800">
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-slate-950 dark:text-slate-100">
                {user ? `Welcome back, ${user.displayName ?? 'friend'} 👋` : 'Welcome to Taskly 👋'}
              </h2>
              <p className="text-xs text-slate-800 dark:text-slate-400">
                Your daily hub for tasks, schedule, and projects.
              </p>
            </div>
            <div className="flex items-center gap-3">
              {user && (
                <div className="hidden sm:flex flex-col text-right text-xs text-slate-800 dark:text-slate-400">
                  <span className="font-semibold text-slate-950 dark:text-slate-100">{user.displayName}</span>
                  <span className="truncate max-w-[150px]">{user.email}</span>
                </div>
              )}
              {user ? (
                <button
                  onClick={handleLogout}
                  className="inline-flex items-center rounded-full bg-slate-950 text-slate-50 text-xs px-3 py-1.5 shadow-sm hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900"
                >
                  Logout
                </button>
              ) : (
                <button
                  onClick={handleLogin}
                  className="inline-flex items-center rounded-full bg-primary-500 text-white text-xs px-3 py-1.5 shadow-md hover:bg-primary-600"
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
                    onCreateEvent={handleCreateCalendarEvent}
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

type DashboardPageProps = {
  isSignedIn: boolean
  hasCalendarToken: boolean
  onConnectCalendar: () => void
  onCreateEvent: (input: NewCalendarEventInput) => Promise<void>
  calendarEvents: CalendarEvent[]
  calendarLoading: boolean
  calendarError: string | null
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
  if (kind === 'poya') return 'bg-violet-600 text-white'
  if (kind === 'new-year') return 'bg-amber-500 text-slate-950'
  return 'bg-rose-600 text-white'
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
    'bg-emerald-700 text-white hover:bg-emerald-800',
    'bg-emerald-600 text-white hover:bg-emerald-700',
    'bg-sky-600 text-white hover:bg-sky-700',
    'bg-teal-600 text-white hover:bg-teal-700',
  ]
  const key = ev.id || ev.summary || 'event'
  return palettes[hashString(key) % palettes.length]
}

// Sunday-first calendar grid with 6 rows (42 days)
function buildMonthGrid(monthStart: Date): CalendarDayCell[] {
  const first = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1)
  const sundayFirstIndex = first.getDay()
  const gridStart = addDays(first, -sundayFirstIndex)

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

  const filterSpecialDays = (days: SpecialDay[]): SpecialDay[] => {
    return showSpecialHolidays ? days : []
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-4">
        <DashboardStat title="Today’s Tasks" value="8" subtitle="3 high priority" />
        <DashboardStat title="Projects" value="4" subtitle="2 active" />
        <DashboardStat title="Quick Ideas" value="12" subtitle="Mind dump" />
        <DashboardStat title="Notes" value="23" subtitle="Pinned & regular" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="rounded-3xl border border-slate-300 p-3 lg:p-4 shadow-sm bg-slate-100/80 dark:bg-slate-900/60">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 px-3 py-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCurrentMonth(new Date())}
                className="inline-flex items-center rounded-full border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                Today
              </button>
              <button
                onClick={handlePrevMonth}
                className="inline-flex items-center justify-center rounded-full border border-transparent hover:border-slate-300 dark:hover:border-slate-700 text-slate-700 dark:text-slate-300 h-8 w-8 text-base font-semibold transition-colors"
              >
                ‹
              </button>
              <button
                onClick={handleNextMonth}
                className="inline-flex items-center justify-center rounded-full border border-transparent hover:border-slate-300 dark:hover:border-slate-700 text-slate-700 dark:text-slate-300 h-8 w-8 text-base font-semibold transition-colors"
              >
                ›
              </button>
              <div className="text-lg font-medium text-slate-900 dark:text-slate-100 ml-1">
                {monthStart.toLocaleString(undefined, { month: 'long', year: 'numeric' })}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {hasCalendarToken && !calendarLoading && !calendarError ? (
                <div className="text-xs text-slate-600 dark:text-slate-400 mr-1">
                  {calendarEvents.length} events
                </div>
              ) : null}
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400 mr-1">
                Map filters
              </span>
              <button
                onClick={() => setShowSpecialHolidays((value) => !value)}
                className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-medium border transition-colors ${
                  showSpecialHolidays
                    ? 'bg-violet-500/20 text-violet-200 border-violet-500/40'
                    : 'bg-slate-900 text-slate-400 border-slate-700 hover:bg-slate-800'
                }`}
              >
                Special days
              </button>
              <button
                onClick={() => setShowMyTasks((value) => !value)}
                className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-medium border transition-colors ${
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
            <div className="mt-2 overflow-x-auto">
              <div className="min-w-[720px]">
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

                <div className="grid grid-cols-7 border-t border-l border-slate-300 dark:border-slate-700 rounded-b-2xl overflow-hidden bg-white dark:bg-slate-900">
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
                        className={`h-[118px] border-r border-b border-slate-300 dark:border-slate-700 p-2 overflow-hidden text-left transition-colors cursor-pointer ${
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

                        <div className="space-y-1 max-h-[84px] overflow-auto pr-0.5">
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

        <aside className="space-y-4">
          <section className="rounded-3xl border border-slate-300 bg-white dark:bg-slate-900/80 p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">Upcoming Events</h3>
            <p className="text-[11px] text-slate-600 dark:text-slate-400 mb-3">
              Your next events from Google Calendar.
            </p>

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
          </section>

          <section className="rounded-3xl border border-slate-300 bg-white dark:bg-slate-900/80 p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">Project Details</h3>
            <p className="text-[11px] text-slate-600 dark:text-slate-400 mb-3">
              Active work and planning items.
            </p>

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
                    <span className="inline-flex rounded-full border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 bg-slate-950/70 shrink-0">
                      {project.status}
                    </span>
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-2 flex-1 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                      <div className="h-full rounded-full bg-blue-500" style={{ width: `${project.progress}%` }} />
                    </div>
                    <span className="text-[10px] text-slate-500 dark:text-slate-400 w-8 text-right">
                      {project.progress}%
                    </span>
                  </div>
                </li>
              ))}
            </ul>
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
          <h3 className="text-sm font-semibold text-slate-950 dark:text-slate-100">Daily schedule</h3>
          <p className="text-xs text-slate-800 dark:text-slate-400">
            Default weekday plan, customizable per user.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        {days.map((day, index) => (
          <button
            key={`${day}-${index}`}
            className="rounded-full border border-slate-300 dark:border-slate-600 px-3 py-1 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-200 hover:bg-sky-50 dark:hover:bg-slate-700 transition-colors font-medium"
          >
            {day}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr,2fr]">
        <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 p-4 space-y-1.5 shadow-sm">
          {defaultSchedule.map((line, i) => {
            const hour = parseInt(line.split(':')[0])
            let dotColor = 'bg-slate-400'
            let timeColor = 'text-slate-400 dark:text-slate-500'
            if (hour >= 6 && hour < 8) { dotColor = 'bg-amber-400'; timeColor = 'text-amber-500 dark:text-amber-400' }
            else if (hour >= 8 && hour < 17) { dotColor = 'bg-blue-500'; timeColor = 'text-blue-500 dark:text-blue-400' }
            else if (hour >= 17 && hour < 22) { dotColor = 'bg-emerald-500'; timeColor = 'text-emerald-500 dark:text-emerald-400' }
            else { dotColor = 'bg-indigo-400'; timeColor = 'text-indigo-400 dark:text-indigo-300' }
            const dashIdx = line.indexOf(' – ')
            const time = dashIdx !== -1 ? line.slice(0, dashIdx) : line
            const desc = dashIdx !== -1 ? line.slice(dashIdx + 3) : ''
            return (
              <div key={i} className="flex items-start gap-2.5 text-xs">
                <span className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${dotColor}`} />
                <span className={`flex-shrink-0 font-mono font-semibold ${timeColor} w-[72px]`}>{time}</span>
                <span className="text-slate-800 dark:text-slate-200">{desc}</span>
              </div>
            )
          })}
        </div>
        <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 p-4 shadow-sm">
          <p className="text-xs font-semibold text-slate-900 dark:text-slate-200 mb-3">
            24-hour visual timeline
          </p>
          <div className="space-y-3">
            {[
              { label: 'Morning', sub: '6:00 – 8:00', fill: 8, color: 'bg-amber-400' },
              { label: 'University', sub: '8:00 – 17:00', fill: 75, color: 'bg-blue-500' },
              { label: 'Evening', sub: '17:00 – 22:00', fill: 42, color: 'bg-emerald-500' },
              { label: 'Night', sub: '22:00 – 6:00', fill: 33, color: 'bg-indigo-400' },
            ].map((block) => (
              <div key={block.label} className="flex items-center gap-3 text-xs">
                <div className="w-24 flex-shrink-0">
                  <p className="font-semibold text-slate-800 dark:text-slate-100">{block.label}</p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500">{block.sub}</p>
                </div>
                <div className="flex-1 h-4 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${block.color}`}
                    style={{ width: `${block.fill}%` }}
                  />
                </div>
                <span className="w-8 text-right text-[11px] text-slate-500 dark:text-slate-400 font-medium">
                  {block.fill}%
                </span>
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
          <h3 className="text-sm font-semibold text-slate-950 dark:text-slate-100">To-Do list</h3>
          <p className="text-xs text-slate-700 dark:text-slate-400">
            Tasks ordered by completion and priority.
          </p>
        </div>
        <button className="inline-flex items-center rounded-full bg-primary-500 text-white text-xs px-3 py-1.5 shadow-md hover:bg-primary-600">
          Add task
        </button>
      </div>

      <div className="rounded-2xl bg-sky-50/80 dark:bg-slate-900/80 border border-sky-200 dark:border-slate-800 divide-y divide-sky-100/80 dark:divide-slate-800/80 shadow-sm">
        {tasks.map((task) => (
          <div key={task.id} className="flex items-center gap-3 px-4 py-3 text-xs">
            <input type="checkbox" className="h-4 w-4 rounded border-slate-300 accent-sky-500" />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-slate-950 dark:text-slate-50 truncate">
                {task.title}
              </p>
              <p className="text-[11px] text-slate-700 dark:text-slate-400">
                Due: {task.due}
              </p>
            </div>
            <span className="inline-flex items-center rounded-full border border-sky-200 dark:border-slate-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-700 dark:text-slate-400 bg-white/70 dark:bg-slate-900/40">
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
