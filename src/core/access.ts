/**
 * Экран доступа: один общий код для учеников ScienceChess, без бэкенда
 * и криптографии — просто отсекает случайных посетителей.
 *
 * ЧТОБЫ СМЕНИТЬ КОД ДОСТУПА, ПРАВЬ СТРОКУ НИЖЕ.
 * Смена кода автоматически «разлогинивает» всех: у сохранённого в
 * localStorage устройства код сверяется с текущим ACCESS_CODE при каждом
 * запуске, старое значение перестаёт совпадать.
 */
export const ACCESS_CODE = 'sciencechess';

/** Куда ведёт кнопка «Получить доступ» на экране входа. */
export const CONTACT_TELEGRAM_URL = 'https://t.me/vLdm56';
export const CONTACT_WHATSAPP_URL = 'https://wa.me/79017002756';

const STORAGE_KEY = 'sciencechess-lab-access';

function normalize(code: string): string {
  return code.trim().toLowerCase();
}

/** Уже вводили верный код на этом устройстве? */
export function hasAccess(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === normalize(ACCESS_CODE);
  } catch {
    // Приватный режим/заблокированный localStorage — просто спросим код снова.
    return false;
  }
}

/** Код совпал — запоминаем на этом устройстве. */
export function grantAccess(): void {
  try {
    localStorage.setItem(STORAGE_KEY, normalize(ACCESS_CODE));
  } catch {
    // Не критично: просто будет спрашивать код при следующем открытии.
  }
}

export function checkCode(input: string): boolean {
  return normalize(input) === normalize(ACCESS_CODE);
}
