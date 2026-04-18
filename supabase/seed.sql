-- OwnFlow demo seed data
-- Run AFTER both migrations. Safe to re-run (uses fixed UUIDs).
-- Purpose: gives a new environment a working organization, project,
--          actors, sprints, and tasks so the UI is not empty on first login.

-- ── Demo organization ────────────────────────────────────────────────────────
insert into organizations (id, name, slug, owner_id, default_ai_model)
values (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'Demo Corp',
  'demo-corp',
  '00000000-0000-0000-0000-000000000000',   -- replace with a real auth.users uuid
  'gpt-4o'
)
on conflict (id) do nothing;

-- ── Demo project ─────────────────────────────────────────────────────────────
insert into projects (id, name, prompt, owner_id, org_id, status)
values (
  'bbbbbbbb-0000-0000-0000-000000000001',
  'E-commerce Platform MVP',
  'Build an e-commerce platform with product listings, cart, checkout, and order management.',
  '00000000-0000-0000-0000-000000000000',   -- same owner_id as above
  'aaaaaaaa-0000-0000-0000-000000000001',
  'active'
)
on conflict (id) do nothing;

-- ── Actors ───────────────────────────────────────────────────────────────────
insert into actors (id, project_id, name, type, model, capabilities)
values
  (
    'cccccccc-0000-0000-0000-000000000001',
    'bbbbbbbb-0000-0000-0000-000000000001',
    'GPT-4o Dev',
    'ai',
    'gpt-4o',
    array['code','research','qa']
  ),
  (
    'cccccccc-0000-0000-0000-000000000002',
    'bbbbbbbb-0000-0000-0000-000000000001',
    'Claude Designer',
    'ai',
    'claude-3-5-sonnet-20241022',
    array['design','content']
  ),
  (
    'cccccccc-0000-0000-0000-000000000003',
    'bbbbbbbb-0000-0000-0000-000000000001',
    'Human Lead',
    'human',
    null,
    array['review','architecture']
  )
on conflict (id) do nothing;

-- ── Sprint 1 ─────────────────────────────────────────────────────────────────
insert into sprints (id, project_id, sprint_number, start_date, end_date, status)
values (
  'dddddddd-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001',
  1,
  current_date,
  current_date + interval '3 days',
  'active'
)
on conflict (id) do nothing;

-- ── Sprint 2 ─────────────────────────────────────────────────────────────────
insert into sprints (id, project_id, sprint_number, start_date, end_date, status)
values (
  'dddddddd-0000-0000-0000-000000000002',
  'bbbbbbbb-0000-0000-0000-000000000001',
  2,
  current_date + interval '3 days',
  current_date + interval '6 days',
  'planned'
)
on conflict (id) do nothing;

-- ── Tasks (Sprint 1) ─────────────────────────────────────────────────────────
insert into tasks (id, sprint_id, project_id, title, description, type, priority, status, estimated_hours)
values
  (
    'eeeeeeee-0000-0000-0000-000000000001',
    'dddddddd-0000-0000-0000-000000000001',
    'bbbbbbbb-0000-0000-0000-000000000001',
    'Set up project scaffolding',
    'Initialize monorepo, configure TypeScript, ESLint, and Prettier. Set up CI pipeline.',
    'code', 'high', 'done', 3
  ),
  (
    'eeeeeeee-0000-0000-0000-000000000002',
    'dddddddd-0000-0000-0000-000000000001',
    'bbbbbbbb-0000-0000-0000-000000000001',
    'Design system & component library',
    'Create Figma design tokens, base components (Button, Input, Card), and Storybook setup.',
    'design', 'high', 'in_progress', 6
  ),
  (
    'eeeeeeee-0000-0000-0000-000000000003',
    'dddddddd-0000-0000-0000-000000000001',
    'bbbbbbbb-0000-0000-0000-000000000001',
    'Product listing API',
    'REST endpoints: GET /products, GET /products/:id, POST /products (admin). Include pagination and filtering.',
    'code', 'high', 'in_progress', 5
  ),
  (
    'eeeeeeee-0000-0000-0000-000000000004',
    'dddddddd-0000-0000-0000-000000000001',
    'bbbbbbbb-0000-0000-0000-000000000001',
    'Shopping cart state management',
    'Implement cart store (add, remove, update quantity, persist to localStorage). Write unit tests.',
    'code', 'medium', 'todo', 4
  ),
  (
    'eeeeeeee-0000-0000-0000-000000000005',
    'dddddddd-0000-0000-0000-000000000001',
    'bbbbbbbb-0000-0000-0000-000000000001',
    'Architecture review',
    'Review API design, DB schema, and authentication strategy. Document decisions in ADR.',
    'review', 'medium', 'todo', 2
  )
on conflict (id) do nothing;

-- ── Tasks (Sprint 2) ─────────────────────────────────────────────────────────
insert into tasks (id, sprint_id, project_id, title, description, type, priority, status, estimated_hours)
values
  (
    'eeeeeeee-0000-0000-0000-000000000006',
    'dddddddd-0000-0000-0000-000000000002',
    'bbbbbbbb-0000-0000-0000-000000000001',
    'Checkout flow',
    'Multi-step checkout: address, shipping method, payment (Stripe), order confirmation.',
    'code', 'high', 'todo', 8
  ),
  (
    'eeeeeeee-0000-0000-0000-000000000007',
    'dddddddd-0000-0000-0000-000000000002',
    'bbbbbbbb-0000-0000-0000-000000000001',
    'Order management dashboard',
    'Admin view: list orders, filter by status, update order status, send notification emails.',
    'code', 'medium', 'todo', 6
  ),
  (
    'eeeeeeee-0000-0000-0000-000000000008',
    'dddddddd-0000-0000-0000-000000000002',
    'bbbbbbbb-0000-0000-0000-000000000001',
    'E2E test suite',
    'Playwright tests covering: product browse → add to cart → checkout → order confirmation.',
    'qa', 'medium', 'todo', 5
  )
on conflict (id) do nothing;

-- ── Assignments ───────────────────────────────────────────────────────────────
insert into assignments (id, task_id, actor_id, assigned_by)
values
  ('ffffffff-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'system'),
  ('ffffffff-0000-0000-0000-000000000002', 'eeeeeeee-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000002', 'system'),
  ('ffffffff-0000-0000-0000-000000000003', 'eeeeeeee-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000001', 'system'),
  ('ffffffff-0000-0000-0000-000000000004', 'eeeeeeee-0000-0000-0000-000000000004', 'cccccccc-0000-0000-0000-000000000001', 'system'),
  ('ffffffff-0000-0000-0000-000000000005', 'eeeeeeee-0000-0000-0000-000000000005', 'cccccccc-0000-0000-0000-000000000003', 'system')
on conflict (task_id) do nothing;
