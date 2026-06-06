if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

// Telegram bot for AcademyKit courses

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const { sendLesson, signLessonPageUrl, encodeFingerprint, escMd } = require("./lessonSender");
const { initWatermark } = require("./watermark");
const { initQuizSender, sendQuiz } = require("./quizSender");

const app = express();
app.use(express.json({ limit: "2mb" }));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const ACADEMYKIT_URL = (process.env.ACADEMYKIT_URL || "").replace(/\/$/, "");
const LESSON_LINK_SECRET =
  process.env.TELEGRAM_LINK_SECRET ||
  process.env.WHATSAPP_LINK_SECRET ||
  WEBHOOK_SECRET;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

// Initialize shared watermark and lessonSender modules with supabase
initWatermark(supabase);
const { init: initLessonSender } = require("./lessonSender");
initLessonSender({
  supabase,
  sendMessage: async (chatId, text, keyboard) =>
    sendMessage(chatId, text, keyboard),
  config: {
    LESSON_LINK_SECRET,
    ACADEMYKIT_URL,
  },
});

initQuizSender({ supabase, config: { TELEGRAM_API } });

Object.entries({
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  ACADEMYKIT_URL,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,
}).forEach(([key, value]) =>
  console.log(`${key}: ${value ? "loaded" : "MISSING"}`),
);

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

function maxFreeLessons(config) {
  if (config === "lesson 1 free") return 1;
  if (config === "2 lessons free") return 2;
  if (config === "3 lessons free") return 3;
  if (config === "module 1 free") return 3;
  if (config === "2 modules free") return 6;
  return 0;
}

async function firstRow(query) {
  const { data, error } = await query.limit(1);
  if (error) {
    console.error("Supabase error:", error.message);
    return null;
  }
  return data?.[0] || null;
}

function courseUrl(course) {
  return `${ACADEMYKIT_URL}/course/${slugify(course.host_name || "creator")}/${slugify(course.name || course.slug || "course")}/${course.id}`;
}

function lessonAllowed(enrollment, lessonNumber) {
  if (enrollment.payment_status === "paid") return true;
  return (
    lessonNumber <=
    maxFreeLessons(enrollment.courses?.free_preview_config || "nothing free")
  );
}

function signResourceUrl(lessonId, type, identity) {
  const exp = Date.now() + 2 * 60 * 60 * 1000;
  const payload = `resource.${lessonId}.${type}.${identity}.${exp}`;
  const sig = crypto
    .createHmac("sha256", LESSON_LINK_SECRET)
    .update(payload)
    .digest("hex");
  const params = new URLSearchParams({
    type,
    identity: String(identity),
    exp: String(exp),
    sig,
  });
  return `${ACADEMYKIT_URL}/resource/${lessonId}?${params.toString()}`;
}

async function sendMessage(chatId, text, keyboard) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    protect_content: true,
    disable_web_page_preview: true,
  };

  if (keyboard) body.reply_markup = keyboard;

  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, body, { timeout: 10000 });
  } catch (err) {
    const fallbackKeyboard = webAppKeyboardToUrl(keyboard);
    const description = err.response?.data?.description || "";
    if (!fallbackKeyboard || !description.includes("BUTTON_TYPE_INVALID")) {
      throw err;
    }

    await axios.post(
      `${TELEGRAM_API}/sendMessage`,
      { ...body, reply_markup: fallbackKeyboard },
      { timeout: 10000 },
    );
  }
}

function webAppKeyboardToUrl(keyboard) {
  if (!keyboard?.inline_keyboard) return null;

  let changed = false;
  const inline_keyboard = keyboard.inline_keyboard.map((row) =>
    row.map((button) => {
      if (!button.web_app?.url) return button;
      changed = true;
      const { web_app, ...rest } = button;
      return { ...rest, url: web_app.url };
    }),
  );

  return changed ? { ...keyboard, inline_keyboard } : null;
}

