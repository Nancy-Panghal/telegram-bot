/**
 * telegram-bot/ratingSender.js
 * Post-certificate 1–5 star rating collection via Telegram, two steps:
 *   1) tap a "⭐N" inline button (Telegram has no WhatsApp-style 3-button
 *      cap, so a real 5-button row is workable here)
 *   2) optional follow-up written feedback (or "skip"), sent as a normal
 *      text message
 *
 * Mirrors assignmentSender.js's pending-state pattern: a row keyed to the
 * student's enrollment tracks where they are in the flow, checked before
 * general text routing in index.js, and cleared once the rating is saved
 * (or the flow is cancelled).
 */

let _supabase, _sendMessage

function initRatingSender({ supabase, sendMessage }) {
  _supabase = supabase
  _sendMessage = sendMessage
}

async function getEnrollmentIdForChat(chatId) {
  const { data } = await _supabase
    .from('enrollments')
    .select('id')
    .eq('telegram_chat_id', String(chatId))
    .order('enrolled_at', { ascending: false })
    .limit(1)
  return data?.[0]?.id || null
}

async function getPendingRating(chatId) {
  const enrollmentId = await getEnrollmentIdForChat(chatId)
  if (!enrollmentId) return null
  const { data } = await _supabase
    .from('pending_ratings')
    .select('*')
    .eq('enrollment_id', enrollmentId)
    .maybeSingle()
  return data || null
}

async function hasPendingRating(chatId) {
  return !!(await getPendingRating(chatId))
}

async function clearPendingRating(pending) {
  await _supabase.from('pending_ratings').delete().eq('id', pending.id)
}

async function cancelPendingRating(chatId) {
  const pending = await getPendingRating(chatId)
  if (!pending) return
  await clearPendingRating(pending)
  await _sendMessage(chatId, 'Rating cancelled.')
}

/**
 * Called right after the certificate CTA is sent in markDone(). Starts the
 * rating flow only if a certificate actually exists for this enrollment
 * and the student hasn't already rated the course.
 */
async function maybePromptForRating(chatId, enrollment) {
  if (!enrollment?.id) return

  const { data: cert } = await _supabase
    .from('certificates')
    .select('student_name')
    .eq('enrollment_id', enrollment.id)
    .maybeSingle()
  if (!cert) return

  const { data: existingRating } = await _supabase
    .from('course_ratings')
    .select('id')
    .eq('enrollment_id', enrollment.id)
    .maybeSingle()
  if (existingRating) return

  const { error: upsertError } = await _supabase
    .from('pending_ratings')
    .upsert({
      student_id: enrollment.student_id || null,
      enrollment_id: enrollment.id,
      course_id: enrollment.course_uuid,
      student_name: cert.student_name,
      stage: 'awaiting_rating',
      rating: null,
    }, { onConflict: 'enrollment_id' })

  if (upsertError) {
    console.error('[ratingSender] upsert error:', upsertError.message)
    return
  }

  await _sendMessage(chatId, '⭐ How would you rate this course?', {
    inline_keyboard: [
      [
        { text: '⭐1', callback_data: 'rate:1' },
        { text: '⭐2', callback_data: 'rate:2' },
        { text: '⭐3', callback_data: 'rate:3' },
        { text: '⭐4', callback_data: 'rate:4' },
        { text: '⭐5', callback_data: 'rate:5' },
      ],
    ],
  })
}

/** Handles a tap on one of the ⭐N inline buttons. */
async function handleRatingStarTap(chatId, star) {
  const pending = await getPendingRating(chatId)
  if (!pending || pending.stage !== 'awaiting_rating') return false

  const n = Number(star)
  if (!Number.isInteger(n) || n < 1 || n > 5) return false

  await _supabase
    .from('pending_ratings')
    .update({ rating: n, stage: 'awaiting_review' })
    .eq('id', pending.id)

  await _sendMessage(
    chatId,
    'Thanks! Want to add a short review? Send your feedback as a message, or reply *skip*.',
  )
  return true
}

/** Handles the follow-up free-text review message (or "skip"). */
async function handleRatingReviewText(chatId, text) {
  const pending = await getPendingRating(chatId)
  if (!pending || pending.stage !== 'awaiting_review') return false

  const trimmed = String(text || '').trim()
  const reviewText = trimmed.toLowerCase() === 'skip' ? null : (trimmed.slice(0, 1000) || null)

  const { error } = await _supabase.from('course_ratings').insert({
    course_id: pending.course_id,
    enrollment_id: pending.enrollment_id,
    student_name: pending.student_name,
    rating: pending.rating,
    review_text: reviewText,
  })

  await clearPendingRating(pending)

  if (error) {
    if (error.code === '23505') {
      await _sendMessage(chatId, 'You already rated this course. Thank you!')
    } else {
      console.error('[ratingSender] insert error:', error.message)
      await _sendMessage(chatId, 'Could not save your rating. Please try again later.')
    }
    return true
  }

  await _sendMessage(chatId, '🙏 Thanks for rating this course!')
  return true
}

module.exports = {
  initRatingSender,
  maybePromptForRating,
  hasPendingRating,
  handleRatingStarTap,
  handleRatingReviewText,
  cancelPendingRating,
}