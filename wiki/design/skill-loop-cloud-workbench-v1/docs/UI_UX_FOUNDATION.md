# UI/UX Foundation

## 1. Experience Intent

The workbench should feel like a calm operating system for reusable Agent work: precise enough
for expert authors, readable enough for a teammate who only wants to understand and run a Loop.

It borrows interaction structure from mature workflow products and list/database clarity from
document tools, but does not visually clone Coze, Notion, Astryx, or the current prototype.

## 2. Experience Principles

### Objects before infrastructure

Lead with purpose, ownership, versions, and next actions. Runtime bindings, schemas, provider
IDs, artifact paths, and internal diagnostics belong in optional technical details.

### Goal before graph

A new Loop starts with the desired outcome and acceptance rules. Canvas composition follows
after the Loop contract is understandable.

### One dominant task per screen

- Skill library: find or create a Skill.
- Skill detail: understand, test, or improve one Skill.
- Loop library: find, run, or continue one Loop.
- Builder: edit one Loop draft.
- Run detail: review one execution.
- Team library: discover or publish reusable assets.

### State explains action

Status must answer what the user can do next. `Needs setup` is paired with `Connect account`,
`Fix required` with `Open affected step`, and `Update available` with `Review update`.

### Versions are visible but quiet

Version identity appears in object headers, publish/update flows, and Runs. It does not become
a badge repeated in every row unless needed for a decision.

### Assistance stays subordinate

The assistant proposes a change set and diff. It never becomes the main screen, silently edits,
publishes, or starts a Run.

## 3. Visual Character

Target character: quiet, editorial, precise, and work-focused.

- Light-first neutral surfaces with complete dark parity.
- Restrained blue accent for current selection, links, focus, and primary actions.
- White/neutral base rather than blue-tinted page chrome.
- Dense lists and tables with generous reading space around object details.
- 6-8px radii for controls and contained tools; square page sections.
- Borders and separators before shadows.
- No decorative gradients, glow, glass, oversized hero type, or dashboard metric theater.
- No card-per-row or card-inside-card layouts.

## 4. Layout System

### Desktop

- App sidebar: 224px default, collapsible to 56px.
- Content max behavior: fluid; no centered marketing container.
- Library list/detail split: `minmax(560px, 1fr) 360px` when detail preview is open.
- Builder: 280px Skill panel, flexible editor, 320px contextual inspector when open.
- Minimum main editor width: 640px at 1280 viewport.
- Top bar: 52px; object header: 72-96px based on content.

### Tablet

- Collapsed app sidebar.
- Library preview opens as a drawer.
- Builder uses one main mode plus overlay Skill/Step drawers.

### Mobile

- Bottom or compact top navigation for Skills, Loops, Team library.
- List and detail are separate routes.
- Loop Definition and Outline are primary editing modes.
- Canvas opens full-screen and may require landscape for complex editing.
- Sticky bottom action bar contains at most one primary and one secondary action.

## 5. Spacing and Density

Use a 4px base grid.

| Token | Value | Use |
|---|---:|---|
| `space-1` | 4px | icon/text micro-gap |
| `space-2` | 8px | compact controls and row internals |
| `space-3` | 12px | standard control groups |
| `space-4` | 16px | panel padding and section gaps |
| `space-5` | 20px | object header groups |
| `space-6` | 24px | major content sections |
| `space-8` | 32px | page-level breathing room |

Library rows are 48-64px depending on secondary information. Toolbars are 36-40px. Primary
buttons are 32-36px. Inputs are 34-38px. Touch targets remain at least 44px on mobile.

## 6. Typography

Use the current system stack to preserve Chinese/English quality and avoid font-loading risk:

```text
-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif
```

| Role | Size / line-height | Weight |
|---|---|---|
| Page title | 24 / 32 | 650-700 |
| Object title | 18 / 26 | 650 |
| Section title | 14 / 20 | 650 |
| Body | 14 / 21 | 400 |
| Compact body | 13 / 18 | 400 |
| Label | 12 / 16 | 550 |
| Metadata | 12 / 16 | 400 |

Letter spacing is 0. Avoid all-caps labels. Keep readable paragraphs below 65 characters per
line. Mixed Chinese/English identifiers must not force a row to grow unexpectedly.

## 7. Semantic Color

Continue from the current semantic tokens, but reduce blue-tinted backgrounds.

### Light

- Page background: `#F7F8FA`
- Sidebar: `#F2F3F5`
- Primary surface: `#FFFFFF`
- Subtle surface: `#F5F6F8`
- Text: `#15171A`
- Muted text: `#5F6875`
- Border: `#DDE1E7`
- Strong border: `#B8C0CC`
- Accent: `#2563EB`
- Success: `#147D46`
- Warning: `#9A6700`
- Danger: `#C4322B`

### Dark

- Page background: `#17191D`
- Sidebar: `#1C1F24`
- Primary surface: `#22262C`
- Subtle surface: `#292E36`
- Text: `#F4F6F8`
- Muted text: `#B0B8C3`
- Border: `#3A414C`
- Accent: `#78AFFF`

Status always includes text or an icon. Warning yellow is not used as a general selected state.

## 8. Component Language

### Buttons

- Primary: one per action region, verb-object label.
- Secondary: neutral fill or outline.
- Tertiary: text/icon for low-frequency actions.
- Destructive: secondary danger by default; solid danger only in confirmation.
- Icon-only buttons use Lucide icons and tooltips.
- Disabled actions show a visible explanation nearby.

### Lists and Tables

- Use rows with separators, not individual cards.
- Selection uses a subtle accent wash plus a 2px leading indicator when needed.
- Row click selects/opens; explicit trailing controls perform mutations.
- Column headers remain concise and optional on compact lists.

### Tabs and Segmented Controls

- Tabs switch object sections such as Overview, Tests, Versions.
- Segmented controls switch representations of the same data such as Definition, Outline,
  Canvas.
- Do not use tabs for filters when chips or menus are more appropriate.

### Status

- Use a small dot plus text for common statuses.
- Use a badge only when status needs scanning across many rows.
- Never show more than three status badges in one object header.

### Panels and Drawers

- Right preview/inspector panels are contextual and collapsible.
- Drawers contain one task and one footer action region.
- A collapsed inspector is a labeled rail; it does not leave half-rendered fields visible.

### Toasts and Banners

- Toasts confirm background or completed actions; maximum two.
- Banners explain blocking context or a pending proposal inside the relevant object.
- One recovery action plus close; no generic `Open` or `Apply`.

## 9. Content Design

Primary UI says:

- What this Skill helps you do
- What it needs
- What it creates
- Needs setup
- Fix required
- Test Loop
- Proposed changes
- Publish to team
- Review update

Primary UI avoids:

- schema, contract, binding, provider, runtime, artifact, ledger, patch, scope;
- raw internal IDs except in technical details;
- mixed Chinese/English product terms;
- duplicate words such as “workflow workflow.”

English and Chinese are authored independently. Business names and package IDs may retain
their source language, but navigation, actions, states, help, and accessibility labels are fully
localized.
