-- M2 fix: stop the same adjustment CSV from being applied twice.
--
-- What was wrong: nothing recorded what an import contained, so submitting the
-- same file again (Huda double-clicked on 4 Sept) posted every row a second
-- time — real ledger money, reversed by hand later.
--
-- The API now stores a sha256 of the parsed rows (merchant, amount in fils,
-- reason) and this unique index makes Postgres refuse a second identical
-- import, even if two submits arrive at the same instant. Older imports keep
-- NULL here, so they aren't affected.
--
-- Numbering: 0080+ is used for this branch's migrations so they can't clash
-- with migrations added on the settlement/ops branch.

ALTER TABLE adjustment_imports ADD COLUMN content_sha256 TEXT;

CREATE UNIQUE INDEX idx_adjustment_imports_content_sha256
    ON adjustment_imports (content_sha256)
    WHERE content_sha256 IS NOT NULL;
