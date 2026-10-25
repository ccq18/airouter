// The quota engine detects credential changes; these two dependency controls
// also affect context identity without changing a quota provider's identity.
function credentialContextInvalidations(previousConfigs, nextConfigs, changedIds) {
  const previous = new Map(previousConfigs.map(config => [config.id, config]));
  const next = new Map(nextConfigs.map(config => [config.id, config]));
  const invalid = new Set(changedIds);
  for (const id of new Set([...previous.keys(), ...next.keys()])) {
    const before = previous.get(id), after = next.get(id);
    if (!before || !after || (before.enabled !== false) !== (after.enabled !== false) || (before.credential_ref || '') !== (after.credential_ref || '')) invalid.add(id);
  }
  // Walk both graphs: removing/changing a reference must invalidate its old
  // dependents as well. Only IDs escape this helper, never credential values.
  const configs = [...previousConfigs, ...nextConfigs];
  let expanded;
  do {
    expanded = false;
    for (const config of configs) if (config.credential_ref && invalid.has(config.credential_ref) && !invalid.has(config.id)) {
      invalid.add(config.id); expanded = true;
    }
  } while (expanded);
  return [...invalid];
}
module.exports = { credentialContextInvalidations };
