-- Onboarding & Approval Engine: Engine mode lifecycle and customer metadata for approval screen
ALTER TABLE loyalty_pricelist_policies ADD COLUMN engine_mode TEXT NOT NULL DEFAULT 'installation';
ALTER TABLE loyalty_recalculation_items ADD COLUMN customer_name TEXT;
ALTER TABLE loyalty_recalculation_items ADD COLUMN customer_email TEXT;
