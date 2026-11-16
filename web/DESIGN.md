# t3code-proxy panel design spec

The panel is a sibling of the T3 Code desktop app: quiet, dense, precise. Neutral
surfaces, one blue accent, small type, 1px borders. It is an admin tool for one
owner, not a landing page. When this file and older page code disagree, this file wins.

Sources: tokens in `src/styles/themes.scss`, Sass constants and mixins in
`src/styles/variables.scss` / `mixins.scss`, shared classes in `components.scss`,
shell in `layout.scss` and `src/components/layout/`, primitives in `src/components/ui/`.

## Tokens

Use CSS variables in new code. Light is the base; dark applies with
`[data-theme='dark']` (set on `<html>` before first paint by `index.html`, then kept
in sync by `useThemeStore`; the choice is Light, Dark or System).

| Variable | Use |
| --- | --- |
| `--background` | Page background (`#000` dark, `oklch(99.2% 0 0)` light) |
| `--foreground` | Body text |
| `--card`, `--popover`, `--sidebar` | Raised surfaces: cards, menus/dialogs/toasts, sidebar |
| `--muted` | Quiet fill (table head, read-only field) |
| `--muted-foreground` | Secondary text, icons, labels (AA on every surface) |
| `--faint-foreground` | Placeholders and disabled hints only, never body copy |
| `--accent` | Hover and selected-row fill |
| `--border`, `--border-strong` | 1px dividers / hovered borders |
| `--input` | Field and secondary-button borders |
| `--primary`, `--primary-foreground` | The one blue: main action, links, selection |
| `--ring` | Focus ring (= primary) |
| `--overlay` | Scrim behind dialogs and the mobile drawer |
| `--success`, `--warning`, `--destructive`, `--info` | Status colour (dots, chart marks, fills) |
| `--success-foreground` ... `--info-foreground` | Status text, AA on its surface |
| `--success-surface` ... `--info-surface`, `--primary-surface` | Tinted fills (8% light, 16% dark) |
| `--shadow-popover` | The only shadow: popovers, dialogs, sheets, toasts |
| `--font-sans`, `--font-mono` | System UI stack; mono stack |
| `--radius-sm/md/lg/xl` | 4 / 6 / 8 / 12px (`--radius` = 0.5rem) |
| `--control-h-sm`, `--control-h`, `--control-h-lg` | 28 / 32 / 36px |
| `--duration-fast`, `--duration`, `--ease-out` | 120ms, 160ms, decelerating curve |

Provider brand colours (Claude orange, Codex blue, ...) are allowed only in provider
marks and chart series. Everything else is neutral or a status colour.

**Legacy aliases.** Older stylesheets read `--bg-primary` (card), `--bg-secondary`
(background), `--bg-tertiary`/`--bg-hover` (solid accent fills), `--text-primary/
secondary/tertiary/quaternary`, `--border-color`, `--border-primary`, `--border-hover`,
`--primary-color` and friends, `--success-color`, `--warning-*`, `--amber-*`,
`--destructive-*`, `--*-badge-*`, `--floating-surface`, `--glass-*` (now plain surfaces,
no blur), `--shadow` (now a zero shadow), `--viz-success/failure`, `--ease-out-strong`,
`--dur-press`, `--dur-hover`. They map onto the tokens above. Do not use them in new
code; replace them when you touch a file. Sass `$spacing-*`, `$radius-*`, `$font-mono`,
`$transition-*`, `$z-*` and `$breakpoint-*` remain available in every module.

## Type

| Role | Size / weight |
| --- | --- |
| Caption, meta | 11px (`--text-xs`) |
| Secondary text, table head, badges | 12px (`--text-sm`) |
| Base UI text, controls, nav | 13px (`--text-base`) |
| Section title | 14px / 600 (`--text-md`) |
| Dialog and sheet title | 14-16px / 600 |
| Page title | 18px / 600 (`--text-xl`), via `PageHeader` |
| Headline metric | 32px max (`--text-display`), one per page, via `Stat size="lg"` |

Nothing in the chrome is larger than 20px. Numbers use `font-variant-numeric:
tabular-nums` (`.tabular`, built into `Stat`, `Badge`, `Table`). Mono (`.mono`,
`--font-mono`) is only for code, keys, IDs, paths, addresses and log lines. No uppercase,
no letter-spaced labels, no gradient text.

## Spacing and density

4px grid: `--space-1` 4, `-2` 8, `-3` 12, `-4` 16, `-5` 20, `-6` 24, `-8` 32. Controls
32px (28 small, 36 large), sidebar rows 30px, icons 16px at 1.5 stroke (`ui/icons.tsx`).
Gaps: 8px inside a control group, 12px between a section heading and content, 24px
between sections. Card padding 16px. Page padding 24px top, 32px sides (16px under
768px), content column max 1200px.

## Motion

120-160ms ease-out, only for hover, press and open/close. No entrance choreography,
no staggered reveals, no bouncy scale. Route changes fade in over 160ms with 4px of
lift. `prefers-reduced-motion` turns animation off globally (`global.scss`).

## Components (`src/components/ui`)

