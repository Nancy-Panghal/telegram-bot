/**
 * telegram-bot/lessonSender.js
 *
 * Changes from original:
 *  - signLessonPageUrl, encodeFingerprint, escMd are now exported
 *    so index.js can import them for sendSpecificLesson
 *  - Everything else is identical
 */

const crypto = require('crypto')
const axios  = require('axios')
const { checkRateLimit, logLessonAccess } = require('./watermark')

let _supabase, _sendMessage, _config

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
    courseId,
    lessonId,
    lesson:   String(lessonNum),
    identity,
    exp:      String(exp),
    sig,
  })

  return `${_config.ACADEMYKIT_URL}/api/lesson/view?${params.toString()}`
}

// ── Zero-width fingerprint (mirrors lib/signer.ts) ────────────────
const ZWS  = '\u200B'   // bit 0
const ZWNJ = '\u200C'   // bit 1

function encodeFingerprint(text, maxChars = 12) {
  let result = ''
  for (let i = 0; i < Math.min(text.length, maxChars); i++) {
    const code = text.charCodeAt(i)
    for (let bit = 7; bit >= 0; bit--) {
      result += (code >> bit) & 1 ? ZWNJ : ZWS
    }
  }
  return result
}

// ── Markdown escaper ──────────────────────────────────────────────
function escMd(text) {
  return String(text || '').replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

// ── Main sendLesson ────────────────────────────────────────────────
async function sendLesson(chatId) {
  // 1. Rate limit
  const { limited, retryAfterSeconds } = checkRateLimit(chatId)
  if (limited) {
    const mins = Math.ceil(retryAfterSeconds / 60)
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
      `🔒 *Free preview complete\\.*\n\nUnlock the full course to continue learning\\.`,
      { inline_keyboard: [[{ text: 'Pay and unlock course', url: courseUrl }]] }
    )
    return
  }

  // 4. Fetch lesson
  const { data: lessons, error: lessonErr } = await _supabase
    .from('lessons')
    .select('*')
    .eq('course_id', course.id)
    .eq('order_num', lessonNum)
    .eq('is_published', true)
    .limit(1)

  if (lessonErr || !lessons?.length) {
    const { count: publishedCount } = await _supabase
      .from('lessons')
      .select('id', { count: 'exact', head: true })
      .eq('course_id', course.id)
      .eq('is_published', true)

    const nextDate = course.next_lesson_date
      ? new Date(course.next_lesson_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : null
    const endDate = course.course_end_date
      ? new Date(course.course_end_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : null
    const total = course.total_lessons || publishedCount || 0
    const infoMessage = course.student_update_message
      ? escMd(String(course.student_update_message).slice(0, 500))
      : null

    await _sendMessage(
      chatId,
      [
        `You are caught up\\. Lesson ${lessonNum} is not published yet\\.`,
        `Progress: ${Math.min(lessonNum - 1, publishedCount || 0)}/${total} lessons watched\\.`,
        nextDate ? `Next lesson is planned for *${escMd(nextDate)}*\\.` : `The creator has not announced the next lesson date yet\\.`,
        endDate  ? `Course planned end date: *${escMd(endDate)}*\\.` : '',
        infoMessage ? `\nCreator note: ${infoMessage}` : '',
      ].filter(Boolean).join('\n')
    )
    return
  }

  const lesson = lessons[0]

  // 5. Generate signed lesson page URL
  const lessonUrl = signLessonPageUrl(course.id, lesson.id, lesson.order_num, String(chatId))

  // 6. Build watermarked message
  const fp = encodeFingerprint(String(chatId))
  const durationLine = lesson.duration ? `⏱ ${lesson.duration}\n` : ''

  const text = [
    `📖 *Lesson ${lesson.order_num}: ${escMd(lesson.title)}*`,
    durationLine,
    `Tap *Open Lesson* below\\. Your protected access expires in 2 hours\\.`,
    ``,
    `🔒 _This link is personal\\. Sharing it violates your license agreement\\._`,
    fp,
  ].join('\n')

  await _sendMessage(chatId, text, {
    inline_keyboard: [
      [{ text: '▶ Open Lesson', url: lessonUrl }],
      [
        { text: '✅ Mark Done', callback_data: `done:${lesson.order_num}` },
        { text: '📊 Progress',  callback_data: 'progress' },
      ],
    ],
  })

  // Update last_accessed (non-blocking)
  _supabase
    .from('enrollments')
    .update({ last_accessed: new Date().toISOString() })
    .eq('id', enrollment.id)
    .then(() => {}).catch(() => {})

  // Log access (non-blocking)
  logLessonAccess(String(chatId), lesson.id, course.id).catch(() => {})
}

// ── Helpers ────────────────────────────────────────────────────────
function isLessonAllowed(enrollment, lessonNum) {
  if (enrollment.payment_status === 'paid') return true
  const config  = enrollment.courses?.free_preview_config || 'nothing free'
  const maxFree = { 'lesson 1 free': 1, '2 lessons free': 2, '3 lessons free': 3, 'module 1 free': 3, '2 modules free': 6 }
  return lessonNum <= (maxFree[config] || 0)
}

function slugify(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim()
}

module.exports = {
  init,
  sendLesson,
  // Exported so index.js can use them in sendSpecificLesson
  signLessonPageUrl,
  encodeFingerprint,
  escMd,
}