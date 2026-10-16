<div align="center">
  <img src="apps/web/public/icon.svg" width="112" alt="AI Turtle Soup" />

# AI Turtle Soup

"I'm Jev, the host of this soup. Ask boldly — I only answer Yes, No, or Irrelevant."

[![Play now](https://img.shields.io/badge/Play_sp.xiaobaozi.cn-7dd8c6?style=flat-square&labelColor=0a1522)](https://sp.xiaobaozi.cn)
[![License](https://img.shields.io/badge/License-GPL--3.0-e6c07d?style=flat-square&labelColor=0a1522)](./LICENSE)

[中文](./README.md) | English

</div>

---

## What is this

A situation puzzle (a.k.a. "turtle soup") is a question-and-answer deduction game: the host holds the full truth of a story and reads only its strange beginning (the *surface*). Players chip away at the truth with questions answerable by Yes or No, until someone can retell the whole story (the *bottom*).

Here, the host is an AI — **Jev**. It never rests, never spoils, and never hand-waves; every question goes through its judgment.

## How to play

1. **Read the surface** — pick a puzzle and read the story that just doesn't add up.
2. **Ask boldly** — "Was the killer someone she knew?" "Did she really die on the boat?" Jev answers only **Yes / No / Irrelevant**, and admits "Uncertain" when it isn't sure instead of guessing and misleading you.
3. **Stuck? Take a hint** — three hints per puzzle from different angles, unlocked one by one.
4. **Reconstruct the truth** — got it? Write down your full reasoning. Jev compares it against the answer and rules **Solved / Close / Not yet**; omitting details that don't affect the core truth is fine.
5. **Reveal the answer** — truly stuck? Confirm and read the bottom.

## Three ways to play

| Mode | For whom |
|---|---|
| 🎮 **Solo** | deducing alone, quietly: no sign-in, unlimited plays; progress stays in your own browser |
| 👥 **Multiplayer rooms** | cracking the case with friends: private rooms for up to 8, invite with a single link, questions and reasoning synced live for everyone |
| ✍️ **Create & share** | be the author: original or reposted puzzles (reposts need the original author's link), reviewed before entering the public library, ready for likes and challenges |

## Highlights

| | |
|---|---|
| 🤖 **An AI host that admits doubt** | every Jev verdict carries a confidence score — when unsure it says "Uncertain" out loud; one tap switches to a large model for a second opinion |
| 📚 **Curated library** | suspense, deduction and twists, with every adapted puzzle credited to its original author |
| 🌍 **Bilingual** | switch 中文 / English in one tap — surfaces, answers and hints, all bilingual |
| 👍 **Player ratings** | like or dislike every puzzle; the community decides what's good |
| 📱 **Mobile first** | plays straight in your phone browser; puzzles and rooms share with one link |
| 🔒 **Lightweight accounts** | sign in with an email code, Google, or LINUX DO — solo mode needs no account at all |

## FAQ

**Do I need an account?**
Not for solo mode. Rooms and creating puzzles need an account, and signing up takes nothing more than an email that can receive a code.

**Is it paid?**
Solo play is free forever; new users get their first month of membership for free.

**Where do the puzzles come from?**
Adapted from public shows by situation-puzzle creators on Bilibili and Douyin, plus platform originals; every adapted puzzle credits its author — see the acknowledgments below.

**Does it work on my phone?**
Yes — the page is designed for phones first, and desktop browsers work just as well.

---

## Acknowledgments

The built-in library is adapted from the public shows of the creators below — thanks for the great stories (per-puzzle credits and mapping live in [`data/sources.md`](./data/sources.md), Chinese):

- **[饭堂时刻](https://space.bilibili.com/216025)** (Bilibili)
- **[小小耶](https://space.bilibili.com/59693163)** (Bilibili)
- **[许二木](https://www.douyin.com/user/MS4wLjABAAAAKurkOY2XLWE80yoCF6NagcyeE-FneMrIYo8oc1vMMVU)** (Douyin)

Judging is powered by [OpenCode Zen](https://opencode.ai/zen); second opinions come from MiniMax. Thanks to the [Linux.do](https://linux.do/) community for its long-term support.

## For developers

Architecture, deployment and contribution guides: [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) and [docs/rebuild/](docs/rebuild/README.md).

## License

Open source under [GPL-3.0](LICENSE).
