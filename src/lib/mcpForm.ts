// Pure decisions for the Settings · MCP servers edit form (S1/S2). Extracted so
// they can be unit-tested without rendering the whole Settings page.

/**
 * S2: the argv to persist on save. The command field flattens argv with
 * join(' '), which CANNOT represent an argument that itself contains a space
 * (e.g. ["node", "/Users/me/My Servers/x.js"]). So when the field is unchanged
 * from the original, reuse the original argv verbatim (non-lossy); only re-split
 * on whitespace when the user actually edited the field.
 */
export function mcpSaveArgv(commandField: string, editCommandOrig: string[] | null): string[] {
  if (editCommandOrig !== null && commandField === editCommandOrig.join(' ')) {
    return editCommandOrig
  }
  return commandField.trim().split(/\s+/).filter(Boolean)
}

/**
 * S1: the test-result keys to invalidate on save — the saved entry's name AND
 * (on a rename) the renamed-from name — so no just-edited/renamed command keeps
 * an old green "N tools" handshake result standing in for an untested command.
 */
export function mcpTestKeysToClear(savedName: string, editingName: string | null): string[] {
  return editingName && editingName !== savedName ? [savedName, editingName] : [savedName]
}
