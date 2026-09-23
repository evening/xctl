/** Best-effort parsing of X's rendered time labels (browser locale assumed en-US, same timezone as this machine). */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseClock(s: string): { h: number; m: number } | null {
  const m = s.match(/(\d{1,2}):(\d{2})\s*([AP]M)?/i);
  if (!m) return null;
  let h = Number(m[1]);
  const ap = m[3]?.toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return { h, m: Number(m[2]) };
}

/** Day part of a chat separator like "Today", "Yesterday 10:11 PM", "Mon 3:04 PM", "Sep 20", "Sep 20, 2025, 3:04 PM". */
export function parseDayLabel(label: string, now = new Date()): Date | null {
  const s = label.trim().toLowerCase();
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (s.startsWith('today')) return d;
  if (s.startsWith('yesterday')) {
    d.setDate(d.getDate() - 1);
    return d;
  }
  const wd = DAYS.findIndex(x => s.startsWith(x));
  if (wd >= 0) {
    const back = (d.getDay() - wd + 7) % 7 || 7;
    d.setDate(d.getDate() - back);
    return d;
  }
  const mm = s.match(/^([a-z]{3})[a-z]*\.? (\d{1,2})(?:,? (\d{4}))?/);
  if (mm && MONTHS.includes(mm[1])) {
    const year = mm[3] ? Number(mm[3]) : now.getFullYear();
    const r = new Date(year, MONTHS.indexOf(mm[1]), Number(mm[2]));
    if (!mm[3] && r > now) r.setFullYear(year - 1);
    return r;
  }
  return null;
}

export function isDayLabel(label: string): boolean {
  return parseDayLabel(label) !== null;
}

export function combine(day: Date | null, clock: string | null | undefined): Date | null {
  if (!day || !clock) return null;
  const c = parseClock(clock);
  if (!c) return null;
  const r = new Date(day);
  r.setHours(c.h, c.m, 0, 0);
  return r;
}

/** Day label may itself include a clock ("Yesterday 10:11 PM"). */
export function dayLabelClock(label: string): string | null {
  const m = label.match(/\d{1,2}:\d{2}\s*([AP]M)?/i);
  return m ? m[0] : null;
}

/** Inbox relative time: "now", "53m", "1h", "3d", "2w", "Yesterday", "Sep 20", "Sep 20, 2025". */
export function parseRelative(label: string, now = new Date()): Date | null {
  const s = label.trim().toLowerCase();
  if (s === 'now' || s === 'just now') return now;
  const m = s.match(/^(\d+)\s*(s|m|h|d|w|mo|y)$/);
  if (m) {
    const n = Number(m[1]);
    const mult: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5, mo: 2592e6, y: 31536e6 };
    return new Date(now.getTime() - n * mult[m[2]]);
  }
  return parseDayLabel(label, now);
}
