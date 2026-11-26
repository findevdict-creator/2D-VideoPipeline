/**
 * Claude could not carry on because a usage limit was reached, or because the service was
 * briefly overloaded. Nothing is wrong with the work: the run waits and continues.
 */
export class UsageLimitError extends Error {
  constructor(
    message: string,
    /** When the limit lifts, if Claude said so. */
    readonly resetAt?: Date,
    /** "limit" is the plan's usage limit; "busy" is a short overload that clears in minutes. */
    readonly cause: "limit" | "busy" = "limit",
  ) {
    super(message);
    this.name = "UsageLimitError";
  }
}

const LIMIT = /usage limit|session limit|weekly limit|hour limit|limit reached|hit your limit|reached your limit|rate.?limit|out of (extra )?usage|too many requests|\b429\b/i;
const BUSY = /overloaded|\b529\b|service unavailable|\b503\b/i;

/**
 * Read a failure message from Claude Code. Returns what it says about a usage limit, or
 * undefined when the failure is something else.
 */
export function parseUsageLimit(text: string, now = new Date()): { cause: "limit" | "busy"; resetAt?: Date } | undefined {
  if (BUSY.test(text) && !LIMIT.test(text)) return { cause: "busy" };
  if (!LIMIT.test(text)) return undefined;
  return { cause: "limit", resetAt: parseResetTime(text, now) };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The time a limit message says the limit lifts: "…|1760000000", "resets 3pm",
 * "resets 11:30pm (Europe/Berlin)", "resets Oct 9 at 10am", "resets in 2 hours".
 */
export function parseResetTime(text: string, now = new Date()): Date | undefined {
  // Older messages end in the reset time as seconds since 1970.
  const epoch = /\|\s*(\d{10})(\d{3})?\b/.exec(text);
  if (epoch) return new Date(Number(epoch[1]) * 1000);

  const relative = /resets? in\s+(?:about\s+)?(\d+(?:\.\d+)?)\s*(minute|min|hour|hr|day)s?(?:\s+(?:and\s+)?(\d+)\s*(?:minute|min)s?)?/i.exec(text);
  if (relative) {
    const unit = relative[2]!.toLowerCase();
    const minutes = Number(relative[1]) * (unit.startsWith("min") ? 1 : unit.startsWith("h") ? 60 : 1440) + Number(relative[3] ?? 0);
    return new Date(now.getTime() + minutes * 60_000);
  }

  const clock = /reset(?:s|ting)?(?:\s+(?:at|on))?\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,|\s+at)?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+\/[A-Za-z_+\-/]+|UTC)\))?/i.exec(text);
  if (!clock) return undefined;
  const month = clock[1] ? MONTHS.indexOf(clock[1].toLowerCase()) : -1;
  if (clock[1] && month < 0) return undefined;
  let hour = Number(clock[3]);
  const minute = Number(clock[4] ?? 0);
  const half = clock[5]?.toLowerCase();
  if (!half && !clock[4]) return undefined; // A bare number is not a time of day.
  if (half === "pm" && hour < 12) hour += 12;
  if (half === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  const zone = validZone(clock[6]);

  // Find the next moment, from now on, whose wall clock in that zone reads as the message says.
  const here = wallClock(now, zone);
  for (let ahead = 0; ahead <= (month >= 0 ? 366 : 1); ahead++) {
    const day = new Date(Date.UTC(here.year, here.month, here.day + ahead));
    if (month >= 0 && (day.getUTCMonth() !== month || day.getUTCDate() !== Number(clock[2]))) continue;
    const at = fromWallClock({ year: day.getUTCFullYear(), month: day.getUTCMonth(), day: day.getUTCDate(), hour, minute }, zone);
    if (at.getTime() > now.getTime()) return at;
  }
  return undefined;
}

function validZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** What a clock on the wall shows at `date`, in a time zone or in this computer's. */
function wallClock(date: Date, zone?: string): Wall {
  if (!zone) return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate(), hour: date.getHours(), minute: date.getMinutes() };
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month") - 1, day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** The moment a wall clock in a time zone shows `wall`. */
function fromWallClock(wall: Wall, zone?: string): Date {
  if (!zone) return new Date(wall.year, wall.month, wall.day, wall.hour, wall.minute);
  const asUtc = Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute);
  // Guess with the zone's offset at that time, then correct once in case the guess crossed a clock change.
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const shown = wallClock(new Date(guess), zone);
    guess += asUtc - Date.UTC(shown.year, shown.month, shown.day, shown.hour, shown.minute);
  }
  return new Date(guess);
}

/** "at 3:00 PM", or "on Thursday at 3:00 PM" when that is not today. */
export function describeTime(at: Date, now = new Date()): string {
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (at.toDateString() === now.toDateString()) return `at ${time}`;
  const days = (at.getTime() - now.getTime()) / 86_400_000;
  return days < 6 ? `on ${at.toLocaleDateString([], { weekday: "long" })} at ${time}` : `on ${at.toLocaleDateString([], { month: "long", day: "numeric" })} at ${time}`;
}
