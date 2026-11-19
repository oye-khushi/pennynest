-- ---------------------------------------------------------------------------
-- PennyNest: idempotent seed for the permanent admin account
--   email: hakhnish99@gmail.com
--   PIN  : 1234   (PBKDF2-SHA256, 30000 iterations, 16-byte salt)
--   role : admin
--
-- Safe to run any number of times:
--   * INSERT ... WHERE NOT EXISTS  -> never duplicates the row
--   * the UPDATE only re-asserts role='admin', it never touches pin_hash/pin_salt
--     (so a PIN changed later from the UI survives re-running this file)
-- ---------------------------------------------------------------------------

-- 1. Create the admin only if no row with that email exists yet.
INSERT INTO users (email, name, role, avatar, theme, pin_hash, pin_salt)
SELECT
  'hakhnish99@gmail.com',
  'PennyNest Admin',
  'admin',
  '👑',
  'matcha',
  '8f458ee141d9d3be2993ae9264759d4e2f17a0d7ea9708a4588a0e5c3c3c1bbf',
  'a1b2c3d4e5f60718293a4b5c6d7e8f90'
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE email = 'hakhnish99@gmail.com'
);

-- 2. Repair the role if the account somehow exists as a normal user.
--    Deliberately does NOT overwrite pin_hash / pin_salt.
UPDATE users SET role = 'admin' WHERE email = 'hakhnish99@gmail.com';

-- 3. Default monthly budgets for the admin account (same defaults the Worker
--    would give a fresh user). INSERT OR IGNORE keeps any edited limits.
INSERT OR IGNORE INTO budgets (user_id, category, monthly_limit)
SELECT id, 'Food',          3000 FROM users WHERE email = 'hakhnish99@gmail.com';
INSERT OR IGNORE INTO budgets (user_id, category, monthly_limit)
SELECT id, 'Transport',     1500 FROM users WHERE email = 'hakhnish99@gmail.com';
INSERT OR IGNORE INTO budgets (user_id, category, monthly_limit)
SELECT id, 'Education',     2000 FROM users WHERE email = 'hakhnish99@gmail.com';
INSERT OR IGNORE INTO budgets (user_id, category, monthly_limit)
SELECT id, 'Utilities',     1000 FROM users WHERE email = 'hakhnish99@gmail.com';
INSERT OR IGNORE INTO budgets (user_id, category, monthly_limit)
SELECT id, 'Entertainment', 1200 FROM users WHERE email = 'hakhnish99@gmail.com';