async function answerCallback(callbackQueryId) {
  if (!callbackQueryId) return;
  await axios
    .post(`${TELEGRAM_API}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
    })
    .catch(() => {});
}

async function getEnrollment(chatId) {
  return firstRow(
    supabase
      .from("enrollments")
      .select("*, courses:course_uuid(*)")
      .eq("telegram_chat_id", String(chatId))
      .order("enrolled_at", { ascending: false }),
  );
}

// Fixes BUG 3: bot creating second free enrollment alongside paid one
// Fixes BUG 8: token marked used before enrollment confirmed
// Rule: token is ONLY marked used AFTER enrollment is verified

async function handleStart(chatId, token) {
  if (!token) {
    await sendMessage(
      chatId,
      "Welcome to AcademyKit.\n\nOpen a course page and tap *Start on Telegram* to connect your course.",
    );
    return;
  }

  // 1. Find valid unused token
  const tokenRow = await firstRow(
    supabase
      .from("telegram_tokens")
      .select("*")
      .eq("token", token)
      .eq("used", false)
      .gt("expires_at", new Date().toISOString()),
  );

  if (!tokenRow) {
    await sendMessage(
      chatId,
      "This Telegram link is invalid or has expired. Please open the course page and tap *Start on Telegram* again.",
    );
    return;
  }

  const courseId = tokenRow.course_id;

  // 2. Verify course still exists (FK protects this but double-check for clear error message)
  const { data: courseRows } = await supabase
    .from("courses")
    .select("id, name")
    .eq("id", courseId)
    .limit(1);

  if (!courseRows?.length) {
    await sendMessage(chatId, "This course is no longer available.");
    // Mark token used so it cannot be retried
    await supabase
      .from("telegram_tokens")
      .update({ used: true, used_at: new Date().toISOString() })
      .eq("id", tokenRow.id);
    return;
  }

  // 3. Upsert student record
  let student = null;

  if (tokenRow.student_auth_id) {
    const { data } = await supabase
      .from("students")
      .select("id")
      .eq("auth_id", tokenRow.student_auth_id)
      .limit(1);
    student = data?.[0] || null;
  }
  if (!student && tokenRow.student_email) {
    const { data } = await supabase
      .from("students")
      .select("id")
      .eq("email", tokenRow.student_email)
      .limit(1);
    student = data?.[0] || null;
  }
  if (!student) {
    const { data: inserted, error: insertErr } = await supabase
      .from("students")
      .insert({
        auth_id: tokenRow.student_auth_id || null,
        email: tokenRow.student_email || null,
        name: tokenRow.student_name || null,
        phone: tokenRow.student_phone || null,
      })
      .select("id")
      .single();
    if (insertErr) {
      console.error("[handleStart] student insert error:", insertErr.message);
      await sendMessage(
        chatId,
        "Something went wrong linking your account. Please try the link again.",
      );
      return; // Do NOT mark token used — student can retry
    }
    student = inserted;
  }

  const phoneOrEmail =
    tokenRow.student_phone || tokenRow.student_email || String(chatId);
  const isPaid = Boolean(tokenRow.payment_id);

  // 4. BUG 3 FIX: Find existing enrollment by EVERY identifier before inserting
  // Priority: student_id → phone → existing telegram enrollment for this course
  let existingEnrollment = null;

  if (student?.id) {
    const { data } = await supabase
      .from("enrollments")
      .select(
        "id, payment_status, completed_lessons, current_lesson, quiz_results",
      )
      .eq("course_uuid", courseId)
      .eq("student_id", student.id)
      .limit(1);
    existingEnrollment = data?.[0] || null;
  }

  if (!existingEnrollment && phoneOrEmail) {
    const { data } = await supabase
      .from("enrollments")
      .select(
        "id, payment_status, completed_lessons, current_lesson, quiz_results",
      )
      .eq("course_uuid", courseId)
      .eq("phone", phoneOrEmail)
      .limit(1);
    existingEnrollment = data?.[0] || null;
  }

  if (!existingEnrollment) {
    const { data } = await supabase
      .from("enrollments")
      .select(
        "id, payment_status, completed_lessons, current_lesson, quiz_results",
      )
      .eq("course_uuid", courseId)
      .eq("telegram_chat_id", String(chatId))
      .limit(1);
    existingEnrollment = data?.[0] || null;
  }

  const now = new Date().toISOString();

  // 5. Update or create enrollment — never downgrade payment_status from paid to free
  let enrollmentId = null;
  let enrollError = null;

  if (existingEnrollment) {
    // Only upgrade payment_status, never downgrade
    const newPaymentStatus =
      existingEnrollment.payment_status === "paid"
        ? "paid"
        : isPaid
          ? "paid"
          : "free";

    const { error } = await supabase
      .from("enrollments")
      .update({
        telegram_chat_id: String(chatId),
        student_id: student?.id || existingEnrollment.student_id || null,
        phone: phoneOrEmail,
        payment_status: newPaymentStatus,
        payment_id:
          tokenRow.payment_id || existingEnrollment.payment_id || null,
        last_telegram_sync: now,
        last_accessed: now,
      })
      .eq("id", existingEnrollment.id);

    enrollError = error;
    enrollmentId = existingEnrollment.id;
  } else {
    // Fresh enrollment
    const { data: inserted, error } = await supabase
      .from("enrollments")
      .insert({
        phone: phoneOrEmail,
        course_uuid: courseId,
        creator_id: tokenRow.creator_id,
        student_id: student?.id || null,
        telegram_chat_id: String(chatId),
        current_lesson: 1,
        payment_id: tokenRow.payment_id || null,
        payment_status: isPaid ? "paid" : "free",
        completed_lessons: [],
        quiz_results: [],
        amount_paid: 0,
        last_telegram_sync: now,
        last_accessed: now,
      })
      .select("id")
      .single();

    enrollError = error;
    enrollmentId = inserted?.id || null;
  }

  // 6. BUG 8 FIX: Only mark token used AFTER enrollment is confirmed
  if (enrollError || !enrollmentId) {
    console.error(
      "[handleStart] enrollment upsert failed:",
      enrollError?.message,
    );
    await sendMessage(
      chatId,
      "Something went wrong saving your enrollment. Please tap the link again — your access token is still valid.",
    );
    return; // Do NOT mark token used — student can retry
  }

  // Enrollment confirmed — now safe to consume the token
  await supabase
    .from("telegram_tokens")
    .update({ used: true, used_at: now })
    .eq("id", tokenRow.id);

  await sendMessage(
  chatId,
  `✅ You're connected\\! Tap below to start learning\\.\n\n📚 You can also view all your enrolled courses at any time:`,
  {
    inline_keyboard: [
      [{ text: "▶ Start Lesson", callback_data: "lesson" }],
      [{ text: "📊 My Progress", callback_data: "progress" }],
      [{ text: "📚 My Courses Dashboard", url: `${ACADEMYKIT_URL}/my-courses` }],
    ],
  },
);
}

