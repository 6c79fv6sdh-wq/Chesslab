/**
 * Передача «доиграть вот эту партию» между вкладками приложения.
 *
 * Тот же приём, что и с планом дня (см. core/session.ts): «Мои партии»
 * помечают партию и уводят на #scramble, а «Цейтнот» на входе забирает
 * пометку и снимает её. Одноразовость важна — иначе один случайный
 * заход в архив заставлял бы восстанавливать ту же партию каждый раз,
 * когда открываешь вкладку партий.
 */

const RESUME_KEY = 'sciencechess-lab-resume-game';

export function markResumeGame(gameId: string): void {
  try {
    sessionStorage.setItem(RESUME_KEY, gameId);
  } catch {
    // Приватный режим: просто не получится доиграть по кнопке, партия цела.
  }
}

/** Идентификатор партии к доигрыванию. Снимает пометку при чтении. */
export function consumeResumeGame(): string | null {
  try {
    const id = sessionStorage.getItem(RESUME_KEY);
    sessionStorage.removeItem(RESUME_KEY);
    return id;
  } catch {
    return null;
  }
}
