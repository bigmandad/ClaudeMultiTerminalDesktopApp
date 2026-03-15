// ── Program Templates — dynamic program.md for research agents ──

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

## Experiment Loop
1. Read the current state of all editable files
2. Identify ONE specific, high-impact improvement
3. Make the change (edit the file)
4. Self-assess: rate the relevant metric 0.0 to 1.0
5. Report results:
\`\`\`
---
metric_name: skill_clarity
metric_value: 0.87
status: keep
description: Simplified trigger description for hytale-plugin-api skill to avoid false positives
---
\`\`\`
6. If the change improves quality (your honest assessment): git commit with descriptive message
7. If not improved or broke something: git checkout -- . (revert all changes)
8. **NEVER STOP.** Continue to the next experiment immediately.

## Strategy Guidelines
- Start by reading ALL editable files to understand the full plugin
- Prioritize changes with highest impact-to-complexity ratio
- Remove redundant or verbose instructions before adding new content
- Ensure skill trigger descriptions are specific (avoid over-firing)
- Look for inconsistencies between related skills
- Check that examples match actual API patterns
- Consolidate duplicate information across skills

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
3. Test changes by verifying the code is syntactically valid
4. Self-assess the quality metric honestly

## Experiment Loop
1. Read all source files
2. Identify ONE specific improvement
3. Make the change
4. Self-assess the relevant metric
5. Report:
\`\`\`
---
metric_name: error_handling
metric_value: 0.82
status: keep
description: Added input validation to search tool for empty queries
---
\`\`\`
6. Keep or discard based on quality assessment
7. **NEVER STOP.** Continue immediately.

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

## Experiment Loop
1. Read the skill file completely
2. Identify ONE improvement opportunity
3. Make the change
4. Self-assess:
\`\`\`
---
metric_name: instruction_clarity
metric_value: 0.91
status: keep
description: Replaced ambiguous step 3 with specific actionable instruction
---
\`\`\`
5. Keep or discard
6. **NEVER STOP.**

## Strategy
- Read the entire skill first before making any changes
- Prioritize clarity over completeness
- Remove hedging language ("you might want to", "consider")
- Use imperative voice ("Do X" not "You should do X")
- Ensure examples match the instruction format
- Check for contradictions between different sections

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
- **NEVER STOP**

${pastContext ? `## Past Experiments\n${pastContext}` : ''}
`;
}

module.exports = { generate };
