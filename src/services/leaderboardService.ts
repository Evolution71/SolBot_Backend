import { supabase } from "../db/supabase";

export interface LeaderboardEntry {
  telegramUserId: string;
  handle: string | null;
  solVolume: number;
  tradeCount: number;
}

/**
 * Real, trade-backed weekly leaderboard — ranked by total SOL volume traded
 * in the last 7 days. No fabricated numbers: this reads straight from the
 * trades table.
 */
export async function getWeeklyLeaderboard(limit = 20): Promise<LeaderboardEntry[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("trades")
    .select("telegram_user_id, sol_amount")
    .gte("created_at", sevenDaysAgo);

  if (error) throw error;

  const totals = new Map<string, { volume: number; count: number }>();
  for (const t of data ?? []) {
    const entry = totals.get(t.telegram_user_id) ?? { volume: 0, count: 0 };
    entry.volume += Number(t.sol_amount);
    entry.count += 1;
    totals.set(t.telegram_user_id, entry);
  }

  const ranked = Array.from(totals.entries())
    .map(([telegramUserId, v]) => ({
      telegramUserId,
      solVolume: v.volume,
      tradeCount: v.count,
    }))
    .sort((a, b) => b.solVolume - a.solVolume)
    .slice(0, limit);

  if (ranked.length === 0) return [];

  const { data: users } = await supabase
    .from("users")
    .select("telegram_user_id, telegram_handle")
    .in(
      "telegram_user_id",
      ranked.map((r) => r.telegramUserId)
    );

  const handleMap = new Map((users ?? []).map((u) => [u.telegram_user_id, u.telegram_handle]));

  return ranked.map((r) => ({
    ...r,
    handle: handleMap.get(r.telegramUserId) ?? null,
  }));
}
