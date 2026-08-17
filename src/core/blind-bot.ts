/**
 * «Слепой» бот — имитация настоящего новичка 300–400, а не «Stockfish
 * послабее» и не Maia на широкой температуре.
 *
 * ТЗ не придумано на глаз, а собрано у тренера с реальными учениками
 * этого уровня:
 *  - мат в один ход видят довольно редко — что свой, что чужой;
 *  - следуют своей идее, но по пути подставляют фигуры, пытаясь её
 *    реализовать — то есть план у них ЕСТЬ, слепота именно тактическая;
 *  - если соперник напал сразу на две фигуры, замечают только одну;
 *  - зевков много за партию, мелких и крупных, но не на каждом ходу —
 *    цельная игра идёт, просто регулярно прерывается зевком;
 *  - при этом не должен быть настолько лёгким, чтобы его обыграл
 *    человек, вообще не умеющий играть в шахматы.
 *
 * Почему не Maia. У сети нет обучающих партий такого уровня — 1100 у неё
 * уже нижняя граница, и даже 5-6-й по вероятности ход в её списке — это
 * ход, который РЕАЛЬНО играли живые 1100, а не бессмысленная подстава.
 * Тактической слепоты в её словаре ходов попросту нет, сколько кандидатов
 * ни бери (подробности — в bots.ts).
 *
 * Почему не Stockfish, вообще ни на какой глубине. Первая версия этого
 * файла пыталась получить слепоту через МАЛУЮ ГЛУБИНУ поиска у самого
 * Stockfish — идея была в том, что на depth 4 движок якобы не достаёт до
 * подставы за два хода. На замере (e2e/strength.ts) это дало ACPL ~80 —
 * уровень около 1900, то есть даже depth 1 играл почти без зевков.
 * Причина: quiescence-поиск досчитывает разменные последовательности ЗА
 * пределами номинальной глубины почти всегда — «малая глубина» отключает
 * стратегию, но не тактику. Ослабить Stockfish глубиной, оставаясь
 * честным по силе, не получится в принципе.
 *
 * Поэтому «своя идея» здесь — не поиск движком, а локальная эвристика по
 * доске (взятие, шах, тяга в центр) без какого-либо заглядывания вперёд:
 * реальная, а не имитированная слепота к последствиям. Мат в один ход,
 * свой и чужой, — тоже проверка симуляцией «сыграть и посмотреть на
 * isCheckmate()», а не поиск движком: это ТОЧНО, дёшево и не зависит от
 * глубины. Движок остаётся только там, где без него не обойтись —
 * оценить, насколько серьёзна угроза материалу в оставшихся кандидатах:
 * «есть ли там что-то плохое» решает эвристика и симуляция мата, а
 * «сколько сантипешек это стоит» — только настоящий Stockfish.
 *
 *  1. Мат в один ход, свой или чужой, — отдельная проверка с шансом
 *     «не заметить», а не часть общего решения: реальные новички зевают
 *     его даже когда всё остальное соображают верно.
 *  2. «Своя идея» — несколько верхних ходов по локальной эвристике:
 *     план есть и он последователен (взятие/шах/центр), но совершенно
 *     не видит, что случится ПОСЛЕ хода соперника.
 *  3. Перед ходом — ОДНА проверка серьёзности материальной угрозы
 *     (одна реплика соперника на глубине threatDepth). Дальше решает не
 *     движок, а шанс seeMaterialThreatChance: заметили — пробуем другую
 *     идею, не заметили — играем как задумали, подставляя фигуру. Как
 *     только находится ход, который либо безопасен, либо угрозу решили
 *     не разглядывать, бот на нём и останавливается — вторую проблему в
 *     той же позиции уже не ищет. Отсюда и «два зевка сразу — замечают
 *     только один».
 */

import {
  allLegalMoves,
  capturedRole,
  fenOf,
  keyOf,
  PIECE_VALUE,
  squareDistance,
  type Chess,
  type NormalMove,
} from './chess';
import type { AnalysisLine, Analyser } from './engine';
import type { Key } from 'chessground/types';

export type { Analyser, AnalysisLine };

export interface BlindProfile {
  /** Сколько верхних ходов по локальной эвристике вообще рассматриваем. */
  ideaWidth: number;
  /** Глубина проверки серьёзности ОДНОЙ угрозы соперника после кандидата. */
  threatDepth: number;
  /** Порог потери в сантипешках, ниже которого угрозу не замечают вовсе. */
  threatThreshold: number;
  /** Шанс всё же заметить и поставить свой мат в один ход. */
  seeOwnMateChance: number;
  /** Шанс всё же заметить и отбить мат в один ход от соперника. */
  seeOpponentMateChance: number;
  /**
   * Шанс всё же заметить обычную (не матовую) угрозу материалу и пойти
   * другим ходом. Это именно ШАНС, не автоматическое избегание: угрозу
   * находит честный Stockfish, а реагировать на неё или нет — решает
   * рандом. Настоящая слепота живёт здесь, а не в глубине поиска.
   */
  seeMaterialThreatChance: number;
}

/**
 * Стартовые параметры под новичка 300–400. Числа — рабочая гипотеза,
 * не измеренный факт (в отличие от Maia-ботов, тут нет реальных партий
 * для сверки): подгонять по факту игры с живыми учениками и по замеру
 * e2e/strength.ts.
 */
