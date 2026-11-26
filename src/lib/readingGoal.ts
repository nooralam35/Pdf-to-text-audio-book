const STORAGE_KEY = 'bhashabook-daily-reading-goal-v1';
const DEFAULT_DAILY_GOAL = 15;
const MIN_DAILY_GOAL = 1;
const MAX_DAILY_GOAL = 300;
const MAX_HISTORY_DAYS = 60;

interface StoredReadingGoalData {
  goalPages: number;
  // Map of local date string (YYYY-MM-DD) -> { [bookId]: unique page numbers read that day }
  byDate: Record<string, Record<string, number[]>>;
}

export interface DailyReadingGoalSnapshot {
  todayKey: string;
  goalPages: number;
  pagesReadToday: number;
  pagesReadTodayByBook: Record<string, number>;
  streakDays: number;
  goalMetToday: boolean;
}

export function getLocalDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftDateKey(baseDate: Date, deltaDays: number): string {
  const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + deltaDays);
  return getLocalDateKey(d);
}

function clampGoal(pages: number): number {
  if (!Number.isFinite(pages)) return DEFAULT_DAILY_GOAL;
  return Math.max(MIN_DAILY_GOAL, Math.min(MAX_DAILY_GOAL, Math.round(pages)));
}

function readStoredData(): StoredReadingGoalData {
  if (typeof window === 'undefined') {
    return { goalPages: DEFAULT_DAILY_GOAL, byDate: {} };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { goalPages: DEFAULT_DAILY_GOAL, byDate: {} };
    const parsed = JSON.parse(raw) as Partial<StoredReadingGoalData>;
    const goalPages = clampGoal(
      typeof parsed.goalPages === 'number' ? parsed.goalPages : DEFAULT_DAILY_GOAL
    );
    const byDate: Record<string, Record<string, number[]>> = {};
    if (parsed.byDate && typeof parsed.byDate === 'object') {
      for (const [dateKey, booksMap] of Object.entries(parsed.byDate)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !booksMap || typeof booksMap !== 'object') {
          continue;
        }
        const cleanedBooks: Record<string, number[]> = {};
        for (const [bookId, pages] of Object.entries(booksMap)) {
          if (Array.isArray(pages)) {
            const unique = Array.from(
              new Set(pages.filter((p): p is number => typeof p === 'number' && p >= 1))
            ).sort((a, b) => a - b);
            if (unique.length > 0) {
              cleanedBooks[bookId] = unique;
            }
          }
        }
        if (Object.keys(cleanedBooks).length > 0) {
          byDate[dateKey] = cleanedBooks;
        }
      }
    }
    return { goalPages, byDate };
  } catch {
    return { goalPages: DEFAULT_DAILY_GOAL, byDate: {} };
  }
}

function writeStoredData(data: StoredReadingGoalData): void {
  if (typeof window === 'undefined') return;
  try {
    // Keep only the most recent MAX_HISTORY_DAYS entries
    const sortedKeys = Object.keys(data.byDate).sort().slice(-MAX_HISTORY_DAYS);
    const pruned: Record<string, Record<string, number[]>> = {};
    for (const k of sortedKeys) {
      pruned[k] = data.byDate[k];
    }
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        goalPages: clampGoal(data.goalPages),
        byDate: pruned,
      })
    );
  } catch {
    // ignore quota / privacy errors
  }
}

function totalPagesForDate(booksMap: Record<string, number[]> | undefined): number {
  if (!booksMap) return 0;
  let total = 0;
  for (const pages of Object.values(booksMap)) {
    total += pages.length;
  }
  return total;
}

function buildSnapshot(data: StoredReadingGoalData, now = new Date()): DailyReadingGoalSnapshot {
  const todayKey = getLocalDateKey(now);
  const todayMap = data.byDate[todayKey] ?? {};
  const pagesReadTodayByBook: Record<string, number> = {};
  let pagesReadToday = 0;

  for (const [bookId, pages] of Object.entries(todayMap)) {
    pagesReadTodayByBook[bookId] = pages.length;
    pagesReadToday += pages.length;
  }

  const goalMetToday = pagesReadToday >= data.goalPages;

  // Compute consecutive daily goal streak (includes today if met, otherwise counts up through yesterday)
  let streakDays = 0;
  const startOffset = goalMetToday ? 0 : -1;
  for (let offset = startOffset; offset >= -MAX_HISTORY_DAYS; offset--) {
    const key = shiftDateKey(now, offset);
    if (totalPagesForDate(data.byDate[key]) >= data.goalPages) {
      streakDays++;
    } else {
      break;
    }
  }

  return {
    todayKey,
    goalPages: data.goalPages,
    pagesReadToday,
    pagesReadTodayByBook,
    streakDays,
    goalMetToday,
  };
}

export function getDailyReadingGoalSnapshot(now = new Date()): DailyReadingGoalSnapshot {
  return buildSnapshot(readStoredData(), now);
}

export function setDailyReadingGoalPages(
  goalPages: number,
  now = new Date()
): DailyReadingGoalSnapshot {
  const data = readStoredData();
  data.goalPages = clampGoal(goalPages);
  writeStoredData(data);
  return buildSnapshot(data, now);
}

export function recordPageReadToday(
  bookId: string,
  pageNumber: number,
  now = new Date()
): DailyReadingGoalSnapshot {
  const safePage = Math.floor(pageNumber);
  const data = readStoredData();
  if (!bookId || !Number.isFinite(safePage) || safePage < 1) {
    return buildSnapshot(data, now);
  }

  const todayKey = getLocalDateKey(now);
  const todayMap = data.byDate[todayKey] ?? {};
  const currentPages = todayMap[bookId] ?? [];

  if (!currentPages.includes(safePage)) {
    todayMap[bookId] = [...currentPages, safePage].sort((a, b) => a - b);
    data.byDate[todayKey] = todayMap;
    writeStoredData(data);
  }

  return buildSnapshot(data, now);
}
