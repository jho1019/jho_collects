-- 022_database_timezone.sql — the database clock runs on Pacific time.
--
-- Every `default current_date` (comps.observed_on, deals.occurred_on,
-- sell_card / record_trade / open_deal) and the card-entry skill's
-- find_or_create_show(..., current_date) read the session time zone. On UTC,
-- anything entered after 5pm Pacific (4pm in winter) was dated tomorrow — two
-- comps already were, and a Dec 31 evening sale would land in the next tax
-- year. Timestamps (timestamptz) are unaffected; only "what day is it" moves.
-- Takes effect for new connections.

alter database postgres set timezone to 'America/Los_Angeles';
