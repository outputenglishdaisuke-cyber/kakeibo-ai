-- Add composite unique constraint to prevent duplicate transactions
-- Key: date + description + amount
ALTER TABLE "Transaction"
ADD CONSTRAINT "Transaction_date_description_amount_key"
UNIQUE ("date", "description", "amount");

