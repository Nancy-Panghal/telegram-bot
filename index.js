if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config()
}

const express = require('express')
const axios = require('axios')
const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')

const app = express()
app.use(express.json({ limit: '2mb' }))

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || ''
const ACADEMYKIT_URL = (process.env.ACADEMYKIT_URL || '').replace(/\/$/, '')
const LESSON_LINK_SECRET = process.env.TELEGRAM_LINK_SECRET || process.env.WHATSAPP_LINK_SECRET || WEBHOOK_SECRET
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

Object.entries({
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  ACADEMYKIT_URL,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,
}).forEach(([key, value]) => console.log(`${key}: ${value ? 'loaded' : 'MISSING'}`))

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
}

function maxFreeLessons(config) {
  if (config === 'lesson 1 free') return 1
  if (config === '2 lessons free') return 2
  if (config === '3 lessons free') return 3
  if (config === 'module 1 free') return 3
  if (config === '2 modules free') return 6
  return 0
}

async function firstRow(query) {
  const { data, error } = await query.limit(1)
  if (error) {
    console.error('Supabase error:', error.message)
    return null
  }
  return data?.[0] || null
}

function courseUrl(course) {
  return `${ACADEMYKIT_URL}/course/${slugify(course.host_name || 'creator')}/${slugify(course.name || course.slug || 'course')}/${course.id}`
}

function signedLessonUrl(course, lesson, chatId) {
  const exp = Date.now() + 60 * 60 * 1000
  const payload = `${course.id}.${lesson.id}.${lesson.order_num}.${chatId}.${exp}`
  const sig = crypto.createHmac('sha256', LESSON_LINK_SECRET).update(payload).digest('hex')
  const params = new URLSearchParams({
    courseId: course.id,
    lessonId: lesson.id,
    lesson: String(lesson.order_num),
    chatId: String(chatId),
    exp: String(exp),
    sig,
  })
  return `${ACADEMYKIT_URL}/api/telegram/lesson?${params.toString()}`
}

function lessonAllowed(enrollment, lessonNumber) {
  if (enrollment.payment_status === 'paid') return true
  return lessonNumber <= maxFreeLessons(enrollment.courses?.free_preview_config || 'nothing free')
}

async function sendMessage(chatId, text, keyboard) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    protect_content: true,
    disable_web_page_preview: false,
  }

  if (keyboard) body.reply_markup = keyboard

  await axios.post(`${TELEGRAM_API}/sendMessage`, body, { timeout: 10000 })
}

async function answerCallback(callbackQueryId) {
  if (!callbackQueryId) return
  await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: callbackQueryId }).catch(() => {})
}

async function getEnrollment(chatId) {
  return firstRow(
    supabase
      .from('enrollments')
      .select('*, courses:course_uuid(*)')
      .eq('telegram_chat_id', String(chatId))
      .order('enrolled_at', { ascending: false })
  )
}

async function handleStart(chatId, token) {
  if (!token) {
    await sendMessage(chatId, 'Welcome to AcademyKit.\n\nOpen a course page and tap *Start on Telegram* to connect your course.')
    return
  }

  const tokenRow = await firstRow(
    supabase
      .from('telegram_tokens')
      .select('*')
      .eq('token', token)
      .eq('used', false)
      .gt('expires_at', new Date().toISOString())
  )

  if (!tokenRow) {
    await sendMessage(chatId, 'This Telegram access link is invalid or expired. Please open the course page and generate a new link.')
    return
  }

  let student = tokenRow.student_auth_id
    ? await firstRow(supabase.from('students').select('id').eq('auth_id', tokenRow.student_auth_id))
    : null

  if (!student && tokenRow.student_email) {
    student = await firstRow(supabase.from('students').select('id').eq('email', tokenRow.student_email))
  }

  if (!student) {
    const { data: insertedStudent, error } = await supabase
      .from('students')
      .insert({
        auth_id: tokenRow.student_auth_id || null,
        email: tokenRow.student_email || null,
        name: tokenRow.student_name || null,
        phone: tokenRow.student_phone || null,
      })
      .select('id')
      .limit(1)
    if (error) throw error
    student = insertedStudent?.[0] || null
  }

  const existing = student?.id
    ? await firstRow(
        supabase
          .from('enrollments')
          .select('id, payment_status')
          .eq('course_uuid', tokenRow.course_id)
          .eq('student_id', student.id)
      )
    : null

  const payload = {
    phone: tokenRow.student_phone || tokenRow.student_email || String(chatId),
    course_uuid: tokenRow.course_id,
    creator_id: tokenRow.creator_id,
    student_id: student?.id || null,
    telegram_chat_id: String(chatId),
    current_lesson: 1,
    payment_id: tokenRow.payment_id || null,
    payment_status: tokenRow.payment_id ? 'paid' : 'free',
  }

  if (existing) {
    await supabase.from('enrollments').update(payload).eq('id', existing.id)
  } else {
    await supabase.from('enrollments').insert(payload)
  }

  await supabase.from('telegram_tokens').update({ used: true, used_at: new Date().toISOString() }).eq('id', tokenRow.id)

  await sendMessage(chatId, 'Your course is connected to Telegram. Tap below to start learning.', {
    inline_keyboard: [[{ text: 'Start lesson', callback_data: 'lesson' }], [{ text: 'Progress', callback_data: 'progress' }]],
  })
}

