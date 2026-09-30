/**
 * Run errors recorded when an activity is cancelled. Shared by backups,
 * prunes, checks and restores so the UI reads the same everywhere.
 */

/** Cancelled on the server while an agent executes it; older agents carry on. */
export const CANCELLED_ON_SERVER_AGENT_MESSAGE =
  'Cancelled on the server — the agent may still be running this task.';

/** Cancelled while `running` without a process this server owns (e.g. after a restart). */
export const CANCELLED_NO_PROCESS_MESSAGE = 'Cancelled — no running process found.';

/** The agent confirmed it stopped restic after the cancel. */
export const CANCELLED_ON_AGENT_MESSAGE = 'Cancelled on the agent.';
