# AI Situation Puzzles 🐢

English | [中文](./README.md)

> "I'm Jev, the host of this soup. Ask boldly — I only answer Yes, No, or Irrelevant."

**👉 Play now: <https://sp.xiaobaozi.cn>**

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
| 🎮 **Solo** | deducing alone, quietly: no sign-in, free, unlimited; progress stays in your own browser |
| 👥 **Multiplayer rooms** | cracking the case with friends: private rooms for up to 8, invite with a single link, questions and reasoning synced live for everyone |
| ✍️ **Create & share** | be the author: original or reposted puzzles (reposts need the original author's link), reviewed before entering the public library, ready for likes and challenges |

## Highlights

| | |
|---|---|
| 🤖 **An AI host that admits doubt** | every Jev verdict carries a confidence score — when unsure it says "Uncertain" out loud; one tap switches to a large model for a second opinion |
| 📚 **446 curated puzzles** | suspense, deduction and twists, with every adapted puzzle credited to its original author |
| 🌍 **Bilingual** | switch 中文 / English in one tap — surfaces, answers and hints, all bilingual |
| 👍 **Player ratings** | like or dislike every puzzle; the community decides what's good |
| 📱 **Mobile first** | plays straight in your phone browser; puzzles and rooms share with one link |
| 🔒 **Lightweight accounts** | sign in with an email code, Google, or LINUX DO — solo mode needs no account at all |

## FAQ

**Do I need an account?**
Not for solo mode. Rooms and creating puzzles need an account, and signing up takes nothing more than an email that can receive a code.

**Is it paid?**
Solo is free forever; joining a friend's room is always free. Creating rooms comes with 10 free credits per account, then sponsorship unlocks unlimited rooms (¥6/month or ¥20 lifetime) — the billing entry stays closed until our WeChat Pay merchant account is approved.

**Where do the puzzles come from?**
Three sources: adapted from the public shows of Bilibili creators 饭堂时刻 and 小小耶 and Douyin creator 许二木 (429 puzzles, each credited), plus 17 platform originals. See the acknowledgments below.

**Does it work on my phone?**
Yes — the page is designed for phones first, and desktop browsers work just as well.

---

## Acknowledgments

The built-in library (446 puzzles) draws on the following sources; the per-puzzle mapping and rewrite notes live in [`data/sources.md`](./data/sources.md) (Chinese):

- **[饭堂时刻](https://space.bilibili.com/216025)** (Bilibili creator 尕丶天堂, 93 puzzles): adapted from, or taken verbatim out of, their public show transcripts.
- **[小小耶](https://space.bilibili.com/59693163)** (Bilibili creator, 240 puzzles): adapted from, or preserved from, their situation-puzzle video transcripts.
- **[许二木](https://www.douyin.com/user/MS4wLjABAAAAKurkOY2XLWE80yoCF6NagcyeE-FneMrIYo8oc1vMMVU)** (Douyin creator, 96 puzzles): adapted from their situation-puzzle video subtitles.
- **17 platform originals**: seven borrow writing techniques from 许二木's works 《宿舍规则怪谈》 (*Dormitory Rules Horror*), 《信》 (*The Letter*) and 《双鱼》 (*Pisces*); ten take structural references from Paul Sloane's lateral thinking puzzles and the [Puzzling Stack Exchange](https://puzzling.stackexchange.com) community.

Technology and community:

- Judging is powered by [OpenCode Zen](https://opencode.ai/zen) (model `jev-1.13`); second opinions come from MiniMax.
- Thanks to the [Linux.do](https://linux.do/) community for its long-term support and sharing.

---

## For developers

Architecture, deployment and contribution guides: [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) and [docs/rebuild/](docs/rebuild/README.md).

## License

Open source under [GPL-3.0](LICENSE). Puzzle content is licensed separately from the code; sources are documented in [`data/sources.md`](./data/sources.md).