async function sendLesson(chatId) {
  const enrollment = await getEnrollment(chatId)
  if (!enrollment || !enrollment.courses) {
    await sendMessage(chatId, 'No course is connected yet. Open your course page and tap *Start on Telegram* first.')
    return
  }

  const course = enrollment.courses
  const lessonNumber = enrollment.current_lesson || 1

  if (!lessonAllowed(enrollment, lessonNumber)) {
    await sendMessage(chatId, `Your free preview is complete.\n\nUnlock the full course here:\n${courseUrl(course)}`)
    return
  }

  const lesson = await firstRow(
    supabase
      .from('lessons')
      .select('*, course_modules:module_id(name)')
      .eq('course_id', course.id)
      .eq('order_num', lessonNumber)
      .eq('is_published', true)
  )

  if (!lesson) {
    await sendMessage(chatId, `No published lesson found for lesson ${lessonNumber}.`)
    return
  }

  const url = signedLessonUrl(course, lesson, chatId)
  const moduleLine = lesson.course_modules?.name ? `Module: ${lesson.course_modules.name}\n` : ''
  await sendMessage(
    chatId,
    `${moduleLine}Lesson ${lesson.order_num}: *${lesson.title}*\n${lesson.duration ? `Duration: ${lesson.duration}\n` : ''}\nProtected link expires in 1 hour:\n${url}`,
    { inline_keyboard: [[{ text: 'Mark done', callback_data: `done:${lesson.order_num}` }], [{ text: 'Progress', callback_data: 'progress' }]] }
  )

  await supabase.from('enrollments').update({ last_accessed: new Date().toISOString() }).eq('id', enrollment.id)
}

async function markDone(chatId, lessonNumber) {
  const enrollment = await getEnrollment(chatId)
  if (!enrollment || !enrollment.courses) {
    await sendMessage(chatId, 'No course is connected yet.')
    return
  }

  const completed = Array.isArray(enrollment.completed_lessons) ? [...enrollment.completed_lessons] : []
  if (!completed.includes(lessonNumber)) completed.push(lessonNumber)

  await supabase
    .from('enrollments')
    .update({
      completed_lessons: completed,
      current_lesson: lessonNumber + 1,
      last_accessed: new Date().toISOString(),
    })
    .eq('id', enrollment.id)

  await sendMessage(chatId, 'Lesson marked complete. Ready for the next one?', {
    inline_keyboard: [[{ text: 'Next lesson', callback_data: 'lesson' }], [{ text: 'Progress', callback_data: 'progress' }]],
  })
}

async function sendProgress(chatId) {
  const enrollment = await getEnrollment(chatId)
  if (!enrollment || !enrollment.courses) {
    await sendMessage(chatId, 'No course is connected yet.')
    return
  }

  const completed = (enrollment.completed_lessons || []).length
  const total = enrollment.courses.total_lessons || 0
  const percent = total > 0 ? Math.min(Math.round((completed / total) * 100), 100) : 0
  await sendMessage(chatId, `Progress: ${completed}/${total} lessons complete (${percent}%).\nCurrent lesson: ${enrollment.current_lesson || 1}`, {
    inline_keyboard: [[{ text: 'Continue', callback_data: 'lesson' }]],
  })
}

async function handleUpdate(update) {
  if (update.message) {
    const chatId = update.message.chat.id
    const text = update.message.text || ''
    if (text.startsWith('/start')) {
      const token = text.split(' ')[1] || ''
      return handleStart(chatId, token)
    }
    if (text === '/lesson' || text === '/next') return sendLesson(chatId)
    if (text === '/progress') return sendProgress(chatId)
    if (text === '/done') {
      const enrollment = await getEnrollment(chatId)
      return markDone(chatId, enrollment?.current_lesson || 1)
    }
    return sendMessage(chatId, 'Use /lesson, /progress, or open your course page and tap Start on Telegram.')
  }

  if (update.callback_query) {
    const chatId = update.callback_query.message.chat.id
    const data = update.callback_query.data || ''
    await answerCallback(update.callback_query.id)
    if (data === 'lesson') return sendLesson(chatId)
    if (data === 'progress') return sendProgress(chatId)
    if (data.startsWith('done:')) return markDone(chatId, Number(data.replace('done:', '')))
  }
}

app.post('/webhook', async (req, res) => {
  const secretHeader = req.header('x-telegram-bot-api-secret-token')
  if (WEBHOOK_SECRET && secretHeader !== WEBHOOK_SECRET) {
    res.sendStatus(401)
    return
  }

  res.sendStatus(200)
  try {
    await handleUpdate(req.body)
  } catch (err) {
    console.error('Telegram handler error:', err.response?.data || err.message)
  }
})

app.get('/', (req, res) => {
  res.json({ status: 'AcademyKit Telegram bot running', time: new Date().toISOString() })
})

const PORT = process.env.PORT || 3002
app.listen(PORT, () => console.log(`Telegram bot running on port ${PORT}`))
