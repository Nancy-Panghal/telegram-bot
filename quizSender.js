/**
 * telegram-bot/quizSender.js
 * ─────────────────────────────────────────────────────────────────
 * Sends lesson quiz questions as native Telegram quiz polls.
 * Each question is a poll with type:'quiz' — Telegram shows the
 * correct answer automatically after the student taps an option.
 * A final score summary is sent after all questions.
 *
 * Usage in index.js:
 *   const { initQuizSender, sendQuiz } = require('./quizSender')
 *   initQuizSender({ supabase, config: { TELEGRAM_API } })
 *
 * Then in handleUpdate callback_query handler:
 *   if (data.startsWith('quiz:')) return sendQuiz(chatId, Number(data.replace('quiz:', '')))
 * ─────────────────────────────────────────────────────────────────
 */

const axios = require('axios')

let _supabase, _config

/**
 * Call once from index.js after creating supabase.
 * @param {{ supabase, config: { TELEGRAM_API: string } }} deps
 */
function initQuizSender({ supabase, config }) {
  _supabase = supabase
  _config = config
}

/**
 * Fetches the lesson for the given order number from the student's
 * active enrollment, then sends each quiz question as a native
 * Telegram quiz poll. Sends a score summary at the end.
 *
 * @param {string|number} chatId
 * @param {number} lessonOrderNum
 */
async function sendQuiz(chatId, lessonOrderNum) {
  // 1. Get enrollment + course
  const { data: enrollments, error: enrollErr } = await _supabase
    .from('enrollments')
    .select('*, courses:course_uuid(*)')
    .eq('telegram_chat_id', String(chatId))
    .order('enrolled_at', { ascending: false })
    .limit(1)

  if (enrollErr || !enrollments?.length || !enrollments[0].courses) {
    await sendMessage(chatId, 'No course connected yet. Open your course page and tap *Start on Telegram* first.')
    return
  }

  const enrollment = enrollments[0]
  const courseId = enrollment.course_uuid

  // 2. Fetch the lesson
  const { data: lessons, error: lessonErr } = await _supabase
    .from('lessons')
    .select('id, title, order_num, quiz_questions')
    .eq('course_id', courseId)
    .eq('order_num', lessonOrderNum)
    .eq('is_published', true)
    .limit(1)

  if (lessonErr || !lessons?.length) {
    await sendMessage(chatId, 'Lesson not found.')
    return
  }

  const lesson = lessons[0]
  const questions = Array.isArray(lesson.quiz_questions) ? lesson.quiz_questions : []

  if (questions.length === 0) {
    await sendMessage(chatId, `No quiz available for *${escMd(lesson.title)}* yet.`)
    return
  }

  // 3. Intro message
  await sendMessage(
    chatId,
    `📝 *Quiz: ${escMd(lesson.title)}*\n\n${questions.length} question${questions.length !== 1 ? 's' : ''} — tap your answer for each one. Correct answer is shown automatically after you respond.`
  )

  // Small delay so intro is read before first question
  await sleep(800)

  // 4. Send each question as a native Telegram quiz poll
  let correctCount = 0
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]

    // Validate question has required fields
    if (!q.question || !Array.isArray(q.options) || q.options.length < 2) continue

    // Telegram quiz poll requires:
    //   - question: string (1-300 chars)
    //   - options: string[] (2-10 items, each 1-100 chars)
    //   - correct_option_id: 0-based index of correct answer
    //   - type: 'quiz'
    //   - is_anonymous: false so we can track (though scores are local)
    const safeQuestion = String(q.question).slice(0, 300)
    const safeOptions = q.options
      .map(opt => String(opt).slice(0, 100))
      .filter(Boolean)
      .slice(0, 10)

    const correctIdx = Math.max(
      0,
      Math.min(Number(q.answerIndex ?? 0), safeOptions.length - 1)
    )

    try {
      await axios.post(`${_config.TELEGRAM_API}/sendPoll`, {
        chat_id: chatId,
        question: safeQuestion,
        options: safeOptions,
        type: 'quiz',
        correct_option_id: correctIdx,
        is_anonymous: false,
        protect_content: true,
        // explanation shown after student answers (optional, max 200 chars)
        // explanation: q.explanation || undefined,
      })
    } catch (err) {
      console.error(`[quizSender] sendPoll error for question ${i + 1}:`, err.response?.data || err.message)
      // Don't abort — keep sending remaining questions
    }

    // Stagger polls so they don't all appear at once
    if (i < questions.length - 1) await sleep(600)
  }

  // 5. Score summary + next action buttons
  await sleep(1000)
  await sendMessage(
    chatId,
    `✅ *Quiz sent\\!*\n\nAnswer each poll above\\. Telegram shows the correct answer right after you respond\\.\n\nTotal questions: *${questions.length}*`,
    {
      inline_keyboard: [
        [{ text: '▶ Next Lesson', callback_data: 'lesson' }],
        [{ text: '📊 My Progress', callback_data: 'progress' }],
      ],
    }
  )
}

// ── Helpers ────────────────────────────────────────────────────────

async function sendMessage(chatId, text, keyboard) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    protect_content: true,
    disable_web_page_preview: true,
  }
  if (keyboard) body.reply_markup = keyboard
  await axios.post(`${_config.TELEGRAM_API}/sendMessage`, body, { timeout: 10000 })
}

function escMd(text) {
  return String(text || '').replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = { initQuizSender, sendQuiz }