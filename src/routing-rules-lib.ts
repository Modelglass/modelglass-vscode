import {
  rankModelsForCategory,
  type CategoryRanking,
  type LeafTaskCategory,
  type RankedModel,
  type RoutableModel,
} from "./routing-engine.js";

/**
 * SCO-231 — user-defined routing rule overrides (Pro scope; tier gating
 * itself is a separate card, SCO-234 — not built here, see run-task.ts's
 * header). Pure half (no `vscode` import — same lib/non-lib split as
 * routing-engine.ts/provider-keys-lib.ts/run-task-lib.ts) so it's directly
 * unit-testable; the workspace-file loader lives in ./routing-rules.ts.
 *
 * CONFIG FORMAT: JSON, not YAML. This repo (modelglass-vscode) has zero
 * existing YAML tooling — no parser dependency, no .yaml data files
 * anywhere in it — whereas the main modelglass monorepo's YAML convention
 * belongs to a separate Python-based registry pipeline that has no bearing
 * here. The applicable precedent is VS Code's OWN workspace-config idiom
 * (.vscode/settings.json, tasks.json, launch.json) — uniformly JSON, no
 * extra parser needed (JSON.parse is a language builtin). Adding a YAML
 * dependency for a small rules list would be pure overhead with no
 * functional upside in this specific repo.
 *
 * FILE LOCATION: .modelglass/routing-rules.json under the first workspace
 * folder — a dedicated dot-folder (mirroring .vscode/, .github/) rather
 * than a bare file at the workspace root, so it doesn't clutter the root
 * and reads clearly as "config belonging to the Modelglass extension."
 *
 * RULE GRAMMAR — one rule per LeafTaskCategory (duplicates rejected), four
 * independently-composable fields covering the card's three example shapes
 * plus SCO-330's quality bar:
 *   - excludeProviders: string[]   -- "never route agentic tasks to provider X"
 *   - strategy: "cheapest"          -- "always prefer cheapest for autocomplete"
 *   - priority: string[]            -- "custom priority ordering per category"
 *     (an ordered list of Modelglass model.id strings, most-preferred first)
 *   - minScore: number (0-1)        -- SCO-330: "cheapest model that still
 *     clears THIS bar," overriding the ENGINE'S OWN DEFAULT bar rather than
 *     introducing quality-filtering that wasn't there before (as of the
 *     2026-07-29 default-flip, routing-engine.ts already applies a default,
 *     per-benchmark quality bar with no rule at all — see
 *     routing-engine.ts's `applyQualityBar` for the ranking-side mechanics
 *     and why the default is per-benchmark, not one shared number). This
 *     field is for a user who wants a DIFFERENT bar than the built-in
 *     default, not the only way to get one at all. Only meaningful for the
 *     five benchmark-scored categories (bug-fix, new-code-generation,
 *     terminal-cli, library-aware-feature-work, refactor); silently a
 *     no-op for the four capability-rating categories, per
 *     routing-engine.ts's own dispatcher comment — their 0-2 rating scale
 *     isn't threshold-comparable to a 0-1 score (and those four already
 *     achieve cheapest-among-the-top-tier naturally, via the tie-break
 *     their coarse rating scale triggers far more often).
 * `priority` and `strategy` are mutually exclusive within one rule (both are
 * full-ranking overrides; combining them is ambiguous, rejected at
 * validation rather than silently resolved by a precedence guess). `minScore`
 * is ALSO rejected together with either: `priority` already fully specifies
 * exactly which models rank at all (a quality floor on top of an explicit
 * list is redundant — just leave sub-bar models off the list), and
 * `strategy: "cheapest"` already means "ignore quality signal entirely,"
 * which a quality floor directly contradicts. This is a deliberate scope
 * narrowing (flagged, not silently chosen) — `minScore` composing with
 * `strategy: "cheapest"` (cheapest-among-qualifying via the rule engine
 * rather than the default engine) is a plausible future shape, but doing it
 * correctly means resolveCategoryRanking's strategy branch would need each
 * model's per-category benchmark score, which today only the specific
 * rankXxx functions in routing-engine.ts know how to compute — left for a
 * follow-up rather than threaded through here.
 * `excludeProviders` composes with any of the other three, or with none (see
 * resolveCategoryRanking's header for the exact precedence).
 *
 * SCOPE DECISION FLAGGED AS GENUINELY AMBIGUOUS (per the card's own
 * instruction to flag rather than silently pick): whether `category` should
 * accept the full TaskCategory union (including the composite
 * "agentic-multi-step", which is literally the card's own worded example --
 * "never route agentic tasks to provider X") or be restricted to the nine
 * LeafTaskCategory values actually reachable through run-task.ts today.
 * Chose the LATTER (restricted to the nine leaf categories) because
 * "agentic-multi-step" isn't wired to any executable path in this repo yet
 * (SCO-232's own header explains why: composite decomposition needs its own
 * subtask UI, deferred) -- accepting it here would validate successfully
 * but silently never fire, which seemed like the worse failure mode versus
 * rejecting it clearly today and revisiting once agentic decomposition is
 * built. A rule for the *leaf* category a decomposed agentic subtask
 * actually resolves to (e.g. "bug-fix") already applies correctly once that
 * decomposition exists, since rankAgenticMultiStep dispatches per-subtask to
 * rankModelsForCategory today -- so this restriction gives up only the
 * "blanket exclude across all agentic subtasks in one rule" shape, not
 * exclusion of agentic tasks entirely.
 */