| Component | Example |
| --- | --- |
| `Button` (primary, secondary, ghost, destructive; sm, md, lg) | `<Button variant="secondary" size="sm" onClick={reload}>Reload</Button>` |
| `IconButton` (aria-label required) | `<IconButton aria-label="Delete key" icon={<IconTrash2 size={16} />} />` |
| `Input`, `Textarea` | `<Input label="Proxy URL" hint="Optional" error={err} />` |
| `Select` | `<Select value={v} options={opts} onChange={setV} size="sm" ariaLabel="Sort" />` |
| `Checkbox` (`SelectionCheckbox`) | `<Checkbox checked={on} onChange={setOn} label="Remember key" />` |
| `Switch` (`ToggleSwitch`) | `<Switch checked={enabled} onChange={toggle} ariaLabel="Enabled" />` |
| `Tabs`, `SegmentedControl` | `<Tabs ariaLabel="Views" items={[{ value: 'all', label: 'All', count: 12 }]} value={tab} onChange={setTab} />` |
| `Badge`, `StatusDot` | `<Badge tone="success" dot>Active</Badge>` |
| `Card` | `<Card title="Proxy" extra={<Button size="sm">Edit</Button>}>...</Card>` |
| `Dialog` (`Modal`), `Sheet` | `<Dialog open title="Delete account?" onClose={close} footer={actions}>...</Dialog>` |
| `DropdownMenu`, `DropdownMenuItem`, `DropdownMenuSeparator` | `<DropdownMenu trigger={<IconButton aria-label="More" icon={<IconEllipsis size={16} />} />}><DropdownMenuItem onSelect={rename}>Rename</DropdownMenuItem></DropdownMenu>` |
| `Tooltip` | `<Tooltip content="Copy key"><IconButton aria-label="Copy key" icon={...} /></Tooltip>` |
| Toast | `showNotification('Saved', 'success')` from `useNotificationStore` |
| `Table` (+ `TableHeader/Body/Row/Head/Cell`) | `<Table><TableHeader>...</TableHeader><TableBody>...</TableBody></Table>` |
| `Skeleton` | `<Skeleton height={32} />` |
| `EmptyState` | `<EmptyState title="No accounts yet" description="Sign in with a subscription." action={<Button>Add account</Button>} />` |
| `Spinner` (`LoadingSpinner`) | `<Spinner size={16} label="Loading accounts" />` |
| `PageHeader` | see below |
| `Toolbar` | `<Toolbar ariaLabel="Filters" end={<SegmentedControl .../>}><Input .../></Toolbar>` |
| `Stat` | `<Stat label="Remaining" value="471%" unit="of 600%" size="lg" />` |
| `Section` | `<Section title="Recent requests" actions={...}>...</Section>` |

Prefer composition (children, `actions`, `end`, `tabs` slots) over new boolean props.
Global classes `.btn`, `.btn-*`, `.input`, `.form-group`, `.hint`, `.error-box`,
`.status-badge`, `.item-row`, `.empty-state`, `.sr-only`, `.mono`, `.tabular` stay
stable because feature styles target them.

## App shell (`src/components/layout`)

`MainLayout` composes `Sidebar` (brand row, `SidebarNav`, `SidebarFooter`), the mobile
top bar and a scrolling `main`. Sidebar: 240px, collapses to a 52px icon rail (Cmd/Ctrl+B,
persisted), off-canvas drawer under 768px. Navigation model and order live in
`navigation.tsx` (Overview, Accounts, Add account, Routing, Connect; Activity,
Providers, Logs; Plugins and plugin pages; Settings, System). The footer holds the hub
address and connection dot, server version, theme menu, refresh and sign out. There is
no top bar on desktop and no floating toolbar: page actions belong in `PageHeader`.

## Page anatomy

```tsx
<>
  <PageHeader
    title="Accounts"
    description="Subscription logins the hub rotates through."
    meta={<Badge>12</Badge>}
    actions={<Button variant="primary">Add account</Button>}
    tabs={<Tabs ariaLabel="Provider" items={providers} value={p} onChange={setP} />}
  />
  <Toolbar ariaLabel="Filters" end={<CardLayoutSwitch value={layout} onChange={setLayout} />}>
    <Input placeholder="Search accounts" aria-label="Search accounts" />
  </Toolbar>
  {content}
</>
```

The page wrapper is the shell's content column; do not add an outer card. Children
are stacked with a 24px gap by the shell.

- **Loading**: `Skeleton` blocks shaped like the content, or an inline `Spinner` with
  a label. Never a full-page splash.
- **Empty**: one `EmptyState` with a plain title, one sentence and at most one action.
- **Error**: `.error-box` (or a `destructive` `Badge` for a row) saying what failed and
  what to do next; keep the rest of the page usable. Toasts confirm actions; they do
  not carry errors the user must act on later.

## Copy

- Sentence case everywhere: "Add account", not "Add Account".
- Plain verbs on buttons: Save, Refresh, Delete key, Sign in. The label says what happens.
- No marketing voice, no slogans, no "Quiet for now.", no exclamation marks.
- Never "Click here"; name the action: "Refresh quota".
- Say "account" for an auth file, "hub" for this server, "key" for an API/management key.
- Numbers with units: "3.8%/h", "12 accounts". Dates relative when recent.
- All strings go through i18n (`src/i18n/locales/en.json`); English is the only locale.

## Do not

- Do not use uppercase or letter-spaced labels, or monospace for ordinary labels.
- Do not add gradients, glows, glass, `backdrop-filter`, noise textures or coloured shadows.
- Do not nest cards in cards; use `Section` or a divider inside a card.
- Do not use shadows except on popovers, dialogs, sheets and toasts.
- Do not use the blue for anything but the main action, links, focus and selection.
  One primary button per view.
- Do not exceed 20px for chrome text or 32px for the headline metric.
- Do not hard-code colours; use tokens. Test both themes and 390px width.
- Do not remove focus outlines without an equal `:focus-visible` replacement.
- Do not animate layout on load or stagger lists; keep motion under 160ms.
- Do not add a floating toolbar, a language switcher or per-page top bars.
- Do not fetch fonts or assets at runtime; the build is a single self-contained HTML file.