export const BEGINNER_PROFILE: BlindProfile = {
  ideaWidth: 3,
  threatDepth: 6,
  threatThreshold: 250,
  seeOwnMateChance: 0.2,
  seeOpponentMateChance: 0.25,
  seeMaterialThreatChance: 0.3,
};

/**
 * На ступеньку сильнее «Дебютанта», не более: та же слепота (та же
 * механика, тот же threatThreshold), но замечает найденное заметно
 * чаще. Не отдельный движок и не другая идея игры — просто более
 * внимательный ученик того же типа. Числа опять же рабочая гипотеза,
 * подгонять по замеру e2e/strength.ts и по факту игры с учениками.
 */
export const STUDENT_PROFILE: BlindProfile = {
  ideaWidth: 3,
  threatDepth: 6,
  threatThreshold: 250,
  seeOwnMateChance: 0.35,
  seeOpponentMateChance: 0.4,
  seeMaterialThreatChance: 0.45,
};

const CENTER: Key[] = ['e4', 'd4', 'e5', 'd5'];

/** Ставит ли этот ход мат прямо сейчас — точной симуляцией, не поиском. */
function deliversMate(pos: Chess, move: NormalMove): boolean {
  const next = pos.clone();
  next.play(move);
  return next.isCheckmate();
}

/** Есть ли у стороны, чей ход в `pos`, мат в один ход — тоже симуляцией. */
function hasMateInOne(pos: Chess): boolean {
  return allLegalMoves(pos).some((m) => deliversMate(pos, m));
}

/**
 * Локальная оценка «идеи» хода: взятие, шах, тяга в центр. Никакого
 * заглядывания вперёд — ровно то, что видно на доске прямо сейчас.
 */
function ideaScore(pos: Chess, move: NormalMove): number {
  let score = 0;

  const victim = capturedRole(pos, move);
  if (victim) score += PIECE_VALUE[victim] * 3; // свободная еда — видят сразу

  const next = pos.clone();
  next.play(move);
  if (next.isCheck()) score += 1; // шах любят давать

  const toKey = keyOf(move.to);
  const centerDist = Math.min(...CENTER.map((c) => squareDistance(toKey, c)));
  score += (3 - centerDist) * 0.5; // тяга в центр — инстинкт даже у новичка

  return score;
}

/** Ходы по убыванию «идеи» — без матующего, если его решили не смотреть. */
function rankedIdeas(pos: Chess, exclude: NormalMove | undefined, width: number): NormalMove[] {
  const pool = allLegalMoves(pos).filter((m) => m !== exclude);
  return pool
    .map((move) => ({ move, score: ideaScore(pos, move) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, width)
    .map((x) => x.move);
}

/**
 * Выбор хода «слепого» бота. `analyse` — единственная внешняя
 * зависимость (обёртка над Stockfish, core/engine.ts, нужна только для
 * оценки серьёзности угрозы материалу), поэтому решение целиком
 * проверяется тестами без реального движка — см. tests/blind-bot.test.ts.
 */
export async function chooseBlindMove(
  analyse: Analyser,
  pos: Chess,
  profile: BlindProfile,
  rnd: () => number,
): Promise<NormalMove | null> {
  const moves = allLegalMoves(pos);
  if (!moves.length) return null;

  const ownMate = moves.find((m) => deliversMate(pos, m));
  if (ownMate && rnd() < profile.seeOwnMateChance) return ownMate;

  const ideas = rankedIdeas(pos, ownMate, profile.ideaWidth);
  if (!ideas.length) return moves[0];

  return pickSafeIdea(analyse, pos, ideas, profile, rnd);
}

/**
 * Проверка и выбор из уже готового списка кандидатов (от самого
 * предпочтительного к менее предпочтительному) — отдельно от
 * ранжирования эвристикой, чтобы тестировать ИМЕННО решение «заметили —
 * не заметили» на реальных позициях, не завися от тонкой настройки
 * ideaScore. chooseBlindMove — единственный настоящий вызывающий, тесты
 * зовут эту функцию напрямую.
 */
export async function pickSafeIdea(
  analyse: Analyser,
  pos: Chess,
  candidates: NormalMove[],
  profile: BlindProfile,
  rnd: () => number,
): Promise<NormalMove | null> {
  for (const move of candidates) {
    const next = pos.clone();
    next.play(move);
    if (next.isEnd()) return move; // мат/пат — дальше проверять нечего

    // Единственная проверка на ход. Мат сопернику после этого кандидата
    // считаем точно (симуляцией), крупную потерю материала — честным
    // Stockfish. Как только ход её проходит (или угрозу решили не
    // разглядывать) — на нём и останавливаемся, вторую проблему в той же
    // позиции уже не ищем.
    if (hasMateInOne(next)) {
      if (rnd() < profile.seeOpponentMateChance) continue; // заметили — пробуем другую идею
      return move; // не заметили мат соперника — играем как задумали
    }

    const replyLines = await analyse(fenOf(next), { depth: profile.threatDepth, multipv: 1 });
    const reply = replyLines[0];
    if (reply && reply.score >= profile.threatThreshold) {
      if (rnd() < profile.seeMaterialThreatChance) continue; // заметили — пробуем другую идею
      return move; // угроза есть, но её не заметили — играем как задумали
    }
    return move; // проверку прошёл — большего не проверяем
  }

  // Все варианты отбраковали проверкой — берём первый как есть. Тоже
  // реалистично (переиграть партию заново новичок не может) и защищает
  // от зависания на пустом результате.
  return candidates[0] ?? null;
}
