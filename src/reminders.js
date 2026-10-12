/** Local-only reminder calculations. This module never creates medication doses. */
export const REMINDER_GRACE_MS = 15 * 60 * 1000;
export const MAX_REMINDER_LOG = 1000;

export function occurrenceId(planId, scheduledAt) {
  return `${planId}@${scheduledAt}`;
}

export function nextReminderAt(plan, now = Date.now()) {
  if (!plan?.enabled) return null;
  const start = Date.parse(plan.startAt);
  const interval = Number(plan.intervalHours) * 3600000;
  if (!Number.isFinite(start) || !Number.isFinite(interval) || interval <= 0) return null;
  if (start > now) return start;
  return start + (Math.floor((now - start) / interval) + 1) * interval;
}

/**
 * Recover just the most recent occurrence for each enabled plan after sleep/restart.
 * Older missed occurrences are never replayed as a burst of notifications.
 * Persist the returned records before displaying a system notification so a restart
 * cannot display the same event twice. No dose record is inferred from a reminder.
 */
export function collectDueReminders(state, now = Date.now()) {
  if (!Number.isFinite(now)) throw new TypeError('Invalid reminder time');
  const seen = new Set((state.reminderLog ?? []).map((entry) => entry.id));
  const reminders = [];
  for (const plan of state.plans ?? []) {
    if (!plan.enabled) continue;
    const start = Date.parse(plan.startAt);
    const interval = Number(plan.intervalHours) * 3600000;
    if (!Number.isFinite(start) || !Number.isFinite(interval) || interval <= 0 || start > now) continue;
    const scheduled = start + Math.floor((now - start) / interval) * interval;
    const scheduledAt = new Date(scheduled).toISOString();
    const id = occurrenceId(plan.id, scheduledAt);
    if (seen.has(id)) continue;
    reminders.push({
      id,
      planId: plan.id,
      scheduledAt,
      at: new Date(now).toISOString(),
      status: now - scheduled > REMINDER_GRACE_MS ? 'missed' : 'notified',
      name: plan.name,
      routeId: plan.routeId,
      amount: plan.amount,
      intervalHours: plan.intervalHours,
      ...(plan.durationHours === undefined ? {} : {durationHours:plan.durationHours}),
    });
  }
  return reminders;
}

/** Keep the most recent record per plan even when trimming a busy history. */
export function appendReminderLog(existing, incoming, limit = MAX_REMINDER_LOG) {
  const byId = new Map();
  for (const record of [...existing, ...incoming]) {
    const { id, planId, scheduledAt, at, status, routeId, amount, intervalHours, durationHours } = record;
    byId.set(id, { id, planId, scheduledAt, at, status,
      ...(routeId === undefined ? {} : {routeId,amount,intervalHours}),
      ...(durationHours === undefined ? {} : {durationHours}),
    });
  }
  const ordered = [...byId.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (ordered.length <= limit) return ordered;
  const latestByPlan = new Map();
  for (const record of ordered) latestByPlan.set(record.planId, record.id);
  const keep = new Set(latestByPlan.values());
  for (let i = ordered.length - 1; i >= 0 && keep.size < limit; i--) keep.add(ordered[i].id);
  return ordered.filter((record) => keep.has(record.id)).slice(-limit);
}
