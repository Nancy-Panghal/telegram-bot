/**
 * telegram-bot/assignmentSender.js
 * Assignment prompts, text submissions, and file uploads via Telegram.
 */

const axios = require('axios')

const MAX_BYTES = 5 * 1024 * 1024
const ALLOWED_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png', 'webp', 'gif',
])

const MIME_TO_EXT = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

let _supabase, _sendMessage, _config

/** chatId -> pending submission context */
const pendingSubmissions = new Map()

function initAssignmentSender({ supabase, sendMessage, config }) {
  _supabase = supabase
  _sendMessage = sendMessage
  _config = config
}

function escMd(text) {
  return String(text || '').replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

function resolveExtension(filename, mimeType) {
  const extFromName = filename && filename.includes('.')
    ? filename.split('.').pop().toLowerCase()
    : null

  if (extFromName) {
    const normalized = extFromName === 'jpeg' ? 'jpg' : extFromName
    if (ALLOWED_EXTENSIONS.has(normalized)) return normalized
  }

  const fromMime = mimeType ? MIME_TO_EXT[mimeType.toLowerCase()] : null
  if (fromMime) return fromMime

  if (mimeType === 'application/octet-stream' && extFromName) {
    const normalized = extFromName === 'jpeg' ? 'jpg' : extFromName
    if (ALLOWED_EXTENSIONS.has(normalized)) return normalized
  }

  return null
}

function validateFile(filename, mimeType, sizeBytes) {
  if (!sizeBytes || sizeBytes <= 0) return { ok: false, error: 'File is empty' }
  if (sizeBytes > MAX_BYTES) return { ok: false, error: 'File must be 5 MB or smaller' }
  const ext = resolveExtension(filename, mimeType)
  if (!ext) {
    return {
      ok: false,
      error: 'Allowed: TXT, Markdown, PDF, Word, or images (JPG, PNG, WEBP, GIF)',
    }
  }
  return { ok: true, ext }
}

function mimeForExt(ext) {
  const map = {
    txt: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
  }
  return map[ext] || 'application/octet-stream'
}

async function getEnrollment(chatId) {
  const { data, error } = await _supabase
    .from('enrollments')
    .select('id, course_uuid, student_id, creator_id, current_lesson')
    .eq('telegram_chat_id', String(chatId))
    .order('enrolled_at', { ascending: false })
    .limit(1)

  if (error || !data?.length) return null
  return data[0]
}

async function getLesson(courseId, orderNum) {
  const { data } = await _supabase
    .from('lessons')
    .select('id, title, order_num, assignment_prompt, assignment_required, assignment_file_url, assignment_file_name')
    .eq('course_id', courseId)
    .eq('order_num', orderNum)
    .eq('is_published', true)
    .limit(1)

  return data?.[0] || null
}

async function hasSubmission(enrollmentId, lessonId) {
  const { data } = await _supabase
    .from('assignments')
    .select('id, status')
    .eq('enrollment_id', enrollmentId)
    .eq('lesson_id', lessonId)
    .maybeSingle()

  return data || null
}

async function getRequiredAssignmentBlock(enrollment, targetLessonNum) {
  if (!enrollment || targetLessonNum <= 1) return null

  const prevNum = targetLessonNum - 1
  const prevLesson = await getLesson(enrollment.course_uuid, prevNum)
  if (!prevLesson?.assignment_required || !prevLesson.assignment_prompt) return null

  const existing = await hasSubmission(enrollment.id, prevLesson.id)
  if (existing) return null

  return {
    prevLessonNum: prevNum,
    lessonId: prevLesson.id,
    title: prevLesson.title,
    prompt: prevLesson.assignment_prompt,
  }
}

async function sendAssignmentPrompt(chatId, lessonOrderNum) {
  const enrollment = await getEnrollment(chatId)
  if (!enrollment) return

  const lesson = await getLesson(enrollment.course_uuid, lessonOrderNum)
  if (!lesson?.assignment_prompt) return

  const existing = await hasSubmission(enrollment.id, lesson.id)
  const requiredLabel = lesson.assignment_required ? ' *(Required)*' : ' *(Optional)*'
  const promptText = escMd(String(lesson.assignment_prompt).slice(0, 800))

  let message = `📝 *Assignment for Lesson ${lessonOrderNum}: ${escMd(lesson.title)}*${requiredLabel}\n\n${promptText}`
  
  if (lesson.assignment_file_url) {
    message += `\n\n📎 *Attachment*: [${escMd(lesson.assignment_file_name || 'File')}](${lesson.assignment_file_url})`
  }
  
  message += `\n\nTap *Submit Assignment* then send your answer as text or attach a file \\(TXT, Markdown, PDF, Word, or image — max 5 MB\\)\\.`

  if (existing) {
    await _sendMessage(
      chatId,
      `${message}\n\n✅ You already submitted this assignment\\. Status: *${existing.status}*\\.`,
    )
    return
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: '📝 Submit Assignment', callback_data: `assign:${lessonOrderNum}` }],
    ],
  }

  if (!lesson.assignment_required) {
    keyboard.inline_keyboard.push([{ text: '▶ Next Lesson', callback_data: 'lesson' }])
  }

  await _sendMessage(
    chatId,
    message,
    keyboard,
  )
}

