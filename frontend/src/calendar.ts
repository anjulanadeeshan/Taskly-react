export type CalendarEvent = {
  id: string
  summary?: string
  description?: string
  htmlLink?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
}

export type NewCalendarEventInput = {
  summary: string
  allDay: boolean
  start: Date
  end: Date
}

const TASKLY_EVENT_MARKER = 'Created by Taskly'

type GoogleApiErrorBody = {
  error?: {
    code?: number
    message?: string
    errors?: Array<{ message?: string; domain?: string; reason?: string }>
    status?: string
  }
}

type GoogleCalendarEventsResponse = {
  items?: CalendarEvent[]
  nextPageToken?: string
}

type CalendarQuery = {
  timeMin: Date
  timeMax: Date
  maxResults?: number
}

function toLocalIsoDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

async function parseApiError(response: Response, action: string): Promise<never> {
  let details = ''
  try {
    const bodyText = await response.text()
    if (bodyText) {
      try {
        const body = JSON.parse(bodyText) as GoogleApiErrorBody
        const reason = body.error?.errors?.[0]?.reason
        const message = body.error?.message ?? bodyText
        details = reason ? `${reason}: ${message}` : message
      } catch {
        details = bodyText
      }
    }
  } catch {
    // ignore
  }

  throw new Error(
    details
      ? `Failed to ${action} (${response.status}) - ${details}`
      : `Failed to ${action} (${response.status})`
  )
}

async function fetchCalendarPage(params: {
  accessToken: string
  timeMin: string
  timeMax: string
  maxResults: number
  pageToken?: string
}): Promise<GoogleCalendarEventsResponse> {
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events')
  url.searchParams.set('timeMin', params.timeMin)
  url.searchParams.set('timeMax', params.timeMax)
  url.searchParams.set('orderBy', 'startTime')
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('maxResults', String(params.maxResults))
  if (params.pageToken) url.searchParams.set('pageToken', params.pageToken)

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
    },
  })

  if (!response.ok) {
    await parseApiError(response, 'fetch calendar events')
  }

  return (await response.json()) as GoogleCalendarEventsResponse
}

export async function getCalendarEvents(
  accessToken: string,
  query?: Partial<CalendarQuery>
): Promise<CalendarEvent[]> {
  const now = new Date()

  const defaultTimeMin = new Date(now.getFullYear() - 1, 0, 1, 0, 0, 0, 0)        // Jan 1 last year
  const defaultTimeMax = new Date(now.getFullYear() + 1, 11, 31, 23, 59, 59, 999) // Dec 31 next year

  const timeMin = query?.timeMin ?? defaultTimeMin
  const timeMax = query?.timeMax ?? defaultTimeMax
  const maxResults = query?.maxResults ?? 250

  const items: CalendarEvent[] = []
  let pageToken: string | undefined

  // Google Calendar API maxResults is <= 2500; we keep a safe value.
  for (let i = 0; i < 20; i++) {
    const page = await fetchCalendarPage({
      accessToken,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults,
      pageToken,
    })
    items.push(...(page.items ?? []))
    pageToken = page.nextPageToken
    if (!pageToken) break
  }

  return items
}

export async function createCalendarEvent(
  accessToken: string,
  input: NewCalendarEventInput
): Promise<CalendarEvent> {
  const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

  const body = input.allDay
    ? {
        summary: input.summary,
        description: TASKLY_EVENT_MARKER,
        start: { date: toLocalIsoDate(input.start) },
        end: { date: toLocalIsoDate(input.end) },
      }
    : {
        summary: input.summary,
        description: TASKLY_EVENT_MARKER,
        start: { dateTime: input.start.toISOString(), timeZone: timezone },
        end: { dateTime: input.end.toISOString(), timeZone: timezone },
      }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    await parseApiError(response, 'create calendar event')
  }

  return (await response.json()) as CalendarEvent
}
