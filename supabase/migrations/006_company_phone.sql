-- Add phone number to companies (collected at registration for feedback calls)
alter table companies add column if not exists phone text;