async function beginAssignmentSubmit(chatId, lessonOrderNum) {
  const enrollment = await getEnrollment(chatId)
  if (!enrollment) {
    await _sendMessage(chatId, 'No course connected yet\\.')
    return
  }

  const lesson = await getLesson(enrollment.course_uuid, lessonOrderNum)
  if (!lesson?.assignment_prompt) {
    await _sendMessage(chatId, 'This lesson has no assignment\\.')
    return
  }

  const existing = await hasSubmission(enrollment.id, lesson.id)
  if (existing) {
    await _sendMessage(
      chatId,
      `You already submitted this assignment\\. Status: *${existing.status}*\\.`,
    )
    return
  }

  pendingSubmissions.set(String(chatId), {
    lessonOrderNum,
    lessonId: lesson.id,
    courseId: enrollment.course_uuid,
    enrollmentId: enrollment.id,
    creatorId: enrollment.creator_id,
    studentId: enrollment.student_id,
  })

  await _sendMessage(
    chatId,
    `📝 *Submit assignment — Lesson ${lessonOrderNum}*\n\n• Type your answer as a message \\(max 2000 characters\\)\n• Or attach a file: TXT, Markdown, PDF, Word, or image \\(max 5 MB\\)\n\nSend /cancel to stop\\.`,
  )
}

