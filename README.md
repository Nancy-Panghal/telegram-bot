# Kurso — Telegram Bot

Delivers Kurso course content to students over Telegram: lessons, quizzes, assignment prompts, and reminders, so students can learn from a chat instead of logging into the website.

Part of the [Kurso](https://github.com/Nancy-Panghal/course-web) platform — see that repo for the full product overview.

## What this service does

- Sends lesson content (video/PDF links, text) to enrolled students on request
- Runs quizzes and assignment submissions directly inside the chat
- Verifies every student against Kurso's Supabase database before sending anything, using signed enrollment tokens
- Generates time-limited, signed links back to the website for content that needs to be viewed there (e.g. watermarked video)

## Tech stack

Node.js, Express (webhook server), Supabase client, Telegram Bot API.

Requires a `.env` file with your own values for `TELEGRAM_BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ACADEMYKIT_URL`, and `LESSON_LINK_SECRET` — this bot doesn't run standalone; it needs a live Kurso backend to fetch course data from.