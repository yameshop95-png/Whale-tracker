-- Holder snapshots: call window 00:07–08:57 UTC (11:07–19:57 Sydney summer time) instead of 00:07–04:57.
-- The first hours do the coins; once they are done, each later call spends its time on the 90-day
-- GoldRush history and on exchange-label lookups (about 100 addresses per call), which had no time
-- left in the shorter window. A call with nothing left to do ends in a few seconds.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'whale-holders'),
  schedule := '7-59/5 0-8 * * *'
);