// Fixes BUG 5: uses /api/lesson/complete so progress is stored identically
//              to web — same code path, same DB write
// Fixes BUG 10: adds Previous Lesson button
// Fixes BUG 6: quiz tracked via API

async function markDone(chatId, lessonNumber) {
  const enrollment = await getEnrollment(chatId);
  if (!enrollment || !enrollment.courses) {
    await sendMessage(chatId, "No course connected yet.");
    return;
  }

  // Call the web API so both platforms write progress the same way
  try {
    const res = await fetch(`${ACADEMYKIT_URL}/api/lesson/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identity: String(chatId), // Telegram path (no enrollmentId)
        lessonNum: lessonNumber,
        courseId: enrollment.course_uuid,
        source: "telegram",
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error("[markDone] API error:", err);
      // Fall through — still show buttons so student isn't stuck
    }
  } catch (err) {
    console.error("[markDone] fetch error:", err.message);
  }

  // Fetch the lesson for its resource links + quiz
  const lesson = await firstRow(
    supabase
      .from("lessons")
      .select("id, summary_url, notes_url, quiz_questions")
      .eq("course_id", enrollment.course_uuid)
      .eq("order_num", lessonNumber)
      .eq("is_published", true),
  );

  // Fetch prev/next lesson order numbers to enable navigation
  const { data: adjacentLessons } = await supabase
    .from("lessons")
    .select("order_num, title")
    .eq("course_id", enrollment.course_uuid)
    .eq("is_published", true)
    .in("order_num", [lessonNumber - 1, lessonNumber + 1]);

  const prevLesson =
    adjacentLessons?.find((l) => l.order_num === lessonNumber - 1) || null;
  const nextLesson =
    adjacentLessons?.find((l) => l.order_num === lessonNumber + 1) || null;

  const keyboard = [];

  // Resources
  if (lesson?.summary_url) {
    keyboard.push([
      {
        text: "📄 Summary",
        url: signResourceUrl(lesson.id, "summary", chatId),
      },
    ]);
  }
  if (lesson?.notes_url) {
    keyboard.push([
      { text: "📝 Notes", url: signResourceUrl(lesson.id, "notes", chatId) },
    ]);
  }

  // Quiz — native Telegram poll (BUG 6 fix)
  const hasQuiz =
    Array.isArray(lesson?.quiz_questions) && lesson.quiz_questions.length > 0;
  if (hasQuiz) {
    keyboard.push([
      { text: "🧠 Take Quiz", callback_data: `quiz:${lessonNumber}` },
    ]);
  }

  // Navigation row — prev and next together
  const navRow = [];
  if (prevLesson) {
    navRow.push({
      text: `⬅ Lesson ${prevLesson.order_num}`,
      callback_data: `goto:${prevLesson.order_num}`,
    });
  }
  if (nextLesson) {
    navRow.push({
      text: `Lesson ${nextLesson.order_num} ➡`,
      callback_data: "lesson",
    });
  }
  if (navRow.length) keyboard.push(navRow);

  keyboard.push([{ text: "📊 Progress", callback_data: "progress" }]);

  await sendMessage(
    chatId,
    `✅ *Lesson ${lessonNumber} marked complete.*\n\nWhat would you like to do next?`,
    { inline_keyboard: keyboard },
  );
}

async function sendProgress(chatId) {
  const enrollment = await getEnrollment(chatId);
  if (!enrollment || !enrollment.courses) {
    await sendMessage(chatId, "No course is connected yet.");
    return;
  }

  const completed = (enrollment.completed_lessons || []).length;
  const total = enrollment.courses.total_lessons || 0;
  const percent =
  total > 0 ? Math.min(Math.round((completed / total) * 100), 100) : 0;
  await sendMessage(
    chatId,
    `Progress: ${completed}/${total} lessons complete (${percent}%).\nCurrent lesson: ${enrollment.current_lesson || 1}`,
    {
      inline_keyboard: [[{ text: "Continue", callback_data: "lesson" }]],
    },
  );
}

async function removeInlineKeyboard(chatId, messageId) {
  try {
    await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] }
    }, { timeout: 5000 });
  } catch (err) {
    console.error("[removeInlineKeyboard] failed:", err.message);
  }
}

async function sendSpecificLesson(chatId, lessonOrderNum) {
  // Re-use sendLesson logic but for a specific lesson number
  // Update enrollment current_lesson to the requested number
  const enrollment = await getEnrollment(chatId)
  if (!enrollment) {
    await sendMessage(chatId, 'No course connected. Open the course page first.')
    return
  }
 
  // Allow going to previous lessons (lifetime access)
  // Don't update current_lesson backwards — keep it as the highest reached
  const { data: lessons } = await supabase
    .from('lessons')
    .select('id, title, order_num, quiz_questions')
    .eq('course_id', enrollment.course_uuid)
    .eq('order_num', lessonOrderNum)
    .eq('is_published', true)
    .limit(1)
 
  const lesson = lessons?.[0]
  if (!lesson) {
    await sendMessage(chatId, `Lesson ${lessonOrderNum} is not available yet.`)
    return
  }
 
  // Check access
  const isPaid = enrollment.payment_status === 'paid'
  if (!isPaid) {
    const config = enrollment.courses?.free_preview_config || 'nothing free'
    const maxFree = { 'lesson 1 free': 1, '2 lessons free': 2, '3 lessons free': 3, 'module 1 free': 3, '2 modules free': 6 }
    const limit = maxFree[config] || 0
    if (lessonOrderNum > limit) {
      const course = enrollment.courses
      const courseUrl = `${ACADEMYKIT_URL}/about-course/${slugify(course?.host_name || 'creator')}/${slugify(course?.name || 'course')}/${enrollment.course_uuid}`
      await sendMessage(chatId, '🔒 This lesson is locked. Enroll to unlock the full course.', {
        inline_keyboard: [[{ text: 'Pay and unlock course', url: courseUrl }]],
      })
      return
    }
  }
 
  const lessonUrl = signLessonPageUrl(enrollment.course_uuid, lesson.id, lesson.order_num, String(chatId))
  const fp = encodeFingerprint(String(chatId))
 
  // Detect if this is a review/watch-again scenario
  const isWatchAgain = lesson.order_num < (enrollment.current_lesson || 1)
  const headerText = isWatchAgain
    ? `🔄 *Watching Again: Lesson ${lesson.order_num}: ${escMd(lesson.title)}*`
    : `📖 *Lesson ${lesson.order_num}: ${escMd(lesson.title)}*`

  const keyboard = [
    [{ text: '▶ Open Lesson', url: lessonUrl }],
    [
      { text: '✅ Mark Done', callback_data: `done:${lesson.order_num}` },
      { text: '📊 Progress', callback_data: 'progress' },
    ],
  ]

  const navRow = []
  if (lesson.order_num > 1) {
    navRow.push({
      text: `⬅ Lesson ${lesson.order_num - 1}`,
      callback_data: `goto:${lesson.order_num - 1}`,
    })
  }

  // Check if next published lesson exists
  const { data: nextLessons } = await supabase
    .from('lessons')
    .select('order_num')
    .eq('course_id', enrollment.course_uuid)
    .eq('order_num', lesson.order_num + 1)
    .eq('is_published', true)
    .limit(1)

  if (nextLessons && nextLessons.length > 0) {
    navRow.push({
      text: `Lesson ${lesson.order_num + 1} ➡`,
      callback_data: `goto:${lesson.order_num + 1}`,
    })
  }

  if (navRow.length > 0) {
    keyboard.push(navRow)
  }

  await sendMessage(
    chatId,
    `${headerText}\n\nTap *Open Lesson* below. Access expires in 2 hours.\n\n🔒 _This link is personal. Do not share it._\n${fp}`,
    { inline_keyboard: keyboard }
  )
 
  await supabase
    .from('enrollments')
    .update({ last_accessed: new Date().toISOString(), last_telegram_sync: new Date().toISOString() })
    .eq('id', enrollment.id)
    .then(() => {}).catch(() => {})
}

// ── Replace handleUpdate in index.js with this ──────────────────
// Wires all new callbacks: goto:N, quiz:N, done:N

async function handleUpdate(update) {
  try {
    if (update.message) {
      const chatId = update.message.chat.id;
      const text = update.message.text || "";

      if (text.startsWith("/start")) {
        const token = text.split(" ")[1] || "";
        if (token.startsWith("done_")) {
          const lessonNumber = Number(token.replace("done_", ""));
          return markDone(chatId, lessonNumber);
        }
        return handleStart(chatId, token);
      }
      if (text === "/lesson" || text === "/next") return sendLesson(chatId);
      if (text === "/progress") return sendProgress(chatId);
      if (text === "/done") {
        const enrollment = await getEnrollment(chatId);
        return markDone(chatId, enrollment?.current_lesson || 1);
      }

      return sendMessage(
        chatId,
        "Use /lesson to get your next lesson, or /progress to check your progress.",
      );
    }

    if (update.callback_query) {
      const chatId = update.callback_query.message.chat.id;
      const messageId = update.callback_query.message.message_id;
      const data = update.callback_query.data || "";
      await answerCallback(update.callback_query.id);

      // Disable/remove buttons on the clicked message to prevent double-clicking or scrolling back to old CTAs
      await removeInlineKeyboard(chatId, messageId);

      if (data === "lesson") return sendLesson(chatId);
      if (data === "progress") return sendProgress(chatId);
      if (data.startsWith("done:"))
        return markDone(chatId, Number(data.replace("done:", "")));
      if (data.startsWith("quiz:"))
        return sendQuiz(chatId, Number(data.replace("quiz:", "")));
      // Previous/specific lesson navigation
      if (data.startsWith("goto:")) {
        const targetNum = Number(data.replace("goto:", ""));
        return sendSpecificLesson(chatId, targetNum);
      }
    }
  } catch (err) {
    console.error("[handleUpdate] unhandled error:", err.message, err.stack);
    // Don't let one user's error crash the whole webhook
  }
}

app.post("/webhook", async (req, res) => {
  const secretHeader = req.header("x-telegram-bot-api-secret-token");
  if (WEBHOOK_SECRET && secretHeader !== WEBHOOK_SECRET) {
    res.sendStatus(401);
    return;
  }

  res.sendStatus(200);
  try {
    await handleUpdate(req.body);
  } catch (err) {
    console.error("Telegram handler error:", err.response?.data || err.message);
  }
});

app.get("/", (req, res) => {
  res.json({
    status: "AcademyKit Telegram bot running",
    time: new Date().toISOString(),
  });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`Telegram bot running on port ${PORT}`));
