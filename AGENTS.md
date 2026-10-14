# Working agreements

AnswerLens is built with AI coding agents as much as by hand, so the rules are explicit.

- **One change, one commit.** Every commit should be reviewable and revertable on its own.
- **Every change ships with tests.** Run `npm test` before you push, and add or update
  assertions when behaviour changes. `npm run test:visual` drives a headless browser
  through the whole product flow and writes screenshots into `qa/`.
- **Never commit secrets.** Keys live in `.env.local` locally and in the hosting
  provider's environment variables in production; `.env.example` only lists names.
- **Never fabricate data.** Every score, quote and recommendation has to trace back to
  a real model answer. When something cannot be judged, show `-` and mark it as not
  applicable instead of inventing a number.
- **Stay honest about the limits.** If a step is mocked, client-side only, or cannot be
  verified, say so in the UI and in the README.
