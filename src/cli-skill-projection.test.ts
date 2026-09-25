import assert from "node:assert/strict";
import test from "node:test";

import { CLI_COMMAND_REGISTRY, canonicalCommandForName } from "./cli-command-registry.js";
import { renderCliSkillPlaybook } from "./cli-skill-projection.js";

test("every canonical-routine command in the playbook resolves through the registry", () => {
  const playbook = renderCliSkillPlaybook();
  const routineCommands = [...playbook.matchAll(/^\d+\. `nawabari ([^`]+)`/gm)].map((match) => match[1]);
  assert.ok(routineCommands.length > 0, "expected at least one canonical-routine entry");
  for (const command of routineCommands) {
    assert.ok(canonicalCommandForName(command) !== undefined, `canonical routine command not registered: ${command}`);
  }
});

test("skill playbook renders every canonical command's own usage block exactly once", () => {
  const playbook = renderCliSkillPlaybook();
  for (const definition of CLI_COMMAND_REGISTRY) {
    assert.ok(playbook.includes(`### \`${definition.name}\``), `missing command heading for ${definition.name}`);
    const usageBlock = `\`\`\`\n${definition.usage}\n\`\`\``;
    assert.ok(playbook.includes(usageBlock), `missing canonical usage block for ${definition.name}`);
    const usageBlockOccurrences = playbook.split(usageBlock).length - 1;
    assert.equal(
      usageBlockOccurrences,
      1,
      `usage block for ${definition.name} must be projected exactly once, not restated`,
    );
  }
});

test("skill playbook never restates an independent option/flag table", () => {
  const playbook = renderCliSkillPlaybook();
  for (const definition of CLI_COMMAND_REGISTRY) {
    for (const optionSpec of definition.options) {
      const bodyWithoutUsageLines = playbook
        .split("\n")
        .filter((line) => !line.includes(definition.usage))
        .join("\n");
      assert.ok(
        !bodyWithoutUsageLines.includes(optionSpec.description),
        `playbook must not duplicate the option description for ${definition.name} ${optionSpec.name}`,
      );
    }
  }
});

test("skill playbook points every command at its own live --help/--json projection", () => {
  const playbook = renderCliSkillPlaybook();
  for (const definition of CLI_COMMAND_REGISTRY) {
    assert.ok(
      playbook.includes(`nawabari ${definition.name} --help --json`),
      `missing live help projection reference for ${definition.name}`,
    );
  }
});

test("skill playbook is deterministic", () => {
  assert.equal(renderCliSkillPlaybook(), renderCliSkillPlaybook());
});
