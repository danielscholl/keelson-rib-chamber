// Composition guidance for agent-authored canvas boards — the knowledge layer over
// the `board` kind, mirroring what @keelson/shared's design-guidance.ts does for the
// `html` kind. It lives here, not in shared: Chamber is the only place an LLM authors
// a board (every other rib builds its boards deterministically in code).
//
// Two tiers, both fed from the same source so they cannot drift: the one-paragraph
// contract that rides the board tools' descriptions — the only seam a room turn has,
// since it tables an exhibit with no prompt to inject into — and the fuller block the
// lens workflow prompt embeds. The renderer owns typography, palette, and layout, so
// neither tier repeats the html guidance's token/font/CSP rules; a board author's
// judgement goes into which form carries each fact, and into the copy.

// The data job each section kind exists to do. `job` stays comma-free: the contract
// joins these into one prose list, and an internal comma would read as a list break.
// The nuance and the trap worth naming live in `detail`, which only the block renders.
const FORMS: readonly { kind: string; job: string; detail: string }[] = [
  {
    kind: "stats",
    job: "the headline figures",
    detail:
      "`{ label, value, sub?, tone? }` — three to five of them, above any detail. `tone` carries state, `sub` the qualifier.",
  },
  {
    kind: "bars",
    job: "magnitude across categories",
    detail:
      "`{ label, value, total, tone?, trailing? }`, sorted by value; `inline: true` gives a dense ranked list. This is the form for *which of these is biggest* — never make the reader count table rows to find it.",
  },
  {
    kind: "segments",
    job: "composition of a whole",
    detail: "`{ label, n, tone? }` — the parts of one total, not a ranking.",
  },
  {
    kind: "chart",
    job: "change over time",
    detail: "up to 6 series, x unique within a series. One measure; a trend, not a snapshot.",
  },
  {
    kind: "table",
    job: "exact values across several dimensions",
    detail:
      "`columns` + `rows`. Earn it: a table is for looking a value up, not for dumping records.",
  },
  {
    kind: "rows",
    job: "a scannable list",
    detail:
      "one line per item. `boxed: true` makes `text` a left-hand label and `trailing` its value; `detail` discloses a long record under a capped line.",
  },
  {
    kind: "cards",
    job: "items that each carry a title and a few labelled fields",
    detail:
      "`stacked: true` gives each field its own line (fields otherwise join into one `·` meta row that wraps badly once they are long); `grid: true` lays cards side by side; `mono: true` sets a code-like title.",
  },
  {
    kind: "grid",
    job: "the status of many items at a glance",
    detail: "labelled cells with small toned badges — lighter than `cards` for a matrix.",
  },
  { kind: "journey", job: "ordered stages", detail: "`{ title, text? }` in sequence." },
  {
    kind: "columns",
    job: "two leaf sections side by side",
    detail: "one level deep; `weight` sizes the tracks.",
  },
];

// The kinds the guidance teaches as a data form, and the ones it deliberately does
// not: `actions` is a control strip (the lens tool's own description teaches the one
// verb a lens may carry) and `seats` is the bench's fixed-capacity identity row, not a
// form a subject's data picks. A drift test holds these two sets exhaustive against
// the shared schema, so a new section kind has to be taught or consciously skipped.
export const BOARD_FORM_KINDS: readonly string[] = FORMS.map((f) => f.kind);
export const BOARD_NON_FORM_KINDS: readonly string[] = ["actions", "seats"];

// Rules about composition rather than form — what the board says and how each text
// slot earns its place. Shared by both tiers.
const COMPOSITION: readonly string[] = [
  "The title states the finding, not the subject — what the board says, not what it is about.",
  "Summary before detail; order sections by what the reader needs first.",
  "Group repeated records. When one subject occupies many rows, the count IS the finding: show it as `bars` and keep the raw records in a `table` or a row's `detail` beneath.",
  "Every text slot stays in its job: a pill or chip is a short state chip, never a clause that truncates; a card field is a label plus a value, never a sentence.",
  "Tone means state (ok / warn / error / caution / info) and always rides a word or label — never colour alone.",
  "Structure encodes truth: number a list only when the order is real, and add a section only when it carries something the reader needs.",
  "Write real copy in the operator's language. Never invent data to fill a section — a short honest board beats a padded one.",
];

// The paragraph that rides the board tools' descriptions — the minimum contract every
// caller sees, including a room turn tabling an exhibit mid-discussion.
export const BOARD_COMPOSITION_CONTRACT = [
  "Compose it from the section kind whose job matches the data:",
  `${FORMS.map((f) => `\`${f.kind}\` for ${f.job}`).join(", ")}.`,
  "Lead with the summary and put the detail under it; title it with the finding, not the subject.",
  "Keep each text slot in its job — a pill is a short state chip, never a clause; a card field is a label plus a value, never a sentence (`stacked: true` when fields need their own lines, a row's `detail` for long-form text).",
  "Group repeated records rather than listing one subject many times: when a row repeats, the count is the finding, so carry it as `bars`.",
  "Tone means state and always rides a word, never colour alone.",
].join(" ");

// The fuller block for a workflow prompt node, where there is room to teach the shape
// of each form and the trap it avoids.
export function buildBoardCompositionGuidance(): string {
  return [
    "## Composing the board",
    "",
    "The board renders through Keelson's canvas: the host owns typography, palette, and layout, so your judgement goes into WHICH form carries each fact, and into the copy. Every section kind is optional — reach for the one whose job matches the data.",
    "",
    "Pick the form from the data's job:",
    ...FORMS.map((f) => `- ${f.job} → \`${f.kind}\`: ${f.detail}`),
    "",
    "Compose it:",
    ...COMPOSITION.map((line) => `- ${line}`),
  ].join("\n");
}
