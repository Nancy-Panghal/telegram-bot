/**
 * telegram-bot/lessonSender.js
 * ─────────────────────────────────────────────────────────────────
 * Drop-in replacement for the sendLesson function in index.js.
 * Uses the new /api/lesson/view signed URL so students open
 * lesson content on YOUR website (with watermark + proxy).
 *
 * HOW TO USE:
 * 1. Copy this file into telegram-bot/
 * 2. In index.js add at top:
 *    const { sendLesson } = require('./lessonSender')
 * 3. Remove the old sendLesson function from index.js
 * 4. The exported sendLesson uses the same globals from index.js
 *    — pass them in via init() below.
 * ─────────────────────────────────────────────────────────────────
 */

const crypto = require('crypto')
const axios  = require('axios')

let _supabase, _sendMessage, _config

/**
 * Call this once from index.js to wire up dependencies.
 * @param {{ supabase, sendMessage, config: { LESSON_LINK_SECRET, ACADEMYKIT_URL } }} deps
 */
function init({ supabase, sendMessage, config }) {
  _supabase    = supabase
  _sendMessage = sendMessage
  _config      = config
}

// ── Signing (mirrors lib/signer.ts) ───────────────────────────────
function signLessonPageUrl(courseId, lessonId, lessonNum, identity) {
  const TTL = 2 * 60 * 60 * 1000 // 2 hours
  const exp = Date.now() + TTL
  const payload = `lesson.${courseId}.${lessonId}.${lessonNum}.${identity}.${exp}`
  const sig = crypto
    .createHmac('sha256', _config.LESSON_LINK_SECRET)
    .update(payload)
    .digest('hex')

  const params = new URLSearchParams({
    courseId, lessonId,
    lesson: String(lessonNum),
    identity, exp: String(exp), sig,
  })

  return `${_config.ACADEMYKIT_URL}/api/lesson/view?${params.toString()}`
}

// ── Rate limiter ──────────────────────────────────────────────────
const rateLimitStore = new Map()
const RATE_WINDOW_MS = 10 * 60 * 1000
const RATE_MAX       = 5

function checkRateLimit(chatId) {
  const key = String(chatId)
  const now = Date.now()
  const entry = rateLimitStore.get(key) || { count: 0, windowStart: now }
  if (now - entry.windowStart > RATE_WINDOW_MS) {
    rateLimitStore.set(key, { count: 1, windowStart: now })
    return { limited: false }
  }
  entry.count++
  rateLimitStore.set(key, entry)
  if (entry.count > RATE_MAX) {
    const retryAfterSec = Math.ceil((RATE_WINDOW_MS - (now - entry.windowStart)) / 1000)
    return { limited: true, retryAfterSec }
  }
  return { limited: false }
}

// ── Zero-width fingerprint ─────────────────────────────────────────
const ZWS  = '\u200B'
const ZWNJ = '\u200C'
function fingerprint(text, maxChars = 12) {
  let r = ''
  for (let i = 0; i < Math.min(text.length, maxChars); i++) {
    const code = text.charCodeAt(i)
    for (let bit = 7; bit >= 0; bit--) r += (code >> bit) & 1 ? ZWNJ : ZWS
  }
  return r
}

// ── Main sendLesson ────────────────────────────────────────────────
async function sendLesson(chatId) {
  // 1. Rate limit
  const { limited, retryAfterSec } = checkRateLimit(chatId)
  if (limited) {
    const mins = Math.ceil(retryAfterSec / 60)
    await _sendMessage(
      chatId,
      `⏳ *Slow down\\!*\n\nYou're requesting lessons too quickly\\. Please wait *${mins} minute${mins > 1 ? 's' : ''}* before requesting the next lesson\\.`
    )
    return
  }

  // 2. Get enrollment (most recent for this chatId)
  const { data: enrollments, error: enrollErr } = await _supabase
    .from('enrollments')
    .select('*, courses:course_uuid(*)')
    .eq('telegram_chat_id', String(chatId))
    .order('enrolled_at', { ascending: false })
    .limit(1)

  if (enrollErr || !enrollments?.length || !enrollments[0].courses) {
    await _sendMessage(chatId, 'No course connected yet\\. Open your course page and tap *Start on Telegram* first\\.')
    return
  }

  const enrollment = enrollments[0]
  const course     = enrollment.courses
  const lessonNum  = enrollment.current_lesson || 1

  // 3. Free preview check
  const allowed = isLessonAllowed(enrollment, lessonNum)
  if (!allowed) {
    const courseUrl = `${_config.ACADEMYKIT_URL}/about-course/${slugify(course.host_name || 'creator')}/${slugify(course.name || 'course')}/${course.id}`
    await _sendMessage(
      chatId,
      `🔒 *Free preview complete\\.*\n\nUnlock all lessons here:\n${courseUrl}`
    )
    return
  }

  // 4. Fetch lesson (no module join — avoids FK error)
  const { data: lesson, error: lessonErr } = await _supabase
    .from('lessons')
    .select('*')
    .eq('course_id', course.id)
    .eq('order_num', lessonNum)
    .eq('is_published', true)
    .limit(1)
    .single()

  if (lessonErr || !lesson) {
    await _sendMessage(chatId, `No published lesson found for lesson ${lessonNum}\\.`)
    return
  }

  // 5. Generate signed lesson page URL (opens on your website with watermark)
  const lessonUrl = signLessonPageUrl(course.id, lesson.id, lesson.order_num, String(chatId))

  // 6. Build watermarked message with invisible fingerprint
  const fp = fingerprint(String(chatId))
  const durationLine = lesson.duration ? `⏱ ${lesson.duration}\n` : ''

  const text = [
    `📖 *Lesson ${lesson.order_num}: ${escMd(lesson.title)}*`,
    durationLine,
    `🔗 Your protected lesson link \\(expires in 2 hours\\):`,
    lessonUrl,
    ``,
    `🔒 _This link is personal\\. Sharing it violates your license agreement\\._`,
    fp,
  ].join('\n')

  // 7. Send message — fire-and-forget logging
  await _sendMessage(chatId, text, {
    inline_keyboard: [
      [{ text: '▶ Open Lesson', url: lessonUrl }],
      [
        { text: '✅ Mark Done', callback_data: `done:${lesson.order_num}` },
        { text: '📊 Progress',  callback_data: 'progress' },
      ],
    ],
  })

  // 8. Update last_accessed (non-blocking)
  _supabase
    .from('enrollments')
    .update({ last_accessed: new Date().toISOString() })
    .eq('id', enrollment.id)
    .then(() => {}).catch(() => {})

  // 9. Log access for piracy detection (non-blocking)
  _supabase
    .from('lesson_access_logs')
    .insert({ chat_id: String(chatId), lesson_id: lesson.id, course_id: course.id, accessed_at: new Date().toISOString() })
    .then(() => {}).catch(() => {})
}

// ── Helpers ────────────────────────────────────────────────────────
function isLessonAllowed(enrollment, lessonNum) {
  if (enrollment.payment_status === 'paid') return true
  const config = enrollment.courses?.free_preview_config || 'nothing free'
  const maxFree = { 'lesson 1 free': 1, '2 lessons free': 2, '3 lessons free': 3, 'module 1 free': 3, '2 modules free': 6 }
  return lessonNum <= (maxFree[config] || 0)
}

function slugify(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim()
}

function escMd(text) {
  return String(text || '').replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

module.exports = { init, sendLesson }