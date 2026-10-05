# Legal & Compliance Notes

**This document is not legal advice, and nothing in this repository
constitutes legal advice.** It's a starting checklist so you know what to
ask a real lawyer before you let strangers deposit funds into a bot you
operate. Requirements vary enormously by country/state and by exactly how
the bot is structured, so treat everything below as "things to raise with
counsel," not "things that are handled."

## Questions worth asking a lawyer before launch

- **Money transmission**: Even though wallets are non-custodial-by-design
  (users hold their own generated keypair, you never touch their main
  wallet), the backend *does* hold encrypted private keys and can move funds
  on a user's behalf via bot commands. Depending on your jurisdiction, that
  may be enough to trigger money-transmitter or virtual-asset-service-
  provider obligations (registration, bonding, KYC/AML) — this is one of
  the most commonly missed issues by hobbyist trading bots.
- **Securities/derivatives exposure**: Sniping newly-launched tokens,
  offering "copy trading," and running a leaderboard with cash prizes can
  each independently raise securities-law or gambling-law questions
  depending on how they're structured and where your users are.
- **Marketing claims**: Referral bonuses, "VIP signals," and leaderboard
  prizes need to be real and exactly as advertised. Regulators and
  platforms (Telegram, X/Twitter) both treat fabricated trade results or
  manufactured urgency as deceptive marketing — this is a fast way to get
  banned or investigated, independent of the money-transmission question
  above.
- **Data protection**: You're storing Telegram user IDs, handles, and trade
  history. Depending on your users' locations, GDPR/CCPA-style obligations
  (data access/export/deletion requests, a real privacy policy) may apply.
- **Age/jurisdiction restrictions**: Decide explicitly whether you're
  geofencing any jurisdictions and how you'll actually enforce it (self-
  attestation is weak evidence; IP-based blocking is what most comparable
  products do at minimum).

## What's implemented in code right now

- `backend/src/services/complianceService.ts` blocks `/snipe` and `/watch`
  until a user runs `/accept`, which records a timestamp in
  `users.terms_accepted_at`. This is a UX gate, not a legal opinion — swap
  the disclosure text for whatever your lawyer approves.
- No KYC/identity verification is implemented. If you need it, that's a
  separate integration (e.g. Persona, Sumsub) gating `/accept`.
- No jurisdiction blocking is implemented.

## Before you launch

1. Replace the placeholder disclosure text in `complianceService.ts` with
   language your lawyer has actually reviewed.
2. Write a real Terms of Service and Privacy Policy and link them from the
   `/accept` message and the frontend footer.
3. Decide on and implement any jurisdiction restrictions your lawyer
   recommends.
4. Keep the referral/leaderboard numbers backed by real data (already true
   in this codebase — `leaderboardService.ts` and `referralService.ts` only
   ever read from the `trades`/`referrals` tables) and keep it that way as
   you extend the marketing side.
