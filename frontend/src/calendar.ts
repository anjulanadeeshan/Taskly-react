export type CalendarEvent = {
  id: string
  summary?: string
  htmlLink?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
}

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
        ? `Failed to fetch calendar events (${response.status}) - ${details}`
        : `Failed to fetch calendar events (${response.status})`
    )
  }

  return (await response.json()) as GoogleCalendarEventsResponse
}

export async function getCalendarEvents(
  accessToken: string,
  query?: Partial<CalendarQuery>
): Promise<CalendarEvent[]> {
  const now = new Date()

  const defaultTimeMin = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
  const defaultTimeMax = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0)

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
