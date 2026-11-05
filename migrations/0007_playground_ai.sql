-- phase: expand
-- The AI playground (AI Exchange P8): a run of kind 'ai' (one chat reply as the app, ai.inference.create). The set of
-- kinds only widens: code before this migration never writes 'ai', so it is N-1 safe. The run keeps the outcome and
-- ids only; the prompt and the reply are never stored.
ALTER TABLE playground_runs DROP CONSTRAINT IF EXISTS playground_runs_kind_check;
ALTER TABLE playground_runs ADD CONSTRAINT playground_runs_kind_check CHECK (kind IN ('events', 'media', 'ai'));
