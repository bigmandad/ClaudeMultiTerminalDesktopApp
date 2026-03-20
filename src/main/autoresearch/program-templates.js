// ── Program Templates — dynamic program.md for research agents ──
// Incorporates: Evolution-DNA learning model (OBSERVE→REMEMBER→ITERATE→GENERATE)
// Incorporates: Two-stage verification, severity-based priorities, TDD discipline

/**
 * Generate a program.md for the research agent based on target type.
 */
function generate(targetProfile, pastContext = '') {
  switch (targetProfile.programTemplate || targetProfile.type) {
    case 'plugin-improvement':
    case 'plugin':
      return pluginTemplate(targetProfile, pastContext);
    case 'mcp-improvement':
    case 'mcp':
      return mcpTemplate(targetProfile, pastContext);
    case 'skill-improvement':
    case 'skill':
      return skillTemplate(targetProfile, pastContext);
    default:
      return genericTemplate(targetProfile, pastContext);
  }
}

// Shared section: Evolution-DNA learning model adapted for autoresearch
function learningModel() {
  return `
## Learning Model (OBSERVE → REMEMBER → ITERATE → GENERATE)

Apply this adaptive learning cycle across experiments:

### OBSERVE (every experiment)
- What approach did you try? What was the result?
- Did the metric improve, decline, or stay flat? Why?
- What unexpected side-effects occurred?

### REMEMBER (accumulate patterns)
- If a technique worked 2+ times → it's a **pattern** (note it in your description)
- If a technique failed 2+ times → it's an **anti-pattern** (avoid repeating)
- Track which file areas have the most improvement potential vs. diminishing returns

### ITERATE (refine approach)
- Each experiment should build on learnings from previous ones
- If metric is plateauing, switch to a different metric or strategy
- If you're stuck: try the OPPOSITE approach of your last 3 experiments

### GENERATE (create reusable knowledge)
- After 5+ experiments, summarize your top findings in the description field
- Note any cross-cutting patterns that apply beyond this specific target
`;
}

// Shared section: verification discipline
function verificationRules() {
  return `
## Verification Discipline
- **Two-stage check**: First verify spec compliance (does it match intent?), then code quality (is it well-built?)
- **No "it should work" claims** — verify by reading the changed file back after editing
- **Severity priority**: If you find a critical bug, fix it immediately before continuing experiments
- **Honest self-assessment**: Rate yourself conservatively. 0.9+ should be reserved for genuinely excellent changes
`;
}

