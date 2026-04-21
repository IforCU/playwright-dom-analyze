/**
 * Resolves ${...} template references from runtime namespaces.
 *
 * Supported namespaces:
 *   ${data.key}        – immutable scenario input
 *   ${captured.key}    – values stored by previous capture steps
 *   ${credential.key}  – runtime-injected credentials (never logged)
 *   ${runtime.key}     – internal engine state
 *   ${key}             – bare key, resolves from data.* for backward compat
 *
 * Unknown references are left as-is.
 *
 * @param {string} template
 * @param {{ data, captured, credential, runtime }} namespaces
 * @returns {string}
 */
export function resolveTemplateValue(template, namespaces) {
  if (typeof template !== 'string') return template;

  return template.replace(/\$\{([^}]+)\}/g, (match, rawKey) => {
    const key = rawKey.trim();
    const resolved = lookupNamespace(key, namespaces);
    return resolved !== undefined && resolved !== null ? String(resolved) : match;
  });
}

function lookupNamespace(key, { data = {}, captured = {}, credential = {}, runtime = {} }) {
  if (key.startsWith('data.'))       return data[key.slice(5)];
  if (key.startsWith('captured.'))   return captured[key.slice(9)];
  if (key.startsWith('credential.')) return credential[key.slice(11)];
  if (key.startsWith('runtime.'))    return runtime[key.slice(8)];
  // Bare key resolves from data for backward compat
  return data[key];
}
