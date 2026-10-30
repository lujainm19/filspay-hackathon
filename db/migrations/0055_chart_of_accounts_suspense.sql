-- Additional suspense accounts for future reconciliation lanes.
--
-- Fixed: this file used columns (code, account_type, description) that
-- chart_of_accounts has never had — 0007 defines (id, name, kind) with kind in
-- ('asset','liability','revenue') — so it failed on every fresh database.
-- Suspense accounts are modelled as assets, like scheme_rounding_residue.

INSERT INTO chart_of_accounts (id, name, kind)
VALUES
  ('fx_rounding_difference', 'FX rounding difference (suspense)', 'asset'),
  ('chargeback_suspense', 'Chargeback suspense', 'asset')
ON CONFLICT (id) DO NOTHING;
