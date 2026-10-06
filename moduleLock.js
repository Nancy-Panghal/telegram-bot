/**
 * telegram-bot/moduleLock.js
 *
 * Module release-schedule lock check for the bot. KEEP IN SYNC BY HAND with
 * course-web/src/lib/moduleLock.ts and src/lib/releaseSchedule.ts (no shared package).
 *
 * Policy:
 *   - all_at_once, no module, a module with no release rule -> UNLOCKED
 *   - fixed_calendar    -> locked until module.unlock_date (same for everyone)
 *   - per_student_drip  -> locked until the student's own moment, computed in IST
 *                          calendar days (never enrolled_at + N*24h)
 *   - missing/unparseable data -> UNLOCKED. A paying student is never locked out by a data gap.
 */

const IST_OFFSET_MS = 330 * 60 * 1000 // +05:30, no DST
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}$/
const MODES = ['all_at_once', 'fixed_calendar', 'per_student_drip']

function normalizeDeliveryMode(value) {
  return MODES.includes(value) ? value : 'all_at_once'
}

function normalizeUnlockTime(value) {
  if (typeof value === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(value)) return value.slice(0, 5)
  return '09:00'
}

function istDateFromIso(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10)
}

function addCalendarDays(date, days) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

function computePerStudentUnlockAt(enrolledAt, unlockAfterDays, unlockTime) {
  if (!enrolledAt || !Number.isInteger(unlockAfterDays) || unlockAfterDays < 0) return null
  // Day 0 = available the moment the student enrolls: no unlock moment exists, so never locked.
  if (unlockAfterDays === 0) return null
  const istDate = istDateFromIso(enrolledAt)
  if (!istDate) return null
  const date = addCalendarDays(istDate, unlockAfterDays)
  const time = normalizeUnlockTime(unlockTime)
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) return null
  const d = new Date(`${date}T${time}:00+05:30`)
  return Number.isNaN(d.getTime()) ? null : d
}

// Pure rule. Returns { locked: false } or { locked: true, unlockAt: ISO, moduleName }.
function evaluateModuleLock({ deliveryMode, unlockTime, module: mod, enrolledAt, now }) {
  const at = now || new Date()
  const mode = normalizeDeliveryMode(deliveryMode)
  if (mode === 'all_at_once' || !mod) return { locked: false }

  let unlockAt = null
  if (mode === 'fixed_calendar') {
    if (!mod.unlock_date) return { locked: false }
    const d = new Date(mod.unlock_date)
    if (Number.isNaN(d.getTime())) return { locked: false }
    unlockAt = d
  } else {
    if (mod.unlock_after_days === null || mod.unlock_after_days === undefined) return { locked: false }
    unlockAt = computePerStudentUnlockAt(enrolledAt, Number(mod.unlock_after_days), unlockTime)
    if (!unlockAt) return { locked: false }
  }

  if (at.getTime() >= unlockAt.getTime()) return { locked: false }
  return { locked: true, unlockAt: unlockAt.toISOString(), moduleName: mod.name || null }
}

// DB-backed. `course` and `enrollment` are the rows the bot already has
// (course comes from the enrollments join `courses:course_uuid(*)`).
async function getLessonLock(supabase, { course, lesson, enrollment, now }) {
  if (!lesson || !lesson.module_id) return { locked: false }
  if (normalizeDeliveryMode(course && course.delivery_mode) === 'all_at_once') return { locked: false }

  const { data: mod } = await supabase
    .from('course_modules')
    .select('name, unlock_date, unlock_after_days')
    .eq('id', lesson.module_id)
    .maybeSingle()

  return evaluateModuleLock({
    deliveryMode: course.delivery_mode,
    unlockTime: course.delivery_unlock_time,
    module: mod,
    enrolledAt: enrollment && enrollment.enrolled_at,
    now,
  })
}

// "8 Oct 2026, 9:00 am IST"
function formatUnlockAt(iso) {
  return (
    new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }) + ' IST'
  )
}

module.exports = {
  evaluateModuleLock,
  computePerStudentUnlockAt,
  getLessonLock,
  formatUnlockAt,
  normalizeDeliveryMode,
}