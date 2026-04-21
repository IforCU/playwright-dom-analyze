export { runScenarioSuite } from './runScenarioSuite.js';
export { runScenario }     from './runScenario.js';

// Utilities for consumers who want to compose at a lower level:
export { resolveDefaults }  from './defaultsResolver.js';
export { loadScenarios, loadAnalysisReport } from './scenarioLoader.js';
export { buildExecutionContext, launchBrowser, createScenarioContext }  from './buildExecutionContext.js';
export { buildAnalysisElementMap } from './target-resolution/resolveAnalysisRef.js';
export { RuntimeState }    from './runtime/runtimeState.js';
export { ERROR_CODES }     from './errors/errorCodes.js';
