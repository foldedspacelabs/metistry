-- 0005 — collectors upsert work rows by external_ref (§4.8 reconcile);
-- ON CONFLICT needs a unique index. Partial: internal threads may have none.
CREATE UNIQUE INDEX IF NOT EXISTS work_external_ref_uidx ON work (external_ref) WHERE external_ref IS NOT NULL;