export type RuleStrategy = "cheapest";

export interface RoutingRule {
  category: LeafTaskCategory;
  excludeProviders?: string[];
  strategy?: RuleStrategy;
  priority?: string[];
  /** SCO-330 — 0-1, same scale as a raw benchmark score. See this file's
   *  header for why it's rejected alongside `priority`/`strategy`. */
  minScore?: number;
}

export interface RoutingRulesConfig {
  version: 1;
  rules: RoutingRule[];
}

export type ValidationResult =
  | { ok: true; rulesByCategory: Map<LeafTaskCategory, RoutingRule> }
  | { ok: false; errors: string[] };

// Deliberately re-declared rather than imported from run-task-lib.ts's
// LEAF_CATEGORIES -- run-task-lib.ts will import resolveCategoryRanking
// from THIS file, so importing the other way would be circular. Same
// independent-small-vocabulary-copy precedent routing-engine.ts's own
// header already establishes for RATING_ORDER (SCO-216).
const KNOWN_LEAF_CATEGORIES = new Set<string>([
  "bug-fix",
  "new-code-generation",
  "terminal-cli",
  "library-aware-feature-work",
  "refactor",
  "test-gen",
  "doc-gen",
  "chat-explain",
  "autocomplete",
]);

const KNOWN_STRATEGIES = new Set<string>(["cheapest"]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Validates an already-JSON.parsed value against the rule grammar above.
 * Pure structural validation -- no file I/O, no vscode. Returns every error
 * found (not just the first) so a user fixing a rules file sees the whole
 * list at once.
 */
export function validateRoutingRulesConfig(raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['routing-rules.json must contain a JSON object, e.g. {"version":1,"rules":[]}'] };
  }
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (obj["version"] !== 1) {
    errors.push(`unsupported "version" (expected 1, got ${JSON.stringify(obj["version"])})`);
  }

  if (!Array.isArray(obj["rules"])) {
    errors.push('"rules" must be an array');
    return { ok: false, errors };
  }

  const rulesByCategory = new Map<LeafTaskCategory, RoutingRule>();

  (obj["rules"] as unknown[]).forEach((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`rules[${i}] must be an object`);
      return;
    }
    const r = entry as Record<string, unknown>;

    if (typeof r["category"] !== "string" || !KNOWN_LEAF_CATEGORIES.has(r["category"])) {
      errors.push(
        `rules[${i}].category must be one of the nine leaf task categories (got ${JSON.stringify(r["category"])})`,
      );
      return;
    }
    const category = r["category"] as LeafTaskCategory;

    if (rulesByCategory.has(category)) {
      errors.push(`rules[${i}]: duplicate rule for category "${category}" — only one rule per category is supported`);
      return;
    }

    if (r["excludeProviders"] !== undefined && !isStringArray(r["excludeProviders"])) {
      errors.push(`rules[${i}].excludeProviders must be an array of strings`);
      return;
    }
    if (r["strategy"] !== undefined && (typeof r["strategy"] !== "string" || !KNOWN_STRATEGIES.has(r["strategy"]))) {
      errors.push(`rules[${i}].strategy must be "cheapest" (the only supported strategy)`);
      return;
    }
    if (r["priority"] !== undefined && !isStringArray(r["priority"])) {
      errors.push(`rules[${i}].priority must be an array of model-id strings`);
      return;
    }
    if (r["priority"] !== undefined && r["strategy"] !== undefined) {
      errors.push(
        `rules[${i}]: "priority" and "strategy" are mutually exclusive — a custom order already fully determines ranking`,
      );
      return;
    }

    if (r["minScore"] !== undefined) {
      if (typeof r["minScore"] !== "number" || Number.isNaN(r["minScore"]) || r["minScore"] < 0 || r["minScore"] > 1) {
        errors.push(`rules[${i}].minScore must be a number between 0 and 1 (a fraction, e.g. 0.65 for 65%)`);
        return;
      }
      if (r["priority"] !== undefined) {
        errors.push(`rules[${i}]: "minScore" and "priority" are mutually exclusive — an explicit model list already decides which models rank`);
        return;
      }
      if (r["strategy"] !== undefined) {
        errors.push(`rules[${i}]: "minScore" and "strategy" are mutually exclusive — "cheapest" already ignores quality signal entirely`);
        return;
      }
    }

    rulesByCategory.set(category, {
      category,
      excludeProviders: r["excludeProviders"] as string[] | undefined,
      strategy: r["strategy"] as RuleStrategy | undefined,
      priority: r["priority"] as string[] | undefined,
      minScore: r["minScore"] as number | undefined,
    });
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, rulesByCategory };
}

