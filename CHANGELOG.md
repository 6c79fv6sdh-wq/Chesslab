# Changelog

## Unreleased

- fixed a false positive that reported a slower forced mate as a missed mate;
  a move that still mates by force is no longer a confirmed error;
- added mate-classification regression tests and a real-engine order lifecycle
  test that runs from payment to delivery and skips without a Stockfish binary.

## 0.2.0 — 2026-08-06

- added deterministic two-pass Stockfish analysis from the player's point of view;
- added bounded Lichess PGN export and exact player matching;
- added versioned `analysis.json`, evidence PDF and four oriented training PGNs;
- added background worker with persisted failure/retry semantics;
- added explicit `review_pending` human-review gate, `/preview` and `/retry`;
- added source/artifact checksum correlation and stricter PGN/PDF validation;
- added Stockfish/Unicode-font Docker runtime and local analysis CLI;
- added migration `0002`, real-engine/PDF verification and expanded integration tests.

## 0.1.0 — 2026-08-06

- recovered the interrupted Telegram concierge flow;
- introduced domain/application/infrastructure/presentation boundaries;
- added payments, order audit, secure local storage, admin delivery and restart-safe file sending;
- added Alembic, Redis production FSM contract, tests and release packaging.
