-- Migrate deprecated Claude 3.5 model names to current Claude 4 equivalents.
-- Also updates team default_ai_model where applicable.

UPDATE actors
SET model = CASE model
  WHEN 'claude-3-5-sonnet-20241022' THEN 'claude-sonnet-4-6'
  WHEN 'claude-3-5-haiku-20241022'  THEN 'claude-haiku-4-5'
  WHEN 'claude-3-opus-20240229'     THEN 'claude-sonnet-4-6'
END
WHERE model IN (
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229'
);

UPDATE teams
SET default_ai_model = CASE default_ai_model
  WHEN 'claude-3-5-sonnet-20241022' THEN 'claude-sonnet-4-6'
  WHEN 'claude-3-5-haiku-20241022'  THEN 'claude-haiku-4-5'
  WHEN 'claude-3-opus-20240229'     THEN 'claude-sonnet-4-6'
END
WHERE default_ai_model IN (
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229'
);