async function notifyCreator(creatorId, lesson, orderNum) {
  if (!creatorId || !_config.TELEGRAM_API) return

  const { data: creator } = await _supabase
    .from('creators')
    .select('telegram_chat_id')
    .eq('id', creatorId)
    .maybeSingle()

  const chatId = creator?.telegram_chat_id
  if (!chatId) return

  try {
    await axios.post(`${_config.TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `📝 *New assignment submission*\n\nLesson ${orderNum}: ${lesson.title || ''}\n\nReview it in your dashboard.`,
      parse_mode: 'Markdown',
    }, { timeout: 10000 })
  } catch (err) {
    console.warn('[assignmentSender] creator notify failed:', err.message)
  }
}

async function uploadBufferToStorage(buffer, ext, courseId, enrollmentId, lessonId) {
  const rand = Math.random().toString(36).slice(2, 10)
  const storagePath = `assignments/${courseId}/${enrollmentId}/${lessonId}-${Date.now()}-${rand}.${ext}`

  const { error: uploadError } = await _supabase.storage
    .from('lessons')
    .upload(storagePath, buffer, {
      contentType: mimeForExt(ext),
      upsert: false,
    })

  if (uploadError) {
    throw new Error(uploadError.message)
  }

  const { data: urlData } = _supabase.storage.from('lessons').getPublicUrl(storagePath)
  return urlData.publicUrl
}

async function downloadTelegramFile(fileId) {
  const fileRes = await axios.get(`${_config.TELEGRAM_API}/getFile`, {
    params: { file_id: fileId },
    timeout: 15000,
  })

  const fileInfo = fileRes.data?.result
  if (!fileInfo?.file_path) throw new Error('Could not read file from Telegram')

  if (fileInfo.file_size && fileInfo.file_size > MAX_BYTES) {
    throw new Error('File must be 5 MB or smaller')
  }

  const fileUrl = `https://api.telegram.org/file/bot${_config.BOT_TOKEN}/${fileInfo.file_path}`
  const download = await axios.get(fileUrl, {
    responseType: 'arraybuffer',
    timeout: 60000,
    maxContentLength: MAX_BYTES + 1024,
    maxBodyLength: MAX_BYTES + 1024,
  })

  return {
    buffer: Buffer.from(download.data),
    size: download.data?.byteLength || fileInfo.file_size || 0,
    filePath: fileInfo.file_path,
  }
}

async function finalizeSubmission(chatId, pending, { submissionText, submissionUrl }) {
  const key = String(chatId)

  const existing = await hasSubmission(pending.enrollmentId, pending.lessonId)
  if (existing) {
    pendingSubmissions.delete(key)
    await _sendMessage(chatId, 'You already submitted this assignment\\.')
    return
  }

  const { error: insertErr } = await _supabase.from('assignments').insert({
    lesson_id: pending.lessonId,
    course_id: pending.courseId,
    student_id: pending.studentId || null,
    enrollment_id: pending.enrollmentId,
    submission_text: submissionText || null,
    submission_url: submissionUrl || null,
    status: 'pending',
  })

  if (insertErr) {
    console.error('[assignmentSender] insert error:', insertErr.message)
    await _sendMessage(chatId, 'Could not save your assignment\\. Please try again in a few minutes\\.')
    return
  }

  pendingSubmissions.delete(key)

  const lesson = await getLesson(pending.courseId, pending.lessonOrderNum)
  await notifyCreator(pending.creatorId, lesson || { title: '' }, pending.lessonOrderNum)

  await _sendMessage(
    chatId,
    `✅ *Assignment received*\n\nYour assignment for Lesson ${pending.lessonOrderNum} has been received\\. Your instructor will review and respond\\.`,
    { inline_keyboard: [[{ text: '▶ Next Lesson', callback_data: 'lesson' }]] },
  )
}

async function submitAssignmentText(chatId, text) {
  const key = String(chatId)
  const pending = pendingSubmissions.get(key)
  if (!pending) return false

  const trimmed = String(text || '').trim()
  if (!trimmed) {
    await _sendMessage(chatId, 'Assignment cannot be empty\\. Type your answer or attach a file, or send /cancel\\.')
    return true
  }
  if (trimmed.length > 2000) {
    await _sendMessage(chatId, 'Text must be 2000 characters or fewer\\. Please shorten or attach a file instead\\.')
    return true
  }

  await finalizeSubmission(chatId, pending, { submissionText: trimmed, submissionUrl: null })
  return true
}

async function submitAssignmentFile(chatId, message) {
  const key = String(chatId)
  const pending = pendingSubmissions.get(key)
  if (!pending) return false

  let fileId = null
  let filename = 'submission'
  let mimeType = null
  let sizeBytes = 0

  if (message.document) {
    fileId = message.document.file_id
    filename = message.document.file_name || 'submission'
    mimeType = message.document.mime_type
    sizeBytes = message.document.file_size || 0
  } else if (message.photo && message.photo.length > 0) {
    const photo = message.photo[message.photo.length - 1]
    fileId = photo.file_id
    filename = 'photo.jpg'
    mimeType = 'image/jpeg'
    sizeBytes = photo.file_size || 0
  }

  if (!fileId) {
    await _sendMessage(chatId, 'Send a supported file or type your answer as text\\.')
    return true
  }

  const validation = validateFile(filename, mimeType, sizeBytes)
  if (!validation.ok) {
    await _sendMessage(chatId, escMd(validation.error) + '\\. Try again or send /cancel\\.')
    return true
  }

  try {
    const { buffer, size } = await downloadTelegramFile(fileId)
    const finalValidation = validateFile(filename, mimeType, size || buffer.length)
    if (!finalValidation.ok) {
      await _sendMessage(chatId, escMd(finalValidation.error) + '\\.')
      return true
    }

    const submissionUrl = await uploadBufferToStorage(
      buffer,
      finalValidation.ext,
      pending.courseId,
      pending.enrollmentId,
      pending.lessonId,
    )

    await finalizeSubmission(chatId, pending, { submissionText: null, submissionUrl })
  } catch (err) {
    console.error('[assignmentSender] file submit error:', err.message)
    await _sendMessage(chatId, 'Could not process that file\\. Please try a smaller supported file or type your answer\\.')
  }

  return true
}

function cancelPending(chatId) {
  pendingSubmissions.delete(String(chatId))
}

function hasPendingSubmission(chatId) {
  return pendingSubmissions.has(String(chatId))
}

module.exports = {
  initAssignmentSender,
  sendAssignmentPrompt,
  beginAssignmentSubmit,
  submitAssignmentText,
  submitAssignmentFile,
  getRequiredAssignmentBlock,
  cancelPending,
  hasPendingSubmission,
}