function pluginTemplate(target, pastContext) {
  return `# AutoResearch: Plugin Self-Improvement

## Target: ${target.name}
## Source: ${target.sourcePath}
## Type: Claude Plugin (${target.metrics?.skillCount || 0} skills, ${target.metrics?.hookCount || 0} hooks, ${target.metrics?.commandCount || 0} commands)

## Editable files
${(target.editableFiles || []).map(f => `- ${f}`).join('\n')}

## Read-only context
${(target.readOnlyFiles || []).map(f => `- ${f}`).join('\n') || '(none)'}

## Goal
Autonomously improve this Claude plugin. Each experiment should make ONE focused change and measure the result. Metrics to optimize (pick the most relevant per experiment):

- **skill_clarity** (0-1): Are skill instructions unambiguous and concise?
- **trigger_accuracy** (0-1): Does the skill description accurately describe when it should fire?
- **coverage** (0-1): Are edge cases and error conditions handled?
- **code_quality** (0-1): Is the implementation clean, correct, and well-structured?
- **instruction_density** (0-1): High-value content per line (no filler/padding)?

## Rules
1. ONLY modify files listed under "Editable files"
2. Each experiment: make ONE focused change
3. After modifying, verify no syntax errors or broken markdown
4. Self-assess the quality metric (be honest and conservative)
5. Report results in the exact format below
${verificationRules()}
## Experiment Loop
1. Read the current state of all editable files
2. Identify ONE specific, high-impact improvement
3. Make the change (edit the file)
4. **Verify**: re-read the file to confirm the edit is correct
5. Self-assess: rate the relevant metric 0.0 to 1.0
6. Report results:
\`\`\`
---
metric_name: skill_clarity
metric_value: 0.87
status: keep
description: Simplified trigger description for hytale-plugin-api skill to avoid false positives
---
\`\`\`
7. If the change improves quality (your honest assessment): git commit with descriptive message
8. If not improved or broke something: git checkout -- . (revert all changes)
9. **NEVER STOP.** Continue to the next experiment immediately.

## Strategy Guidelines
- Start by reading ALL editable files to understand the full plugin
- Prioritize changes with highest impact-to-complexity ratio
- Remove redundant or verbose instructions before adding new content
- Ensure skill trigger descriptions start with "Use when..." (Claude Search Optimization)
- Look for inconsistencies between related skills
- Check that examples match actual API patterns
- Consolidate duplicate information across skills
- For trigger descriptions: describe triggering conditions ONLY, not the workflow
${learningModel()}
${pastContext ? `## Past Experiments (from knowledge base)\n${pastContext}` : ''}
`;
}

function mcpTemplate(target, pastContext) {
  return `# AutoResearch: MCP Server Self-Improvement

## Target: ${target.name}
## Command: ${target.command} ${(target.args || []).join(' ')}
## Source: ${target.sourcePath || 'unknown'}

## Editable files
${(target.editableFiles || []).map(f => `- ${f}`).join('\n') || '(no source files found — focus on configuration)'}

## Goal
Autonomously improve this MCP server. Metrics:

- **tool_coverage** (0-1): Are all useful operations exposed as tools?
- **error_handling** (0-1): Do tools handle invalid inputs gracefully?
- **response_quality** (0-1): Are tool responses clear and well-structured?
- **input_validation** (0-1): Are tool input schemas complete and correct?
- **documentation** (0-1): Are tool descriptions clear and helpful?

## Rules
1. ONLY modify files listed under "Editable files"
2. Each experiment: make ONE focused change
3. Test changes by verifying the code is syntactically valid (run \`node --check <file>\` if JS)
4. Self-assess the quality metric honestly
${verificationRules()}
## Experiment Loop
1. Read all source files
2. Identify ONE specific improvement
3. Make the change
4. **Verify**: re-read the changed file, check for syntax errors
5. Self-assess the relevant metric
6. Report:
\`\`\`
---
metric_name: error_handling
metric_value: 0.82
status: keep
description: Added input validation to search tool for empty queries
---
\`\`\`
7. Keep or discard based on quality assessment
8. **NEVER STOP.** Continue immediately.
${learningModel()}
${pastContext ? `## Past Experiments\n${pastContext}` : ''}
`;
}

function skillTemplate(target, pastContext) {
  return `# AutoResearch: Skill Self-Improvement

## Target: ${target.name}
## File: ${(target.editableFiles || [])[0] || 'unknown'}
## Lines: ${target.totalLines || 'unknown'}

## Goal
Autonomously improve this Claude custom command/skill. Metrics:

- **instruction_clarity** (0-1): Are instructions unambiguous? Would Claude follow them correctly?
- **trigger_precision** (0-1): Does the description accurately describe when to use this skill?
- **completeness** (0-1): Does the skill cover all necessary steps and edge cases?
- **conciseness** (0-1): Is every line high-value? No filler or redundancy?
- **example_quality** (0-1): Are examples clear, correct, and representative?

## Rules
1. ONLY modify the skill file
2. Each experiment: ONE focused change
3. Maintain the overall structure and intent
4. Self-assess honestly

## Claude Search Optimization (CSO)
Skill descriptions MUST start with "Use when..." and describe ONLY triggering conditions (not the workflow).
Bad: "This skill helps you create new plugins by walking through a wizard..."
Good: "Use when the user wants to create, scaffold, or initialize a new plugin project."
${verificationRules()}
## Experiment Loop
1. Read the skill file completely
2. Identify ONE improvement opportunity
3. Make the change
4. **Verify**: re-read the file to confirm correctness
5. Self-assess:
\`\`\`
---
metric_name: instruction_clarity
metric_value: 0.91
status: keep
description: Replaced ambiguous step 3 with specific actionable instruction
---
\`\`\`
6. Keep or discard
7. **NEVER STOP.**

## Strategy
- Read the entire skill first before making any changes
- Prioritize clarity over completeness
- Remove hedging language ("you might want to", "consider")
- Use imperative voice ("Do X" not "You should do X")
- Ensure examples match the instruction format
- Check for contradictions between different sections
- Apply CSO: optimize the description for accurate triggering
${learningModel()}
${pastContext ? `## Past Experiments\n${pastContext}` : ''}
`;
}

function genericTemplate(target, pastContext) {
  return `# AutoResearch: Autonomous Improvement

## Target: ${target.name} (${target.type})
## Source: ${target.sourcePath || 'unknown'}

## Editable files
${(target.editableFiles || []).map(f => `- ${f}`).join('\n')}

## Goal
Improve this target autonomously. Make ONE focused change per experiment.

## Report format
\`\`\`
---
metric_name: quality
metric_value: 0.85
status: keep
description: what you changed
---
\`\`\`

## Rules
- ONE change per experiment
- Self-assess honestly (0.0-1.0)
- Git commit if improved, revert if not
- **Verify** every change by re-reading the modified file
- **NEVER STOP**
${learningModel()}
${pastContext ? `## Past Experiments\n${pastContext}` : ''}
`;
}

module.exports = { generate };