/**
 * Structurally a superset of CategoryRanking (extra fields only) — assignable
 * anywhere a CategoryRanking is expected, so run-task-lib.ts's existing
 * `ranking.ranked[0]!.model` access works unchanged whether or not a rule
 * fired.
 */
export interface RuleAppliedRanking extends CategoryRanking {
  ruleApplied: boolean;
  /** priority entries that matched no model in the pool at all (typo, or a
   *  retired/renamed model) — surfaced so a stale rules file doesn't fail
   *  silently. */
  unmatchedPriorityIds: string[];
}

/**
 * Resolves a category's ranking, applying `rule` (if any) on top of SCO-230's
 * rankModelsForCategory rather than beside it. Precedence, most to least
 * binding:
 *   1. excludeProviders — ALWAYS filters the pool first, regardless of what
 *      follows. A rule always wins over the default here: an excluded
 *      provider's models never appear in `ranked`, even if the default
 *      engine would have ranked one #1.
 *   2. priority — if set, a FULL override: only the named models (in the
 *      given order) appear in `ranked`; every other pool model (including
 *      ones the default engine would have scored well) is moved to
 *      `excluded` with a stated reason. The default engine is not consulted
 *      at all for this category.
 *   3. strategy: "cheapest" — also a FULL override, re-ranking the
 *      (exclude-filtered) pool purely by price ascending, ignoring
 *      benchmark/capability signal entirely for this category.
 *   4. Neither priority nor strategy set (an exclude-only rule, or no rule
 *      at all) — falls through to SCO-230's rankModelsForCategory,
 *      unmodified, on the (possibly exclude-filtered) pool. THIS is the
 *      "compose, don't replace" case the card calls out explicitly: an
 *      excludeProviders-only rule for one category changes nothing about
 *      how every other category ranks, and doesn't disable ranking for its
 *      own category either — it only narrows the pool the default engine
 *      sees.
 * No rule for this category at all → identical to calling
 * rankModelsForCategory directly (ruleApplied: false).
 */
export function resolveCategoryRanking(
  models: RoutableModel[],
  category: LeafTaskCategory,
  rule: RoutingRule | undefined,
): RuleAppliedRanking {
  if (!rule) {
    const base = rankModelsForCategory(models, category);
    return { ...base, ruleApplied: false, unmatchedPriorityIds: [] };
  }

  const excludeSet = new Set(rule.excludeProviders ?? []);
  const pool = excludeSet.size ? models.filter((m) => !excludeSet.has(m.provider)) : models;
  const excludedByRule = models
    .filter((m) => excludeSet.has(m.provider))
    .map((m) => ({
      model: m,
      reason: `excluded by routing-rules.json: provider "${m.provider}" is on this category's excludeProviders list`,
    }));

  if (rule.priority?.length) {
    const ranked: RankedModel[] = [];
    const matched = new Set<string>();
    rule.priority.forEach((modelId, index) => {
      const match = pool.find((m) => m.modelId === modelId);
      if (match) {
        matched.add(match.modelId);
        ranked.push({
          model: match,
          score: rule.priority!.length - index,
          scoreKind: "capability-rating",
          scoreLabel: `custom priority #${index + 1} of ${rule.priority!.length} (routing-rules.json override)`,
        });
      }
    });
    const unnamed = pool.filter((m) => !matched.has(m.modelId));
    const excludedUnnamed = unnamed.map((m) => ({
      model: m,
      reason:
        "not present in this category's custom priority list (routing-rules.json) — priority is a full override, unnamed models are not ranked",
    }));
    const unmatchedPriorityIds = rule.priority.filter((id) => !pool.some((m) => m.modelId === id));
    return {
      category,
      ranked,
      excluded: [...excludedByRule, ...excludedUnnamed],
      unscored: [],
      ruleApplied: true,
      unmatchedPriorityIds,
    };
  }

  if (rule.strategy === "cheapest") {
    const priced = pool.filter((m) => m.inputPricePerM !== null);
    const unpriced = pool.filter((m) => m.inputPricePerM === null);
    const ranked: RankedModel[] = [...priced]
      .sort((a, b) => a.inputPricePerM! - b.inputPricePerM!)
      .map((m) => ({
        model: m,
        score: -m.inputPricePerM!,
        scoreKind: "capability-rating",
        scoreLabel: `cheapest-first override (routing-rules.json): $${m.inputPricePerM}/M input`,
      }));
    return {
      category,
      ranked,
      excluded: excludedByRule,
      unscored: unpriced,
      ruleApplied: true,
      unmatchedPriorityIds: [],
    };
  }

  // exclude-only and/or minScore rule (or excludeProviders was empty and no
  // minScore set — the true no-op case) — compose with the default engine
  // on the filtered pool, per the card's explicit "don't fully replace the
  // default" requirement. SCO-330: minScore forwarded here, not in the
  // priority/strategy branches above — see this file's header for why.
  const defaultRanking = rankModelsForCategory(pool, category, rule.minScore);
  return {
    ...defaultRanking,
    excluded: [...excludedByRule, ...defaultRanking.excluded],
    ruleApplied: excludeSet.size > 0 || rule.minScore !== undefined,
    unmatchedPriorityIds: [],
  };
}
