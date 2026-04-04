# Answers: Lesson 54 — Output Style and Efficiency

## Exercise 1
**Question:** Rewrite the verbose model response to comply with output efficiency rules.

**Answer:** The original response uses filler phrases ("Great question!", "I'd be happy to help"), narrates its own actions ("Let me take a look", "I'll use the FileRead tool"), and over-explains. A compliant version:

"my-app v2.0.0. Dependencies: react 18, next 14, prisma 5. Dev deps: typescript, vitest, eslint. Scripts: dev, build, test, lint, db:migrate."

This follows the efficiency rules: no filler, no narration, no repeating the question, summarized key findings rather than raw output, and uses the minimum text needed to fully answer.

---

## Exercise 2
**Question:** Explain the five-layer style system and why language is applied last.

**Answer:** The five layers, in order: (1) **Efficiency** — Baseline rules that always apply: no filler phrases, no repetition, minimum output. This is the foundation all other layers build on. (2) **Tone** — Communication personality: professional, direct, like a senior engineer. Builds on efficiency by defining *how* the concise output sounds. (3) **Style config** — User-adjustable verbosity (concise/normal/verbose) within the efficiency and tone bounds. Adjusts the volume dial without changing the fundamental approach. (4) **Brief/keepCoding modes** — Override modes that tighten further: brief limits to 3 sentences, keepCoding eliminates pauses for confirmation. These are special modes that override style config. (5) **Language** — Applied last because it wraps everything: all the behavioral rules from layers 1-4 are expressed in the target language. If language were first, the subsequent English-language rules might confuse the model about which language to use for output.

---

## Exercise 3
**Challenge:** Write a `getOutputStyleConfig` function.

**Answer:**
```typescript
interface StyleConfig {
  verbosity: "concise" | "normal" | "verbose";
  codeComments: boolean;
  explanations: "minimal" | "standard" | "detailed";
}

function getOutputStyleConfig(config: StyleConfig): string {
  const parts: string[] = [];

  switch (config.verbosity) {
    case "concise":
      parts.push(
        "Be extremely concise. One-line answers when possible. " +
        "Skip all pleasantries and meta-commentary."
      );
      break;
    case "verbose":
      parts.push(
        "Provide detailed explanations. Include reasoning, " +
        "alternatives considered, and potential trade-offs."
      );
      break;
    default:
      parts.push(
        "Use moderate verbosity. Explain non-obvious decisions " +
        "but skip obvious narration."
      );
  }

  if (!config.codeComments) {
    parts.push(
      "Do NOT add comments to code unless they explain " +
      "non-obvious logic. Avoid narrating what the code does."
    );
  } else {
    parts.push(
      "Add clear comments to code explaining the intent " +
      "behind non-trivial logic."
    );
  }

  switch (config.explanations) {
    case "minimal":
      parts.push(
        "Only explain when asked. Let the code and results speak for themselves."
      );
      break;
    case "detailed":
      parts.push(
        "Explain each significant change: what it does, why " +
        "it's needed, and alternatives you considered."
      );
      break;
    default:
      parts.push(
        "Explain non-obvious changes briefly. Skip explanations " +
        "for straightforward modifications."
      );
  }

  return parts.join("\n");
}
```
**Explanation:** Each configuration dimension independently contributes a paragraph of instructions. The function composes them together, creating a unique style profile for any combination of settings. The default cases provide reasonable middle-ground behavior.

---

## Exercise 4
**Question:** Identify anti-patterns and write corrected versions.

**Answer:** (a) "Absolutely! Let me dive into that for you! 🚀" — **Over-Eager Helper.** Uses filler ("Absolutely!"), unnecessary enthusiasm, and an emoji. Corrected: Simply begin the task with no preamble. If the task is "fix the login bug," the agent should start reading the relevant file immediately, not announce its excitement.

(b) "It's possible that there might perhaps be a null reference issue that could potentially cause problems." — **Hedge Machine.** Layers hedging words ("possible", "might", "perhaps", "potentially") making the statement meaningless. Corrected: "There's a null reference on line 42. `user.profile` is accessed without checking if `user` is null." State the finding directly with specifics.

(c) "Here's the complete updated file: [entire 200-line file with 2 lines changed]" — **Wall of Code.** Reproduces an entire file when only 2 lines changed, wasting tokens and screen space. Corrected: Show only the changed lines with 2-3 lines of context above and below: "Changed lines 42-43 in `auth.ts`:" followed by a small code block showing just the edit region.
