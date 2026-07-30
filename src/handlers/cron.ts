// Daily cron: reset API-key quotas, flip recurring tasks back to
// pending, and reopen recurring debts on their schedule.

import type { Env } from '../types/env';
import { resetDailyQuotas } from '../db/apiKeys';
import { resetRecurringForDay } from '../db/tasks';
import { reopenRecurringForDay } from '../db/debts';
import { purgeExpiredConfirmations } from '../db/confirmations';
import { localDateString } from '../utils/time';
import { log } from '../utils/logger';

export async function handleCron(env: Env): Promise<void> {
  const tz = env.DEFAULT_TIMEZONE || 'UTC';
  const today = localDateString(new Date(), tz);

  const keysReset = await resetDailyQuotas(env.DB, today);
  const tasksReset = await resetRecurringForDay(env.DB, tz);
  // Mirrors the tasks-side reset path exactly: recurring debts whose
  // rule fires today and are currently paid/cancelled get flipped
  // back to 'open'. Wiring lives in db/debts.reopenRecurringForDay.
  const debtsReopened = await reopenRecurringForDay(env.DB, tz);
  const confirmationsPurged = await purgeExpiredConfirmations(env.DB);

  log.info('cron_daily_reset', {
    date: today,
    api_keys_reset: keysReset,
    recurring_tasks_reset: tasksReset,
    recurring_debts_reopened: debtsReopened,
    confirmations_purged: confirmationsPurged,
  });
}
