-- phase: expand
-- Person-owned resources (ADR-048 amendment 2026-10-15): a control request for a person's robot, room, restream
-- definition or paste names no project, so its audit row has none either. Old code always writes one.
ALTER TABLE services_audit ALTER COLUMN project_id DROP NOT NULL;
