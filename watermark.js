/**
 * telegram-bot/watermark.js
 *
 * Telegram-side watermark helpers.
 * Since Telegram renders HTML pages via the signed lesson URL,
 * the main watermark is on the lesson viewer page (WatermarkedPlayer).
 *
 * This file provides shared utilities:
 *  1. Rate limiting per chat_id — prevents bulk lesson scraping
 *  2. Zero-width fingerprinting — detects content sharing
 *  3. Access logging — tracks piracy signals
 *
 * Usage in index.js:
 *   const { initWatermark } = require('./watermark')
 *   initWatermark(supabase)
 */

const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')

// Default supabase instance — will be overridden by init()
let _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

/**
 * Initialize watermark module with the shared Supabase instance.
 * Call this once from index.js after creating supabase.
 */
function initWatermark(supabase) {
  _supabase = supabase
}

// ── Rate limit store (in-memory; swap for Redis in production) ───────────────
const rateLimitStore = new Map()
const RATE_WINDOW_MS = 10 * 60 * 1000  // 10 minutes
const RATE_MAX_LESSONS = 5             // max 5 lesson requests per 10 min

/**
 * Returns true if this chatId is requesting lessons too fast.
 * @param {string|number} chatId
 * @returns {{ limited: boolean, retryAfterSeconds: number }}
 */
function checkRateLimit(chatId) {
  const key = String(chatId)
  const now = Date.now()
  const entry = rateLimitStore.get(key) || { count: 0, windowStart: now, firstRequest: now }

  if (now - entry.windowStart > RATE_WINDOW_MS) {
    // New window
    rateLimitStore.set(key, { count: 1, windowStart: now, firstRequest: now })
    return { limited: false, retryAfterSeconds: 0 }
  }

  entry.count += 1
  rateLimitStore.set(key, entry)

  if (entry.count > RATE_MAX_LESSONS) {
    const retryAfterMs = RATE_WINDOW_MS - (now - entry.windowStart)
    return {
      limited: true,
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    }
  }

  return { limited: false, retryAfterSeconds: 0 }
}

/**
 * Builds the lesson message text with embedded watermark and anti-piracy notice.
 *
 * @param {object} params
 * @param {object} params.lesson        - lesson row from DB
 * @param {object} params.course        - course row from DB
 * @param {object} params.enrollment    - enrollment row from DB
 * @param {string} params.streamUrl     - signed lesson viewer URL
 * @param {string|number} params.chatId - Telegram chat ID
 * @returns {string} formatted message text (Markdown)
 */
function buildLessonMessage({ lesson, course, enrollment, streamUrl, chatId }) {
  const studentName = enrollment.student_name || enrollment.phone || `User ${String(chatId).slice(-4)}`
  const moduleLine = lesson.module_name ? `📂 *${lesson.module_name}*\n` : ''
  const durationLine = lesson.duration ? `⏱ Duration: ${lesson.duration}\n` : ''

  // Short fingerprint — not shown to user but embedded as invisible chars
  // Using zero-width spaces to encode chatId bits (survives copy-paste of text)
  const fingerprint = encodeFingerprint(String(chatId))

  const message = [
    `${moduleLine}`,
    `📖 Lesson ${lesson.order_num}: *${lesson.title}*`,
    durationLine,
    ``,
    `🔗 Your protected lesson link \\(expires in 1 hour\\):`,
    streamUrl,
    ``,
    `─────────────────────`,
    `🔒 Licensed to: *${studentName}*`,
    `📋 Course: ${course.name || 'Your Course'}`,
    `⚠️ This link is personal\\. Sharing it is a violation of your license agreement and may result in account suspension\\.`,
    `─────────────────────`,
    fingerprint, // zero-width encoded chatId — invisible but present
  ].join('\n')

  return message
}

/**
 * Encodes a string as zero-width Unicode characters.
 * These survive copy-paste and are invisible to readers.
 * If shared content leaks, we can decode the chatId from the text.
 *
 * Zero-width space (U+200B) = 0 bit
 * Zero-width non-joiner (U+200C) = 1 bit
 *
 * @param {string} text - text to encode (chatId as string)
 * @returns {string} invisible encoded string
 */
function encodeFingerprint(text) {
  const ZWS = '\u200B'  // 0
  const ZWNJ = '\u200C' // 1

  let result = ''
  for (let i = 0; i < Math.min(text.length, 12); i++) {
    const code = text.charCodeAt(i)
    for (let bit = 7; bit >= 0; bit--) {
      result += (code >> bit) & 1 ? ZWNJ : ZWS
    }
  }
  return result
}

/**
 * Decodes a zero-width fingerprint back to the original string.
 * Use this if leaked content is found to identify the source.
 *
 * @param {string} encoded - string containing zero-width chars
 * @returns {string} decoded chatId
 */
function decodeFingerprint(encoded) {
  const ZWS = '\u200B'
  const ZWNJ = '\u200C'

  const zwChars = encoded.split('').filter(c => c === ZWS || c === ZWNJ)
  let result = ''

  for (let i = 0; i < zwChars.length; i += 8) {
    let code = 0
    for (let bit = 0; bit < 8; bit++) {
      if (zwChars[i + bit] === ZWNJ) code |= (1 << (7 - bit))
    }
    if (code > 0) result += String.fromCharCode(code)
  }

  return result
}

/**
 * Logs lesson access to Supabase for audit trail.
 * Detects if the same course is being accessed from multiple Telegram accounts (piracy signal).
 *
 * @param {string|number} chatId
 * @param {string} lessonId
 * @param {string} courseId
 */
async function logLessonAccess(chatId, lessonId, courseId) {
  try {
    // Insert access log
    await _supabase.from('lesson_access_logs').insert({
      chat_id: String(chatId),
      lesson_id: lessonId,
      course_id: courseId,
      accessed_at: new Date().toISOString(),
    })

    // Check for suspicious multi-account access (same course, 3+ different chat_ids in 24h)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: recentAccess } = await _supabase
      .from('lesson_access_logs')
      .select('chat_id')
      .eq('course_id', courseId)
      .gte('accessed_at', since)

    if (recentAccess) {
      const uniqueChatIds = new Set(recentAccess.map(r => r.chat_id))
      if (uniqueChatIds.size >= 3 && !uniqueChatIds.has(String(chatId))) {
        console.warn(
          `[watermark] ⚠️ Suspicious: course ${courseId} accessed from ${uniqueChatIds.size + 1} Telegram accounts in 24h. Chat IDs: ${[...uniqueChatIds, String(chatId)].join(', ')}`
        )
        // In production: alert creator via email/notification
      }
    }
  } catch (err) {
    // Non-critical — don't let logging failure break lesson delivery
    console.error('[watermark] Log error:', err.message)
  }
}

/**
 * Builds the rate limit exceeded message.
 * @param {number} retryAfterSeconds
 * @returns {string}
 */
function rateLimitMessage(retryAfterSeconds) {
  const minutes = Math.ceil(retryAfterSeconds / 60)
  return (
    `⏳ You're requesting lessons too quickly.\n\n` +
    `To protect course content, there's a limit of ${RATE_MAX_LESSONS} lessons per ${RATE_WINDOW_MS / 60000} minutes.\n\n` +
    `Please wait *${minutes} minute${minutes > 1 ? 's' : ''}* before requesting the next lesson.`
  )
}

module.exports = {
  initWatermark,
  checkRateLimit,
  buildLessonMessage,
  logLessonAccess,
  rateLimitMessage,
  encodeFingerprint,
  decodeFingerprint,
}