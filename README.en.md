# Jev Turtle Soup 🐢

English | [中文](./README.md)

> A situation puzzle that talks back — with Jev, your AI game master.

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](./LICENSE)
[![Built with Next.js](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)](https://nextjs.org)
[![Powered by Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![AI: Vercel AI Gateway](https://img.shields.io/badge/AI-Vercel%20AI%20Gateway-000?logo=vercel)](https://vercel.com/docs/ai-gateway)

**👉 Play it live: <https://puzzle.xiaobaozi.cn>**

---

## What is this

A **situation puzzle** (known in Chinese communities as 海龟汤, "turtle soup") works like this: the game master knows the full truth behind a strange story (the "answer"), but only reads you its eerie beginning (the "puzzle"). You chip away at the truth with questions that can only be answered **Yes / No / Irrelevant**, then wrap up by retelling the whole story in your own words.

Jev Turtle Soup puts that experience on a mobile web page:

- Read the puzzle, then ask Jev things like *"Did she really die on the boat?"* or *"Was the killer someone she knew?"*
- Jev answers only **Yes / No / Irrelevant** — and honestly admits *"I can't determine that"* when unsure;
- Stuck? Unlock up to **three hints**, one at a time;
- Think you've got it? Hit **Reveal the Truth**, write down your theory, and Jev will judge it **Solved / Almost there / Not yet**;
- Completely lost? **Publish the Answer** and read the full story.

The main experience is a mobile-first website. A lightweight native Xiaohongshu widget uses the same puzzle library, copy, and public API.

![Jev Turtle Soup main screen](docs/screenshot-play.png)

---

## Highlights

| | |
|---|---|
| 🤖 **A game master that feels human** | Jev isn't scripted — every judgment goes to an LLM and comes back with a **Yes / No / Irrelevant** verdict plus a confidence score; when unsure, Jev says so instead of guessing and misleading you. |
| 📝 **Three ways to finish** | Unlock **hints** one by one, **publish the answer** to read the full story, or **reveal the truth** and let Jev vet your theory. |
| 📚 **Hand-picked built-in library** | Around 30 puzzles out of the box (classic rewrites + originals), each with three hints, spanning suspense, deduction and twist endings. |
| 🌍 **Bilingual: EN / ZH** | One tap to switch languages; every built-in puzzle ships with a full English story, answer and hints, and your choice is remembered. |
| 📊 **Local progress** | Played and solved puzzles are marked automatically and stored on the current device. No account is required. |
| ✍️ **Player submissions** | Write your own puzzle, answer and hints in the **Create** tab; Jev reviews it before it enters the public library, with a reason if it doesn't. |
| 🛡 **Moderation dashboard** | Review, unpublish or delete submissions, with every action logged. |
| 🔗 **Share with confidence** | A share link carries only the puzzle ID — the answer never travels with the link. |
| 📱 **Mobile-first** | The website is tuned for touch; a one-page native Xiaohongshu widget is also included. |
| 🌗 **Ocean-night theme** | Dark base, rounded panels — easy on the eyes during long sessions. |

---

## The library

Classics, rewrites and originals live side by side, each with three hints. Source notes live in [`data/library-sources.md`](./data/library-sources.md) (Chinese).

> Classics: *The Person in the Photograph*, *The Letter I Wanted Returned*, *The Second Applause*, *The Child Who Grew Behind the Wall*, *A Year Too Late in the Obituary*…
>
> Originals: *The Flash in the Painting*, *Stop Calling My Name*, *The Wrong Stop*, *A Smile in the Subtitles*…

> Want to try it locally first? No backend keys needed:
>
> ```bash
> pnpm install
> cp .env.example .env.local        # leave NEXT_PUBLIC_API_URL empty
> pnpm dev
> ```
>
> Then open <http://localhost:3000> and play straight from the built-in library.

## Xiaohongshu widget

Run `pnpm sync:xiaohongshu` at the repository root, then import [`platforms/xiaohongshu`](./platforms/xiaohongshu) into the Xiaohongshu developer tool as a widget. Use base library version 3.152.1 or newer.

The widget has native Play, Library, Progress, and Create views. The sync command copies puzzle data from `data/library*.json` and interface text from `lib/i18n.ts`. Run it again after changing those source files. The widget calls the same public Cloudflare Worker API without platform sign-in. Its progress is stored locally inside Xiaohongshu and does not sync with browser progress.

Before release, add `situation-puzzle-api.xiaobaozi.cn` to the platform's allowed request domains and check the Worker URL in [`platforms/xiaohongshu/app.js`](./platforms/xiaohongshu/app.js).

---

## Acknowledgments

- Classic situation puzzles come from public community sources (Minute Mysteries, Jed Hartman's situation puzzle archive, Braingle, Puzzling Stack Exchange, and others); sources and rewrite notes are documented in [`data/library-sources.md`](./data/library-sources.md).
- Judging is powered by [Vercel AI Gateway](https://vercel.com/docs/ai-gateway), using the `typesafe-ai/jev` evaluation model.

---

## License

This project is open-sourced under the **GNU General Public License v3.0** — see the [`LICENSE`](./LICENSE) file.
