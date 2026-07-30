// Daily cron: reset API-key quotas and flip recurring tasks back to
// pending so they show up again today.

import type { Env } from '../types/env';
import { resetDailyQuotas } from '../db/apiKeys';
import { resetRecurringForDay } from '../db/tasks';
import { purgeExpiredConfirmations } from '../db/confirmations';
import { localDateString } from '../utils/time';
import { log } from '../utils/logger';

export async function handleCron(env: Env): Promise<void> {
  const tz = env.DEFAULT_TIMEZONE || 'UTC';
  const today = localDateString(new Date(), tz);

  const keysReset = await resetDailyQuotas(env.DB, today);
  const tasksReset = await resetRecurringForDay(env.DB, tz);
  const confirmationsPurged = await purgeExpiredConfirmations(env.DB);

  log.info('cron_daily_reset', {
    date: today,
    api_keys_reset: keysReset,
    recurring_tasks_reset: tasksReset,
    confirmations_purged: confirmationsPurged,
  });
}
